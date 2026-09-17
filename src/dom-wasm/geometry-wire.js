// Primitive geometry wire encoding; no DOM implementation or renderer imports.
const overflowCodes = { visible: 0, clip: 1, hidden: 2, auto: 3, scroll: 4 };
const overscrollCodes = { auto: 0, contain: 1, none: 2 };
const boxNames = [
  "x",
  "y",
  "w",
  "h",
  "cx",
  "cy",
  "cw",
  "ch",
  "scrollLeft",
  "scrollTop",
  "scrollWidth",
  "scrollHeight",
  "stickyLeft",
  "stickyTop",
];
const sides = ["top", "right", "bottom", "left"];
const identity = [1, 0, 0, 1, 0, 0];

// A boxes array carries the native snapshot the core took of the engine
// rows it was read from (the frame's boxes are transient across host
// awaits; the snapshot is the geometry builder's box source). A boxes
// array without one (host-adjusted, or read from an engine in another
// memory) uploads its values in the same row shape.
export const BOX_SNAPSHOT = Symbol.for("sandom.geometry.boxSnapshot");
const boxSnapshotFinalizer = new FinalizationRegistry(({ core, handle }) => {
  core.exports.geometry_boxes_release(handle);
});

export function attachBoxSnapshot(boxes, core, deviceScale = 1) {
  const handle = core.status(
    "engine_boxes_snapshot",
    boxes.length,
    deviceScale,
  );
  const snapshot = { core, handle, count: boxes.length, references: 1 };
  boxSnapshotFinalizer.register(snapshot, { core, handle }, snapshot);
  boxes[BOX_SNAPSHOT] = snapshot;
  return boxes;
}

// Retained renderers and independently returned frames share one immutable
// geometry snapshot. The finalizer still releases once if callers rely on GC.
export function retainBoxSnapshot(boxes) {
  const attached = boxes?.[BOX_SNAPSHOT];
  if (attached?.handle) attached.references++;
  return boxes;
}

// Releases the native snapshot behind `boxes` now rather than at collection.
// A later boxSnapshotFor over the same array uploads its values instead.
export function releaseBoxSnapshot(boxes) {
  const attached = boxes?.[BOX_SNAPSHOT];
  if (!attached || attached.handle === 0n) return;
  if (--attached.references > 0) return;
  boxSnapshotFinalizer.unregister(attached);
  attached.core.exports.geometry_boxes_release(attached.handle);
  attached.handle = 0n;
}

// A snapshot handle for `boxes` in `core`: the attached one when it is
// this core's and covers the array, else an upload of the array's values.
// The returned release() is a no-op for an attached snapshot.
export function boxSnapshotFor(boxes, core) {
  const attached = boxes[BOX_SNAPSHOT];
  if (
    attached && attached.handle !== 0n && attached.core === core &&
    attached.count === boxes.length
  ) {
    return { handle: attached.handle, release() {} };
  }
  const pointer = core.status("abi_allocate", boxes.length * 112);
  const view = new DataView(
    core.refreshBytes().buffer,
    pointer,
    boxes.length * 112,
  );
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    for (let field = 0; field < 14; field++) {
      view.setFloat64(
        index * 112 + field * 8,
        box?.[boxNames[field]] ?? 0,
        true,
      );
    }
  }
  const handle = core.status("geometry_boxes_import", boxes.length, pointer);
  return {
    handle,
    release() {
      core.status("geometry_boxes_release", handle);
    },
  };
}

