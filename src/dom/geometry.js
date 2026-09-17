// Geometry snapshots are built in the core (geometry_build): it walks the
// flat tree, joins each node's resolved fields with the frame's box snapshot
// and the serialization's publication rows, and derives every coordinate.
// The host supplies only what it alone knows: text geometry (carets and
// glyphs), scrollbar descriptors, revisions and the viewport.
import { computeLayoutBoxes } from "./layout-getters.js";
import { boxSnapshotFor, encodeGeometryTail, releaseBoxSnapshot, textWireBlocks, writeGlyph } from "../dom-wasm/geometry-wire.js";

const measurement = Symbol.for("sandom.domCore.measurement");
const geometryFinalizer = new FinalizationRegistry(({ core, handle }) => {
  core.exports.geometry_release(handle);
});

function appendTextGlyphs(output, node, geometry) {
  for (const glyph of geometry.glyphs ?? []) {
    output.push({
      handle: node._coreHandle, recordIndex: -1,
      sourceStart: glyph.sourceStart, sourceEnd: glyph.sourceEnd,
      x: glyph.x, top: glyph.top, bottom: glyph.bottom, width: glyph.width,
      translationX: geometry.translationX ?? 0,
      translationY: geometry.translationY ?? 0,
    });
  }
}

// The revisions a snapshot is stamped with. Callers on a frame pass the
// frame's; a standalone query reads the current ones.
export function currentGeometryRevisions(document, revision = 0) {
  const core = document._domCore;
  const style = core.status("document_style_generation", document._coreHandle) >>> 0;
  return { document: style, style, resource: core.status("resource_revision") >>> 0, viewport: revision, scene: revision, presentation: revision };
}

export function buildGeometry({ root, boxes, publication, viewport, viewportIndex, revision = 0, scrollbars = [], textGeometryByNode = new Map(), textGeometryByElement = new Map(), presented = false, sourceRevisions }) {
  const document = root.ownerDocument;
  const core = document._domCore;
  const revisions = sourceRevisions ? { ...sourceRevisions, presentation: revision } : null;
  const textBlocks = [];
  const text = textGeometryByElement.size === 0
    ? textGeometryByNode
    : new Map([...textGeometryByNode, ...textGeometryByElement]);
  for (const [node, geometry] of text) {
    textBlocks.push({
      blocks: textWireBlocks(node, geometry),
      translationX: geometry.translationX ?? 0,
      translationY: geometry.translationY ?? 0,
    });
  }
  const tail = encodeGeometryTail({ scrollbars, textBlocks });
  const snapshot = boxSnapshotFor(boxes, core);
  const styleSystem = document._styleSystem;
  let handle;
  try {
    // Native resolution can raise font-family requests. The host answers
    // them (bumping the style generation) and builds again, so a live
    // snapshot's revisions are current when its consumers query it - the
    // same loop the host resolver ran before it stamped revisions.
    for (let attempt = 0;; attempt++) {
      handle = buildOnce();
      if (!styleSystem || attempt > 8 || core.fontFamilyRequests().length === 0) break;
      core.status("geometry_release", handle);
      styleSystem.answerFontFamilyRequests();
    }
  } finally {
    snapshot.release();
  }
  function buildOnce() {
    // One transient block: the arena can move on a second allocation.
    const pointer = core.status("abi_allocate", 48 + tail.byteLength);
    const bytes = core.refreshBytes();
    const revisionView = new DataView(bytes.buffer, pointer, 48);
    if (revisions) {
      for (const [index, name] of ["document", "style", "resource", "viewport", "scene", "presentation"].entries()) {
        revisionView.setBigUint64(index * 8, BigInt(revisions[name] ?? 0), true);
      }
    }
    bytes.set(tail, pointer + 48);
    // The document element with a live surface is the viewport's client.
    const viewportClient = document.documentElement === root && Boolean(root._renderSurface);
    return core.status("geometry_build", document._coreHandle, publication ?? 0, root._coreHandle, snapshot.handle,
      viewport.width, viewport.height, viewport.deviceScale ?? 1, presented ? 1 : 0, viewportClient ? 1 : 0,
      viewportIndex ?? -1, revisions ? pointer : 0, BigInt(revision), pointer + 48, tail.byteLength);
  }
  const collector = globalThis[measurement];
  if (typeof collector?.record === "function") collector.record({ category: "geometry", operation: "geometry_build", direction: "host-to-core", bytes: tail.byteLength, allocations: 1, allocationBytes: tail.byteLength });
  const result = { core, handle, release() {
    if (this.handle === 0n) return;
    core.status("geometry_release", this.handle);
    this.handle = 0n;
    geometryFinalizer.unregister(this);
  } };
  geometryFinalizer.register(result, { core, handle }, result);
  return result;
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
    geometry = buildGeometry(layout);
    core.status("geometry_live_ack", request, token, geometry.handle);
    return callback(geometry);
  } finally {
    // A synchronous getter's publication, box snapshot and geometry are
    // this call's alone: release them here, not at collection (a getter
    // per frame on a text page held megabytes per call until the next GC).
    geometry?.release();
    if (layout !== null && !layout.ownedBySurface) {
      layout.serialized.release();
      core.releaseSceneResources(layout.serialized.nodes);
      releaseBoxSnapshot(layout.boxes);
    }
    core.status("geometry_live_abort", request);
  }
}

// A node's untransformed border box in the snapshot, or null when the
// snapshot has no record for it (a node with no box or outside the tree).
export function geometryBox(core, handle, node) {
  if (core.status("geometry_index", handle, node) < 0) return null;
  const values = [0, 1, 2, 3].map((field) => core.status("geometry_value", handle, node, field));
  if (!(values[2] > 0 || values[3] > 0)) return null;
  return { x: values[0], y: values[1], w: values[2], h: values[3] };
}

