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
const noFragments = Object.freeze([]);

// The box snapshot layout (geometry-build.watpart): a 24-byte header
// (magic, row count, fragment count, SVG path-reference rows, serial),
// rows of the fourteen box values, the classic scrollbar space in the
// box's padding (top, right, bottom, left f64 CSS px) @112, then u32 first
// fragment @144 and u32 fragment count @148, then the fragments. A
// fragment is a border box (x, y, w, h f64 CSS px) relative to its box's
// border box origin; the geometry wire (geometry.watpart) carries the same
// fragments after its glyph block.
export const BOX_SNAPSHOT_HEADER_SIZE = 24;
export const BOX_SNAPSHOT_ROW_SIZE = 152;
const BOX_SNAPSHOT_MAGIC = 0x584f4247;
const BOX_ROW_SCROLLBAR_SPACE = 112;
const BOX_ROW_FIRST_FRAGMENT = 144;
const BOX_ROW_FRAGMENT_COUNT = 148;
export const GEOMETRY_FRAGMENT_SIZE = 32;
export const GEOMETRY_ENVELOPE_SIZE = 160;
export const GEOMETRY_RECORD_SIZE = 768;
const GEOMETRY_SCROLLBAR_SIZE = 192;
const GEOMETRY_CARET_SIZE = 64;
const GEOMETRY_GLYPH_SIZE = 80;
const GEOMETRY_ENVELOPE_FRAGMENT_COUNT = 100;
const GEOMETRY_RECORD_FIRST_FRAGMENT = 592;
const GEOMETRY_RECORD_FRAGMENT_COUNT = 596;

// Bytes of the geometry wire form: the envelope, then the record,
// scrollbar, caret, glyph and fragment blocks (geometry.watpart
// $geometryWireSize).
export function geometryWireSize(records, scrollbars, carets, glyphs, fragments) {
  return GEOMETRY_ENVELOPE_SIZE + records * GEOMETRY_RECORD_SIZE +
    scrollbars * GEOMETRY_SCROLLBAR_SIZE + carets * GEOMETRY_CARET_SIZE +
    glyphs * GEOMETRY_GLYPH_SIZE + fragments * GEOMETRY_FRAGMENT_SIZE;
}

// A box's fragments: none, or two and more for a box broken across
// columns or lines.
function boxFragments(box) {
  const fragments = box?.fragments ?? noFragments;
  if (fragments.length === 1) {
    throw new Error("A box has one fragment; a box in one piece has none and a broken box two or more");
  }
  return fragments;
}

// A boxes array carries a retained core snapshot of its values (the
// engine's box buffer is transient across host awaits). The engine's boxes
// are read as a box list over a copy of the core's snapshot of its rows
// (readEngineBoxes), which outlives the native snapshot's explicit release
// (plans/dom/PLAN-large-document-memory.md, problem 1). An array without an
// attached snapshot uploads its values on demand in the same row shape.
export const BOX_SNAPSHOT = Symbol.for("sandom.geometry.boxSnapshot");
const boxSnapshotFinalizer = new FinalizationRegistry(({ core, handle }) => {
  core.exports.geometry_boxes_release(handle);
});
const measurementKey = Symbol.for("sandom.domCore.measurement");
// A snapshot row in f64 words: the fourteen box values, then the u32 first
// fragment and fragment count; a fragment in f64 words.
export const BOX_SNAPSHOT_ROW_WORDS = BOX_SNAPSHOT_ROW_SIZE / 8;
const FRAGMENT_WORDS = GEOMETRY_FRAGMENT_SIZE / 8;

function attach(boxes, core, handle) {
  const snapshot = { core, handle, count: boxes.length, references: 1 };
  boxSnapshotFinalizer.register(snapshot, { core, handle }, snapshot);
  boxes[BOX_SNAPSHOT] = snapshot;
  return boxes;
}

// The rows behind each box list: its copy of the snapshot body (rows, then
// fragments), which outlives the native snapshot, and how many boxes the
// list has made.
const boxListRows = new WeakMap();

