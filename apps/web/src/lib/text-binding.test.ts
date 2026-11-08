import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createTextBinding, rebaseEdit, type TextEdit } from './text-binding';
import { applyEdit, FakeTextarea } from './test-support';

const codePointCount = (text: string) => [...text].length;
const unitIndex = (text: string, codePoints: number) =>
  [...text].slice(0, codePoints).join('').length;

/**
 * A textarea, a document text and a binding between them, driven the way the browser and React
 * drive them: the user's input is reported to the binding, the document applies the reported edit,
 * and the binding is then told the document's new text, but only when that text changed, because
 * the layout effect in `NoteTextArea` depends on `value`.
 */
function setup(initial: string, hasFocus = true) {
  const control = new FakeTextarea(initial);
  let doc = initial;
  const edits: TextEdit[] = [];
  const binding = createTextBinding(initial, (edit) => {
    if (edit.start < 0 || edit.start + edit.deleteCount > codePointCount(doc)) {
      throw new Error(
        `edit ${JSON.stringify(edit)} is outside the document ${JSON.stringify(doc)}`,
      );
    }
    edits.push(edit);
    doc = applyEdit(doc, edit);
  });
  let shown = initial;
  const showDocument = () => {
    if (doc === shown) return;
    shown = doc;
    binding.documentChanged(control, doc, hasFocus);
  };
  return {
    control,
    edits,
    binding,
    get doc() {
      return doc;
    },
    /** The user types (or pastes) over the selection. */
    type(text: string) {
      control.replaceSelection(text);
      binding.input(control);
      showDocument();
    },
    backspace() {
      control.deleteBackward();
      binding.input(control);
      showDocument();
    },
    /** Someone else edits the document. */
    remote(edit: TextEdit) {
      doc = applyEdit(doc, edit);
      showDocument();
    },
    compositionStart() {
      binding.compositionStart();
    },
    /** An input method changes the text while composing. */
    compose(text: string) {
      control.replaceSelection(text);
      binding.input(control);
    },
    compositionEnd() {
      binding.compositionEnd(control, hasFocus);
      showDocument();
    },
  };
}

describe('rebaseEdit', () => {
  it('leaves an edit in front of the other change alone', () => {
    const edit = { start: 0, deleteCount: 2, insert: 'x' };
    expect(rebaseEdit(edit, { start: 5, deleteCount: 0, insert: 'abc' })).toEqual(edit);
  });

  it('leaves an edit that ends where the other change begins alone', () => {
    const edit = { start: 0, deleteCount: 2, insert: 'x' };
    expect(rebaseEdit(edit, { start: 2, deleteCount: 0, insert: 'abc' })).toEqual(edit);
  });

  it('puts an edit before an insertion at the same index', () => {
    const edit = { start: 3, deleteCount: 0, insert: 'x' };
    expect(rebaseEdit(edit, { start: 3, deleteCount: 0, insert: 'abc' })).toEqual(edit);
  });

  it('moves an edit behind the other change by the size of that change', () => {
    expect(
      rebaseEdit(
        { start: 6, deleteCount: 1, insert: 'x' },
        { start: 2, deleteCount: 1, insert: 'abc' },
      ),
    ).toEqual({ start: 8, deleteCount: 1, insert: 'x' });
    expect(
      rebaseEdit(
        { start: 6, deleteCount: 0, insert: 'x' },
        { start: 1, deleteCount: 3, insert: '' },
      ),
    ).toEqual({ start: 3, deleteCount: 0, insert: 'x' });
  });

  it('moves an edit that begins where the other change ends', () => {
    expect(
      rebaseEdit(
        { start: 3, deleteCount: 0, insert: 'x' },
        { start: 2, deleteCount: 1, insert: 'ab' },
      ),
    ).toEqual({ start: 4, deleteCount: 0, insert: 'x' });
  });

  it('counts what the other change inserted in code points', () => {
    expect(
      rebaseEdit(
        { start: 4, deleteCount: 0, insert: 'x' },
        { start: 0, deleteCount: 0, insert: '😀😀' },
      ),
    ).toEqual({ start: 6, deleteCount: 0, insert: 'x' });
  });

  it('keeps only the inserted text of an edit that overlaps the other change', () => {
    expect(
      rebaseEdit(
        { start: 4, deleteCount: 3, insert: 'Q' },
        { start: 5, deleteCount: 1, insert: 'zz' },
      ),
    ).toEqual({ start: 7, deleteCount: 0, insert: 'Q' });
  });

  describe('properties', () => {
    const letters = fc.array(fc.constantFrom('a', 'b', '😀'), { maxLength: 8 });
    const change = fc.record({
      at: fc.nat(20),
      erase: fc.nat(6),
      text: fc.array(fc.constantFrom('x', 'y', '😁'), { maxLength: 3 }).map((p) => p.join('')),
    });
    const within = (
      base: string,
      { at, erase, text }: { at: number; erase: number; text: string },
    ) => {
      const length = codePointCount(base);
      const start = at % (length + 1);
      return { start, deleteCount: Math.min(erase, length - start), insert: text };
    };

    it('always gives an edit that fits the changed text and keeps what was typed', () => {
      fc.assert(
        fc.property(letters, change, change, (parts, first, second) => {
          const base = parts.join('');
          const edit = within(base, first);
          const over = within(base, second);
          const changed = applyEdit(base, over);
          const rebased = rebaseEdit(edit, over);
          if (rebased.start < 0 || rebased.start + rebased.deleteCount > codePointCount(changed)) {
            return false;
          }
          return applyEdit(changed, rebased).includes(edit.insert);
        }),
        { numRuns: 1000 },
      );
    });

    it('gives the same text whichever of two separate edits is applied first', () => {
      fc.assert(
        fc.property(letters, change, change, (parts, first, second) => {
          const base = parts.join('');
          const a = within(base, first);
          const b = within(base, second);
          const tie = a.deleteCount === 0 && b.deleteCount === 0 && a.start === b.start;
          const separate = a.start + a.deleteCount <= b.start || b.start + b.deleteCount <= a.start;
          if (tie || !separate) return true;
          return (
            applyEdit(applyEdit(base, b), rebaseEdit(a, b)) ===
            applyEdit(applyEdit(base, a), rebaseEdit(b, a))
          );
        }),
        { numRuns: 1000 },
      );
    });
  });
});

