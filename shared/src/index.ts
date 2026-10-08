export {
  CloseCode,
  MAX_MESSAGE_BYTES,
  MAX_OPS_PER_MESSAGE,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
} from "./protocol.js";
export type { ClientMessage, ErrorCode, Parsed, Peer, ServerMessage } from "./protocol.js";
export { MAX_NAME_LENGTH, MAX_SELECTION, PERSON_COLORS, type Presence, parsePresence } from "./presence.js";
export * from "./board/index.js";