// The boxes of the first `count` engine rows, read through a new core
// snapshot of them (engine_boxes_snapshot). The result is an array whose
// box objects are made, frozen, on their first read, from a copy of the
// snapshot's rows: a frame reads a few boxes (scroll feedback, overlays),
// so it pays for those, not for one object per node. A box the engine broke
// across columns or lines has its `fragments`. `adjustRows(rows)` may
// rewrite box values before any is read (fifteen f64 words per row, the
// fourteen values first) and returns whether it did; the snapshot then
// holds the rewritten rows. It runs only when a row's SVG kind is a path
// reference (the snapshot header's path row count), the rows it rewrites.
//
// The list refuses writes, as a frozen array does, but reports itself
// extensible until an operation that lists its properties (ownKeys, a
// property descriptor, a write, freezing) makes every box and freezes it:
// freezeBoxes and boxesReadOnly answer for it without that.
export function readEngineBoxes(core, count, deviceScale, adjustRows = null) {
  const measurement = globalThis[measurementKey];
  const start = measurement ? performance.now() : 0;
  const handle = core.status("engine_boxes_snapshot", count, deviceScale);
  const bytes = core.refreshBytes();
  const header = new DataView(bytes.buffer, handle, BOX_SNAPSHOT_HEADER_SIZE);
  if (header.getUint32(0, true) !== BOX_SNAPSHOT_MAGIC || header.getUint32(4, true) !== count) {
    throw new Error(`Box snapshot ${handle} does not hold ${count} rows`);
  }
  const fragmentCount = header.getUint32(8, true);
  const pathRows = header.getUint32(12, true);
  const bodyStart = handle + BOX_SNAPSHOT_HEADER_SIZE;
  const body = bytes.slice(
    bodyStart,
    bodyStart + count * BOX_SNAPSHOT_ROW_SIZE + fragmentCount * GEOMETRY_FRAGMENT_SIZE,
  );
  let snapshotHandle = handle;
  try {
    if (adjustRows !== null && pathRows !== 0 && adjustRows(new Float64Array(body.buffer, 0, count * BOX_SNAPSHOT_ROW_WORDS))) {
      snapshotHandle = importBoxRows(core, body, count, fragmentCount);
      core.status("geometry_boxes_release", handle);
    }
  } catch (error) {
    core.status("geometry_boxes_release", handle);
    throw error;
  }
  const boxes = boxList(core, snapshotHandle, body, count, fragmentCount);
  measurement?.record({
    category: "geometry",
    operation: "boxes.decode",
    direction: "engine-to-host",
    bytes: body.byteLength,
    allocations: 2,
    allocationBytes: body.byteLength,
    milliseconds: performance.now() - start,
  });
  return boxes;
}