describe('createTextBinding: the user edits', () => {
  it('reports typing as one edit', () => {
    const t = setup('hello');
    t.control.select(5, 5);
    t.type(' world');
    expect(t.edits).toEqual([{ start: 5, deleteCount: 0, insert: ' world' }]);
    expect(t.doc).toBe('hello world');
    expect(t.control.value).toBe('hello world');
  });

  it('reports a paste over a selection as one replacement', () => {
    const t = setup('one two three');
    t.control.select(4, 7);
    t.type('2');
    expect(t.edits).toEqual([{ start: 4, deleteCount: 3, insert: '2' }]);
    expect(t.doc).toBe('one 2 three');
    expect(t.control.selectionStart).toBe(5);
  });

  it('reports deleting a selection and pressing backspace', () => {
    const t = setup('abcdef');
    t.control.select(2, 4);
    t.backspace();
    t.backspace();
    expect(t.edits).toEqual([
      { start: 2, deleteCount: 2, insert: '' },
      { start: 1, deleteCount: 1, insert: '' },
    ]);
    expect(t.doc).toBe('aef');
  });

  it('reports a change once, however often it hears of it', () => {
    const t = setup('abc');
    t.control.select(3, 3);
    t.type('d');
    t.binding.input(t.control);
    t.binding.input(t.control);
    expect(t.edits).toHaveLength(1);
  });

  it('reports a change once even before the document has caught up', () => {
    const t = setup('abc');
    t.control.select(3, 3);
    t.control.replaceSelection('d');
    t.binding.input(t.control);
    t.binding.input(t.control);
    expect(t.edits).toEqual([{ start: 3, deleteCount: 0, insert: 'd' }]);
  });

  it('counts the edit in code points', () => {
    const t = setup('a😀b');
    t.control.select(3, 3); // between the emoji and "b"
    t.type('X');
    expect(t.edits).toEqual([{ start: 2, deleteCount: 0, insert: 'X' }]);
    expect(t.doc).toBe('a😀Xb');
  });

  it('does not touch the caret when the document shows the user’s own edit', () => {
    const t = setup('abc');
    t.control.select(1, 1);
    t.type('X');
    expect(t.control.selectionStart).toBe(2);
    expect(t.control.selectionCalls).toBe(0);
  });
});

