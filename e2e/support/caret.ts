/**
 * Gives a note's textarea the focus and puts its caret at `fraction` of its text, from 0 (the
 * start) to 1 (the end), but never between the two halves of a character outside the basic plane
 * (an emoji is two units long). It runs in the page, so it can use nothing outside itself.
 */
export function placeCaretIn(area: HTMLTextAreaElement, fraction: number): void {
  const text = area.value;
  let index = Math.round(fraction * text.length);
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) index -= 1;
  area.focus({ preventScroll: true });
  area.setSelectionRange(index, index);
}