// The host tail of a geometry build: counts, then the wire scrollbar,
// caret and glyph blocks (a record index of -1 resolves in the core).
// A text node's caret and glyph wire blocks, encoded once per geometry
// object (they are frozen and reused across frames) with zero translation;
// the tail copies them and patches the translation words of a scrolled
// node. `carets` and `glyphs` still take individual records.
// Keyed by the frozen caret-stop array: a scroll-only frame wraps the same
// stops and glyphs in a new geometry object with a new translation.
const wireBlocks = new WeakMap();
export function textWireBlocks(node, geometry) {
  const stops = geometry.caretStops;
  const glyphs = geometry.glyphs ?? [];
  let blocks = wireBlocks.get(stops);
  if (
    blocks !== undefined && blocks.handle === node._coreHandle &&
    blocks.glyphSource === glyphs
  ) return blocks;
  const carets = new Uint8Array(stops.length * 64);
  const caretView = new DataView(carets.buffer);
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index];
    const offset = index * 64;
    caretView.setBigUint64(offset, node._coreHandle, true);
    caretView.setFloat64(offset + 8, stop.sourceOffset, true);
    caretView.setFloat64(offset + 16, stop.x, true);
    caretView.setFloat64(offset + 24, stop.top, true);
    caretView.setFloat64(offset + 32, stop.bottom, true);
    caretView.setInt32(offset + 40, -1, true);
  }
  const glyphBytes = new Uint8Array(glyphs.length * 80);
  const glyphView = new DataView(glyphBytes.buffer);
  for (let index = 0; index < glyphs.length; index++) {
    const glyph = glyphs[index];
    const offset = index * 80;
    glyphView.setBigUint64(offset, node._coreHandle, true);
    glyphView.setFloat64(offset + 8, glyph.sourceStart, true);
    glyphView.setFloat64(offset + 16, glyph.sourceEnd, true);
    glyphView.setFloat64(offset + 24, glyph.x, true);
    glyphView.setFloat64(offset + 32, glyph.top, true);
    glyphView.setFloat64(offset + 40, glyph.bottom, true);
    glyphView.setFloat64(offset + 48, glyph.width, true);
    glyphView.setInt32(offset + 72, -1, true);
  }
  blocks = {
    handle: node._coreHandle,
    glyphSource: glyphs,
    carets,
    glyphs: glyphBytes,
    caretCount: stops.length,
    glyphCount: glyphs.length,
  };
  wireBlocks.set(stops, blocks);
  return blocks;
}

function patchTranslation(bytes, base, stride, count, offsetInRecord, x, y) {
  if (x === 0 && y === 0) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  for (let index = 0; index < count; index++) {
    view.setFloat64(base + index * stride + offsetInRecord, x, true);
    view.setFloat64(base + index * stride + offsetInRecord + 8, y, true);
  }
}

// `textBlocks`: [{ blocks, translationX, translationY }] appended after the
// individual carets and glyphs.
export function encodeGeometryTail(
  { scrollbars = [], carets = [], glyphs = [], textBlocks = [] },
) {
  let blockCarets = 0;
  let blockGlyphs = 0;
  for (const { blocks } of textBlocks) {
    blockCarets += blocks.caretCount;
    blockGlyphs += blocks.glyphCount;
  }
  const caretCount = carets.length + blockCarets;
  const glyphCount = glyphs.length + blockGlyphs;
  const bytes = new Uint8Array(
    16 + scrollbars.length * 192 + caretCount * 64 + glyphCount * 80,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, scrollbars.length, true);
  view.setUint32(4, caretCount, true);
  view.setUint32(8, glyphCount, true);
  let offset = 16;
  for (const scrollbar of scrollbars) {
    for (const [index, name] of ["x", "y", "width", "height"].entries()) {
      view.setFloat64(offset + index * 8, scrollbar.track[name], true);
      view.setFloat64(
        offset + 32 + index * 8,
        scrollbar.clip?.[name] ?? 0,
        true,
      );
      view.setFloat64(
        offset + 144 + index * 8,
        scrollbar.thumb?.[name] ?? 0,
        true,
      );
    }
    view.setUint32(offset + 64, scrollbar.clip ? 1 : 0, true);
    view.setUint32(
      offset + 68,
      scrollbar.orientation === "vertical" ? 1 : 0,
      true,
    );
    view.setBigUint64(
      offset + 72,
      scrollbar.element?._coreHandle ?? scrollbar.targetHandle ?? 0n,
      true,
    );
    [
      "value",
      "minimum",
      "maximum",
      "range",
      "viewportLength",
      "scrollLength",
      "thickness",
    ].forEach((name, index) =>
      view.setFloat64(offset + 80 + index * 8, scrollbar[name] ?? 0, true)
    );
    offset += 192;
  }
  for (const caret of carets) {
    view.setBigUint64(offset, caret.handle, true);
    [caret.sourceOffset, caret.x, caret.top, caret.bottom].forEach((
      value,
      index,
    ) => view.setFloat64(offset + 8 + index * 8, value, true));
    view.setInt32(offset + 40, caret.recordIndex ?? -1, true);
    view.setFloat64(offset + 48, caret.translationX ?? 0, true);
    view.setFloat64(offset + 56, caret.translationY ?? 0, true);
    offset += 64;
  }
  for (const { blocks, translationX, translationY } of textBlocks) {
    bytes.set(blocks.carets, offset);
    patchTranslation(
      bytes,
      offset,
      64,
      blocks.caretCount,
      48,
      translationX,
      translationY,
    );
    offset += blocks.caretCount * 64;
  }
  for (const glyph of glyphs) {
    writeGlyph(view, offset, glyph);
    offset += 80;
  }
  for (const { blocks, translationX, translationY } of textBlocks) {
    bytes.set(blocks.glyphs, offset);
    patchTranslation(
      bytes,
      offset,
      80,
      blocks.glyphCount,
      56,
      translationX,
      translationY,
    );
    offset += blocks.glyphCount * 80;
  }
  return bytes;
}