describe('createTextBinding: the document changes under the user', () => {
  it('moves the caret along when text is inserted before it', () => {
    const t = setup('hello world');
    t.control.select(11, 11);
    t.remote({ start: 0, deleteCount: 0, insert: '>> ' });
    expect(t.control.value).toBe('>> hello world');
    expect([t.control.selectionStart, t.control.selectionEnd]).toEqual([14, 14]);
  });

  it('keeps the caret still when text is inserted after it', () => {
    const t = setup('hello world');
    t.control.select(2, 2);
    t.remote({ start: 6, deleteCount: 0, insert: 'big ' });
    expect(t.control.value).toBe('hello big world');
    expect([t.control.selectionStart, t.control.selectionEnd]).toEqual([2, 2]);
  });

  it('keeps the caret in front of text inserted exactly at the caret', () => {
    const t = setup('ab');
    t.control.select(1, 1);
    t.remote({ start: 1, deleteCount: 0, insert: 'X' });
    expect(t.control.value).toBe('aXb');
    expect(t.control.selectionStart).toBe(1);
  });

  it('puts a caret inside replaced text at the end of the replacement', () => {
    const t = setup('hello world');
    t.control.select(8, 8);
    t.remote({ start: 6, deleteCount: 5, insert: 'there' });
    expect(t.control.value).toBe('hello there');
    expect(t.control.selectionStart).toBe(11);
  });

  it('keeps a selection’s ends and direction, and the scroll position', () => {
    const t = setup('hello world');
    t.control.select(6, 11, 'backward');
    t.control.scrollTop = 40;
    t.remote({ start: 0, deleteCount: 0, insert: 'XY' });
    expect([t.control.selectionStart, t.control.selectionEnd]).toEqual([8, 13]);
    expect(t.control.selectionDirection).toBe('backward');
    expect(t.control.scrollTop).toBe(40);
  });

  it('tracks the caret in UTF-16 units across astral characters', () => {
    const t = setup('a😀b');
    t.control.select(3, 3);
    t.type('X');
    t.remote({ start: 1, deleteCount: 0, insert: '--' });
    expect(t.control.value).toBe('a--😀Xb');
    expect(t.control.selectionStart).toBe(6);
  });

  it('only updates the text of a control that has no focus', () => {
    const t = setup('hello world', false);
    t.remote({ start: 6, deleteCount: 0, insert: 'big ' });
    expect(t.control.value).toBe('hello big world');
    expect(t.control.selectionCalls).toBe(0);
  });

  it('does not send a remote edit back as the user’s own', () => {
    const t = setup('ab');
    t.remote({ start: 0, deleteCount: 0, insert: 'XY' });
    t.binding.input(t.control);
    expect(t.edits).toEqual([]);
  });

  it('positions the user’s next edit in the text as it is now', () => {
    const t = setup('ab');
    t.remote({ start: 0, deleteCount: 0, insert: 'XY' });
    expect(t.control.selectionStart).toBe(4);
    t.type('Z');
    expect(t.edits).toEqual([{ start: 4, deleteCount: 0, insert: 'Z' }]);
    expect(t.doc).toBe('XYabZ');
  });
});

