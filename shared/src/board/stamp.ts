/**
 * When an edit was made, in a form every replica orders the same way.
 *
 * `counter` is a Lamport clock: each replica counts its own edits, and
 * jumps past the counter of every edit it receives. So an edit made after
 * seeing another always has a higher counter, and wins. Two edits made
 * without seeing each other (concurrently) are ordered by `client`, which
 * is arbitrary but the same everywhere.
 */
export type Stamp = { readonly counter: number; readonly client: string };

/**
 * Negative, zero or positive, like a sort comparator. Strings compare by
 * UTF-16 code units (`<`), never `localeCompare`, whose answer depends on
 * the locale of the machine running it: two replicas must never disagree.
 */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.counter !== b.counter) {
    return a.counter < b.counter ? -1 : 1;
  }
  if (a.client !== b.client) {
    return a.client < b.client ? -1 : 1;
  }
  return 0;
}

// Web Crypto, present in browsers and in Node; `shared` is compiled with
// neither's types, so this module declares the one function it uses.
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

const CLIENT_ID = /^[0-9A-Za-z_-]{1,64}$/;

export function isClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID.test(value);
}

export function isStamp(value: unknown): value is Stamp {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { counter, client } = value as Record<string, unknown>;
  return (
    typeof counter === "number" &&
    Number.isSafeInteger(counter) &&
    counter > 0 &&
    isClientId(client)
  );
}

/**
 * A new replica id: 64 random bits as 16 hex digits. A page gets a fresh
 * one every time it loads, so a replica that lost its clock (a reload)
 * can never repeat a stamp it used before. `crypto.getRandomValues`, not
 * `randomUUID`, because browsers offer `randomUUID` only on HTTPS and
 * localhost, and a board on a LAN address is plain HTTP.
 */
export function newClientId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
