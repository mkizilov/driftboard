/**
 * The characters of `text` that are in `alphabet`, in order. When every person types with letters
 * of their own, this is what one person typed, as the merged text shows it: if it is not exactly
 * what they typed, a keystroke was lost, repeated or put out of order.
 */
export function only(text: string, alphabet: string): string {
  const allowed = new Set(Array.from(alphabet));
  return Array.from(text)
    .filter((character) => allowed.has(character))
    .join('');
}
