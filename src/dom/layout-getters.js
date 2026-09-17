// The layout-getter family (plans/dom/README.md):
// getBoundingClientRect,
// offsetWidth/offsetHeight/offsetTop/offsetLeft, clientWidth/
// clientHeight, scrollWidth/scrollHeight/scrollTop/scrollLeft. All
// answered by ONE mechanism — serializeToScene the live tree, run a
// real layout pass (layoutTreeBoxesSync, examples/render-scene.js), and
// read back the requested node's own computed box — reshaped per
// property into the units/reference-frame each one actually uses.
//
// SYNCHRONOUS by ruling — these must match a real browser's synchronous
// property getters exactly. Registry-backed fonts are either runtime faces
// whose bytes are already present or deterministic local assets that Deno can
// register synchronously. Resources that still require asynchronous work
// (browser font fetches, images, and SVG-path module initialization) throw
// clearly rather than blocking or returning guessed geometry.
//
// A second, previously-unresolved design question this module settles:
// running layout needs a VIEWPORT SIZE, and nothing in the mothership
// backend contract tracks one (no live createDomCapability call site exists
// yet to confirm a convention against, and the real browser backend's
// createBrowserDomBackend() takes no viewport argument either — it
// implicitly reads the real window). Resolved: a viewportW/viewportH
// pair, defaulting to 1280x720 (test/oracle/dom-oracle.js's own
// convention), threaded through from createSandomDOM's caller.

import { serializeToScene } from "./serialize.js";
import { layoutTreeBoxesSync } from "../scene-renderer.js";
import { scrollIntoViewCore } from "./scroll-core.js";
import { buildGeometry, currentGeometryRevisions, geometryRect, withLiveGeometry } from "./geometry.js";
import { hitTestSnapshot } from "./presented-frame.js";
import { createLayoutGeometryBindings } from "./dom-bindings.generated.js";

export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;

// Runs one shared layout pass over `node`'s whole tree and returns
// { boxes, indexOf, root } — every layout-getter below is a cheap
// re-shape of this. Exported for callers that need multiple properties
// off the SAME layout pass without re-running it (e.g. a batch read);
// most callers should reach for the single-property helpers below.
export function computeLayoutBoxes(
  node,
  {
    viewportW = DEFAULT_VIEWPORT_WIDTH,
    viewportH = DEFAULT_VIEWPORT_HEIGHT,
  } = {},
) {
  let root = node;
  while (root.parentElement) root = root.parentElement;
  const document = root.ownerDocument;
  const core = document._domCore;
  const runtime = document._sandomSceneRendererRuntime ?? null;
  const runtimeLayoutTreeBoxesSync =
    runtime?.layoutTreeBoxesSync ?? layoutTreeBoxesSync;
  const surface = root._renderSurface ?? null;
  const surfaceViewport = surface?.viewport;
  // The engine holds this surface's last frame of THIS tree: the
  // analytical layout inherits it and relayouts only what changed (and
  // hands the claim back, so the next frame keeps its incremental node
  // set). Without a live surface the engine holds whatever another caller
  // last wrote, and the layout must stand alone.
  const engineWriteOwner = surface?._persistentRenderer?.engineWriteToken ??
    null;
  const viewport = {
    width: surfaceViewport?.width ?? viewportW,
    height: surfaceViewport?.height ?? viewportH,
    deviceScale: surfaceViewport?.deviceScale ?? 1,
    _requestedLeft: surfaceViewport?._requestedLeft,
    _requestedTop: surfaceViewport?._requestedTop,
  };
  for (;;) {
    const style = core.status("document_style_generation", document._coreHandle) >>> 0;
    const resource = core.status("resource_revision") >>> 0;
    const serialized = serializeToScene(root, {
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      viewport: surfaceViewport ? viewport : undefined,
    });
    const revisions = currentGeometryRevisions(document);
    // Resolving a previously unseen style or resource can invalidate records
    // already serialized earlier in the traversal. Rebuild those records.
    if (revisions.document !== style || revisions.resource !== resource) {
      core.releaseSceneResources(serialized.nodes);
      continue;
    }
    const scene = {
      width: viewport.width,
      height: viewport.height,
      nodes: serialized.nodes,
      imageSources: serialized.imageSources,
    };
    const boxes = runtimeLayoutTreeBoxesSync(
      scene,
      engineWriteOwner === null ? {} : { engineWriteOwner },
    );
    // A cold font can invalidate both resource and computed-style generations.
    // Keep the original envelope; only fresh serialization and layout can
    // establish that all boxes use the newly resolved metrics.
    if (
      revisions.document !== (core.status("document_style_generation", document._coreHandle) >>> 0) ||
      revisions.resource !== (core.status("resource_revision") >>> 0)
    ) {
      core.releaseSceneResources(serialized.nodes);
      continue;
    }
    const layout = { boxes, indexOf: serialized.indexOf, root, viewport,
      viewportIndex: serialized.viewportIndex, publication: serialized.publication, serialized, ownedBySurface: false };
    // A live surface takes the serialization: its next frame reuses it
    // instead of serializing the same tree again (the "scrollTop =
    // scrollHeight" pattern paid two serializations per line appended).
    if (surfaceViewport !== undefined && root._renderSurface?._offerSyncLayout?.(layout, revisions.document, resource)) {
      layout.ownedBySurface = true;
    }
    return layout;
  }
}

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
function liveValue(node, options, field) {
  return withLiveGeometry(node, options, ({ core, handle }) =>
    core.status("geometry_value", handle, node._coreHandle, field));
}

export const {
  getBoundingClientRect, elementFromPoint, offsetWidth, offsetHeight,
  offsetTop, offsetLeft, clientTop, clientLeft, clientWidth, clientHeight,
  scrollTop, scrollLeft, scrollWidth, scrollHeight,
} = createLayoutGeometryBindings({ queryValue: liveValue, queryRect, queryHit });

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
// (plans/bugs/BUG-element-from-point-traps-on-live-document.md). With no
// surface, or before its first frame, the live layout IS the only geometry
// and still answers.
function queryHit(root, x, y, options) {
  const presented = root._renderSurface?.presentedFrame ?? null;
  if (presented !== null) return hitTestSnapshot(presented, x, y);
  return withLiveGeometry(root, options, ({ core, handle }) =>
    core.wrapperFor(core.status("geometry_hit_test", handle, x, y)));
}
