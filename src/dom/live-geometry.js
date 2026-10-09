// The live layout pass behind every synchronous geometry read (the
// layout-getter family, scroll reads and scrollIntoView, a computed style
// value that depends on layout): serializeToScene the live tree, run a real
// layout pass (layoutTreeBoxesSync, examples/render-scene.js), and build the
// geometry snapshot the read answers from.
//
// This module sits above geometry.js and below its readers
// (layout-getters.js, scroll-core.js, stylesheet.js). geometry.js and
// presented-frame.js therefore import nothing that waits on the default
// scene renderer's top-level await, and no import cycle passes through that
// await (test/module_graph_test.js).
//
// Running layout needs a VIEWPORT SIZE, and nothing in the mothership
// backend contract tracks one (no live createDomCapability call site exists
// yet to confirm a convention against, and the real browser backend's
// createBrowserDomBackend() takes no viewport argument either — it
// implicitly reads the real window). Resolved: a viewportW/viewportH
// pair, defaulting to 1280x720 (test/oracle/dom-oracle.js's own
// convention), threaded through from createSandomDOM's caller.

import { serializeToScene } from "./serialize.js";
import { layoutTreeBoxesSync } from "../scene-renderer.js";
import { buildGeometry, currentGeometryRevisions } from "./geometry.js";
import { releaseBoxSnapshot } from "../dom-wasm/geometry-wire.js";

export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;

// Runs one shared layout pass over `node`'s whole tree and returns
// { boxes, indexOf, root } — every layout-getter is a cheap
// re-shape of this. Exported for callers that need multiple properties
// off the SAME layout pass without re-running it (e.g. a batch read);
// most callers should reach for the single-property helpers in
// layout-getters.js.
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
    const scroll = core.status("scroll_revision") >>> 0;
    // An unchanged document answers from the layout the surface holds.
    if (surfaceViewport !== undefined) {
      const held = surface._peekSyncLayout?.(style, viewport, resource, scroll);
      if (held) return held;
    }
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
    if (surfaceViewport !== undefined && root._renderSurface?._offerSyncLayout?.(layout, revisions.document, resource, scroll)) {
      layout.ownedBySurface = true;
    }
    return layout;
  }
}

export function withLiveGeometry(node, options, callback) {
  const document = node.ownerDocument;
  const core = document._domCore;
  const request = core.status("geometry_live_begin", document._coreHandle);
  let geometry;
  let layout = null;
  try {
    const token = core.status("geometry_live_token", request);
    layout = computeLayoutBoxes(node, options);
    // A surface-held layout keeps its geometry for the next getter; the
    // surface releases both together.
    geometry = layout.ownedBySurface
      ? (layout.retainedGeometry ??= buildGeometry(layout))
      : buildGeometry(layout);
    core.status("geometry_live_ack", request, token, geometry.handle);
    return callback(geometry);
  } finally {
    // A synchronous getter's own publication, box snapshot and geometry are
    // this call's alone: release them here, not at collection (a getter
    // per frame on a text page held megabytes per call until the next GC).
    if (layout !== null && !layout.ownedBySurface) {
      geometry?.release();
      layout.serialized.release();
      core.releaseSceneResources(layout.serialized.nodes);
      releaseBoxSnapshot(layout.boxes);
    }
    core.status("geometry_live_abort", request);
  }
}