export function encodeGeometryFacts(
  {
    records,
    scrollbars = [],
    carets = [],
    glyphs = [],
    viewport,
    revisions = {},
    presented = false,
  },
) {
  const bytes = new Uint8Array(
    160 + records.length * 768 + scrollbars.length * 192 + carets.length * 64 +
      glyphs.length * 80,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 768, true);
  view.setUint32(8, records.length, true);
  view.setUint32(12, scrollbars.length, true);
  view.setUint32(16, carets.length, true);
  view.setUint32(20, presented ? 1 : 0, true);
  for (
    const [index, name] of [
      "document",
      "style",
      "resource",
      "viewport",
      "scene",
      "presentation",
    ].entries()
  ) {
    view.setBigUint64(24 + index * 8, BigInt(revisions[name] ?? 0), true);
  }
  view.setFloat64(72, viewport.width, true);
  view.setFloat64(80, viewport.height, true);
  view.setFloat64(88, viewport.deviceScale ?? 1, true);
  view.setUint32(96, glyphs.length, true);
  let offset = 160;
  for (const record of records) {
    const fields = record.fields ?? {};
    const box = record.box;
    let flags = box ? 1 : 0;
    if (record.hitable !== false) flags |= 2;
    if ((fields.position ?? "static") !== "static") flags |= 4;
    if (fields.zIndex !== undefined) flags |= 8;
    if (fields.direction === "rtl") flags |= 32;
    if (record.viewport) flags |= 64;
    if (record.viewportClient) flags |= 128;
    if (fields.visibility === "hidden") flags |= 512;
    if (fields.pointerEvents === "none") flags |= 1024;
    view.setBigUint64(offset, record.handle ?? 0n, true);
    view.setInt32(offset + 8, record.parent ?? -1, true);
    view.setInt32(offset + 12, record.engineIndex ?? -1, true);
    view.setUint32(offset + 16, flags, true);
    view.setInt32(offset + 20, overflowCodes[fields.overflowX] ?? -1, true);
    view.setInt32(offset + 24, overflowCodes[fields.overflowY] ?? -1, true);
    view.setUint32(
      offset + 28,
      {
        "padding-box": 0,
        "content-box": 1,
        "border-box": 2,
      }[fields.overflowClipMargin?.visualBox ?? "padding-box"],
      true,
    );
    boxNames.forEach((name, index) =>
      view.setFloat64(offset + 32 + index * 8, box?.[name] ?? 0, true)
    );
    for (const [index, name] of sides.entries()) {
      view.setFloat64(
        offset + 320 + index * 8,
        fields.border?.[name] ?? 0,
        true,
      );
      view.setFloat64(
        offset + 352 + index * 8,
        fields.padding?.[name] ?? 0,
        true,
      );
      view.setFloat64(
        offset + 384 + index * 8,
        record.gutters?.[name] ?? 0,
        true,
      );
    }
    (record.matrix ?? identity).forEach((value, index) =>
      view.setFloat64(offset + 416 + index * 8, value, true)
    );
    view.setFloat64(offset + 544, Number(fields.zIndex ?? 0), true);
    view.setFloat64(offset + 552, fields.overflowClipMargin?.offset ?? 0, true);
    view.setUint32(
      offset + 560,
      {
        "horizontal-tb": 0,
        "vertical-rl": 1,
        "vertical-lr": 2,
      }[fields.writingMode ?? "horizontal-tb"],
      true,
    );
    view.setUint32(
      offset + 564,
      overscrollCodes[fields.overscrollBehaviorX ?? "auto"],
      true,
    );
    view.setUint32(
      offset + 568,
      overscrollCodes[fields.overscrollBehaviorY ?? "auto"],
      true,
    );
    view.setUint32(offset + 572, record.pseudo ?? 0, true);
    view.setBigUint64(offset + 576, record.ownerHandle ?? 0n, true);
    view.setUint32(offset + 584, record.kind ?? 0, true);
    view.setInt32(offset + 588, overflowCodes[fields.overflow] ?? -1, true);
    offset += 768;
  }
  for (const scrollbar of scrollbars) {
    for (const [index, name] of ["x", "y", "width", "height"].entries()) {
      view.setFloat64(offset + index * 8, scrollbar.track[name], true);
      view.setFloat64(
        offset + 32 + index * 8,
        scrollbar.clip?.[name] ?? 0,
        true,
      );
      view.setFloat64(
        offset + 144 + index * 8,
        scrollbar.thumb?.[name] ?? 0,
        true,
      );
    }
    view.setUint32(offset + 64, scrollbar.clip ? 1 : 0, true);
    view.setUint32(
      offset + 68,
      scrollbar.orientation === "vertical" ? 1 : 0,
      true,
    );
    view.setBigUint64(
      offset + 72,
      scrollbar.element?._coreHandle ?? scrollbar.targetHandle ?? 0n,
      true,
    );
    [
      "value",
      "minimum",
      "maximum",
      "range",
      "viewportLength",
      "scrollLength",
      "thickness",
    ].forEach((name, index) =>
      view.setFloat64(offset + 80 + index * 8, scrollbar[name] ?? 0, true)
    );
    offset += 192;
  }
  for (const caret of carets) {
    view.setBigUint64(offset, caret.handle, true);
    [caret.sourceOffset, caret.x, caret.top, caret.bottom].forEach((
      value,
      index,
    ) => view.setFloat64(offset + 8 + index * 8, value, true));
    view.setInt32(offset + 40, caret.recordIndex ?? -1, true);
    view.setFloat64(offset + 48, caret.translationX ?? 0, true);
    view.setFloat64(offset + 56, caret.translationY ?? 0, true);
    offset += 64;
  }
  for (const glyph of glyphs) {
    writeGlyph(view, offset, glyph);
    offset += 80;
  }
  return bytes;
}

export function writeGlyph(view, offset, glyph) {
  view.setBigUint64(offset, glyph.handle, true);
  for (
    const [index, name] of [
      "sourceStart",
      "sourceEnd",
      "x",
      "top",
      "bottom",
      "width",
    ].entries()
  ) {
    view.setFloat64(offset + 8 + index * 8, glyph[name], true);
  }
  view.setFloat64(offset + 56, glyph.translationX ?? 0, true);
  view.setFloat64(offset + 64, glyph.translationY ?? 0, true);
  view.setInt32(offset + 72, glyph.recordIndex ?? -1, true);
}
