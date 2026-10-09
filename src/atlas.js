/**
 * MSDF atlas wrappers over the wasm-side atlas cache.
 *
 * The cache tables, texel-budget sizing, opsz resolution, and the
 * deterministic skyline packer all live in the msdfgen wasm module
 * (vendor/msdfgen-wasm-cpp/src/atlas.cpp) — the empirically-tuned
 * constants (MSDF_RANGE, the 48/32..256 texel clamps) and their
 * provenance comments moved there with the code. This file is the thin
 * host-side layer: byte I/O into wasm memory, handle lifecycle, and
 * typed views over wasm-owned results (the packed RGBA atlas buffer and
 * per-entry info blocks are read in place, never copied).
 *
 * A GlyphAtlas instance wraps one wasm atlas handle per font;
 * SvgPathAtlas wraps the one shared path atlas. Both used to hold the
 * cache/packing logic themselves — see atlas.cpp for everything that
 * moved.
 */

import createMsdfgenModule from "../vendor/msdfgen.mjs";
import { readBinaryFile } from "./host.js";
import { createGlyphOutlineSource as createDefaultGlyphOutlineSource } from "./shaping.js";
import * as GlyphPolicy from "./wasm/glyph-policy-atlas-interface.js";

// Mirror of atlas.cpp's MSDF_RANGE — exposed to the rasterizer via
// getMsdfParams, and part of the generated MSDFs' padding geometry.
const MSDF_RANGE = 6.0;

// atlas_entry_info_ptr and glyph residency rows expose the same information
// block. The generated policy interface owns its length.

// Mirror of glyph_timing.h's exclusive native phase array. The final value is
// the enclosing native atlas_insert_glyph duration and is used only to remove
// native execution from the host-side allocation/copy/call measurement; it is
// not reported as another phase because that would overlap every native field.
const NATIVE_GLYPH_TIMING_FIELDS = Object.freeze([
  "nativeOutlineDecodeAndShapeConstructionMilliseconds",
  "skiaGeometryResolutionMilliseconds",
  "normalizationAndDeconvergenceMilliseconds",
  "geometrySizingAndProjectionMilliseconds",
  "edgeColoringMilliseconds",
  "bitmapAllocationMilliseconds",
  "generateMsdfIncludingErrorCorrectionMilliseconds",
  "pixelPackingAndCopyMilliseconds",
  "atlasInsertionAndBookkeepingMilliseconds",
  "atlasInsertTotalMilliseconds",
]);

export const GLYPH_PERFORMANCE_PHASE_FIELDS = Object.freeze([
  "harfBuzzOutlineExtractionMilliseconds",
  "javascriptToWebAssemblyAllocationCopyCallMilliseconds",
  ...NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1),
  "webGpuPipelineCreationMilliseconds",
  "webGpuCpuPackingMilliseconds",
  "webGpuUploadMilliseconds",
  "webGpuEncodeMilliseconds",
  "webGpuSubmitMilliseconds",
  "webGpuCompletionMilliseconds",
  "directAtlasPopulationMilliseconds",
  "directAtlasCopyMilliseconds",
  "cacheReuseMilliseconds",
  "atlasRebuildAndPackingMilliseconds",
  "gpuUploadMilliseconds",
  "otherPreparationMilliseconds",
]);

export function emptyGlyphPhaseMilliseconds() {
  return Object.fromEntries(
    GLYPH_PERFORMANCE_PHASE_FIELDS.map((field) => [field, 0]),
  );
}

function nativeGlyphTiming(Module) {
  const timingPointer = Module._glyph_timing_ptr();
  const timingView = new DataView(
    Module.HEAPU8.buffer,
    timingPointer,
    NATIVE_GLYPH_TIMING_FIELDS.length * 8,
  );
  return Object.fromEntries(
    NATIVE_GLYPH_TIMING_FIELDS.map((field, index) => [
      field,
      timingView.getFloat64(index * 8, true),
    ]),
  );
}

const textEncoder = new TextEncoder();

