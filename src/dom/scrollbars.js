import { resolvedElementFields, resolvedOverflowAxes } from "./style.js";
import { withScrollGeometry } from "./scroll-core.js";
import { sharedDomCore } from "../dom-wasm/core.js";
const overflowCodes = Object.freeze({ visible: 0, clip: 1, hidden: 2, auto: 3, scroll: 4 });
const sides = ["top", "right", "bottom", "left"];
export function guttersForFields(fields, box, core = sharedDomCore) {
  if (!box) return { top: 0, right: 0, bottom: 0, left: 0 };
  const overflow = resolvedOverflowAxes(fields);
  const width = { auto: 0, thin: 1, none: 2 }[fields.scrollbarWidth ?? "auto"];
  const gutter = { auto: 0, stable: 1, "stable both-edges": 2 }[fields.scrollbarGutter ?? "auto"];
  return Object.fromEntries(sides.map((side, index) => [side, core.status("scroll_gutter_fields", width, gutter, fields.direction === "rtl" ? 1 : 0, overflowCodes[overflow.x], overflowCodes[overflow.y], index)]));
}
function scrollbarColors(element) {
  const value = resolvedElementFields(element).scrollbarColor;
  return !value || value === "auto" ? { thumb: { r: 0.42, g: 0.45, b: 0.5, a: 0.9 }, track: { r: 0.1, g: 0.12, b: 0.16, a: 0.82 } } : { thumb: value[0], track: value[1] };
}
function describe(core, record, element, viewport, root) {
  try {
    const value = (slot) => core.status("scrollbar_value", record, slot);
    const rectangle = (slot) => ({ x: value(slot), y: value(slot + 1), width: value(slot + 2), height: value(slot + 3) });
    const axis = value(20);
    return { element, orientation: axis ? "vertical" : "horizontal", value: value(0), minimum: value(1), maximum: value(2), range: value(3), viewportLength: value(4), scrollLength: value(5), thickness: value(6), track: rectangle(7), thumb: rectangle(11), colors: scrollbarColors(element === viewport ? root : element), role: "scrollbar", ...(element === viewport ? {} : { clip: value(19) ? rectangle(15) : null }) };
  } finally { core.status("scrollbar_release", record); }
}
// Every scrollbar of a geometry snapshot (viewport first, then elements in
// flat-tree order), predicted for the pending scroll capture when given.
export function snapshotScrollbars(root, viewport, core, snapshot, capture = 0n) {
  const count = core.status("scrollbars_build", snapshot, capture, root._coreHandle);
  const descriptors = new Array(count);
  for (let index = 0; index < count; index++) {
    const record = core.handle("selector_result_handle", index);
    const node = core.status("scrollbar_node", record);
    descriptors[index] = describe(core, record, node ? core.wrapperFor(node) : viewport, viewport, root);
  }
  return descriptors;
}
// First-frame path: no presented snapshot yet, so one is built from boxes.
export function computeScrollbars(serialized, boxes, viewport = null) {
  const root = viewport?._surface?._root ?? serialized.indexOf.keys().next().value;
  if (!root) return [];
  return withScrollGeometry(root, viewport, boxes, serialized, (core, snapshot) => snapshotScrollbars(root, viewport, core, snapshot));
}
