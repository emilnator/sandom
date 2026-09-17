// Generated from dom-interfaces.json; do not edit.
export const SceneBuildBoxSize = 72;
export function readSceneBuildBox(view, pointer) { return {
  kind: view.getUint8(pointer + 0, true),
  display: view.getUint8(pointer + 1, true),
  flags: view.getUint16(pointer + 2, true),
  owner: view.getInt32(pointer + 4, true),
  handle: view.getBigUint64(pointer + 8, true),
  context: view.getBigUint64(pointer + 16, true),
  childOffset: view.getUint32(pointer + 24, true),
  childCount: view.getUint32(pointer + 28, true),
  textPointer: view.getUint32(pointer + 32, true),
  textLength: view.getUint32(pointer + 36, true),
  whiteSpace: view.getUint8(pointer + 40, true),
  textTransform: view.getUint8(pointer + 41, true),
  host: view.getUint8(pointer + 42, true),
  font: view.getUint32(pointer + 44, true),
  letterSpacing: view.getFloat64(pointer + 48, true),
  stableId: view.getBigUint64(pointer + 56, true),
  sourceRevision: view.getBigUint64(pointer + 64, true),
}; }
export function writeSceneBuildBox(view, pointer, value) {
  view.setUint8(pointer + 0, value.kind ?? 0, true);
  view.setUint8(pointer + 1, value.display ?? 0, true);
  view.setUint16(pointer + 2, value.flags ?? 0, true);
  view.setInt32(pointer + 4, value.owner ?? 0, true);
  view.setBigUint64(pointer + 8, value.handle ?? 0n, true);
  view.setBigUint64(pointer + 16, value.context ?? 0n, true);
  view.setUint32(pointer + 24, value.childOffset ?? 0, true);
  view.setUint32(pointer + 28, value.childCount ?? 0, true);
  view.setUint32(pointer + 32, value.textPointer ?? 0, true);
  view.setUint32(pointer + 36, value.textLength ?? 0, true);
  view.setUint8(pointer + 40, value.whiteSpace ?? 0, true);
  view.setUint8(pointer + 41, value.textTransform ?? 0, true);
  view.setUint8(pointer + 42, value.host ?? 0, true);
  view.setUint32(pointer + 44, value.font ?? 0, true);
  view.setFloat64(pointer + 48, value.letterSpacing ?? 0, true);
  view.setBigUint64(pointer + 56, value.stableId ?? 0n, true);
  view.setBigUint64(pointer + 64, value.sourceRevision ?? 0n, true);
}
export const SceneBuildBoxFields = Object.freeze({"kind":0,"display":1,"flags":2,"owner":4,"handle":8,"context":16,"childOffset":24,"childCount":28,"textPointer":32,"textLength":36,"whiteSpace":40,"textTransform":41,"host":42,"font":44,"letterSpacing":48,"stableId":56,"sourceRevision":64});
export const EngineSvgRequestSize = 72;
export function readEngineSvgRequest(view, pointer) { return {
  path: view.getUint32(pointer + 0, true),
  length: view.getUint32(pointer + 4, true),
  identity: view.getBigUint64(pointer + 8, true),
  fillRule: view.getUint32(pointer + 16, true),
  strokePresent: view.getUint32(pointer + 20, true),
  width: view.getFloat64(pointer + 24, true),
  cap: view.getUint32(pointer + 32, true),
  join: view.getUint32(pointer + 36, true),
  miterLimit: view.getFloat64(pointer + 40, true),
  dashArray: view.getUint32(pointer + 48, true),
  dashCount: view.getUint32(pointer + 52, true),
  dashPhase: view.getFloat64(pointer + 56, true),
  resourceRevision: view.getUint32(pointer + 64, true),
}; }
export function writeEngineSvgRequest(view, pointer, value) {
  view.setUint32(pointer + 0, value.path ?? 0, true);
  view.setUint32(pointer + 4, value.length ?? 0, true);
  view.setBigUint64(pointer + 8, value.identity ?? 0n, true);
  view.setUint32(pointer + 16, value.fillRule ?? 0, true);
  view.setUint32(pointer + 20, value.strokePresent ?? 0, true);
  view.setFloat64(pointer + 24, value.width ?? 0, true);
  view.setUint32(pointer + 32, value.cap ?? 0, true);
  view.setUint32(pointer + 36, value.join ?? 0, true);
  view.setFloat64(pointer + 40, value.miterLimit ?? 0, true);
  view.setUint32(pointer + 48, value.dashArray ?? 0, true);
  view.setUint32(pointer + 52, value.dashCount ?? 0, true);
  view.setFloat64(pointer + 56, value.dashPhase ?? 0, true);
  view.setUint32(pointer + 64, value.resourceRevision ?? 0, true);
}
export const EngineSvgRequestFields = Object.freeze({"path":0,"length":4,"identity":8,"fillRule":16,"strokePresent":20,"width":24,"cap":32,"join":36,"miterLimit":40,"dashArray":48,"dashCount":52,"dashPhase":56,"resourceRevision":64});
export const CoreTransportBlockSize = 24;
export function readCoreTransportBlock(view, pointer) { return {
  poolKind: view.getUint32(pointer + 0, true),
  sourceBase: view.getUint32(pointer + 4, true),
  data: view.getUint32(pointer + 8, true),
  sourceLength: view.getUint32(pointer + 12, true),
  format: view.getUint32(pointer + 16, true),
  reserved: view.getUint32(pointer + 20, true),
}; }
export function writeCoreTransportBlock(view, pointer, value) {
  view.setUint32(pointer + 0, value.poolKind ?? 0, true);
  view.setUint32(pointer + 4, value.sourceBase ?? 0, true);
  view.setUint32(pointer + 8, value.data ?? 0, true);
  view.setUint32(pointer + 12, value.sourceLength ?? 0, true);
  view.setUint32(pointer + 16, value.format ?? 0, true);
  view.setUint32(pointer + 20, value.reserved ?? 0, true);
}
export const CoreTransportBlockFields = Object.freeze({"poolKind":0,"sourceBase":4,"data":8,"sourceLength":12,"format":16,"reserved":20});
export const CoreTransportCaptureSize = 40;
export function readCoreTransportCapture(view, pointer) { return {
  record: view.getUint32(pointer + 0, true),
  recordLength: view.getUint32(pointer + 4, true),
  blocks: view.getUint32(pointer + 8, true),
  blockCount: view.getUint32(pointer + 12, true),
  flags: view.getUint32(pointer + 16, true),
  boxFlags: view.getUint32(pointer + 20, true),
  stableId: view.getBigUint64(pointer + 24, true),
  sourceRevision: view.getBigUint64(pointer + 32, true),
}; }
export function writeCoreTransportCapture(view, pointer, value) {
  view.setUint32(pointer + 0, value.record ?? 0, true);
  view.setUint32(pointer + 4, value.recordLength ?? 0, true);
  view.setUint32(pointer + 8, value.blocks ?? 0, true);
  view.setUint32(pointer + 12, value.blockCount ?? 0, true);
  view.setUint32(pointer + 16, value.flags ?? 0, true);
  view.setUint32(pointer + 20, value.boxFlags ?? 0, true);
  view.setBigUint64(pointer + 24, value.stableId ?? 0n, true);
  view.setBigUint64(pointer + 32, value.sourceRevision ?? 0n, true);
}
export const CoreTransportCaptureFields = Object.freeze({"record":0,"recordLength":4,"blocks":8,"blockCount":12,"flags":16,"boxFlags":20,"stableId":24,"sourceRevision":32});
export const DirectSceneValueSize = 32;
export function readDirectSceneValue(view, pointer) { return {
  keyHash: view.getUint32(pointer + 0, true),
  kind: view.getUint32(pointer + 4, true),
  payload: view.getUint32(pointer + 8, true),
  count: view.getUint32(pointer + 12, true),
  number: view.getFloat64(pointer + 16, true),
  key: view.getUint32(pointer + 24, true),
  keyLength: view.getUint32(pointer + 28, true),
}; }
export function writeDirectSceneValue(view, pointer, value) {
  view.setUint32(pointer + 0, value.keyHash ?? 0, true);
  view.setUint32(pointer + 4, value.kind ?? 0, true);
  view.setUint32(pointer + 8, value.payload ?? 0, true);
  view.setUint32(pointer + 12, value.count ?? 0, true);
  view.setFloat64(pointer + 16, value.number ?? 0, true);
  view.setUint32(pointer + 24, value.key ?? 0, true);
  view.setUint32(pointer + 28, value.keyLength ?? 0, true);
}
export const DirectSceneValueFields = Object.freeze({"keyHash":0,"kind":4,"payload":8,"count":12,"number":16,"key":24,"keyLength":28});
export const EngineFrameResolutionSize = 96;
export function readEngineFrameResolution(view, pointer) { return {
  flags: view.getUint32(pointer + 0, true),
  fontIndex: view.getUint32(pointer + 4, true),
  imageIndex: view.getUint32(pointer + 8, true),
  pathIndex: view.getUint32(pointer + 12, true),
  strokePathIndex: view.getUint32(pointer + 16, true),
  backgroundImages: view.getUint32(pointer + 20, true),
  backgroundImageCount: view.getUint32(pointer + 24, true),
  reserved: view.getUint32(pointer + 28, true),
  fillBounds0: view.getFloat64(pointer + 32, true),
  fillBounds1: view.getFloat64(pointer + 40, true),
  fillBounds2: view.getFloat64(pointer + 48, true),
  fillBounds3: view.getFloat64(pointer + 56, true),
  strokeBounds0: view.getFloat64(pointer + 64, true),
  strokeBounds1: view.getFloat64(pointer + 72, true),
  strokeBounds2: view.getFloat64(pointer + 80, true),
  strokeBounds3: view.getFloat64(pointer + 88, true),
}; }
export function writeEngineFrameResolution(view, pointer, value) {
  view.setUint32(pointer + 0, value.flags ?? 0, true);
  view.setUint32(pointer + 4, value.fontIndex ?? 0, true);
  view.setUint32(pointer + 8, value.imageIndex ?? 0, true);
  view.setUint32(pointer + 12, value.pathIndex ?? 0, true);
  view.setUint32(pointer + 16, value.strokePathIndex ?? 0, true);
  view.setUint32(pointer + 20, value.backgroundImages ?? 0, true);
  view.setUint32(pointer + 24, value.backgroundImageCount ?? 0, true);
  view.setUint32(pointer + 28, value.reserved ?? 0, true);
  view.setFloat64(pointer + 32, value.fillBounds0 ?? 0, true);
  view.setFloat64(pointer + 40, value.fillBounds1 ?? 0, true);
  view.setFloat64(pointer + 48, value.fillBounds2 ?? 0, true);
  view.setFloat64(pointer + 56, value.fillBounds3 ?? 0, true);
  view.setFloat64(pointer + 64, value.strokeBounds0 ?? 0, true);
  view.setFloat64(pointer + 72, value.strokeBounds1 ?? 0, true);
  view.setFloat64(pointer + 80, value.strokeBounds2 ?? 0, true);
  view.setFloat64(pointer + 88, value.strokeBounds3 ?? 0, true);
}
export const EngineFrameResolutionFields = Object.freeze({"flags":0,"fontIndex":4,"imageIndex":8,"pathIndex":12,"strokePathIndex":16,"backgroundImages":20,"backgroundImageCount":24,"reserved":28,"fillBounds0":32,"fillBounds1":40,"fillBounds2":48,"fillBounds3":56,"strokeBounds0":64,"strokeBounds1":72,"strokeBounds2":80,"strokeBounds3":88});
export const EngineFrameFactSize = 16;
export function readEngineFrameFact(view, pointer) { return {
  flags: view.getUint32(pointer + 0, true),
  poolDigest: view.getUint32(pointer + 4, true),
  previousGeneration: view.getUint32(pointer + 8, true),
  reserved: view.getUint32(pointer + 12, true),
}; }
export function writeEngineFrameFact(view, pointer, value) {
  view.setUint32(pointer + 0, value.flags ?? 0, true);
  view.setUint32(pointer + 4, value.poolDigest ?? 0, true);
  view.setUint32(pointer + 8, value.previousGeneration ?? 0, true);
  view.setUint32(pointer + 12, value.reserved ?? 0, true);
}
export const EngineFrameFactFields = Object.freeze({"flags":0,"poolDigest":4,"previousGeneration":8,"reserved":12});
export const EngineFrameFinishRowSize = 8;
export function readEngineFrameFinishRow(view, pointer) { return {
  index: view.getUint32(pointer + 0, true),
  flags: view.getUint32(pointer + 4, true),
}; }
export function writeEngineFrameFinishRow(view, pointer, value) {
  view.setUint32(pointer + 0, value.index ?? 0, true);
  view.setUint32(pointer + 4, value.flags ?? 0, true);
}
export const EngineFrameFinishRowFields = Object.freeze({"index":0,"flags":4});
export const EngineFrameInputSize = 56;
export function readEngineFrameInput(view, pointer) { return {
  count: view.getUint32(pointer + 0, true),
  imageCount: view.getUint32(pointer + 4, true),
  gridCursor: view.getUint32(pointer + 8, true),
  backgroundCursor: view.getUint32(pointer + 12, true),
  stopCursor: view.getUint32(pointer + 16, true),
  shadowCursor: view.getUint32(pointer + 20, true),
  geometryCursor: view.getUint32(pointer + 24, true),
  publication: view.getUint32(pointer + 28, true),
  flags: view.getUint32(pointer + 32, true),
  sceneGeneration: view.getUint32(pointer + 36, true),
  filterCursor: view.getUint32(pointer + 40, true),
  clipCursor: view.getUint32(pointer + 44, true),
  maskCursor: view.getUint32(pointer + 48, true),
  borderImageCursor: view.getUint32(pointer + 52, true),
}; }
export function writeEngineFrameInput(view, pointer, value) {
  view.setUint32(pointer + 0, value.count ?? 0, true);
  view.setUint32(pointer + 4, value.imageCount ?? 0, true);
  view.setUint32(pointer + 8, value.gridCursor ?? 0, true);
  view.setUint32(pointer + 12, value.backgroundCursor ?? 0, true);
  view.setUint32(pointer + 16, value.stopCursor ?? 0, true);
  view.setUint32(pointer + 20, value.shadowCursor ?? 0, true);
  view.setUint32(pointer + 24, value.geometryCursor ?? 0, true);
  view.setUint32(pointer + 28, value.publication ?? 0, true);
  view.setUint32(pointer + 32, value.flags ?? 0, true);
  view.setUint32(pointer + 36, value.sceneGeneration ?? 0, true);
  view.setUint32(pointer + 40, value.filterCursor ?? 0, true);
  view.setUint32(pointer + 44, value.clipCursor ?? 0, true);
  view.setUint32(pointer + 48, value.maskCursor ?? 0, true);
  view.setUint32(pointer + 52, value.borderImageCursor ?? 0, true);
}
export const EngineFrameInputFields = Object.freeze({"count":0,"imageCount":4,"gridCursor":8,"backgroundCursor":12,"stopCursor":16,"shadowCursor":20,"geometryCursor":24,"publication":28,"flags":32,"sceneGeneration":36,"filterCursor":40,"clipCursor":44,"maskCursor":48,"borderImageCursor":52});
export const EngineFrameOutputSize = 88;
export function readEngineFrameOutput(view, pointer) { return {
  count: view.getUint32(pointer + 0, true),
  records: view.getUint32(pointer + 4, true),
  facts: view.getUint32(pointer + 8, true),
  reserved: view.getUint32(pointer + 12, true),
  gridPool: view.getUint32(pointer + 16, true),
  gridPoolLength: view.getUint32(pointer + 20, true),
  backgroundPool: view.getUint32(pointer + 24, true),
  backgroundPoolLength: view.getUint32(pointer + 28, true),
  stopPool: view.getUint32(pointer + 32, true),
  stopPoolLength: view.getUint32(pointer + 36, true),
  shadowPool: view.getUint32(pointer + 40, true),
  shadowPoolLength: view.getUint32(pointer + 44, true),
  geometryPool: view.getUint32(pointer + 48, true),
  geometryPoolLength: view.getUint32(pointer + 52, true),
  filterPool: view.getUint32(pointer + 56, true),
  filterPoolLength: view.getUint32(pointer + 60, true),
  clipPool: view.getUint32(pointer + 64, true),
  clipPoolLength: view.getUint32(pointer + 68, true),
  maskPool: view.getUint32(pointer + 72, true),
  maskPoolLength: view.getUint32(pointer + 76, true),
  borderImagePool: view.getUint32(pointer + 80, true),
  borderImagePoolLength: view.getUint32(pointer + 84, true),
}; }
export function writeEngineFrameOutput(view, pointer, value) {
  view.setUint32(pointer + 0, value.count ?? 0, true);
  view.setUint32(pointer + 4, value.records ?? 0, true);
  view.setUint32(pointer + 8, value.facts ?? 0, true);
  view.setUint32(pointer + 12, value.reserved ?? 0, true);
  view.setUint32(pointer + 16, value.gridPool ?? 0, true);
  view.setUint32(pointer + 20, value.gridPoolLength ?? 0, true);
  view.setUint32(pointer + 24, value.backgroundPool ?? 0, true);
  view.setUint32(pointer + 28, value.backgroundPoolLength ?? 0, true);
  view.setUint32(pointer + 32, value.stopPool ?? 0, true);
  view.setUint32(pointer + 36, value.stopPoolLength ?? 0, true);
  view.setUint32(pointer + 40, value.shadowPool ?? 0, true);
  view.setUint32(pointer + 44, value.shadowPoolLength ?? 0, true);
  view.setUint32(pointer + 48, value.geometryPool ?? 0, true);
  view.setUint32(pointer + 52, value.geometryPoolLength ?? 0, true);
  view.setUint32(pointer + 56, value.filterPool ?? 0, true);
  view.setUint32(pointer + 60, value.filterPoolLength ?? 0, true);
  view.setUint32(pointer + 64, value.clipPool ?? 0, true);
  view.setUint32(pointer + 68, value.clipPoolLength ?? 0, true);
  view.setUint32(pointer + 72, value.maskPool ?? 0, true);
  view.setUint32(pointer + 76, value.maskPoolLength ?? 0, true);
  view.setUint32(pointer + 80, value.borderImagePool ?? 0, true);
  view.setUint32(pointer + 84, value.borderImagePoolLength ?? 0, true);
}
export const EngineFrameOutputFields = Object.freeze({"count":0,"records":4,"facts":8,"reserved":12,"gridPool":16,"gridPoolLength":20,"backgroundPool":24,"backgroundPoolLength":28,"stopPool":32,"stopPoolLength":36,"shadowPool":40,"shadowPoolLength":44,"geometryPool":48,"geometryPoolLength":52,"filterPool":56,"filterPoolLength":60,"clipPool":64,"clipPoolLength":68,"maskPool":72,"maskPoolLength":76,"borderImagePool":80,"borderImagePoolLength":84});
export const coreTransportMaximumEntries = 2796202;
export const coreTransportMaximumBytes = 268435456;
export const coreTransportFlags = Object.freeze({"HAS_TEXT_SOURCE":1,"ELLIPSIS_ELIGIBLE":2,"BOX":4,"BACKGROUND":8,"BOX_SHADOW":16,"SVG":32,"MASK":64,"BORDER_IMAGE":128,"FUSED_GRADIENT":256,"TEXT_SHADOW":512,"FILTER":1024,"BACKDROP_FILTER":2048,"CLIP_PATH":4096});
export const coreTransportPoolKinds = Object.freeze({"GRID":13,"BACKGROUND":14,"GRADIENT_STOPS":3,"SHADOW":16,"SVG_GEOMETRY":15,"FILTER":17,"CLIP_PATH":18,"MASK":19,"BORDER_IMAGE":20});
export const coreTransportLegacyPoolByKind = Object.freeze({"3":3,"13":1,"14":2,"15":5,"16":4,"17":6,"18":7,"19":8,"20":9});
