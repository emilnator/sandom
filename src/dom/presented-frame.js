// Accepted pixels and this immutable native handle are published together.
// The host owns wrapper identity/decoding; geometry.watpart owns targeting,
// transforms, clips, stacking, scroll facts and generation-safe retention.
// Host-side records are decoded on demand: hit testing, scrolling and
// anchoring query the native snapshot directly, so a frame that nobody
// inspects materializes no JavaScript records.
import { buildGeometry } from "./geometry.js";

const axis = (value, sign) => Object.freeze({ axis: value === 0 ? "x" : "y", startAtHigh: sign < 0 });
const overscroll = ["auto", "contain", "none"];

function decodeRecord(core, handle, index) {
  core.status("geometry_record_export", handle, index);
  const view = new DataView(core.memory.buffer, core.exports.abi_output_pointer(), 768);
  const value = (field) => view.getFloat64(32 + field * 8, true);
  const flags = view.getUint32(16, true);
  const nodeHandle = view.getBigUint64(0, true);
  const parentIndex = view.getInt32(8, true);
  const engineIndex = view.getInt32(12, true);
  const box = flags & 1 ? Object.freeze({ x: value(0), y: value(1), w: value(2), h: value(3), cx: value(4), cy: value(5), cw: value(6), ch: value(7), scrollLeft: value(8), scrollTop: value(9), scrollWidth: value(10), scrollHeight: value(11), stickyLeft: value(12), stickyTop: value(13) }) : null;
  const matrix = Object.freeze(Array.from({ length: 6 }, (_, i) => view.getFloat64(464 + i * 8, true)));
  const clip = view.getUint32(20, true) || view.getUint32(24, true) ? Object.freeze({ left: view.getFloat64(512, true), top: view.getFloat64(520, true), right: view.getFloat64(528, true), bottom: view.getFloat64(536, true) }) : null;
  const scroll = box && (value(20) || value(21) || (flags & 64)) ? Object.freeze({ userX: Boolean(value(20) || (flags & 64)), userY: Boolean(value(21) || (flags & 64)), blockAxis: axis(value(24), value(25)), inlineAxis: axis(value(26), value(27)), left: value(8), top: value(9), minLeft: value(16), maxLeft: value(17), minTop: value(18), maxTop: value(19), clientWidth: value(14), clientHeight: value(15) }) : null;
  const element = nodeHandle === 0n ? null : core.wrapperFor(nodeHandle);
  return { nodeHandle, element, parentIndex, engineIndex, viewport: Boolean(flags & 64), order: index, box, hitable: Boolean(flags & 2), zIndex: view.getFloat64(544, true), matrix, clip, overscrollX: overscroll[value(22)], overscrollY: overscroll[value(23)], scroll };
}

// Every record of the snapshot, decoded once and memoized on the frame.
function decodeAll(frame) {
  const { geometryCore: core, geometryHandle: handle } = frame;
  const allRecords = [];
  const records = [];
  const recordOf = new Map();
  let viewportScroll = null;
  const boxes = frame._inputBoxes.slice();
  for (let i = 0, count = core.status("geometry_count", handle); i < count; i++) {
    const record = decodeRecord(core, handle, i);
    record.parent = record.parentIndex < 0 ? null : allRecords[record.parentIndex];
    allRecords.push(Object.freeze(record));
    if (record.engineIndex >= 0) boxes[record.engineIndex] = record.box;
    if (record.viewport) viewportScroll = record.scroll;
    if (record.element?.tag === undefined) continue;
    records.push(record);
    recordOf.set(record.element, record);
  }
  return Object.freeze({ records: Object.freeze(records), recordOf, boxes: Object.freeze(boxes), viewportScroll });
}

export function buildInteractionSnapshot({ root, viewport, viewportIndex = 0, revision, boxes, publication, scrollbars, timeMilliseconds, textGeometryByElement = new Map(), textGeometryByNode = new Map(), sourceRevisions }) {
  const geometry = buildGeometry({ root, viewport, viewportIndex, revision, boxes, publication, scrollbars, textGeometryByElement, textGeometryByNode, sourceRevisions, presented: true });
  let decoded = null;
  const frame = {
    kind: "presented-interaction-frame", version: 1, revision, timeMilliseconds,
    viewport: Object.freeze({ width: viewport.width, height: viewport.height, deviceScale: viewport.deviceScale }),
    geometry, geometryCore: geometry.core, geometryHandle: geometry.handle,
    _inputBoxes: boxes,
    textGeometryByElement: new Map(textGeometryByElement), textGeometryByNode: new Map(textGeometryByNode),
    scrollbars: Object.freeze(scrollbars.map((scrollbar) => Object.freeze({ ...scrollbar, track: Object.freeze({ ...scrollbar.track }), clip: scrollbar.clip ? Object.freeze({ ...scrollbar.clip }) : null }))),
  };
  const lazy = (name) => ({ enumerable: true, get() { decoded ??= decodeAll(frame); return decoded[name]; } });
  Object.defineProperties(frame, { records: lazy("records"), recordOf: lazy("recordOf"), boxes: lazy("boxes"), viewportScroll: lazy("viewportScroll") });
  return Object.freeze(frame);
}

export function hitTestSnapshot(snapshot, x, y) {
  const core = snapshot.geometryCore;
  return core.wrapperFor(core.status("geometry_hit_test", snapshot.geometryHandle, x, y));
}

export function scrollbarAtPoint(snapshot, x, y) {
  const index = snapshot.geometryCore.status("geometry_scrollbar_hit", snapshot.geometryHandle, x, y);
  return index < 0 ? null : snapshot.scrollbars[index];
}
