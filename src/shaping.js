// Text shaping via HarfBuzz's own WASM build (vendor/hb.wasm), called
// directly through its raw C ABI — the same "host marshals bytes across a
// wasm_alloc/call/read/wasm_dealloc boundary" pattern src/atlas.js already
// uses for msdfgen.wasm. No JS reimplementation of shaping,
// and no hbjs.js/harfbuzzjs dependency: that wrapper is optional convenience
// sugar HarfBuzz's own build ships on top of the C ABI, not something the
// engine needs. See design/layout-engine.md's HarfBuzz section for the
// full architecture rationale (HarfBuzz as an imported WASM module, not a
// JS dependency — so shaping can eventually be called synchronously from
// WAT during layout, not just from this JS host).

import { readBinaryFile } from "./host.js";
import { instantiate as instantiateDrawTrampoline } from "./wasm/draw-trampoline-binary.js";
import { instantiateRendererCore } from "./wasm/renderer-core-binary.js";
import { loadHb } from "./wasm/loader.js";

export function createShapingRuntime({ harfbuzzBytes } = {}) {
let hbInstance = null;
let hbMemory = null;

async function ensureHb() {
  if (hbInstance) return hbInstance;

  // vendor/hb.wasm imports its memory with GLOBAL_BASE baked at the
  // engine's layout boundary and carries no allocator (design/memory-map.md),
  // so even this standalone instance lives in a memory of the shared shape
  // and allocates through a renderer core instance of its own. It does NOT
  // share the active renderer's memory: shapeText/outline extraction here is
  // independent of engine layout. The pages below the DOM region stay
  // untouched and lazily committed.
  const allocator = instantiateRendererCore().exports;
  hbMemory = allocator.memory;
  const instance = await loadHb(hbMemory, allocator, harfbuzzBytes);
  // Callers allocate through the same surface HarfBuzz uses.
  hbInstance = {
    exports: Object.freeze({
      ...instance.exports,
      malloc: allocator.abi_malloc,
      free: allocator.abi_free,
    }),
  };
  return hbInstance;
}

// hb_memory_mode_t: HB_MEMORY_MODE_WRITABLE. HarfBuzz copies-on-write only
// when it needs to mutate; passing WRITABLE (not READONLY) avoids an extra
// internal copy since we already own a throwaway copy in hb.wasm's heap.
const HB_MEMORY_MODE_WRITABLE = 2;

function setFontVariations(exports, font, variations) {
  if (variations.length === 0) return;
  const variationsPointer = exports.malloc(variations.length * 8);
  const view = new DataView(
    hbMemory.buffer,
    variationsPointer,
    variations.length * 8,
  );
  variations.forEach(([tag, value], index) => {
    if (
      typeof tag !== "string" || tag.length !== 4 || !Number.isFinite(value)
    ) {
      exports.free(variationsPointer);
      throw new TypeError(
        "HarfBuzz variations must contain a four-character tag and finite value",
      );
    }
    const encodedTag = (tag.charCodeAt(0) << 24) |
      (tag.charCodeAt(1) << 16) |
      (tag.charCodeAt(2) << 8) |
      tag.charCodeAt(3);
    view.setUint32(index * 8, encodedTag >>> 0, true);
    view.setFloat32(index * 8 + 4, value, true);
  });
  exports.hb_font_set_variations(font, variationsPointer, variations.length);
  exports.free(variationsPointer);
}

/**
 * Shape text using HarfBuzz (vendor/hb.wasm, raw C ABI — no hbjs.js).
 *
 * @param {Uint8Array} fontBytes - TTF font file bytes
 * @param {string} text - Text to shape
 * @param {number} fontSize - Desired font size in pixels
 * @param {{variations?: Array<[string, number]>}} options - OpenType variation coordinates
 * @returns {Promise<{glyphs: Array<{g: number, ax: number, ay: number, dx: number, dy: number}>, upem: number}>}
 */
async function shapeText(
  fontBytes,
  text,
  fontSize,
  { variations = [] } = {},
) {
  const hb = await ensureHb();
  const E = hb.exports;

  const fontPtr = E.malloc(fontBytes.length);
  new Uint8Array(hbMemory.buffer, fontPtr, fontBytes.length).set(fontBytes);

  const blob = E.hb_blob_create(
    fontPtr,
    fontBytes.length,
    HB_MEMORY_MODE_WRITABLE,
    0,
    0,
  );
  const face = E.hb_face_create(blob, 0);
  const upem = E.hb_face_get_upem(face);

  const font = E.hb_font_create(face);
  E.hb_font_set_scale(font, upem, upem);
  setFontVariations(E, font, variations);

  const buffer = E.hb_buffer_create();
  const textBytes = new TextEncoder().encode(text);
  const textPtr = E.malloc(textBytes.length || 1);
  new Uint8Array(hbMemory.buffer, textPtr, textBytes.length).set(textBytes);
  E.hb_buffer_add_utf8(buffer, textPtr, textBytes.length, 0, textBytes.length);
  E.free(textPtr);
  E.hb_buffer_guess_segment_properties(buffer);
  E.hb_shape(font, buffer, 0, 0);

  const glyphCountPtr = E.malloc(4);
  const infosPtr = E.hb_buffer_get_glyph_infos(buffer, glyphCountPtr);
  const glyphCount = new Uint32Array(hbMemory.buffer, glyphCountPtr, 1)[0];
  const positionsPtr = E.hb_buffer_get_glyph_positions(buffer, glyphCountPtr);

  // hb_glyph_info_t = { codepoint: u32, mask: u32, cluster: u32, var1: u32, var2: u32 } (20 B)
  // hb_glyph_position_t = { xAdvance: i32, yAdvance: i32, xOffset: i32, yOffset: i32, var: u32 } (20 B)
  const infos = new Int32Array(hbMemory.buffer, infosPtr, glyphCount * 5);
  const positions = new Int32Array(
    hbMemory.buffer,
    positionsPtr,
    glyphCount * 5,
  );
  const glyphs = [];
  for (let i = 0; i < glyphCount; i++) {
    glyphs.push({
      g: infos[i * 5 + 0],
      ax: positions[i * 5 + 0],
      ay: positions[i * 5 + 1],
      dx: positions[i * 5 + 2],
      dy: positions[i * 5 + 3],
    });
  }

  E.hb_buffer_destroy(buffer);
  E.hb_font_destroy(font);
  E.hb_face_destroy(face);
  E.hb_blob_destroy(blob);
  E.free(fontPtr);
  E.free(glyphCountPtr);

  return { glyphs, upem };
}



// ---------------------------------------------------------------------------
// Glyph outlines (design/text-rendering.md): hb_font_draw_glyph on this
// same hb.wasm instance replaces FreeType inside msdfgen.wasm. Callbacks are
// C function pointers — indices into hb's __indirect_function_table — and
// WebAssembly.Table.set refuses a plain JS closure, so the committed
// src/wasm/draw-trampoline.wat exports five real wasm functions with hb's
// exact callback signatures and forwards the coordinates to the JS
// collector below. Outline extraction runs on an atlas cache MISS, not per
// frame, so the JS hop costs nothing measurable.

// Flat binary verb buffer contract with glyph_msdf.cpp's
// buildShapeFromOutlineVerbs (little-endian):
//   [u8 verb][f32 coords...]
//   verb 0 = move (2 floats), 1 = line (2), 2 = quadratic (4), 3 = cubic
//   (6), 4 = close (0).
const VERB_MOVE = 0;
const VERB_LINE = 1;
const VERB_QUADRATIC = 2;
const VERB_CUBIC = 3;
const VERB_CLOSE = 4;

let drawFuncs = 0;
// The live collector the trampoline's callbacks append to — [tag,
// ...coords] tuples for the duration of one hb_font_draw_glyph call.
let sink = null;

function ensureDrawFuncs() {
  if (drawFuncs) return;
  const e = hbInstance.exports;

  const trampoline = instantiateDrawTrampoline({
    cb: {
      moveTo: (x, y) => sink.push([VERB_MOVE, x, y]),
      lineTo: (x, y) => sink.push([VERB_LINE, x, y]),
      quadTo: (cx, cy, x, y) => sink.push([VERB_QUADRATIC, cx, cy, x, y]),
      cubicTo: (c1x, c1y, c2x, c2y, x, y) =>
        sink.push([VERB_CUBIC, c1x, c1y, c2x, c2y, x, y]),
      closePath: () => sink.push([VERB_CLOSE]),
    },
  });

  // Append the five callbacks to hb's own table (no declared maximum, so
  // it grows) and hand hb back their indices.
  const table = e.__indirect_function_table;
  const base = table.length;
  table.grow(5);
  const order = [
    "move_to",
    "line_to",
    "quadratic_to",
    "cubic_to",
    "close_path",
  ];
  order.forEach((name, i) => table.set(base + i, trampoline.exports[name]));

  drawFuncs = e.hb_draw_funcs_create();
  e.hb_draw_funcs_set_move_to_func(drawFuncs, base + 0, 0, 0);
  e.hb_draw_funcs_set_line_to_func(drawFuncs, base + 1, 0, 0);
  e.hb_draw_funcs_set_quadratic_to_func(drawFuncs, base + 2, 0, 0);
  e.hb_draw_funcs_set_cubic_to_func(drawFuncs, base + 3, 0, 0);
  e.hb_draw_funcs_set_close_path_func(drawFuncs, base + 4, 0, 0);
}

// hb_ot_var_axis_info_t: axis_index u32, tag u32, name_id u32, flags u32,
// min f32, default f32, max f32, reserved u32 — 32 bytes.
const AXIS_INFO_BYTES = 32;
const OPSZ_TAG = (0x6f << 24) | (0x70 << 16) | (0x73 << 8) | 0x7a; // 'opsz'

function serializeVerbs(tuples) {
  let bytes = 0;
  for (const tuple of tuples) bytes += 1 + (tuple.length - 1) * 4;
  const buffer = new Uint8Array(bytes);
  const view = new DataView(buffer.buffer);
  let offset = 0;
  for (const tuple of tuples) {
    buffer[offset++] = tuple[0];
    for (let i = 1; i < tuple.length; i++) {
      view.setFloat32(offset, tuple[i], true);
      offset += 4;
    }
  }
  return buffer;
}

/**
 * Opens a font as a glyph outline source: HarfBuzz face-level metadata
 * (upem, the real-tag opsz axis range) plus per-variation-instance outline
 * extraction in font units, y-up — the coordinate space
 * generate_outline_msdf expects (FT_LOAD_NO_SCALE's equivalent, via
 * hb_font_set_scale(font, upem, upem)).
 *
 * The face and its font-byte copy stay resident in hb.wasm's heap until
 * destroy() — one font copy total, replacing the two extra copies the
 * FreeType pipeline kept (msdfgen's atlas_set_font copy is gone).
 *
 * @param {Uint8Array} fontBytes
 */
async function createGlyphOutlineSource(fontBytes) {
  await ensureHb();
  ensureDrawFuncs();
  const e = hbInstance.exports;

  const fontPtr = e.malloc(fontBytes.length);
  new Uint8Array(hbMemory.buffer, fontPtr, fontBytes.length).set(fontBytes);
  const blob = e.hb_blob_create(
    fontPtr,
    fontBytes.length,
    HB_MEMORY_MODE_WRITABLE,
    0,
    0,
  );
  const face = e.hb_face_create(blob, 0);
  const upem = e.hb_face_get_upem(face);

  // opsz axis range by real 4-byte OpenType tag — the metadata
  // atlas_set_font used to resolve through FreeType's name-based layer.
  let opszAxis = null;
  {
    const countPtr = e.malloc(4);
    new DataView(hbMemory.buffer).setUint32(countPtr, 0, true);
    const total = e.hb_ot_var_get_axis_infos(face, 0, countPtr, 0);
    if (total > 0) {
      const axesPtr = e.malloc(total * AXIS_INFO_BYTES);
      new DataView(hbMemory.buffer).setUint32(countPtr, total, true);
      e.hb_ot_var_get_axis_infos(face, 0, countPtr, axesPtr);
      const view = new DataView(hbMemory.buffer);
      const written = view.getUint32(countPtr, true);
      for (let i = 0; i < written; i++) {
        const base = axesPtr + i * AXIS_INFO_BYTES;
        if (view.getUint32(base + 4, true) !== OPSZ_TAG) continue;
        opszAxis = {
          min: view.getFloat32(base + 16, true),
          default: view.getFloat32(base + 20, true),
          max: view.getFloat32(base + 24, true),
        };
        break;
      }
      e.free(axesPtr);
    }
    e.free(countPtr);
  }

  return {
    upem,
    opszAxis,

    /**
     * One variation instance ([tag, value] pairs, e.g. [['wght', 700]]).
     * Destroy it after extracting the instance's outlines — the face
     * outlives every font created from it.
     */
    createFont(variations = []) {
      const font = e.hb_font_create(face);
      e.hb_font_set_scale(font, upem, upem);
      setFontVariations(e, font, variations);
      return {
        /** @returns {{verbs: Uint8Array, advance: number}} font units, y-up */
        glyphOutline(glyphId) {
          sink = [];
          e.hb_font_draw_glyph(font, glyphId, drawFuncs, 0);
          const verbs = serializeVerbs(sink);
          sink = null;
          return {
            verbs,
            advance: e.hb_font_get_glyph_h_advance(font, glyphId),
          };
        },
        destroy() {
          e.hb_font_destroy(font);
        },
      };
    },

    destroy() {
      e.hb_face_destroy(face);
      e.hb_blob_destroy(blob);
      e.free(fontPtr);
    },
  };
}

  return Object.freeze({
    preload: ensureHb,
    shapeText,
    createGlyphOutlineSource,
    instanceIdentity() {
      return hbInstance;
    },
  });
}

const defaultShapingRuntime = createShapingRuntime();

export const shapeText = (...arguments_) =>
  defaultShapingRuntime.shapeText(...arguments_);
export const createGlyphOutlineSource = (...arguments_) =>
  defaultShapingRuntime.createGlyphOutlineSource(...arguments_);
