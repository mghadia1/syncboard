export { type Operation, type ShapeId, isShapeId, parseOperation } from "./operation.js";
export { DIGITS, MAX_KEY_LENGTH, isOrderKey, keyAfter, keyBefore, keyBetween } from "./order.js";
export {
  type BoardState,
  type Entry,
  type NewShape,
  type Shape,
  type ShapeChange,
  type ShapeState,
  Replica,
  compareShapes,
  serializeState,
  wins,
} from "./replica.js";
export {
  COLORS,
  type Color,
  DEFAULTS,
  MAX_COORDINATE,
  MAX_POINTS,
  MAX_TEXT_LENGTH,
  PROP_NAMES,
  type PropName,
  REQUIRED_PROPS,
  SHAPE_KINDS,
  type ShapeKind,
  type ShapeProps,
  isPropName,
  isPropValue,
} from "./shape.js";
export {
  type Snapshot,
  type SnapshotEntry,
  chunkSnapshot,
  fromSnapshot,
  highestCounter,
  parseSnapshot,
  toOperations,
  toSnapshot,
} from "./snapshot.js";
export {
  MAX_COUNTER,
  type Stamp,
  compareStamps,
  isBoardId,
  isClientId,
  isStamp,
  newBoardId,
  newClientId,
} from "./stamp.js";