function boxList(core, handle, body, count, fragmentCount) {
  const values = new Float64Array(body.buffer);
  const words = new Uint32Array(body.buffer, 0, count * BOX_SNAPSHOT_ROW_WORDS * 2);
  const fragmentBase = count * BOX_SNAPSHOT_ROW_WORDS;
  const target = new Array(count);
  attach(target, core, handle);
  const rows = { body, count, fragmentCount, made: 0 };
  const boxAt = (index) => {
    const made = target[index];
    if (made !== undefined) return made;
    rows.made++;
    return target[index] = rowBox(values, words, fragmentBase, index);
  };
  let complete = false;
  const completeAll = () => {
    if (complete) return;
    for (let index = 0; index < count; index++) boxAt(index);
    Object.freeze(target);
    complete = true;
  };
  const boxes = new Proxy(target, {
    get(target, key, receiver) {
      const index = typeof key === "string" ? rowIndex(key, count) : -1;
      return index < 0 ? Reflect.get(target, key, receiver) : boxAt(index);
    },
    has(target, key) {
      return (typeof key === "string" && rowIndex(key, count) >= 0) || Reflect.has(target, key);
    },
    ownKeys(target) {
      completeAll();
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      completeAll();
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    defineProperty(target, key, descriptor) {
      completeAll();
      return Reflect.defineProperty(target, key, descriptor);
    },
    set(target, key, value, receiver) {
      completeAll();
      return Reflect.set(target, key, value, receiver);
    },
    deleteProperty(target, key) {
      completeAll();
      return Reflect.deleteProperty(target, key);
    },
    preventExtensions(target) {
      completeAll();
      return Reflect.preventExtensions(target);
    },
  });
  boxListRows.set(boxes, rows);
  return boxes;
}

// How many box objects `boxes` holds: every one of an array, the ones a
// box list has made so far.
export function boxesMade(boxes) {
  return boxListRows.get(boxes)?.made ?? boxes.length;
}

// The row a property key names: a canonical array index below `count`,
// else -1.
function rowIndex(key, count) {
  const length = key.length;
  if (length === 0 || length > 10 || (length > 1 && key.charCodeAt(0) === 48)) return -1;
  let index = 0;
  for (let at = 0; at < length; at++) {
    const digit = key.charCodeAt(at) - 48;
    if (digit < 0 || digit > 9) return -1;
    index = index * 10 + digit;
  }
  return index < count ? index : -1;
}

function rowBox(values, words, fragmentBase, index) {
  const at = index * BOX_SNAPSHOT_ROW_WORDS;
  const box = {
    x: values[at],
    y: values[at + 1],
    w: values[at + 2],
    h: values[at + 3],
    cx: values[at + 4],
    cy: values[at + 5],
    cw: values[at + 6],
    ch: values[at + 7],
    scrollLeft: values[at + 8],
    scrollTop: values[at + 9],
    scrollWidth: values[at + 10],
    scrollHeight: values[at + 11],
    stickyLeft: values[at + 12],
    stickyTop: values[at + 13],
  };
  // The classic scrollbar space (top, right, bottom, left), only when the
  // box reserves some, so that a copied box keeps it.
  const space = at + BOX_ROW_SCROLLBAR_SPACE / 8;
  if (values[space] !== 0 || values[space + 1] !== 0 || values[space + 2] !== 0 || values[space + 3] !== 0) {
    box.scrollbarSpace = Object.freeze([values[space], values[space + 1], values[space + 2], values[space + 3]]);
  }
  const fragmentCount = words[at * 2 + BOX_ROW_FRAGMENT_COUNT / 4];
  if (fragmentCount !== 0) {
    const first = words[at * 2 + BOX_ROW_FIRST_FRAGMENT / 4];
    const fragments = [];
    for (let offset = 0; offset < fragmentCount; offset++) {
      const fragment = fragmentBase + (first + offset) * FRAGMENT_WORDS;
      fragments.push(Object.freeze({
        x: values[fragment],
        y: values[fragment + 1],
        w: values[fragment + 2],
        h: values[fragment + 3],
      }));
    }
    box.fragments = Object.freeze(fragments);
  }
  return Object.freeze(box);
}

// Freezes a box array. A box list refuses writes already; freezing it would
// make every box.
export function freezeBoxes(boxes) {
  return boxListRows.has(boxes) ? boxes : Object.freeze(boxes);
}

// Whether `boxes` can no longer change: a frozen array or a box list.
export function boxesReadOnly(boxes) {
  return boxListRows.has(boxes) || Object.isFrozen(boxes);
}

// Retained renderers and independently returned frames share one immutable
// geometry snapshot. The finalizer still releases once if callers rely on GC.
export function retainBoxSnapshot(boxes) {
  const attached = boxes?.[BOX_SNAPSHOT];
  if (attached?.handle) attached.references++;
  return boxes;
}

// Releases the native snapshot behind `boxes` now rather than at collection.
// A later boxSnapshotFor over the same array uploads its values (a box
// list's rows) instead.
export function releaseBoxSnapshot(boxes) {
  const attached = boxes?.[BOX_SNAPSHOT];
  if (!attached || attached.handle === 0n) return;
  if (--attached.references > 0) return;
  boxSnapshotFinalizer.unregister(attached);
  attached.core.exports.geometry_boxes_release(attached.handle);
  attached.handle = 0n;
}

function importBoxSnapshot(boxes, core) {
  let fragmentCount = 0;
  for (const box of boxes) fragmentCount += boxFragments(box).length;
  const size = boxes.length * BOX_SNAPSHOT_ROW_SIZE + fragmentCount * GEOMETRY_FRAGMENT_SIZE;
  const pointer = core.status("abi_allocate", size);
  const view = new DataView(core.refreshBytes().buffer, pointer, size);
  const fragmentBase = boxes.length * BOX_SNAPSHOT_ROW_SIZE;
  let fragment = 0;
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const row = index * BOX_SNAPSHOT_ROW_SIZE;
    for (let field = 0; field < 14; field++) {
      view.setFloat64(row + field * 8, box?.[boxNames[field]] ?? 0, true);
    }
    // A host box carries the classic scrollbar space a box list gave it.
    for (let side = 0; side < 4; side++) {
      view.setFloat64(row + BOX_ROW_SCROLLBAR_SPACE + side * 8, box?.scrollbarSpace?.[side] ?? 0, true);
    }
    const fragments = boxFragments(box);
    view.setUint32(row + BOX_ROW_FIRST_FRAGMENT, fragments.length === 0 ? 0 : fragment, true);
    view.setUint32(row + BOX_ROW_FRAGMENT_COUNT, fragments.length, true);
    for (const { x, y, w, h } of fragments) {
      const at = fragmentBase + fragment * GEOMETRY_FRAGMENT_SIZE;
      view.setFloat64(at, x, true);
      view.setFloat64(at + 8, y, true);
      view.setFloat64(at + 16, w, true);
      view.setFloat64(at + 24, h, true);
      fragment++;
    }
  }
  return core.status("geometry_boxes_import", boxes.length, fragmentCount, pointer);
}

