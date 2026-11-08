// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyEdit } from '../lib/test-support';
import type { TextEdit } from '../lib/text-binding';
import { cleanup, composition, flush, must, render, typeInto } from '../test-render';
import { NoteTextArea } from './NoteTextArea';

afterEach(cleanup);

/**
 * A note's text kept outside React, as the board keeps it: the textarea reports its edits here,
 * and the new text is passed back down. `remote` is an edit by someone else.
 */
function mount(initial: string, { focus = true } = {}) {
  let text = initial;
  const edits: TextEdit[] = [];
  const view = () => <NoteTextArea value={text} onEdit={onEdit} />;
  const onEdit = (edit: TextEdit) => {
    edits.push(edit);
    text = applyEdit(text, edit);
    screen.rerender(view());
  };
  const screen = render(view());
  const textarea = must(screen.container.querySelector('textarea'));
  if (focus) textarea.focus();
  return {
    textarea,
    edits,
    get text() {
      return text;
    },
    remote(edit: TextEdit) {
      text = applyEdit(text, edit);
      screen.rerender(view());
    },
  };
}

describe('NoteTextArea', () => {
  it('shows the note’s text in a labelled textarea', () => {
    const note = mount('hello');
    expect(note.textarea.value).toBe('hello');
    expect(note.textarea.getAttribute('aria-label')).toBe('Note text');
  });

  describe('reporting the focus', () => {
    it('says when it gets the focus and when it loses it', () => {
      const changes: boolean[] = [];
      const screen = render(
        <NoteTextArea
          value="hello"
          onEdit={() => undefined}
          onFocusChange={(focused) => {
            changes.push(focused);
          }}
        />,
      );
      const textarea = must(screen.container.querySelector('textarea'));
      flush(() => {
        textarea.focus();
      });
      flush(() => {
        textarea.blur();
      });
      expect(changes).toEqual([true, false]);
    });

    it('needs no one to listen', () => {
      const screen = render(<NoteTextArea value="hello" onEdit={() => undefined} />);
      const textarea = must(screen.container.querySelector('textarea'));
      flush(() => {
        textarea.focus();
        textarea.blur();
      });
      expect(textarea.value).toBe('hello');
    });
  });

  describe('diffing what the user changes', () => {
    it('reports typing as one edit at the caret', () => {
      const note = mount('hello');
      note.textarea.setSelectionRange(5, 5);
      typeInto(note.textarea, ' world');
      expect(note.edits).toEqual([{ start: 5, deleteCount: 0, insert: ' world' }]);
      expect(note.textarea.value).toBe('hello world');
    });

    it('reports a paste over a selection as one replacement', () => {
      const note = mount('one two three');
      note.textarea.setSelectionRange(4, 7);
      typeInto(note.textarea, '2');
      expect(note.edits).toEqual([{ start: 4, deleteCount: 3, insert: '2' }]);
      expect(note.text).toBe('one 2 three');
    });

    it('counts the edit in code points', () => {
      const note = mount('a😀b');
      note.textarea.setSelectionRange(3, 3);
      typeInto(note.textarea, 'X');
      expect(note.edits).toEqual([{ start: 2, deleteCount: 0, insert: 'X' }]);
      expect(note.text).toBe('a😀Xb');
    });

    it('leaves the caret where the user put it after its own edit comes back', () => {
      const note = mount('abc');
      note.textarea.setSelectionRange(1, 1);
      typeInto(note.textarea, 'X');
      expect(note.textarea.value).toBe('aXbc');
      expect(note.textarea.selectionStart).toBe(2);
      expect(note.textarea.selectionEnd).toBe(2);
    });
  });

  describe('keeping the caret when others edit', () => {
    it('moves the caret along when text is inserted before it', () => {
      const note = mount('hello world');
      note.textarea.setSelectionRange(8, 8);
      note.remote({ start: 0, deleteCount: 0, insert: '>> ' });
      expect(note.textarea.value).toBe('>> hello world');
      expect(note.textarea.selectionStart).toBe(11);
      expect(note.textarea.selectionEnd).toBe(11);
      expect(document.activeElement).toBe(note.textarea);
    });

    it('keeps the caret still when text is inserted after it', () => {
      const note = mount('hello world');
      note.textarea.setSelectionRange(2, 2);
      note.remote({ start: 6, deleteCount: 0, insert: 'big ' });
      expect(note.textarea.value).toBe('hello big world');
      expect(note.textarea.selectionStart).toBe(2);
    });

    it('keeps a selection and its direction', () => {
      const note = mount('hello world');
      note.textarea.setSelectionRange(6, 11, 'backward');
      note.remote({ start: 0, deleteCount: 0, insert: 'XY' });
      expect(note.textarea.selectionStart).toBe(8);
      expect(note.textarea.selectionEnd).toBe(13);
      expect(note.textarea.selectionDirection).toBe('backward');
    });

    it('does not send a remote edit back, and positions the next edit in the new text', () => {
      const note = mount('ab');
      note.textarea.setSelectionRange(2, 2);
      note.remote({ start: 0, deleteCount: 0, insert: 'XY' });
      expect(note.edits).toEqual([]);
      typeInto(note.textarea, 'Z');
      expect(note.edits).toEqual([{ start: 4, deleteCount: 0, insert: 'Z' }]);
      expect(note.text).toBe('XYabZ');
    });

    it('updates a textarea that has no focus without taking the focus', () => {
      const note = mount('hello', { focus: false });
      note.remote({ start: 5, deleteCount: 0, insert: '!' });
      expect(note.textarea.value).toBe('hello!');
      expect(document.activeElement).not.toBe(note.textarea);
    });
  });

  describe('input method composition', () => {
    it('leaves the textarea alone while composing, then reports the result in place', () => {
      const note = mount('hello');
      note.textarea.setSelectionRange(5, 5);
      composition(note.textarea, 'start');
      typeInto(note.textarea, 'あ');
      note.remote({ start: 0, deleteCount: 0, insert: '>> ' });
      expect(note.textarea.value).toBe('helloあ');
      expect(note.edits).toEqual([]);

      composition(note.textarea, 'end');
      expect(note.edits).toEqual([{ start: 8, deleteCount: 0, insert: 'あ' }]);
      expect(note.textarea.value).toBe('>> helloあ');
      expect(note.textarea.selectionStart).toBe(9);
    });

    it('catches up after a composition that changed nothing', () => {
      const note = mount('hello');
      composition(note.textarea, 'start');
      note.remote({ start: 0, deleteCount: 0, insert: '>> ' });
      expect(note.textarea.value).toBe('hello');
      composition(note.textarea, 'end');
      expect(note.edits).toEqual([]);
      expect(note.textarea.value).toBe('>> hello');
    });
  });

  it('keeps the caret in front of the first words someone else writes in an empty note', () => {
    const note = mount('');
    note.textarea.setSelectionRange(0, 0);
    note.remote({ start: 0, deleteCount: 0, insert: 'hello' });
    expect(note.textarea.value).toBe('hello');
    expect(note.textarea.selectionStart).toBe(0);
    expect(note.textarea.selectionEnd).toBe(0);
  });

  it('reports to the latest onEdit', () => {
    const first: TextEdit[] = [];
    const second: TextEdit[] = [];
    const screen = render(
      <NoteTextArea
        value="ab"
        onEdit={(edit) => {
          first.push(edit);
        }}
      />,
    );
    screen.rerender(
      <NoteTextArea
        value="ab"
        onEdit={(edit) => {
          second.push(edit);
        }}
      />,
    );
    const textarea = must(screen.container.querySelector('textarea'));
    textarea.setSelectionRange(2, 2);
    typeInto(textarea, 'c');
    expect(first).toEqual([]);
    expect(second).toEqual([{ start: 2, deleteCount: 0, insert: 'c' }]);
  });
});
