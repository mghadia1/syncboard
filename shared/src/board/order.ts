/**
 * Stacking order by fractional index: each shape holds a key, and shapes are
 * drawn in key order. There is always room for a new key between two
 * others, so putting a shape between two neighbours changes only that
 * shape: no renumbering, nothing for concurrent edits to fight over.
 *
 * Keys are strings of base-62 digits compared as plain strings; they never
 * end in the zero digit, so there is also always room before a key. Two
 * replicas can produce the same key concurrently (both putting a shape on
 * top); the board breaks that tie by shape id.
 *
 * The midpoint algorithm is the one popularized by Figma and David
 * Greenspan's "fractional-indexing", without its integer-part prefix.
 */

// In ASCII order, so string comparison is digit comparison.
export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Longer keys are refused: a sign of abuse, not of a real board. */
export const MAX_KEY_LENGTH = 1024;

const KEY = new RegExp(`^[${DIGITS}]*[${DIGITS.slice(1)}]$`);

export function isOrderKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_KEY_LENGTH && KEY.test(value);
}

function digitAt(text: string, index: number): number {
  const char = text[index];
  return char === undefined ? -1 : DIGITS.indexOf(char);
}

function digit(value: number): string {
  const char = DIGITS[value];
  if (char === undefined) {
    throw new RangeError(`no digit ${String(value)}`);
  }
  return char;
}

/** A key strictly between a ("" = the start) and b (null = the end). */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Skip the common prefix, reading a missing digit of `a` as zero.
    let n = 0;
    while (n < b.length && (a[n] ?? DIGITS[0]) === b[n]) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
  }
  const low = a.length > 0 ? digitAt(a, 0) : 0;
  const high = b !== null ? digitAt(b, 0) : DIGITS.length;
  if (high - low > 1) {
    return digit(Math.round((low + high) / 2));
  }
  // The first digits are adjacent.
  if (b !== null && b.length > 1) {
    return b.slice(0, 1);
  }
  return digit(low) + midpoint(a.slice(1), null);
}

function checked(key: string): string {
  if (key.length > MAX_KEY_LENGTH) {
    // Unreachable in normal use; rebalancing the keys is not built, and
    // an operation with a longer key would be refused by every other replica.
    throw new RangeError(`order keys would exceed ${String(MAX_KEY_LENGTH)} characters`);
  }
  return key;
}

/**
 * A key strictly between `before` and `after`; null for either means the
 * start or the end. With both null, the first key of an empty board.
 */
export function keyBetween(before: string | null, after: string | null): string {
  for (const key of [before, after]) {
    if (key !== null && !isOrderKey(key)) {
      throw new RangeError(`not an order key: ${JSON.stringify(key)}`);
    }
  }
  if (before !== null && after !== null && before >= after) {
    throw new RangeError(`${before} is not before ${after}`);
  }
  return checked(midpoint(before ?? "", after));
}

/**
 * A key above `top`, for a shape put on top of everything: the last digit
 * goes up by one, or a digit is added. Adding shapes on top is the common
 * case, and this grows keys by one character every 61 additions: after
 * 1,000, a key is 17 characters long, where repeated midpoints make it 201.
 */
export function keyAfter(top: string): string {
  if (!isOrderKey(top)) {
    throw new RangeError(`not an order key: ${JSON.stringify(top)}`);
  }
  const last = digitAt(top, top.length - 1);
  if (last < DIGITS.length - 1) {
    return checked(top.slice(0, -1) + digit(last + 1));
  }
  return checked(top + digit(1));
}

/**
 * A key below `bottom`, for a shape sent to the back: the mirror image of
 * keyAfter. The last digit goes down by one; a last digit of 1 becomes 0
 * followed by the highest digit ("V1" -> "V0z"), since a key cannot end
 * in 0.
 */
export function keyBefore(bottom: string): string {
  if (!isOrderKey(bottom)) {
    throw new RangeError(`not an order key: ${JSON.stringify(bottom)}`);
  }
  const last = digitAt(bottom, bottom.length - 1);
  if (last > 1) {
    return checked(bottom.slice(0, -1) + digit(last - 1));
  }
  return checked(bottom.slice(0, -1) + digit(0) + digit(DIGITS.length - 1));
}