export function geometryRect(core, handle, node) {
  const values = [28, 29, 30, 31].map((field) => core.status("geometry_value", handle, node, field));
  return { x: values[0], y: values[1], width: values[2], height: values[3], left: values[0], top: values[1], right: values[0] + values[2], bottom: values[1] + values[3] };
}

const noSelectionRectangles = Object.freeze([]);

function writeSelectionSpan(view, offset, span) {
  view.setBigUint64(offset, span.node._coreHandle, true);
  view.setFloat64(offset + 8, span.start, true);
  view.setFloat64(offset + 16, span.end, true);
  view.setFloat64(offset + 24, span.deltaX ?? 0, true);
  view.setFloat64(offset + 32, span.deltaY ?? 0, true);
}

function readSelectionRectangles(core, count) {
  if (count === 0) return noSelectionRectangles;
  const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), count * 32);
  const rectangles = [];
  for (let index = 0; index < count; index++) {
    const offset = index * 32;
    rectangles.push(Object.freeze({
      x: view.getFloat64(offset, true),
      y: view.getFloat64(offset + 8, true),
      width: view.getFloat64(offset + 16, true),
      height: view.getFloat64(offset + 24, true),
    }));
  }
  return Object.freeze(rectangles);
}

export function selectionRectangles(snapshot, spans, {
  physical = false, deviceScale = snapshot?.viewport.deviceScale ?? 1,
} = {}) {
  if (!snapshot) return noSelectionRectangles;
  const core = snapshot.geometryCore;
  const pointer = core.status("abi_allocate", spans.length * 40);
  const view = new DataView(core.refreshBytes().buffer, pointer, spans.length * 40);
  for (let index = 0; index < spans.length; index++) {
    writeSelectionSpan(view, index * 40, spans[index]);
  }
  const count = core.status("geometry_selection_rects", snapshot.geometryHandle,
    pointer, spans.length, physical ? 1 : 0, deviceScale);
  return readSelectionRectangles(core, count);
}

export function caretRectangle(snapshot, node, position, {
  deltaX = 0, deltaY = 0, deviceScale = snapshot?.viewport.deviceScale ?? 1,
} = {}) {
  if (!snapshot) return null;
  const core = snapshot.geometryCore;
  const count = core.status("geometry_caret_rect", snapshot.geometryHandle,
    node._coreHandle, position, deltaX, deltaY, deviceScale);
  return count === 0 ? null : readSelectionRectangles(core, count)[0];
}

export function selectionRectanglesForText(node, textGeometry, start, end) {
  const core = node._domCore;
  if (!core.status("geometry_selection_nonempty", start, end)) {
    return noSelectionRectangles;
  }
  const glyphs = [];
  appendTextGlyphs(glyphs, node, textGeometry);
  const glyphBytes = glyphs.length * 80;
  const pointer = core.status("abi_allocate", glyphBytes + 40);
  const view = new DataView(core.refreshBytes().buffer, pointer, glyphBytes + 40);
  for (let index = 0; index < glyphs.length; index++) {
    writeGlyph(view, index * 80, glyphs[index]);
  }
  writeSelectionSpan(view, glyphBytes, { node, start, end });
  const count = core.status("geometry_selection_rects_from_glyphs",
    node.ownerDocument._coreHandle, pointer, glyphs.length,
    pointer + glyphBytes, 1, 0, 1);
  return readSelectionRectangles(core, count);
}

// A text node's glyph and caret geometry from the previous frame, valid
// for this frame's painted line rectangles, or null when it has to be
// rebuilt. The captured rectangles (`anchors`, one x/y/width/height
// quadruple per painted line) must still describe the same lines at the
// same sizes; a uniform move becomes the geometry's translation, measured
// from the capture so it never accumulates.
export function keptTextGeometryFor(previous, operations) {
  const anchors = previous.anchors;
  if (anchors === undefined || anchors.length !== operations.length * 4) {
    return null;
  }
  const deltaX = operations[0].logicalRectangle.x - anchors[0];
  const deltaY = operations[0].logicalRectangle.y - anchors[1];
  for (let index = 0; index < operations.length; index++) {
    const rectangle = operations[index].logicalRectangle;
    if (
      rectangle.x - anchors[index * 4] !== deltaX ||
      rectangle.y - anchors[index * 4 + 1] !== deltaY ||
      rectangle.width !== anchors[index * 4 + 2] ||
      rectangle.height !== anchors[index * 4 + 3]
    ) {
      return null;
    }
  }
  if (
    deltaX === 0 && deltaY === 0 && (previous.translationX ?? 0) === 0 &&
    (previous.translationY ?? 0) === 0
  ) {
    return previous;
  }
  return Object.freeze({
    ...previous,
    translationX: deltaX,
    translationY: deltaY,
  });
}

export function uniqueCaretStops(node, stops) {
  const core = node._domCore;
  const pointer = core.status("abi_allocate", stops.length * 24);
  const view = new DataView(core.refreshBytes().buffer, pointer, stops.length * 24);
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index];
    view.setFloat64(index * 24, stop.sourceOffset, true);
    view.setFloat64(index * 24 + 8, stop.x, true);
    view.setFloat64(index * 24 + 16, stop.top, true);
  }
  const count = core.status("geometry_unique_carets", node._coreHandle, pointer, stops.length);
  const ordinals = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), count * 4);
  const result = [];
  for (let index = 0; index < count; index++) {
    result.push(stops[ordinals.getUint32(index * 4, true)]);
  }
  return result;
}