// A snapshot of a box list's rows, uploaded as they are.
function importBoxRows(core, body, count, fragmentCount) {
  const pointer = core.status("abi_allocate", body.byteLength);
  core.refreshBytes().set(body, pointer);
  return core.status("geometry_boxes_import", count, fragmentCount, pointer);
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
  const rows = boxListRows.get(boxes);
  const handle = rows === undefined
    ? importBoxSnapshot(boxes, core)
    : importBoxRows(core, rows.body, rows.count, rows.fragmentCount);
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
  const carets = new Uint8Array(stops.length * GEOMETRY_CARET_SIZE);
  const caretView = new DataView(carets.buffer);
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index];
    const offset = index * GEOMETRY_CARET_SIZE;
    caretView.setBigUint64(offset, node._coreHandle, true);
    caretView.setFloat64(offset + 8, stop.sourceOffset, true);
    caretView.setFloat64(offset + 16, stop.x, true);
    caretView.setFloat64(offset + 24, stop.top, true);
    caretView.setFloat64(offset + 32, stop.bottom, true);
    caretView.setInt32(offset + 40, -1, true);
  }
  const glyphBytes = new Uint8Array(glyphs.length * GEOMETRY_GLYPH_SIZE);
  const glyphView = new DataView(glyphBytes.buffer);
  for (let index = 0; index < glyphs.length; index++) {
    const glyph = glyphs[index];
    const offset = index * GEOMETRY_GLYPH_SIZE;
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

// Writes a text node's translation into its copied wire blocks, as it is:
// a shared text block shifts it later, so a -0 stays -0 (the core reads a
// pair of zeros as +0). The blocks are encoded with +0.
function patchTranslation(bytes, base, stride, count, offsetInRecord, x, y) {
  if (Object.is(x, 0) && Object.is(y, 0)) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  for (let index = 0; index < count; index++) {
    view.setFloat64(base + index * stride + offsetInRecord, x, true);
    view.setFloat64(base + index * stride + offsetInRecord + 8, y, true);
  }
}

// One wire scrollbar block (192 bytes) at `offset`.
function writeScrollbar(view, offset, scrollbar) {
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
    16 + scrollbars.length * GEOMETRY_SCROLLBAR_SIZE + caretCount * GEOMETRY_CARET_SIZE +
      glyphCount * GEOMETRY_GLYPH_SIZE,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, scrollbars.length, true);
  view.setUint32(4, caretCount, true);
  view.setUint32(8, glyphCount, true);
  let offset = 16;
  for (const scrollbar of scrollbars) {
    writeScrollbar(view, offset, scrollbar);
    offset += GEOMETRY_SCROLLBAR_SIZE;
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
    offset += GEOMETRY_CARET_SIZE;
  }
  for (const { blocks, translationX, translationY } of textBlocks) {
    bytes.set(blocks.carets, offset);
    patchTranslation(
      bytes,
      offset,
      GEOMETRY_CARET_SIZE,
      blocks.caretCount,
      48,
      translationX,
      translationY,
    );
    offset += blocks.caretCount * GEOMETRY_CARET_SIZE;
  }
  for (const glyph of glyphs) {
    writeGlyph(view, offset, glyph);
    offset += GEOMETRY_GLYPH_SIZE;
  }
  for (const { blocks, translationX, translationY } of textBlocks) {
    bytes.set(blocks.glyphs, offset);
    patchTranslation(
      bytes,
      offset,
      GEOMETRY_GLYPH_SIZE,
      blocks.glyphCount,
      56,
      translationX,
      translationY,
    );
    offset += blocks.glyphCount * GEOMETRY_GLYPH_SIZE;
  }
  return bytes;
}

