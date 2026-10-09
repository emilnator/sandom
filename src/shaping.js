import { DomCore, sharedDomCore } from "./dom-wasm/core.js";
import { loadEngine } from "./wasm/loader.js";

const textEncoder = new TextEncoder();

// Byte marshalling only. HarfBuzz calls, glyph collection, and outline encoding live in WAT.
export function createShapingRuntime({
  engine: suppliedEngine = null,
  core = suppliedEngine?.core ?? new DomCore(),
  registerFont = null,
} = {}) {
  let engine = suppliedEngine;
  let loading = null;
  const registeredFonts = new WeakMap();

  async function preload() {
    if (!engine) {
      loading ??= loadEngine({ core });
      engine = await loading;
    }
    return engine;
  }

  function allocate(byteLength) {
    if (byteLength === 0) return 0;
    const pointer = engine.exports.abi_malloc(byteLength);
    if (pointer === 0) {
      throw new RangeError(`Native font transport allocation failed for ${byteLength} bytes; reduce the request size`);
    }
    return pointer;
  }

  function fontIndexFor(fontBytes, faceIndex = 0) {
    if (Number.isInteger(fontBytes)) return fontBytes;
    if (!(fontBytes instanceof Uint8Array)) {
      throw new TypeError("Native font operations require a registered font index or Uint8Array font bytes");
    }
    let faces = registeredFonts.get(fontBytes);
    if (!faces) {
      faces = new Map();
      registeredFonts.set(fontBytes, faces);
    }
    let fontIndex = faces.get(faceIndex);
    if (fontIndex === undefined) {
      if (registerFont) {
        fontIndex = registerFont(fontBytes, faceIndex);
      } else {
        const pointer = allocate(fontBytes.byteLength);
        new Uint8Array(engine.memory.buffer, pointer, fontBytes.byteLength).set(fontBytes);
        fontIndex = engine.exports.register_font(pointer, fontBytes.byteLength, faceIndex, 0, 0, 0);
        if (fontIndex < 0) {
          throw new Error(
            `The engine font table is full: font_table_count() is ${engine.exports.font_table_count()}, ` +
              "the FONT_TABLE_MAX_ENTRIES limit of src/wasm/layout.js. Raise FONT_TABLE_MAX_ENTRIES and FONT_TABLE_SIZE together.",
          );
        }
      }
      faces.set(faceIndex, fontIndex);
    }
    return fontIndex;
  }

  function encodeTags(records, features = false) {
    const stride = features ? 16 : 8;
    for (const [tag, value] of records) {
      if (typeof tag !== "string" || tag.length !== 4 || !Number.isFinite(value) ||
        (features && (!Number.isInteger(value) || value < 0))) {
        throw new TypeError(`Native font ${features ? "feature" : "variation"} requires a four-character tag and ${features ? "non-negative integer" : "finite"} value, got ${JSON.stringify([tag, value])}`);
      }
    }
    const pointer = allocate(records.length * stride);
    const view = new DataView(engine.memory.buffer);
    for (let index = 0; index < records.length; index++) {
      const [tag, value] = records[index];
      const offset = pointer + index * stride;
      view.setUint32(offset, ((tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) |
        (tag.charCodeAt(2) << 8) | tag.charCodeAt(3)) >>> 0, true);
      if (features) {
        view.setUint32(offset + 4, value, true);
        view.setUint32(offset + 8, 0, true);
        view.setUint32(offset + 12, 0xFFFFFFFF, true);
      } else {
        view.setFloat32(offset + 4, value, true);
      }
    }
    return pointer;
  }

  async function shapeFontText(fontBytes, text, _fontSize, {
    variations = [], features = [], unitScale = 1, faceIndex = 0,
  } = {}) {
    if (!Number.isInteger(unitScale) || unitScale < 1 || unitScale > 0x7FFFFFFF) {
      throw new RangeError(`Native shaping unitScale must be a positive i32, got ${unitScale}`);
    }
    await preload();
    const fontIndex = fontIndexFor(fontBytes, faceIndex);
    const encodedText = textEncoder.encode(text);
    let textPointer = 0;
    let variationPointer = 0;
    let featurePointer = 0;
    let outputPointer = 0;
    try {
      textPointer = allocate(encodedText.length);
      new Uint8Array(engine.memory.buffer, textPointer, encodedText.length).set(encodedText);
      variationPointer = encodeTags(variations);
      featurePointer = encodeTags(features, true);
      outputPointer = engine.exports.font_shape_text(fontIndex, textPointer, encodedText.length,
        variationPointer, variations.length, featurePointer, features.length, unitScale, 0);
      const view = new DataView(engine.memory.buffer);
      const count = view.getUint32(outputPointer, true);
      const glyphs = new Array(count);
      for (let index = 0; index < count; index++) {
        const row = outputPointer + 8 + index * 24;
        glyphs[index] = {
          g: view.getUint32(row, true), cl: view.getUint32(row + 4, true),
          ax: view.getInt32(row + 8, true), ay: view.getInt32(row + 12, true),
          dx: view.getInt32(row + 16, true), dy: view.getInt32(row + 20, true),
        };
      }
      return { glyphs, upem: view.getUint32(outputPointer + 4, true) };
    } finally {
      engine.exports.abi_free(outputPointer);
      engine.exports.abi_free(featurePointer);
      engine.exports.abi_free(variationPointer);
      engine.exports.abi_free(textPointer);
    }
  }

  function shapeGlyphIds(fontIndex, text, variations = []) {
    if (!engine) throw new Error("Native glyph shaping requires preload before synchronous use");
    const encodedText = textEncoder.encode(text);
    let textPointer = 0;
    let variationPointer = 0;
    let outputPointer = 0;
    try {
      textPointer = allocate(encodedText.length);
      new Uint8Array(engine.memory.buffer, textPointer, encodedText.length).set(encodedText);
      variationPointer = encodeTags(variations);
      outputPointer = engine.exports.font_shape_glyph_ids(fontIndex, textPointer, encodedText.length,
        variationPointer, variations.length);
      const count = new DataView(engine.memory.buffer).getUint32(outputPointer, true);
      return new Uint32Array(engine.memory.buffer, outputPointer + 8, count).slice();
    } finally {
      engine.exports.abi_free(outputPointer);
      engine.exports.abi_free(variationPointer);
      engine.exports.abi_free(textPointer);
    }
  }

  async function createGlyphOutlineSource(fontBytes, { faceIndex = 0 } = {}) {
    await preload();
    const fontIndex = fontIndexFor(fontBytes, faceIndex);
    const metadataPointer = allocate(20);
    engine.exports.font_outline_metadata(fontIndex, metadataPointer);
    const metadata = new DataView(engine.memory.buffer, metadataPointer, 20);
    const upem = metadata.getUint32(0, true);
    const opszAxis = metadata.getUint32(4, true) === 0 ? null : {
      min: metadata.getFloat32(8, true), default: metadata.getFloat32(12, true), max: metadata.getFloat32(16, true),
    };
    let active = true;
    return {
      upem, opszAxis, fontIndex,
      createFont(variations = []) {
        if (!active) throw new Error("Cannot create an outline font after releasing its source");
        const variationPointer = encodeTags(variations);
        let font;
        try {
          font = engine.exports.glyph_outline_font_create(fontIndex, variationPointer, variations.length, 1);
        } finally {
          engine.exports.abi_free(variationPointer);
        }
        return {
          glyphOutline(glyphId) {
            if (!font) throw new Error("Cannot extract an outline after releasing its font");
            const pointer = engine.exports.glyph_outline_extract(font, glyphId);
            const length = engine.exports.glyph_outline_length();
            // The native collector reuses its buffer. Own this span before any generator await.
            const verbs = new Uint8Array(engine.memory.buffer, pointer, length).slice();
            return { verbs, advance: engine.exports.glyph_outline_advance() };
          },
          destroy() {
            if (font) engine.exports.glyph_outline_font_destroy(font);
            font = 0;
          },
        };
      },
      destroy() {
        if (active) engine.exports.abi_free(metadataPointer);
        active = false;
      },
    };
  }

  return Object.freeze({ preload, shapeFontText, shapeGlyphIds, createGlyphOutlineSource,
    instanceIdentity: () => engine?.hb ?? null,
  });
}

const defaultShapingRuntime = createShapingRuntime({ core: sharedDomCore });
export const shapeFontText = (...arguments_) => defaultShapingRuntime.shapeFontText(...arguments_);
export const createGlyphOutlineSource = (...arguments_) => defaultShapingRuntime.createGlyphOutlineSource(...arguments_);
