// The layout-getter family (plans/dom/README.md):
// getBoundingClientRect,
// offsetWidth/offsetHeight/offsetTop/offsetLeft, clientWidth/
// clientHeight, scrollWidth/scrollHeight/scrollTop/scrollLeft. All
// answered by ONE mechanism — the live layout pass (live-geometry.js):
// serializeToScene the live tree, run a real layout pass
// (layoutTreeBoxesSync, examples/render-scene.js), and read back the
// requested node's own computed box — reshaped per property into the
// units/reference-frame each one actually uses.
//
// SYNCHRONOUS by ruling — these must match a real browser's synchronous
// property getters exactly. Registry-backed fonts are either runtime faces
// whose bytes are already present or deterministic local assets that Deno can
// register synchronously. Resources that still require asynchronous work
// (browser font fetches, images, and SVG-path module initialization) throw
// clearly rather than blocking or returning guessed geometry.

import { elementScrollSource, scrollIntoViewCore } from "./scroll-core.js";
import { buildGeometry, geometryClientRects, geometryRect } from "./geometry.js";
import { DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH, withLiveGeometry } from "./live-geometry.js";
import { hitTestSnapshot } from "./presented-frame.js";
import { createLayoutGeometryBindings } from "./dom-bindings.generated.js";

// getBoundingClientRect: viewport-relative border-box, matching the
// browser backend's own plainified shape exactly (frontend-iris.js:91-95
// — a real DOMRect's getters are on the prototype, not own-enumerable,
// so it must be plainified before crossing any capability boundary;
// sandom's box is already a plain object, but the SAME flat shape is
// used here for drop-in parity).
function queryRect(node, options) {
  return withLiveGeometry(node, options, ({ core, handle }) =>
    geometryRect(core, handle, node._coreHandle));
}

// getClientRects: one viewport-relative rectangle per fragment of a box
// broken across columns or lines (a block box around a spanner, an inline
// box's line boxes), else the border box, each through its transforms.
function queryClientRects(node, options) {
  return withLiveGeometry(node, options, ({ core, handle }) =>
    geometryClientRects(core, handle, node._coreHandle));
}

// Reuses a layout that the caller already produced. Batch renderers must use
// this path instead of triggering one complete layout pass per element.
export function getBoundingClientRectFromLayout(node, layout) {
  let root = node;
  while (root.parentElement) root = root.parentElement;
  const geometry = buildGeometry({ ...layout, root,
    viewport: layout.viewport ?? root._renderSurface?.viewport ?? { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT, deviceScale: 1 } });
  try {
    return geometryRect(geometry.core, geometry.handle, node._coreHandle);
  } finally {
    geometry.release();
  }
}

// offsetWidth/offsetHeight: border-box dimensions (content + padding +
// border, no margin) — exactly the box buffer's own border-box fields.
// scrollLeft (8) and scrollTop (9) read the scroller the element's scroll
// position belongs to (elementScrollSource): the viewport's for the root
// element, whose overflow the viewport takes, and 0 for none.
function liveValue(node, options, field) {
  let target = node._coreHandle;
  if (field === 8 || field === 9) {
    const source = elementScrollSource(node);
    if (source === null) return 0;
    if (source !== node) target = source._coreHandle ?? 0n;
  }
  return withLiveGeometry(node, options, ({ core, handle }) =>
    core.status("geometry_value", handle, target, field));
}

export const {
  getBoundingClientRect, getClientRects, elementFromPoint, offsetWidth, offsetHeight,
  offsetTop, offsetLeft, clientTop, clientLeft, clientWidth, clientHeight,
  scrollTop, scrollLeft, scrollWidth, scrollHeight,
} = createLayoutGeometryBindings({ queryValue: liveValue, queryRect, queryClientRects, queryHit });

export function scrollIntoView(node, options = {}, layoutOptions) {
  return scrollIntoViewCore(node, options, layoutOptions);
}

// A surface-owned tree is hit-tested against the frame the host is looking
// at — the same geometry the pointer path targets
// (src/dom/input-controller.js's snapshotFor, design/interaction.md's
// ruling that input addresses the last PRESENTED frame). Answering
// "what is at this point?" from a fresh synchronous layout instead made
// elementFromPoint disagree with pointerDown about the same point, and
// paid a whole re-layout to do it — plus every layout-side capacity guard
// that layout can raise, which is how the call came to throw
// `RuntimeError: unreachable` on a live document
// (BUG-element-from-point-traps-on-live-document, resolved; see
// activity/reports/REPORT-2026-10-09-resolved-bug-records.md). With no
// surface, or before its first frame, the live layout IS the only geometry
// and still answers.
function queryHit(root, x, y, options) {
  const presented = root._renderSurface?.presentedFrame ?? null;
  if (presented !== null) return hitTestSnapshot(presented, x, y);
  return withLiveGeometry(root, options, ({ core, handle }) =>
    core.wrapperFor(core.status("geometry_hit_test", handle, x, y)));
}