export function createAtlasRuntime({
  msdfgenBytes,
  createGlyphOutlineSource = createDefaultGlyphOutlineSource,
} = {}) {
  let wasmModule = null;

  async function ensureWasm() {
    if (wasmModule) return wasmModule;

    let wasmBinary = msdfgenBytes ??
      globalThis[Symbol.for("sandom.msdfgenBytes")];
    if (!msdfgenBytes) {
      delete globalThis[Symbol.for("sandom.msdfgenBytes")];
    }
    if (!wasmBinary) {
      wasmBinary = await readBinaryFile(
        new URL("../vendor/msdfgen.wasm", import.meta.url),
      );
    }
    const Module = await createMsdfgenModule({
      instantiateWasm(imports, receiveInstance) {
        const module = new WebAssembly.Module(wasmBinary);
        receiveInstance(new WebAssembly.Instance(module, imports));
      },
    });
    const infoFloats = Module._atlas_entry_info_floats();
    if (infoFloats !== GlyphPolicy.RESIDENCY_INFORMATION_COUNT) {
      throw new Error(
        `atlas entry layout mismatch: wasm reports ${infoFloats} info floats, generated glyph policy expects ${GlyphPolicy.RESIDENCY_INFORMATION_COUNT} — rebuild vendor/msdfgen.wasm or update the glyph policy interface`,
      );
    }
    const timingCount = Module._glyph_timing_count();
    if (timingCount !== NATIVE_GLYPH_TIMING_FIELDS.length) {
      throw new Error(
        `glyph timing layout mismatch: wasm reports ${timingCount} fields, JS mirror expects ${NATIVE_GLYPH_TIMING_FIELDS.length} — rebuild vendor/msdfgen.wasm or update src/atlas.js`,
      );
    }
    wasmModule = Module;
    return wasmModule;
  }
  // Scene rendering imports this runtime before exposing synchronous DOM layout
  // getters. Local SVG paths are deterministic inputs just like local fonts;
  // mount-time getBoundingClientRect must not depend on an unrelated prior frame.
  async function initializeAtlasRuntime() {
    await ensureWasm();
  }

  // Rendered by rebuildAtlas() on an atlas that never reached the wasm side
  // (zero entries ensured): the same 1x1 transparent RGBA the wasm packer
  // produces for an empty table.
  const EMPTY_ATLAS_DATA = new Uint8Array(4);

  // Shared handle/lifecycle layer — one wasm atlas handle per instance.
  // GlyphAtlas and SvgPathAtlas deliberately share this single
  // implementation (they always shared one packing/caching shape; keeping
  // them split was two copies of the same bug surface).
  class WasmAtlas {
    constructor(kind) {
      this._kind = kind;
      this.id = 0;
      // Distinguishes "rebuild ran on an empty, never-created atlas" (1x1
      // empty texture, matching the wasm packer's own empty case) from
      // "rebuild never ran" (null atlasData / zero dims, the pre-rebuild
      // state the old JS classes also had).
      this._rebuiltEmpty = false;
      // Bumped by every rebuildAtlas() that packs again — the ONLY thing
      // that changes the packed atlas's dimensions or pixels (ensurePaths
      // only adds entries; atlasData/atlasWidth/atlasHeight all read the
      // packed result). A GPU consumer caching an uploaded texture keys on
      // this plus the atlas's own identity, instead of re-uploading every
      // frame.
      this.revision = 0;
      this._destroyListeners = new Set();
      this._webGpuTextures = new Map();
    }

    async _ensureCreated() {
      const Module = await ensureWasm();
      if (!this.id) this.id = Module._atlas_create(this._kind);
      return Module;
    }

    // The scene renderer initializes the local atlas runtime before exporting
    // synchronous layout getters. Reaching this guard means a caller imported
    // this low-level module directly without honoring that initialization
    // contract; fail loudly rather than returning false path geometry.
    _ensureCreatedSync() {
      if (!wasmModule) {
        throw new Error(
          "atlas.js: wasm module not loaded yet — synchronous layout-getters require the tree to have been rendered at least once already (see src/dom/layout-getters.js)",
        );
      }
      if (!this.id) this.id = wasmModule._atlas_create(this._kind);
      return wasmModule;
    }

    _infoFloats(slot) {
      const ptr = wasmModule._atlas_entry_info_ptr(this.id, slot);
      if (ptr === 0) return null;
      // One view over the heap, re-made only when the heap grows.
      const buffer = wasmModule.HEAPU8.buffer;
      if (
        this._heapFloats === undefined || this._heapFloats.buffer !== buffer
      ) {
        this._heapFloats = new Float32Array(buffer);
      }
      return this._heapFloats.subarray(
        ptr >> 2,
        (ptr >> 2) + GlyphPolicy.RESIDENCY_INFORMATION_COUNT,
      );
    }

    rebuildAtlas() {
      if (this.id) {
        // An atlas no ensure changed since its last packing keeps its
        // packed pixels, so its revision (and every texture and bind group
        // keyed on it) holds: a frame of unchanged paths uploads nothing.
        if (this.revision !== 0 && !wasmModule._atlas_dirty(this.id)) return 0;
        wasmModule._atlas_rebuild(this.id);
        this.revision++;
        return wasmModule._atlas_last_rebuild_milliseconds(this.id);
      }
      // An atlas that never reached the wasm side stays the same 1x1 empty
      // texture: only its first rebuild changes it.
      if (this._rebuiltEmpty) return 0;
      this._rebuiltEmpty = true;
      this.revision++;
      return 0;
    }

    // Live views over the wasm-owned packed atlas — re-derived on every
    // access rather than cached, because a wasm memory growth (any later
    // ensure call) detaches earlier views. Consumers read these at
    // texture-upload time, immediately before the upload call.
    get atlasData() {
      if (!this.id) return this._rebuiltEmpty ? EMPTY_ATLAS_DATA : null;
      const ptr = wasmModule._atlas_data_ptr(this.id);
      if (ptr === 0) return null;
      return new Uint8Array(
        wasmModule.HEAPU8.buffer,
        ptr,
        this.atlasWidth * this.atlasHeight * 4,
      );
    }

    // The packed atlas bytes in the form an upload call accepts. WebGPU's
    // writeTexture and WebGL's texSubImage2D reject a view over a growable
    // buffer (a browser wasm heap), so those get a copy; a fixed buffer
    // (Deno's) is passed straight through. Called once per revision by the
    // caches below, so the copy is paid once per rebuild, not per upload.
    uploadBytes() {
      const data = this.atlasData;
      if (data === null) return data;
      return data.buffer.resizable || data.buffer.growable
        ? data.slice()
        : data;
    }

    get atlasWidth() {
      if (!this.id) return this._rebuiltEmpty ? 1 : 0;
      return wasmModule._atlas_width(this.id);
    }

    get atlasHeight() {
      if (!this.id) return this._rebuiltEmpty ? 1 : 0;
      return wasmModule._atlas_height(this.id);
    }

    _entryPlacement(slot) {
      return {
        x: wasmModule._atlas_entry_pack_x(this.id, slot),
        y: wasmModule._atlas_entry_pack_y(this.id, slot),
      };
    }

    // The generated-on-GPU texture for a device, if the glyph resource
    // manager built one (rebuildWebGpuTexture / createRequestWebGpuTexture);
    // null otherwise. A probe only: it never uploads.
    webGpuTexture(device) {
      const state = this._webGpuTextures.get(device);
      return state?.generated ? state.texture : null;
    }

    // The packed atlas as a texture on `device`, for every draw that samples
    // it. A GPU-generated texture wins; otherwise the CPU-packed bytes are
    // uploaded ONCE per (device, revision) and held by the atlas until the
    // next rebuild or destroy(). revision is bumped by rebuildAtlas(), the
    // only thing that changes the packed pixels or dimensions, so the key is
    // exact rather than a heuristic on dimensions.
    //
    // Before this cache, the text and svg-path batches created, uploaded and
    // destroyed an atlas texture per draw per frame: the landing page's
    // MOTION section paid ~1 300 writeTexture calls a second for one 568 KB
    // atlas whose revision never moved, and every frame waited on the queue
    // (BUG-motion-frames-wait-on-the-gpu, resolved; see
    // activity/reports/REPORT-2026-10-07-resolved-bug-records.md).
    deviceTexture(device) {
      const cached = this._webGpuTextures.get(device);
      if (cached && (cached.generated || cached.revision === this.revision)) {
        return cached.texture;
      }
      const texture = device.createTexture({
        label: "atlas-upload",
        size: { width: this.atlasWidth, height: this.atlasHeight },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture },
        this.uploadBytes(),
        { bytesPerRow: this.atlasWidth * 4 },
        { width: this.atlasWidth, height: this.atlasHeight },
      );
      if (cached) cached.texture.destroy();
      this._webGpuTextures.set(device, {
        texture,
        placements: new Map(),
        generated: false,
        revision: this.revision,
      });
      return texture;
    }

    async rebuildWebGpuTexture(
      generator,
      generatedGlyphs,
      descriptors,
      sourceAtlas = this,
    ) {
      const device = generator.device;
      const previous = sourceAtlas._webGpuTextures.get(device) ?? null;
      const texture = device.createTexture({
        label: "glyph-resource-atlas",
        size: {
          width: this.atlasWidth,
          height: this.atlasHeight,
        },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
      const uploadStartedAt = performance.now();
      device.queue.writeTexture(
        { texture },
        this.uploadBytes(),
        { bytesPerRow: this.atlasWidth * 4 },
        { width: this.atlasWidth, height: this.atlasHeight },
      );
      const currentPlacements = new Map();
      const encoder = device.createCommandEncoder({
        label: "glyph-resource-atlas-rebuild",
      });
      for (const descriptor of descriptors) {
        const slot = this.glyphSlot(
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        if (slot < 0) continue;
        const information = this.glyphInfo(
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        const placement = this._entryPlacement(slot);
        currentPlacements.set(slot, {
          ...placement,
          width: information.w,
          height: information.h,
        });
        const oldPlacement = previous?.placements.get(
          descriptor.resourceSlot ?? slot,
        );
        if (
          oldPlacement && information.w > 0 && information.h > 0
        ) {
          encoder.copyTextureToTexture(
            {
              texture: previous.texture,
              origin: { x: oldPlacement.x, y: oldPlacement.y },
            },
            { texture, origin: placement },
            { width: information.w, height: information.h },
          );
        }
      }
      device.queue.submit([encoder.finish()]);
      const copyMilliseconds = performance.now() - uploadStartedAt;

      let generationTimings = null;
      try {
        const inked = generatedGlyphs.filter((glyph) =>
          glyph.width > 0 && glyph.height > 0
        );
        if (inked.length > 0) {
          generationTimings = (await generator.generate(
            inked.map((glyph) => glyph.preparedGeometry),
            {
              directAtlas: {
                texture,
                placements: inked.map((glyph) => {
                  const slot = this.glyphSlot(
                    glyph.glyphId,
                    glyph.weight,
                    glyph.opticalSize,
                    glyph.devicePixelSize,
                  );
                  return this._entryPlacement(slot);
                }),
              },
            },
          )).timings;
        } else {
          await device.queue.onSubmittedWorkDone();
        }
      } catch (error) {
        texture.destroy();
        throw error;
      }
      if (previous) previous.texture.destroy();
      this._webGpuTextures.set(device, {
        texture,
        placements: currentPlacements,
        generated: true,
        revision: this.revision,
      });
      return { generationTimings, copyMilliseconds };
    }

    createRequestWebGpuTexture(device, sourceAtlas, descriptors) {
      const source = sourceAtlas._webGpuTextures.get(device);
      if (!source?.generated) return { texture: null, copyMilliseconds: 0 };
      const startedAt = performance.now();
      const texture = device.createTexture({
        label: "glyph-request-atlas",
        size: { width: this.atlasWidth, height: this.atlasHeight },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture },
        this.uploadBytes(),
        { bytesPerRow: this.atlasWidth * 4 },
        { width: this.atlasWidth, height: this.atlasHeight },
      );
      const encoder = device.createCommandEncoder({
        label: "glyph-request-atlas-assembly",
      });
      for (const descriptor of descriptors) {
        const sourceSlot = sourceAtlas.glyphSlot(
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        const destinationSlot = this.glyphSlot(
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        const sourcePlacement = source.placements.get(sourceSlot);
        if (!sourcePlacement || destinationSlot < 0) continue;
        const information = this.glyphInfo(
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        if (information.w === 0 || information.h === 0) continue;
        encoder.copyTextureToTexture(
          {
            texture: source.texture,
            origin: {
              x: sourcePlacement.x,
              y: sourcePlacement.y,
            },
          },
          {
            texture,
            origin: this._entryPlacement(destinationSlot),
          },
          { width: information.w, height: information.h },
        );
      }
      device.queue.submit([encoder.finish()]);
      this._webGpuTextures.set(device, {
        texture,
        placements: new Map(),
        generated: true,
        revision: this.revision,
      });
      return {
        texture,
        copyMilliseconds: performance.now() - startedAt,
      };
    }

    getMsdfParams() {
      return { range: MSDF_RANGE };
    }

    onDestroy(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("atlas destroy listener must be a function");
      }
      this._destroyListeners.add(listener);
      return () => this._destroyListeners.delete(listener);
    }

    // Frees the wasm-side entry pixels, cache table, and packed atlas.
    // Wasm memory is not garbage collected — every owner that drops an
    // atlas (render-scene's per-scene glyph atlases) must call this.
    destroy() {
      const errors = [];
      for (const listener of this._destroyListeners) {
        try {
          listener();
        } catch (error) {
          errors.push(error);
        }
      }
      this._destroyListeners.clear();
      for (const state of this._webGpuTextures.values()) {
        state.texture.destroy();
      }
      this._webGpuTextures.clear();
      if (this.id) wasmModule._atlas_destroy(this.id);
      this.id = 0;
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "atlas graphics resource release failed",
        );
      }
    }
  }

  /**
   * Font-level glyph atlas — one wasm atlas handle per font instance: the
   * font file and the 'wdth' coordinate (variationWidth; 0 for none) and
   * 'slnt' coordinate (variationSlant; 0 for upright) every glyph is
   * outlined at.
   */
  class GlyphAtlas extends WasmAtlas {
    constructor(fontBytes, variationWidth = 0, variationSlant = 0, faceIndex = 0) {
      super(0);
      this.fontBytes = fontBytes;
      this.variationWidth = variationWidth;
      this.variationSlant = variationSlant;
      this.faceIndex = faceIndex;
      this.unitsPerEm = 0;
      // Registered HarfBuzz face in fused renderer memory. The native
      // collector supplies outline bytes and metadata; msdfgen receives
      // only bounded verb spans, never font bytes (design/text-rendering.md).
      this._outlineSource = null;
    }

    // The variation instance a glyph is outlined at: the requested weight,
    // the atlas's width and slant (a font without a 'slnt' axis ignores
    // it), and the clamped optical size (opsz-less fonts take none).
    _outlineVariations(Module, weight, opszCss) {
      const variations = [["wght", weight], ["slnt", this.variationSlant]];
      if (this.variationWidth !== 0) {
        variations.push(["wdth", this.variationWidth]);
      }
      if (this._outlineSource.opszAxis) {
        variations.push([
          "opsz",
          Module._atlas_resolve_opsz(this.id, opszCss ?? Number.NaN),
        ]);
      }
      return variations;
    }

    async _ensureCreated() {
      const created = this.id === 0;
      const Module = await super._ensureCreated();
      if (!this._outlineSource) {
        this._outlineSource = await createGlyphOutlineSource(this.fontBytes, { faceIndex: this.faceIndex });
      }
      if (created) {
        const axis = this._outlineSource.opszAxis;
        const configured = Module._atlas_configure_font(
          this.id,
          this._outlineSource.upem,
          axis ? 1 : 0,
          axis?.min ?? 0,
          axis?.default ?? 0,
          axis?.max ?? 0,
        );
        if (!configured) {
          throw new Error(
            "atlas_configure_font rejected the font metadata — zero units-per-em or a non-glyph atlas handle",
          );
        }
        this.unitsPerEm = this._outlineSource.upem;
      }
      return Module;
    }

    /**
     * Ensure glyphs are cached, generating MSDFs for missing ones — at the
     * given weight, optical size (opszCss, CSS px; null = the font's own
     * default opsz, ignored for opsz-less fonts), and MSDF texel budget
     * (from devicePx). Key construction — opsz clamping, texel-budget
     * bucketing — happens wasm-side (atlas.cpp's makeGlyphKey), so ensure
     * and lookup can never disagree; atlas_resolve_opsz hands back the
     * clamped value so the HarfBuzz variation instance matches the key.
     * On a miss, the outline is extracted from HarfBuzz as a flat verb
     * buffer and marshalled into msdfgen's memory for generation.
     */
    async ensureGlyphs(glyphIds, weight, opszCss = null, devicePx = null) {
      const preparationStartedAt = performance.now();
      const phases = emptyGlyphPhaseMilliseconds();
      const generatedGlyphs = [];
      const requestedGlyphIds = [...glyphIds];
      const Module = await this._ensureCreated();
      const missing = requestedGlyphIds.filter((glyphId) =>
        Module._atlas_lookup_glyph(
          this.id,
          glyphId,
          weight,
          opszCss ?? Number.NaN,
          devicePx ?? 0,
        ) < 0
      );

      if (missing.length > 0) {
        const font = this._outlineSource.createFont(
          this._outlineVariations(Module, weight, opszCss),
        );
        try {
          for (const glyphId of missing) {
            const outlineStartedAt = performance.now();
            const { verbs, advance } = font.glyphOutline(glyphId);
            phases.harfBuzzOutlineExtractionMilliseconds += performance.now() -
              outlineStartedAt;

            const boundaryStartedAt = performance.now();
            const allocationLength = verbs.length || 1;
            const ptr = Module._wasm_alloc(allocationLength);
            let slot;
            try {
              Module.HEAPU8.set(verbs, ptr);
              slot = Module._atlas_insert_glyph(
                this.id,
                glyphId,
                weight,
                opszCss ?? Number.NaN,
                devicePx ?? 0,
                ptr,
                verbs.length,
                advance,
              );
            } finally {
              Module._wasm_dealloc(ptr, allocationLength);
            }
            const boundaryMilliseconds = performance.now() - boundaryStartedAt;
            const nativeTimings = nativeGlyphTiming(Module);
            phases.javascriptToWebAssemblyAllocationCopyCallMilliseconds += Math
              .max(
                0,
                boundaryMilliseconds -
                  nativeTimings.atlasInsertTotalMilliseconds,
              );
            for (
              const field of NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1)
            ) {
              phases[field] += nativeTimings[field];
            }

            if (slot < 0) {
              throw new Error(
                `glyph atlas insert failed for glyphId ${glyphId} — cache table full (atlas.cpp's TABLE_CAP is a hard cap, not an eviction boundary) or malformed outline buffer`,
              );
            }
            const info = this._infoFloats(slot);
            const width = info[0];
            const height = info[1];
            generatedGlyphs.push(Object.freeze({
              glyphId,
              width,
              height,
              texelCount: width * height,
            }));
          }
        } finally {
          font.destroy();
        }
      }

      const measuredPreparationMilliseconds = Object.values(phases).reduce(
        (total, milliseconds) => total + milliseconds,
        0,
      );
      phases.otherPreparationMilliseconds = Math.max(
        0,
        performance.now() - preparationStartedAt -
          measuredPreparationMilliseconds,
      );
      const totalMilliseconds = Object.values(phases).reduce(
        (total, milliseconds) => total + milliseconds,
        0,
      );
      return Object.freeze({
        requestedGlyphCount: requestedGlyphIds.length,
        cacheHitGlyphCount: requestedGlyphIds.length - missing.length,
        generatedGlyphCount: generatedGlyphs.length,
        outputTexelCount: generatedGlyphs.reduce(
          (total, glyph) => total + glyph.texelCount,
          0,
        ),
        generatedGlyphs: Object.freeze(generatedGlyphs),
        phaseMilliseconds: Object.freeze(phases),
        totalMilliseconds,
      });
    }

    /**
     * Runs the unchanged CPU geometry-preparation and edge-coloring phases, then
     * registers metadata-only atlas entries for one WebGPU batch. The selected
     * WebGPU generator validates and consumes the returned prepared records.
     */
    async prepareGlyphsForWebGpu(
      glyphIds,
      weight,
      opszCss = null,
      devicePx = null,
    ) {
      const preparationStartedAt = performance.now();
      const phases = emptyGlyphPhaseMilliseconds();
      const generatedGlyphs = [];
      const requestedGlyphIds = [...glyphIds];
      const Module = await this._ensureCreated();
      const missing = requestedGlyphIds.filter((glyphId) =>
        Module._atlas_lookup_glyph(
          this.id,
          glyphId,
          weight,
          opszCss ?? Number.NaN,
          devicePx ?? 0,
        ) < 0
      );
      if (missing.length > 0) {
        const font = this._outlineSource.createFont(
          this._outlineVariations(Module, weight, opszCss),
        );
        try {
          for (const glyphId of missing) {
            const outlineStartedAt = performance.now();
            const { verbs, advance } = font.glyphOutline(glyphId);
            phases.harfBuzzOutlineExtractionMilliseconds += performance.now() -
              outlineStartedAt;

            const boundaryStartedAt = performance.now();
            const verbsLength = verbs.length || 1;
            const verbsPointer = Module._wasm_alloc(verbsLength);
            let preparedPointer = 0;
            let preparedCapacity = 96;
            let preparedLength = 0;
            try {
              Module.HEAPU8.set(verbs, verbsPointer);
              preparedPointer = Module._wasm_alloc(preparedCapacity);
              const msdfSize = Module._atlas_glyph_msdf_size(
                this.id,
                devicePx ?? 0,
              );
              const minimumShapeUnitsPerTexel = Module
                ._atlas_glyph_minimum_shape_units_per_texel(
                  this.id,
                  devicePx ?? 0,
                );
              preparedLength = Module._prepare_outline_msdf_geometry(
                verbsPointer,
                verbs.length,
                msdfSize,
                MSDF_RANGE,
                minimumShapeUnitsPerTexel,
                preparedPointer,
                preparedCapacity,
              );
              if (preparedLength > preparedCapacity) {
                Module._wasm_dealloc(preparedPointer, preparedCapacity);
                preparedCapacity = preparedLength;
                preparedPointer = Module._wasm_alloc(preparedCapacity);
                preparedLength = Module._prepare_outline_msdf_geometry(
                  verbsPointer,
                  verbs.length,
                  msdfSize,
                  MSDF_RANGE,
                  minimumShapeUnitsPerTexel,
                  preparedPointer,
                  preparedCapacity,
                );
              }
              if (preparedLength === 0 || preparedLength > preparedCapacity) {
                throw new Error(
                  `prepared glyph geometry failed for glyphId ${glyphId}`,
                );
              }
              const preparedGeometry = Module.HEAPU8.slice(
                preparedPointer,
                preparedPointer + preparedLength,
              );
              const slot = Module._atlas_insert_prepared_glyph(
                this.id,
                glyphId,
                weight,
                opszCss ?? Number.NaN,
                devicePx ?? 0,
                preparedPointer,
                preparedLength,
                advance,
              );
              if (slot < 0) {
                throw new Error(
                  `prepared glyph atlas insert failed for glyphId ${glyphId}`,
                );
              }
              const view = new DataView(
                preparedGeometry.buffer,
                preparedGeometry.byteOffset,
                preparedGeometry.byteLength,
              );
              const width = view.getUint32(8, true);
              const height = view.getUint32(12, true);
              generatedGlyphs.push(Object.freeze({
                glyphId,
                weight,
                opticalSize: opszCss,
                devicePixelSize: devicePx,
                width,
                height,
                texelCount: width * height,
                advance,
                preparedGeometry,
              }));
            } finally {
              if (preparedPointer) {
                Module._wasm_dealloc(preparedPointer, preparedCapacity);
              }
              Module._wasm_dealloc(verbsPointer, verbsLength);
            }
            const nativeTimings = nativeGlyphTiming(Module);
            const nativeTotal = NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1).reduce(
              (total, field) => total + nativeTimings[field],
              0,
            );
            phases.javascriptToWebAssemblyAllocationCopyCallMilliseconds += Math
              .max(0, performance.now() - boundaryStartedAt - nativeTotal);
            for (const field of NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1)) {
              phases[field] += nativeTimings[field];
            }
          }
        } finally {
          font.destroy();
        }
      }
      const measured = Object.values(phases).reduce(
        (total, milliseconds) => total + milliseconds,
        0,
      );
      phases.otherPreparationMilliseconds = Math.max(
        0,
        performance.now() - preparationStartedAt - measured,
      );
      return Object.freeze({
        requestedGlyphCount: requestedGlyphIds.length,
        cacheHitGlyphCount: requestedGlyphIds.length - missing.length,
        generatedGlyphCount: generatedGlyphs.length,
        outputTexelCount: generatedGlyphs.reduce(
          (total, glyph) => total + glyph.texelCount,
          0,
        ),
        generatedGlyphs: Object.freeze(generatedGlyphs),
        phaseMilliseconds: Object.freeze(phases),
        totalMilliseconds: Object.values(phases).reduce(
          (total, milliseconds) => total + milliseconds,
          0,
        ),
      });
    }

    hydratePreparedGlyphForCpu(glyph) {
      const Module = this._ensureCreatedSync();
      const startedAt = performance.now();
      const preparedPointer = Module._wasm_alloc(glyph.preparedGeometry.length);
      try {
        Module.HEAPU8.set(glyph.preparedGeometry, preparedPointer);
        const slot = Module._atlas_hydrate_prepared_glyph(
          this.id,
          glyph.glyphId,
          glyph.weight,
          glyph.opticalSize ?? Number.NaN,
          glyph.devicePixelSize ?? 0,
          preparedPointer,
          glyph.preparedGeometry.length,
          glyph.advance,
        );
        if (slot < 0) {
          throw new Error(
            `CPU glyph hydration failed for glyphId ${glyph.glyphId}`,
          );
        }
        const phases = emptyGlyphPhaseMilliseconds();
        const nativeTimings = nativeGlyphTiming(Module);
        for (const field of NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1)) {
          phases[field] = nativeTimings[field];
        }
        const measured = Object.values(phases).reduce(
          (total, milliseconds) => total + milliseconds,
          0,
        );
        phases.javascriptToWebAssemblyAllocationCopyCallMilliseconds = Math.max(
          0,
          performance.now() - startedAt - measured,
        );
        return Object.freeze({
          slot,
          phaseMilliseconds: Object.freeze(phases),
        });
      } finally {
        Module._wasm_dealloc(preparedPointer, glyph.preparedGeometry.length);
      }
    }

    /**
     * Copy an already-generated glyph field from a resource atlas into this
     * atlas. This configures a new destination from the source font metadata,
     * but deliberately does not create another HarfBuzz outline source and
     * never calls MSDF generation. Request-scoped atlases use this path so
     * their packing contains only the current render's glyph set.
     */
    async copyGlyphFrom(
      sourceAtlas,
      glyphId,
      weight,
      opszCss = null,
      devicePx = null,
    ) {
      if (!(sourceAtlas instanceof GlyphAtlas)) {
        throw new TypeError("glyph resource source must be a GlyphAtlas");
      }
      const Module = await sourceAtlas._ensureCreated();
      if (!this.id) {
        await super._ensureCreated();
        const axis = sourceAtlas._outlineSource.opszAxis;
        const configured = Module._atlas_configure_font(
          this.id,
          sourceAtlas.unitsPerEm,
          axis ? 1 : 0,
          axis?.min ?? 0,
          axis?.default ?? 0,
          axis?.max ?? 0,
        );
        if (!configured) {
          throw new Error("glyph request atlas rejected source font metadata");
        }
        this.unitsPerEm = sourceAtlas.unitsPerEm;
      }
      const slot = Module._atlas_copy_glyph(
        this.id,
        sourceAtlas.id,
        glyphId,
        weight,
        opszCss ?? Number.NaN,
        devicePx ?? 0,
      );
      if (slot < 0) {
        throw new Error(
          `glyph resource copy failed for glyphId ${glyphId} — source miss, font mismatch, or request atlas full`,
        );
      }
      return slot;
    }

    glyphSlot(glyphId, weight, opszCss = null, devicePx = null) {
      if (!this.id) return -1;
      return wasmModule._atlas_lookup_glyph(
        this.id,
        glyphId,
        weight,
        opszCss ?? Number.NaN,
        devicePx ?? 0,
      );
    }
    glyphResidency(glyphIds, weight, opszCss = null, devicePx = null) {
      const slots = new Int32Array(glyphIds.length);
      if (!glyphIds.length) return slots;
      if (!this.id) {
        slots.fill(-1);
        return slots;
      }
      return this._glyphKeyBatch(
        this._ensureCreatedSync(),
        GlyphPolicy.MODE_RESIDENCY,
        "residency",
        glyphIds,
        weight,
        opszCss,
        devicePx,
        (view, outputPointer) => {
          for (let index = 0; index < glyphIds.length; index++) {
            slots[index] = view.getInt32(
              outputPointer + index * GlyphPolicy.RESIDENCY_SIZE +
                GlyphPolicy.RESIDENCY_SLOT_OFFSET,
              true,
            );
          }
          return slots;
        },
      );
    }

    // Runs one glyph-policy key batch over glyphIds at one weight, optical
    // size and device size, and hands its published output records to
    // readOutput(view, outputPointer).
    _glyphKeyBatch(Module, mode, label, glyphIds, weight, opszCss, devicePx, readOutput) {
      const batch = Module._atlas_glyph_keys_create(glyphIds.length, mode);
      if (!batch) {
        const error = GlyphPolicy.readError(
          new DataView(Module.HEAPU8.buffer),
          Module._atlas_glyph_keys_error_ptr(),
        );
        throw new Error(
          `glyph ${label} batch creation failed (${error.code}:${error.field})`,
        );
      }
      try {
        const inputPointer = Module._atlas_glyph_keys_input_ptr(batch);
        const view = new DataView(Module.HEAPU8.buffer);
        for (let index = 0; index < glyphIds.length; index++) {
          const row = inputPointer + index * GlyphPolicy.INPUT_SIZE;
          view.setFloat64(
            row + GlyphPolicy.INPUT_GLYPH_ID_OFFSET,
            glyphIds[index],
            true,
          );
          view.setFloat64(row + GlyphPolicy.INPUT_WEIGHT_OFFSET, weight, true);
          view.setFloat64(
            row + GlyphPolicy.INPUT_OPTICAL_SIZE_OFFSET,
            opszCss ?? 0,
            true,
          );
          view.setFloat64(
            row + GlyphPolicy.INPUT_DEVICE_PIXEL_SIZE_OFFSET,
            devicePx ?? 0,
            true,
          );
          view.setUint32(
            row + GlyphPolicy.INPUT_OPTICAL_SIZE_PRESENT_OFFSET,
            Number(opszCss !== null),
            true,
          );
          view.setUint32(
            row + GlyphPolicy.INPUT_DEVICE_PIXEL_SIZE_PRESENT_OFFSET,
            Number(devicePx !== null),
            true,
          );
        }
        if (!Module._atlas_glyph_keys_execute(batch, this.id)) {
          const error = GlyphPolicy.readError(
            new DataView(Module.HEAPU8.buffer),
            Module._atlas_glyph_keys_error_ptr(),
          );
          throw new Error(
            `glyph ${label} query failed (${error.code}:${error.field}:${error.recordIndex})`,
          );
        }
        return readOutput(
          new DataView(Module.HEAPU8.buffer),
          Module._atlas_glyph_keys_output_ptr(batch),
        );
      } finally {
        Module._atlas_glyph_keys_destroy(batch);
      }
    }

    get generationCount() {
      return this.id ? wasmModule._atlas_generation_count(this.id) : 0;
    }

    destroy() {
      super.destroy();
      if (this._outlineSource) {
        this._outlineSource.destroy();
        this._outlineSource = null;
      }
    }

    /**
     * Draw-time lookup — the single key rule the old keyFor/glyphCache pair
     * implemented, now resolved wasm-side. Takes the same raw values
     * ensureGlyphs took; returns null for a glyph that was never ensured.
     */
    // The same lookup as a view over the entry's residency floats (w, h,
    // u, v, uW, vH, bearingX, bearingY, advance, bboxXMin, bboxYMin,
    // bboxXMax, bboxYMax, msdfWidth, msdfHeight; the GlyphPolicy residency
    // layout), valid until the next atlas operation: the draw loop reads
    // every glyph of every frame through it and builds no objects.
    glyphInfoFloats(glyphId, weight, opszCss = null, devicePx = null) {
      if (!this.id) return null;
      const slot = wasmModule._atlas_lookup_glyph(
        this.id,
        glyphId,
        weight,
        opszCss ?? Number.NaN,
        devicePx ?? 0,
      );
      if (slot < 0) return null;
      return this._infoFloats(slot);
    }

    glyphInfo(glyphId, weight, opszCss = null, devicePx = null) {
      const f = this.glyphInfoFloats(glyphId, weight, opszCss, devicePx);
      if (f === null) return null;
      return {
        w: f[0],
        h: f[1],
        u: f[2],
        v: f[3],
        uW: f[4],
        vH: f[5],
        metrics: {
          bearingX: f[6],
          bearingY: f[7],
          advance: f[8],
          bboxXMin: f[9],
          bboxYMin: f[10],
          bboxXMax: f[11],
          bboxYMax: f[12],
          msdfWidth: f[13],
          msdfHeight: f[14],
        },
      };
    }
  }

  /**
   * MSDF atlas for arbitrary SVG path shapes (design/svg-rendering.md, Tier B) — keyed
   * by path content + fill-rule + scale bucket (+ stroke params), one
   * shared instance across every svg-path/svg-polygon/svg-polyline node in
   * a scene.
   */
  class SvgPathAtlas extends WasmAtlas {
    constructor({ coverageMode = false } = {}) {
      super(1);
      this._pathBoundsByKey = new Map();
      this.coverageMode = coverageMode;
      // pathIndex -> the entry its alias was last ensured from, with the
      // atlas handle. The atlas never evicts an entry, so a path index
      // ensured again from the same definition and screen size names the
      // same slot: ensurePaths skips it instead of encoding its `d` string
      // and probing the atlas every frame.
      this._ensuredByPathIndex = new Map();
    }

    destroy() {
      this._ensuredByPathIndex.clear();
      super.destroy();
    }

    get generationCount() {
      return this.id ? wasmModule._atlas_generation_count(this.id) : 0;
    }

    // The SVG scene writer needs the path bbox before it knows the screen
    // size. Measure geometry without constructing a throwaway distance field;
    // both the async and layout-getter paths share the same cached result.
    async measurePathBounds(pathDef, fillRule) {
      const Module = await this._ensureCreated();
      return this._measurePathBounds(Module, pathDef, fillRule);
    }

    measurePathBoundsSync(pathDef, fillRule) {
      const Module = this._ensureCreatedSync();
      return this._measurePathBounds(Module, pathDef, fillRule);
    }

    _measurePathBounds(Module, pathDef, fillRule) {
      const key = `${fillRule}\0${pathDef}`;
      const cached = this._pathBoundsByKey.get(key);
      if (cached) return cached;
      const bytes = textEncoder.encode(pathDef);
      const pathPtr = Module._wasm_alloc(bytes.length || 1);
      const boundsPtr = Module._wasm_alloc(16);
      let bounds;
      try {
        Module.HEAPU8.set(bytes, pathPtr);
        Module._measure_path_fill_bounds(
          pathPtr,
          bytes.length,
          fillRule === "evenodd" ? 1 : 0,
          boundsPtr,
        );
        const values = new Float32Array(Module.HEAPU8.buffer, boundsPtr, 4);
        bounds = {
          xMin: values[0],
          yMin: values[1],
          xMax: values[2],
          yMax: values[3],
        };
      } finally {
        Module._wasm_dealloc(boundsPtr, 16);
        Module._wasm_dealloc(pathPtr, bytes.length || 1);
      }
      this._pathBoundsByKey.set(key, bounds);
      return bounds;
    }

    /**
     * Ensure MSDFs exist for the given { pathDef, fillRule, screenSize,
     * pathIndex?, stroke? } combinations — same entry shape as before (see
     * render-scene.js's callers). stroke selects the stroke-outline shape
     * (stroke-outline shapes get their own atlas entry); pathIndex registers the CMD_SVG_PATH alias resolved
     * by getPathByIndex.
     */
    async ensurePaths(entries) {
      const Module = await this._ensureCreated();
      this._ensureEntries(Module, entries);
    }

    // Synchronous counterpart of ensurePaths, for the layout-getter fast
    // path — throws (via _ensureCreatedSync) rather than awaiting if the
    // wasm module isn't loaded yet.
    ensurePathsSync(entries) {
      this._ensureEntries(this._ensureCreatedSync(), entries);
    }

    _ensureEntries(Module, entries) {
      for (const entry of entries) {
        if (entry.pathIndex === undefined) {
          this._ensurePath(Module, entry);
          continue;
        }
        const ensured = this._ensuredByPathIndex.get(entry.pathIndex);
        if (
          ensured !== undefined && ensured.id === this.id &&
          ensured.pathDef === entry.pathDef && ensured.fillRule === entry.fillRule &&
          ensured.stroke === entry.stroke && ensured.screenSize === entry.screenSize
        ) continue;
        const slot = this._ensurePath(Module, entry);
        Module._atlas_alias_path_index(this.id, entry.pathIndex, slot);
        this._ensuredByPathIndex.set(entry.pathIndex, {
          id: this.id,
          pathDef: entry.pathDef,
          fillRule: entry.fillRule,
          stroke: entry.stroke,
          screenSize: entry.screenSize,
        });
      }
    }

    _ensurePath(Module, { pathDef, fillRule, screenSize, stroke }) {
      const slot = this._pathCall(
        Module._atlas_ensure_path,
        pathDef,
        fillRule,
        screenSize,
        stroke,
      );
      if (slot < 0) {
        throw new Error(
          `svg path atlas cache table full — atlas.cpp's TABLE_CAP is a hard cap, not an eviction boundary`,
        );
      }
      return slot;
    }

    // Shared marshalling for ensure and lookup — the path bytes and the
    // normalized stroke params (cap/join default 0, miterLimit default 4,
    // dash by value) must be IDENTICAL between the two, or lookups silently
    // miss entries ensure just created.
    _pathCall(wasmFunction, pathDef, fillRule, screenSize, stroke) {
      const Module = wasmModule;
      const pathBytes = textEncoder.encode(pathDef);
      const pathPtr = Module._wasm_alloc(pathBytes.length);
      Module.HEAPU8.set(pathBytes, pathPtr);
      const dashArray = stroke?.dashArray ?? [];
      let dashPtr = 0;
      if (dashArray.length) {
        dashPtr = Module._wasm_alloc(dashArray.length * 4);
        new Float32Array(Module.HEAPU8.buffer, dashPtr, dashArray.length).set(
          dashArray,
        );
      }

      const slot = wasmFunction(
        this.id,
        pathPtr,
        pathBytes.length,
        fillRule === "evenodd" ? 1 : 0,
        screenSize,
        stroke ? 1 : 0,
        stroke?.width ?? 0,
        stroke?.cap ?? 0,
        stroke?.join ?? 0,
        stroke?.miterLimit ?? 4,
        dashPtr,
        dashArray.length,
        stroke?.dashPhase ?? 0,
        this.coverageMode ? 1 : 0,
      );
      if (dashPtr) Module._wasm_dealloc(dashPtr, dashArray.length * 4);
      Module._wasm_dealloc(pathPtr, pathBytes.length);
      return slot;
    }

    /**
     * Get path info (UV + bbox metrics) for a combination already ensured
     * via ensurePaths. Read-only — a miss returns null, never generates.
     */
    getPath(pathDef, fillRule, screenSize, stroke) {
      if (!this.id) return null;
      const slot = this._pathCall(
        wasmModule._atlas_lookup_path,
        pathDef,
        fillRule,
        screenSize,
        stroke,
      );
      return this._pathInfo(slot);
    }

    /**
     * Get path info by the opaque pathIndex a CMD_SVG_PATH command carries —
     * the rasterizer's own lookup path (it never sees pathDef/fillRule/
     * screenSize; see engine.wat's NODE_SVG_PATH_INDEX doc).
     */
    getPathByIndex(pathIndex) {
      if (!this.id) return null;
      return this._pathInfo(
        wasmModule._atlas_path_slot_by_index(this.id, pathIndex),
      );
    }

    _pathInfo(slot) {
      if (slot < 0) return null;
      const f = this._infoFloats(slot);
      if (!f) return null;
      return {
        pixelW: f[0],
        pixelH: f[1],
        bboxXMin: f[9],
        bboxYMin: f[10],
        bboxXMax: f[11],
        bboxYMax: f[12],
        u: f[2],
        v: f[3],
        uW: f[4],
        vH: f[5],
      };
    }
  }

  return Object.freeze({
    initializeAtlasRuntime,
    GlyphAtlas,
    SvgPathAtlas,
    moduleIdentity() {
      return wasmModule;
    },
  });
}

const defaultAtlasRuntime = createAtlasRuntime();

export const initializeAtlasRuntime = (...arguments_) =>
  defaultAtlasRuntime.initializeAtlasRuntime(...arguments_);
export class GlyphAtlas extends defaultAtlasRuntime.GlyphAtlas {}
export class SvgPathAtlas extends defaultAtlasRuntime.SvgPathAtlas {}