// The host tail of a scroll successor (geometry-build.watpart
// geometry_scroll_successor), a 48-byte header: u32 scrollbar count, u32
// text entry count, u32 text mode, 4 reserved bytes, f64 predecessor text
// shift x and y, f64 text shift x and y; then the wire scrollbars, then
// one entry per text node in the predecessor's caret and glyph order: u64
// node handle, f64 translation x and y. `textShift` (text mode 1, no
// entries) keeps the predecessor's carets and glyphs under a new shift:
// { previousX, previousY, x, y }.
const GEOMETRY_SUCCESSOR_TAIL_HEADER_SIZE = 48;
const GEOMETRY_SUCCESSOR_TEXT_ENTRY_SIZE = 24;
export function encodeGeometrySuccessorTail({ scrollbars, textTranslations = [], textShift = null }) {
  const bytes = new Uint8Array(
    GEOMETRY_SUCCESSOR_TAIL_HEADER_SIZE + scrollbars.length * GEOMETRY_SCROLLBAR_SIZE +
      textTranslations.length * GEOMETRY_SUCCESSOR_TEXT_ENTRY_SIZE,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, scrollbars.length, true);
  view.setUint32(4, textTranslations.length, true);
  if (textShift !== null) {
    view.setUint32(8, 1, true);
    view.setFloat64(16, textShift.previousX, true);
    view.setFloat64(24, textShift.previousY, true);
    view.setFloat64(32, textShift.x, true);
    view.setFloat64(40, textShift.y, true);
  }
  let offset = GEOMETRY_SUCCESSOR_TAIL_HEADER_SIZE;
  for (const scrollbar of scrollbars) {
    writeScrollbar(view, offset, scrollbar);
    offset += GEOMETRY_SCROLLBAR_SIZE;
  }
  for (const { handle, translationX, translationY } of textTranslations) {
    view.setBigUint64(offset, handle, true);
    view.setFloat64(offset + 8, translationX, true);
    view.setFloat64(offset + 16, translationY, true);
    offset += GEOMETRY_SUCCESSOR_TEXT_ENTRY_SIZE;
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
  let fragmentCount = 0;
  for (const record of records) fragmentCount += boxFragments(record.box).length;
  const bytes = new Uint8Array(geometryWireSize(
    records.length,
    scrollbars.length,
    carets.length,
    glyphs.length,
    fragmentCount,
  ));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, GEOMETRY_RECORD_SIZE, true);
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
  view.setUint32(GEOMETRY_ENVELOPE_FRAGMENT_COUNT, fragmentCount, true);
  const fragmentBase = geometryWireSize(
    records.length,
    scrollbars.length,
    carets.length,
    glyphs.length,
    0,
  );
  let fragment = 0;
  let offset = GEOMETRY_ENVELOPE_SIZE;
  for (const record of records) {
    const fields = record.fields ?? {};
    const box = record.box;
    let flags = box ? 1 : 0;
    if (record.hitable !== false) flags |= 2;
    if ((fields.position ?? "static") !== "static") flags |= 4;
    if (fields.zIndex !== undefined) flags |= 8;
    if (fields.direction === "rtl") flags |= 32;
    if (fields.display === "flex" || fields.display === "inline-flex") {
      if (fields.flexDirection === "row-reverse") flags |= 16;
      if (fields.flexDirection === "column-reverse") flags |= 256;
    }
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
    const fragments = boxFragments(box);
    if (fragments.length > 0) {
      view.setUint32(offset + GEOMETRY_RECORD_FIRST_FRAGMENT, fragment, true);
      view.setUint32(offset + GEOMETRY_RECORD_FRAGMENT_COUNT, fragments.length, true);
    }
    for (const { x, y, w, h } of fragments) {
      const at = fragmentBase + fragment * GEOMETRY_FRAGMENT_SIZE;
      view.setFloat64(at, x, true);
      view.setFloat64(at + 8, y, true);
      view.setFloat64(at + 16, w, true);
      view.setFloat64(at + 24, h, true);
      fragment++;
    }
    offset += GEOMETRY_RECORD_SIZE;
  }
  for (const scrollbar of scrollbars) {
    writeScrollbar(view, offset, scrollbar);
    offset += GEOMETRY_SCROLLBAR_SIZE;
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
    offset += GEOMETRY_CARET_SIZE;
  }
  for (const glyph of glyphs) {
    writeGlyph(view, offset, glyph);
    offset += GEOMETRY_GLYPH_SIZE;
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
