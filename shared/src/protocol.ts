/**
 * The messages the server and the browser exchange over the WebSocket, as
 * JSON text frames. Both sides import these types, so a change to the
 * protocol that one side does not handle is a compile error, not a bug
 * found in production.
 *
 * Everything that arrives over the wire is `unknown` until it has been
 * checked: the parse functions below are the only way to get a typed
 * message, and they never trust the sender.
 */

/** Raised whenever a message's meaning changes; a mismatch is refused. */
export const PROTOCOL_VERSION = 1;

/** The largest frame either side accepts, in bytes. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export type ClientMessage = { type: "hello"; protocol: number };

export type ErrorCode = "bad_message" | "unsupported_protocol";

export type ServerMessage =
  | { type: "welcome"; protocol: number; version: string }
  | { type: "error"; code: ErrorCode; message: string };

/** WebSocket close codes this protocol uses (4000-4999 are for applications). */
export const CloseCode = {
  /** The standard "going away": the server is shutting down. */
  GoingAway: 1001,
  /** The standard "policy violation": a message that is not this protocol. */
  BadMessage: 1008,
  /** The client speaks a different protocol version. */
  UnsupportedProtocol: 4001,
} as const;

export type Parsed<T> = { ok: true; message: T } | { ok: false; error: string };

type Fields = Record<string, unknown>;

function decode(text: string): Fields | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "not valid JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not a JSON object";
  }
  return value as Fields;
}

function isProtocol(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "bad_message",
  "unsupported_protocol",
]);

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

/**
 * Checks a frame from a browser. Fields the protocol does not know are
 * ignored, so a newer client's additions do not break an older server.
 */
export function parseClientMessage(text: string): Parsed<ClientMessage> {
  const fields = decode(text);
  if (typeof fields === "string") {
    return { ok: false, error: fields };
  }
  switch (fields.type) {
    case "hello":
      if (!isProtocol(fields.protocol)) {
        return { ok: false, error: "hello needs a positive integer protocol" };
      }
      return { ok: true, message: { type: "hello", protocol: fields.protocol } };
    default:
      return { ok: false, error: `unknown message type ${JSON.stringify(fields.type)}` };
  }
}

/** Checks a frame from the server. */
export function parseServerMessage(text: string): Parsed<ServerMessage> {
  const fields = decode(text);
  if (typeof fields === "string") {
    return { ok: false, error: fields };
  }
  switch (fields.type) {
    case "welcome":
      if (!isProtocol(fields.protocol) || typeof fields.version !== "string") {
        return { ok: false, error: "welcome needs a protocol and a version" };
      }
      return {
        ok: true,
        message: { type: "welcome", protocol: fields.protocol, version: fields.version },
      };
    case "error":
      if (!isErrorCode(fields.code) || typeof fields.message !== "string") {
        return { ok: false, error: "error needs a known code and a message" };
      }
      return {
        ok: true,
        message: { type: "error", code: fields.code, message: fields.message },
      };
    default:
      return { ok: false, error: `unknown message type ${JSON.stringify(fields.type)}` };
  }
}
