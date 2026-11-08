/**
 * The difference between two versions of a text, found by trimming the common prefix and suffix.
 * What is left in the middle is one replacement: `deleteCount` characters at `start` become
 * `insert`. That is exactly the shape of `Board.editText`, so a textarea change turns into one
 * edit operation however much text was typed, pasted, cut or replaced.
 *
 * The edit is in Unicode code points, as the board counts them. The same change is also given in
 * UTF-16 units, which is how the DOM counts string offsets and selections.
 */
export interface TextDiff {
  /** Code points before the changed part. */
  readonly start: number;
  /** Code points of the old text that were replaced. */
  readonly deleteCount: number;
  /** What replaced them. */
  readonly insert: string;
  /** `start`, `deleteCount` and the length of `insert` in UTF-16 units. */
  readonly unitStart: number;
  readonly unitDeleteCount: number;
  readonly unitInsertLength: number;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Number of code points in `text`, counting a lone surrogate as one, like `[...text].length`. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const pairedLow =
      index > 0 &&
      isLowSurrogate(text.charCodeAt(index)) &&
      isHighSurrogate(text.charCodeAt(index - 1));
    if (!pairedLow) count += 1;
  }
  return count;
}

/** The change from `oldText` to `newText`, or `null` if they are equal. */
export function diffText(oldText: string, newText: string): TextDiff | null {
  if (oldText === newText) return null;
  const shortest = Math.min(oldText.length, newText.length);

  let prefix = 0;
  while (prefix < shortest && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix += 1;
  }
  // Never cut between the two halves of a surrogate pair.
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix -= 1;

  let suffix = 0;
  const longestSuffix = shortest - prefix;
  while (
    suffix < longestSuffix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix -= 1;

  const removed = oldText.slice(prefix, oldText.length - suffix);
  const insert = newText.slice(prefix, newText.length - suffix);
  return {
    start: countCodePoints(oldText.slice(0, prefix)),
    deleteCount: countCodePoints(removed),
    insert,
    unitStart: prefix,
    unitDeleteCount: removed.length,
    unitInsertLength: insert.length,
  };
}

/** Applies a diff, as the board would, to a text. */
export function applyDiff(text: string, diff: TextDiff): string {
  return (
    text.slice(0, diff.unitStart) + diff.insert + text.slice(diff.unitStart + diff.unitDeleteCount)
  );
}