describe('createTextBinding: input method composition', () => {
  it('leaves the control alone while composing, whatever arrives', () => {
    const t = setup('hello');
    t.control.select(5, 5);
    t.compositionStart();
    t.compose('あ');
    t.remote({ start: 0, deleteCount: 0, insert: '>> ' });
    expect(t.control.value).toBe('helloあ');
    expect(t.control.selectionCalls).toBe(0);
    expect(t.edits).toEqual([]);
  });

  it('reports the composed text where it was typed, in the text as it is now', () => {
    const t = setup('hello');
    t.control.select(5, 5);
    t.compositionStart();
    t.compose('あ');
    t.remote({ start: 0, deleteCount: 0, insert: '>> ' });
    t.compositionEnd();
    expect(t.edits).toEqual([{ start: 8, deleteCount: 0, insert: 'あ' }]);
    expect(t.doc).toBe('>> helloあ');
    expect(t.control.value).toBe('>> helloあ');
    expect(t.control.selectionStart).toBe(9);
  });

  it('moves the composed text over every change that arrived meanwhile', () => {
    const t = setup('aaa bbb ccc');
    t.control.select(4, 7);
    t.compositionStart();
    t.compose('Q');
    t.remote({ start: 0, deleteCount: 0, insert: 'X' });
    t.remote({ start: 12, deleteCount: 0, insert: 'Y' });
    t.compositionEnd();
    expect(t.edits).toEqual([{ start: 5, deleteCount: 3, insert: 'Q' }]);
    expect(t.doc).toBe('Xaaa Q cccY');
    expect(t.control.value).toBe('Xaaa Q cccY');
  });

  it('keeps only the composed text when others changed the text it replaced', () => {
    const t = setup('hello world');
    t.control.select(6, 11);
    t.compositionStart();
    t.compose('世界');
    t.remote({ start: 6, deleteCount: 5, insert: 'earth' });
    t.compositionEnd();
    expect(t.edits).toEqual([{ start: 11, deleteCount: 0, insert: '世界' }]);
    expect(t.doc).toBe('hello earth世界');
    expect(t.control.value).toBe('hello earth世界');
    expect(t.control.selectionStart).toBe(13);
  });

  it('brings the control up to date when a composition ends without a change', () => {
    const t = setup('hello');
    t.control.select(5, 5);
    t.compositionStart();
    t.remote({ start: 0, deleteCount: 0, insert: '>> ' });
    expect(t.control.value).toBe('hello');
    t.compositionEnd();
    expect(t.edits).toEqual([]);
    expect(t.control.value).toBe('>> hello');
    expect(t.control.selectionStart).toBe(8);
  });

  it('reports nothing for a change that others already made, and still catches up', () => {
    const t = setup('abc');
    t.control.select(1, 2);
    t.compositionStart();
    t.compose('');
    t.remote({ start: 1, deleteCount: 1, insert: 'X' });
    t.compositionEnd();
    expect(t.edits).toEqual([]);
    expect(t.control.value).toBe('aXc');
    expect(t.doc).toBe('aXc');
  });

  it('does not report twice when an input event follows the end of the composition', () => {
    const t = setup('hello');
    t.control.select(5, 5);
    t.compositionStart();
    t.compose('あ');
    t.compositionEnd();
    t.binding.input(t.control);
    expect(t.edits).toHaveLength(1);
  });

  it('goes back to ordinary editing after a composition', () => {
    const t = setup('hello');
    t.control.select(5, 5);
    t.compositionStart();
    t.compose('あ');
    t.remote({ start: 0, deleteCount: 0, insert: '>> ' });
    t.compositionEnd();
    t.type('!');
    t.remote({ start: 0, deleteCount: 0, insert: '#' });
    t.type('?');
    expect(t.doc).toBe('#>> helloあ!?');
    expect(t.control.value).toBe(t.doc);
    expect(t.edits.at(-1)).toEqual({ start: 11, deleteCount: 0, insert: '?' });
  });
});

describe('createTextBinding: random sessions', () => {
  const words = fc
    .array(fc.constantFrom('a', 'b', ' ', 'é', '😀', 'あ'), { maxLength: 4 })
    .map((parts) => parts.join(''));
  const where = fc.record({ at: fc.nat(30), erase: fc.nat(5), text: words });
  const step = fc.oneof(
    fc.record({ kind: fc.constant('type' as const), edit: where }),
    fc.record({ kind: fc.constant('remote' as const), edit: where }),
    fc.record({
      kind: fc.constant('compose' as const),
      edit: where,
      remotes: fc.array(where, { maxLength: 3 }),
    }),
  );

  it('reports only valid edits, reports typing faithfully and ends up showing the document', () => {
    fc.assert(
      fc.property(words, fc.array(step, { maxLength: 12 }), (initial, steps) => {
        const t = setup(initial);
        for (const current of steps) {
          const { edit } = current;
          const text = t.doc;
          const length = codePointCount(text);
          const start = edit.at % (length + 1);
          const deleteCount = Math.min(edit.erase, length - start);
          const editsBefore = t.edits.length;
          if (current.kind === 'remote') {
            t.remote({ start, deleteCount, insert: edit.text });
            expect(t.edits).toHaveLength(editsBefore);
          } else {
            t.control.select(unitIndex(text, start), unitIndex(text, start + deleteCount));
            if (current.kind === 'type') {
              t.type(edit.text);
              expect(t.doc).toBe(applyEdit(text, { start, deleteCount, insert: edit.text }));
            } else {
              t.compositionStart();
              t.compose(edit.text);
              const composed = t.control.value;
              for (const remote of current.remotes) {
                const now = codePointCount(t.doc);
                const at = remote.at % (now + 1);
                t.remote({
                  start: at,
                  deleteCount: Math.min(remote.erase, now - at),
                  insert: remote.text,
                });
              }
              expect(t.control.value).toBe(composed);
              t.compositionEnd();
              // Only what differs from the old text is reported, so that is what must survive.
              for (const reported of t.edits.slice(editsBefore)) {
                expect(t.doc).toContain(reported.insert);
              }
            }
          }
          expect(t.control.value).toBe(t.doc);
          expect(t.control.selectionStart).toBeLessThanOrEqual(t.control.value.length);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
