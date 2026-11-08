export type Ordering = -1 | 0 | 1;

/** Compares numbers numerically and strings by UTF-16 code unit (never by locale). */
export function compareValues<T extends number | string>(a: T, b: T): Ordering {
  return a < b ? -1 : a > b ? 1 : 0;
}
