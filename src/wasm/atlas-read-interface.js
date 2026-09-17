// Generated from atlas-read-interface.json; do not edit.
export const ABI_VERSION = 1;
export const KIND_GLYPH = 0;
export const KIND_PATH = 1;
export const FLAG_DIRTY = 1;
export const FLAG_HAS_OPSZ = 2;
export const ERROR_NONE = 0;
export const ERROR_CAPACITY = 1;
export const ERROR_SNAPSHOT = 2;
export const ERROR_ATLAS = 3;
export const ERROR_BATCH = 4;
export const ERROR_STATE = 5;
export const ERROR_INPUT = 6;
export const FIELD_NONE = 0;
export const FIELD_SNAPSHOT = 1;
export const FIELD_ATLAS = 2;
export const FIELD_BATCH = 3;
export const FIELD_MODE = 4;
export const FIELD_ALLOCATION = 5;
export const FIELD_REVISION = 6;
export const INFO_SIZE = 96;
export const INFO_VERSION_OFFSET = 0;
export const INFO_KIND_OFFSET = 4;
export const INFO_NATIVE_ATLAS_ID_OFFSET = 8;
export const INFO_FLAGS_OFFSET = 12;
export const INFO_NATIVE_REVISION_OFFSET = 16;
export const INFO_IMAGE_IDENTITY_OFFSET = 24;
export const INFO_WIDTH_OFFSET = 32;
export const INFO_HEIGHT_OFFSET = 36;
export const INFO_PIXELS_OFFSET_OFFSET = 40;
export const INFO_PIXELS_LENGTH_OFFSET = 44;
export const INFO_ENTRY_COUNT_OFFSET = 48;
export const INFO_ALIAS_COUNT_OFFSET = 52;
export const INFO_ALIASES_OFFSET_OFFSET = 56;
export const INFO_UNITS_PER_EM_OFFSET = 60;
export const INFO_OPTICAL_MIN_OFFSET = 64;
export const INFO_OPTICAL_DEFAULT_OFFSET = 72;
export const INFO_OPTICAL_MAX_OFFSET = 80;
export const INFO_RESERVED_ZERO_OFFSET = 88;
export const PATH_ALIAS_SIZE = 96;
export const PATH_ALIAS_PATH_INDEX_OFFSET = 0;
export const PATH_ALIAS_NATIVE_SLOT_OFFSET = 4;
export const PATH_ALIAS_PIXEL_WIDTH_OFFSET = 8;
export const PATH_ALIAS_PIXEL_HEIGHT_OFFSET = 12;
export const PATH_ALIAS_INFORMATION_OFFSET = 16;
export const PATH_ALIAS_FILL_RULE_OFFSET = 76;
export const PATH_ALIAS_STROKE_IDENTITY_OFFSET = 80;
export const PATH_ALIAS_CANONICAL_STROKE_OFFSET_OFFSET = 88;
export const PATH_ALIAS_CANONICAL_STROKE_BYTE_LENGTH_OFFSET = 92;
export const ERROR_SIZE = 16;
export const ERROR_CODE_OFFSET = 0;
export const ERROR_RECORD_INDEX_OFFSET = 4;
export const ERROR_FIELD_OFFSET = 8;
export const ERROR_RESERVED_ZERO_OFFSET = 12;
export function readInfo(view, pointer) {
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 96) throw new RangeError("Info out of bounds");
  return {
    version: view.getUint32(pointer + 0, true),
    kind: view.getUint32(pointer + 4, true),
    nativeAtlasId: view.getUint32(pointer + 8, true),
    flags: view.getUint32(pointer + 12, true),
    nativeRevision: view.getBigUint64(pointer + 16, true),
    imageIdentity: view.getBigUint64(pointer + 24, true),
    width: view.getUint32(pointer + 32, true),
    height: view.getUint32(pointer + 36, true),
    pixelsOffset: view.getUint32(pointer + 40, true),
    pixelsLength: view.getUint32(pointer + 44, true),
    entryCount: view.getUint32(pointer + 48, true),
    aliasCount: view.getUint32(pointer + 52, true),
    aliasesOffset: view.getUint32(pointer + 56, true),
    unitsPerEm: view.getUint32(pointer + 60, true),
    opticalMin: view.getFloat64(pointer + 64, true),
    opticalDefault: view.getFloat64(pointer + 72, true),
    opticalMax: view.getFloat64(pointer + 80, true),
    reservedZero: view.getBigUint64(pointer + 88, true),
  };
}
export function readPathAlias(view, pointer) {
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 96) throw new RangeError("PathAlias out of bounds");
  return {
    pathIndex: view.getUint32(pointer + 0, true),
    nativeSlot: view.getInt32(pointer + 4, true),
    pixelWidth: view.getUint32(pointer + 8, true),
    pixelHeight: view.getUint32(pointer + 12, true),
    information: [view.getFloat32(pointer + 16, true), view.getFloat32(pointer + 20, true), view.getFloat32(pointer + 24, true), view.getFloat32(pointer + 28, true), view.getFloat32(pointer + 32, true), view.getFloat32(pointer + 36, true), view.getFloat32(pointer + 40, true), view.getFloat32(pointer + 44, true), view.getFloat32(pointer + 48, true), view.getFloat32(pointer + 52, true), view.getFloat32(pointer + 56, true), view.getFloat32(pointer + 60, true), view.getFloat32(pointer + 64, true), view.getFloat32(pointer + 68, true), view.getFloat32(pointer + 72, true)],
    fillRule: view.getUint32(pointer + 76, true),
    strokeIdentity: view.getBigUint64(pointer + 80, true),
    canonicalStrokeOffset: view.getUint32(pointer + 88, true),
    canonicalStrokeByteLength: view.getUint32(pointer + 92, true),
  };
}
export function readError(view, pointer) {
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 16) throw new RangeError("Error out of bounds");
  return {
    code: view.getUint32(pointer + 0, true),
    recordIndex: view.getUint32(pointer + 4, true),
    field: view.getUint32(pointer + 8, true),
    reservedZero: view.getUint32(pointer + 12, true),
  };
}
