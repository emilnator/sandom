import { resolvedElementFields } from "./style.js";
import { withScrollGeometry } from "./scroll-core.js";
import { scrollbarColors } from "./scrollbar-paint.js";
function describe(core, record, element, viewport, root, style) {
  try {
    const value = (slot) => core.status("scrollbar_value", record, slot);
    const rectangle = (slot) => ({ x: value(slot), y: value(slot + 1), width: value(slot + 2), height: value(slot + 3) });
    const axis = value(20);
    const isViewport = element === viewport;
    const owner = isViewport ? root : element;
    // A vertical bar sits on the left of a right-to-left element scroller;
    // the viewport's stays on the right (scroll.watpart $scrollbarBuild).
    const side = !axis ? "bottom" : !isViewport && resolvedElementFields(element).direction === "rtl" ? "left" : "right";
    return { element, orientation: axis ? "vertical" : "horizontal", value: value(0), minimum: value(1), maximum: value(2), range: value(3), viewportLength: value(4), scrollLength: value(5), thickness: value(6), track: rectangle(7), thumb: rectangle(11), side, colors: scrollbarColors(owner, isViewport, style), role: "scrollbar", ...(isViewport ? {} : { clip: value(19) ? rectangle(15) : null }) };
  } finally { core.status("scrollbar_release", record); }
}
// Every scrollbar of a geometry snapshot (viewport first, then elements in
// flat-tree order), predicted for the pending scroll capture when given.
// `style` ("overlay" or "classic") selects the palette.
export function snapshotScrollbars(root, viewport, core, snapshot, capture = 0n, style = "overlay") {
  const count = core.status("scrollbars_build", snapshot, capture, root._coreHandle);
  const descriptors = new Array(count);
  for (let index = 0; index < count; index++) {
    const record = core.handle("selector_result_handle", index);
    const node = core.status("scrollbar_node", record);
    descriptors[index] = describe(core, record, node ? core.wrapperFor(node) : viewport, viewport, root, style);
  }
  return descriptors;
}
// First-frame path: no presented snapshot yet, so one is built from boxes.
export function computeScrollbars(serialized, boxes, viewport = null, style = "overlay") {
  const root = viewport?._surface?._root ?? serialized.indexOf.keys().next().value;
  if (!root) return [];
  return withScrollGeometry(root, viewport, boxes, serialized, (core, snapshot) => snapshotScrollbars(root, viewport, core, snapshot, 0n, style));
}
