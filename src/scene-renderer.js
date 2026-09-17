// Shared scene rendering machinery for the gallery AND the headless pixel test.
// Single source of truth for: spec → WAT layout nodes, spec → equivalent
// CSS/HTML (the Chrome side), and lay-out-and-render to pixels. Both the visible
// gallery and the test import these, so the test renders the exact same bytes
// the gallery shows.

const resourceMeasurementKey = Symbol.for("sandom.domCore.measurement");
const engineWriteClaims = new WeakMap();

import { loadEngine } from "./wasm/loader.js";
import {
  attachBoxSnapshot,
  releaseBoxSnapshot,
  retainBoxSnapshot,
} from "./dom-wasm/geometry-wire.js";
const domMeasurementKey = Symbol.for("sandom.domCore.measurement");
import {
  createRenderContext,
  releaseSharedWebgl2State,
  releaseSharedWebgpuStates,
  render,
} from "./rasterize.js";
import { createAnimationController } from "./animations.js";
import {
  animationTransitionChanged,
  animationTransitionProperties,
} from "./dom-wasm/animation.js";
import { encodeImage } from "./output/image.js";
import { createAtlasRuntime, emptyGlyphPhaseMilliseconds } from "./atlas.js";
import { GlyphResourceManager } from "./glyph-resource-manager.js";
export {
  DEFAULT_GLYPH_RESOURCE_LIMITS,
  GLYPH_RESOURCE_FORMAT_VERSION,
  GlyphResourceManager,
} from "./glyph-resource-manager.js";
import { createImageCodecRuntime } from "./jpeg.js";
import { createWebPDecoder } from "./webp.js";
import { createJpegXlCodec } from "./jpeg-xl.js";
import {
  lazyAssetBytes,
  prepareSandomRuntimeOptions,
} from "./runtime-assets.js";
import { prepareImageProfile, toSrgbRgba8 } from "./image-data.js";
import { convertXyzToLinearRgb, encodeSrgbTransfer } from "./color.js";
import { createShapingRuntime } from "./shaping.js";
import { readFontMetrics } from "./font-metrics.js";
import { readBinaryFile } from "./host.js";
import {
  createFontRegistry,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  defaultFontRegistry,
} from "./font-registry.js";
import {
  gridTrackCss,
  scaleGridTrack,
} from "./grid-tracks.js";
import { DomCore, sharedDomCore } from "./dom-wasm/core.js";
import { publishDirectSceneInput } from "./dom-wasm/direct-scene-input.js";
import {
  EngineFrameFinishRowFields,
  EngineFrameFinishRowSize,
  EngineFrameResolutionFields,
  EngineFrameResolutionSize,
  writeEngineFrameInput,
} from "./dom-wasm/record-readers.generated.js";
import {
  BLEND_MODE_NAMES,
  BORDER_STYLE_DASHED,
  BORDER_STYLE_DOTTED,
  BORDER_STYLE_DOUBLE,
  BORDER_STYLE_GROOVE,
  BORDER_STYLE_HIDDEN,
  BORDER_STYLE_INSET,
  BORDER_STYLE_NONE,
  BORDER_STYLE_OUTSET,
  BORDER_STYLE_RIDGE,
  BORDER_STYLE_SOLID,
  BOX_OFFSET_CONTENT_H,
  BOX_OFFSET_CONTENT_W,
  BOX_OFFSET_CONTENT_X,
  BOX_OFFSET_CONTENT_Y,
  BOX_OFFSET_HEIGHT,
  BOX_OFFSET_WIDTH,
  BOX_OFFSET_X,
  BOX_OFFSET_Y,
  BOX_SIZE,
  CLEAR_BOTH,
  CLEAR_LEFT,
  CLEAR_NONE,
  CLEAR_RIGHT,
  CLIP_ENTRY_FLAG_AFFINE,
  CLIP_ENTRY_FLAG_PATH_MASK,
  CLIP_ENTRY_OFFSET_AFFINE,
  CLIP_ENTRY_OFFSET_FLAGS,
  CLIP_ENTRY_OFFSET_H,
  CLIP_ENTRY_OFFSET_RADII,
  CLIP_ENTRY_OFFSET_W,
  CLIP_ENTRY_OFFSET_X,
  CLIP_ENTRY_OFFSET_Y,
  CLIP_ENTRY_SIZE,
  CMD_BOX_SHADOW,
  CMD_BOX_SHADOW_FLAG_TRANSFORM,
  CMD_BOX_SHADOW_OFFSET_FLAGS,
  CMD_BOX_SHADOW_OFFSET_H,
  CMD_BOX_SHADOW_OFFSET_W,
  CMD_BOX_SHADOW_OFFSET_X,
  CMD_BOX_SHADOW_OFFSET_XFORM,
  CMD_BOX_SHADOW_OFFSET_Y,
  CMD_IMAGE,
  CMD_IMAGE_FLAG_TRANSFORM,
  CMD_IMAGE_OFFSET_FLAGS,
  CMD_IMAGE_OFFSET_H,
  CMD_IMAGE_OFFSET_W,
  CMD_IMAGE_OFFSET_X,
  CMD_IMAGE_OFFSET_XFORM,
  CMD_IMAGE_OFFSET_Y,
  CMD_POP_BACKDROP_FILTER,
  CMD_POP_BACKGROUND,
  CMD_POP_BLEND_LAYER,
  CMD_POP_CLIP,
  CMD_POP_MASK_LAYER,
  CMD_POP_OPACITY,
  CMD_PUSH_BACKDROP_FILTER,
  CMD_PUSH_BACKGROUND,
  CMD_PUSH_BLEND_LAYER,
  CMD_PUSH_BLEND_LAYER_OFFSET_MODE,
  CMD_PUSH_CLIP,
  CMD_PUSH_CLIP_HEADER_SIZE,
  CMD_PUSH_CLIP_OFFSET_COUNT,
  CMD_PUSH_MASK,
  CMD_PUSH_MASK_LAYER,
  CMD_PUSH_OPACITY,
  CMD_PUSH_OPACITY_FLAG_BLEND_MASK,
  CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT,
  CMD_PUSH_OPACITY_OFFSET_ALPHA,
  CMD_PUSH_OPACITY_OFFSET_FLAGS,
  CMD_RECT,
  CMD_RECT_FLAG_TRANSFORM,
  CMD_RECT_OFFSET_FLAGS,
  CMD_RECT_OFFSET_H,
  CMD_RECT_OFFSET_W,
  CMD_RECT_OFFSET_X,
  CMD_RECT_OFFSET_XFORM,
  CMD_RECT_OFFSET_Y,
  CMD_SET_NODE,
  CMD_SET_NODE_OFFSET_INDEX,
  CMD_SVG_PATH,
  CMD_SVG_PATH_FLAG_TRANSFORM,
  CMD_SVG_PATH_OFFSET_FLAGS,
  CMD_SVG_PATH_OFFSET_H,
  CMD_SVG_PATH_OFFSET_INDEX,
  CMD_SVG_PATH_OFFSET_W,
  CMD_SVG_PATH_OFFSET_X,
  CMD_SVG_PATH_OFFSET_XFORM,
  CMD_SVG_PATH_OFFSET_Y,
  CMD_TEXT,
  CMD_TEXT_FLAG_TEXT_SHADOW,
  CMD_TEXT_FLAG_TRANSFORM,
  CMD_TEXT_OFFSET_ASCENT,
  CMD_TEXT_OFFSET_BL,
  CMD_TEXT_OFFSET_DESCENT,
  CMD_TEXT_OFFSET_FLAGS,
  CMD_TEXT_OFFSET_FONT,
  CMD_TEXT_OFFSET_FSIZE,
  CMD_TEXT_OFFSET_GCOUNT,
  CMD_TEXT_OFFSET_GOFF,
  CMD_TEXT_OFFSET_LH,
  CMD_TEXT_OFFSET_UPEM,
  CMD_TEXT_OFFSET_WEIGHT,
  CMD_TEXT_OFFSET_X,
  CMD_TEXT_OFFSET_XFORM,
  CMD_TEXT_OFFSET_Y,
  COMMAND_BUFFER_BASE,
  commandByteSize,
  FLOAT_LEFT,
  FLOAT_NONE,
  FLOAT_RIGHT,
  FONT_TABLE_BASE,
  FONT_TABLE_ENTRY_SIZE,
  FONT_TABLE_MAX_ENTRIES,
  FONT_TABLE_OFFSET_ASCENDER,
  FONT_TABLE_OFFSET_DESCENDER,
  FONT_TABLE_OFFSET_LINE_GAP,
  FONT_TABLE_OFFSET_UPEM,
  GLYPH_ENTRY_SIZE,
  GLYPH_ID_INVISIBLE,
  GLYPH_OFFSET_CLUSTER_END,
  GLYPH_OFFSET_CLUSTER_START,
  GLYPH_OFFSET_ID,
  GLYPH_OFFSET_X_ADVANCE,
  GLYPH_OFFSET_X_OFFSET,
  GRADIENT_STOP_POOL_BASE,
  GRADIENT_STOP_POOL_SIZE,
  HEADER_BASE,
  HEADER_OFFSET_GENERATION,
  IMAGE_TABLE_MAX_ENTRIES,
  LAYOUT_NODE_OFFSET_BG_COLOR,
  LAYOUT_NODE_OFFSET_BORDER_LEFT,
  LAYOUT_NODE_OFFSET_BORDER_RIGHT,
  LAYOUT_NODE_OFFSET_CHANGED_GEN,
  LAYOUT_NODE_OFFSET_DIRECTION_RTL,
  LAYOUT_NODE_OFFSET_FLEX_BASIS,
  LAYOUT_NODE_OFFSET_FLEX_BASIS_PERCENT,
  LAYOUT_NODE_OFFSET_FLEX_BASIS_TAG,
  LAYOUT_NODE_OFFSET_FONT_INDEX,
  LAYOUT_NODE_OFFSET_FONT_SIZE,
  LAYOUT_NODE_OFFSET_HEIGHT,
  LAYOUT_NODE_OFFSET_HEIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_HEIGHT_TAG,
  LAYOUT_NODE_OFFSET_INSET_BOTTOM,
  LAYOUT_NODE_OFFSET_INSET_BOTTOM_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_BOTTOM_TAG,
  LAYOUT_NODE_OFFSET_INSET_LEFT,
  LAYOUT_NODE_OFFSET_INSET_LEFT_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_LEFT_TAG,
  LAYOUT_NODE_OFFSET_INSET_RIGHT,
  LAYOUT_NODE_OFFSET_INSET_RIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_RIGHT_TAG,
  LAYOUT_NODE_OFFSET_INSET_TOP,
  LAYOUT_NODE_OFFSET_INSET_TOP_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_TOP_TAG,
  LAYOUT_NODE_OFFSET_LINE_HEIGHT,
  LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG,
  LAYOUT_NODE_OFFSET_MAX_H_TAG,
  LAYOUT_NODE_OFFSET_MAX_HEIGHT,
  LAYOUT_NODE_OFFSET_MAX_HEIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_MAX_W_TAG,
  LAYOUT_NODE_OFFSET_MAX_WIDTH,
  LAYOUT_NODE_OFFSET_MAX_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_MIN_H_TAG,
  LAYOUT_NODE_OFFSET_MIN_HEIGHT,
  LAYOUT_NODE_OFFSET_MIN_HEIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_MIN_W_TAG,
  LAYOUT_NODE_OFFSET_MIN_WIDTH,
  LAYOUT_NODE_OFFSET_MIN_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_OPACITY,
  LAYOUT_NODE_OFFSET_TRANSFORM,
  LAYOUT_NODE_OFFSET_TRANSFORM_KIND,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT,
  LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT,
  LAYOUT_NODE_OFFSET_VISIBILITY_HIDDEN,
  LAYOUT_NODE_OFFSET_WIDTH,
  LAYOUT_NODE_OFFSET_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_WIDTH_TAG,
  LAYOUT_NODE_SIZE,
  LAYOUT_UNIT,
  LINE_HEIGHT_LENGTH,
  LINE_HEIGHT_NORMAL,
  LINE_HEIGHT_NUMBER,
  SCROLL_DATA_ENTRY_SIZE,
  SCROLL_DATA_OFFSET_EFFECTIVE_LEFT,
  SCROLL_DATA_OFFSET_EFFECTIVE_TOP,
  SCROLL_DATA_OFFSET_HEIGHT,
  SCROLL_DATA_OFFSET_STICKY_LEFT,
  SCROLL_DATA_OFFSET_STICKY_TOP,
  SCROLL_DATA_OFFSET_WIDTH,
  SIZE_TAG_CALC_PAIR,
  SIZE_TAG_LENGTH,
  SIZE_TAG_MAX_CONTENT,
  SIZE_TAG_MIN_CONTENT,
  SIZE_TAG_PERCENT,
  TEXT_LINE_ENTRY_SIZE,
  TEXT_LINE_OFFSET_AVAIL,
  TEXT_LINE_OFFSET_FIRST_GLYPH,
  TEXT_LINE_OFFSET_GLYPH_COUNT,
  TEXT_LINE_OFFSET_WIDTH,
  TEXT_LINE_OFFSET_X,
  TEXT_LINE_OFFSET_Y,
  TEXT_RUN_ENTRY_SIZE,
  TEXT_RUN_OFFSET_LINE_COUNT,
  TEXT_RUN_OFFSET_LINE_OFFSET,
  TILE_CONFIG_BASE,
  TRANSFORM_KIND_RESOLVED,
} from "./wasm/layout.js";

export { LAYOUT_UNIT };

export async function createSceneRendererRuntime({
  harfbuzzBytes = null,
  msdfgenBytes = null,
  fontRegistry: suppliedFontRegistry = null,
  graphicsDevice = null,
  resolveSystemFontFamily = null,
  shapingRuntime: suppliedShapingRuntime = null,
  atlasRuntime: suppliedAtlasRuntime = null,
  codecRuntime: suppliedCodecRuntime = null,
  // The DOM core whose memory this runtime's engine shares. The realm's
  // default runtime renders the realm's documents and passes sharedDomCore;
  // an isolated runtime keeps its own memory (design/memory-map.md).
  core = new DomCore(),
} = {}) {
  const shapingRuntime = suppliedShapingRuntime ??
    createShapingRuntime({ harfbuzzBytes });
  const atlasRuntime = suppliedAtlasRuntime ??
    createAtlasRuntime({
      msdfgenBytes,
      createGlyphOutlineSource: shapingRuntime.createGlyphOutlineSource,
    });
  const fontRegistry = suppliedFontRegistry ??
    createFontRegistry({ resolveSystemFontFamily, core });
  if (fontRegistry.core && fontRegistry.core !== core) {
    throw new TypeError("Font registry belongs to another renderer core");
  }
  core.defaultFontRegistry = fontRegistry;
  const codecRuntime = suppliedCodecRuntime ?? createImageCodecRuntime();
  const {
    initializeAtlasRuntime,
    SvgPathAtlas,
  } = atlasRuntime;
  const {
    shapeText,
  } = shapingRuntime;
  const {
    fontFamilyCssValue,
    fontFamilyKeyForCssValue,
    fontFileFor,
    fontWeightInCssUnits,
    isVariableFamily,
  } = fontRegistry;
  const { decodeImage, imageMimeType } = codecRuntime;
  if (
    graphicsDevice !== null &&
    (typeof graphicsDevice?.createBuffer !== "function" ||
      typeof graphicsDevice?.queue?.submit !== "function")
  ) {
    throw new TypeError("graphicsDevice must be a GPUDevice");
  }
  const graphicsStateOwner = graphicsDevice === null
    ? {}
    : { webgpuDevice: graphicsDevice };
  // Engine layout-buffer occupancy. Persistent renderers created through
  // this runtime share ONE engine; a renderer's incremental node diff is
  // only valid while the engine memory still holds THAT renderer's scene.
  // Every writer nulls the owner (writeSceneNodesAndTileConfig below);
  // renderScenePixels re-claims it after its main write when the caller
  // passes an engineWriteOwner token. A caller whose token no longer
  // matches the current owner gets a full node rewrite instead of its
  // incremental set — writeNode is write-if-changed, so generations still
  // advance only where bytes genuinely differ.
  let engineWriteOwner = null;
  // The rows a synchronous layout getter left in the engine on behalf of
  // the surface that owns the write claim (layoutTreeBoxesSync), for the
  // frame that takes the same serialization to reuse instead of publishing
  // every row again. Any other engine write supersedes it.
  let syncLayoutWrite = null;
  const retainedPreparations = new WeakMap();

  function releaseRetainedPreparation(owner) {
    const retained = owner && retainedPreparations.get(owner);
    if (!retained) return;
    retainedPreparations.delete(owner);
    retained.textResources.glyphLease.release();
    releaseBoxSnapshot(retained.boxes);
  }

  function needsGlobalPreparation(node) {
    return node.display === "svg-use" || (node.order ?? 0) !== 0 ||
      (!usesCoreRecord(node) && (node.display === "grid" ||
        node.display === "inline-grid" ||
        node.transform?.kind === "cssTransform" ||
        node.clipPath !== undefined));
  }
  // Animation-side twin: the renderer about to render suspends the
  // previous occupant's engine animation tracks (state 0 in the shared
  // table) so its tick can never sample a foreign renderer's tracks onto
  // the scene nodes it just wrote.
  let engineAnimationOccupant = null;
  // Renders through the shared engine are SERIALIZED: renderScenePixels
  // holds live views over the engine's command buffer across awaits, so a
  // second renderer starting mid-render would clobber the first's frame.
  let engineRenderChain = Promise.resolve();
  function runExclusiveEngineOperation(operation) {
    const run = engineRenderChain.then(operation);
    // Keep the chain alive past a failing operation, or one thrown error
    // would poison every later operation through this engine.
    engineRenderChain = run.then(() => {}, () => {});
    return run;
  }
  // Take the engine's animation occupancy for one renderer's controller:
  // suspend the previous occupant's tracks (state 0 in the shared table)
  // and restore the acquirer's own, so a tick samples exactly one
  // renderer's tracks onto the scene currently in the layout buffer.
  function acquireEngineAnimations(animations) {
    if (engineAnimationOccupant === animations) return;
    engineAnimationOccupant?.suspend();
    animations.restore();
    engineAnimationOccupant = animations;
  }
  let defaultGlyphResourceManager = null;
  function getDefaultGlyphResourceManager() {
    if (
      !defaultGlyphResourceManager ||
      defaultGlyphResourceManager.snapshot().shutDown
    ) {
      defaultGlyphResourceManager = new GlyphResourceManager({
        glyphAtlasFactory: (fontBytes) =>
          new atlasRuntime.GlyphAtlas(fontBytes),
      });
    }
    return defaultGlyphResourceManager;
  }
  async function shutdownDefaultGlyphResourceManager() {
    const manager = defaultGlyphResourceManager;
    defaultGlyphResourceManager = null;
    if (manager) await manager.shutdown();
  }


  // Resolve authored transforms for CSS/HTML diagnostics and host resources.
  function resolveTransform(node) {
    const t = node.transform;
    if (t === undefined) return [1, 0, 0, 1, 0, 0];
    if (Array.isArray(t)) {
      if (t.length !== 6) {
        throw new Error(`transform array must have 6 values, got ${t.length}`);
      }
      return t;
    }
    const sx = typeof t.scale === "number" ? t.scale : (t.scale?.x ?? 1);
    const sy = typeof t.scale === "number" ? t.scale : (t.scale?.y ?? 1);
    const rad = ((t.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;

    const tx = t.translate?.x ?? 0, ty = t.translate?.y ?? 0;
    return [a, b, c, d, tx, ty];
  }

  // svg-use (S6 step 2): composes "apply innerAffine's transform first, then
  // outerAffine's" — matrix() order, same convention as engine.wat's own
  // $composeNodeTransform ("this node's transform, then the already-
  // accumulated parent transform"). Used to fold <use>'s own x/y translate
  // (applied to the referenced content, spec: "appended to the right-side of
  // the transformation list") together with any transform the <use> element
  // itself carries, into ONE affine for the synthetic wrapping group — same
  // [a,b,c,d,e,f] shape resolveTransform() already produces/consumes.
  function composeAffine(outer, inner) {
    const [oa, ob, oc, od, oe, of] = outer;
    const [ia, ib, ic, id, ie, iff] = inner;
    return [
      oa * ia + oc * ib,
      ob * ia + od * ib,
      oa * ic + oc * id,
      ob * ic + od * id,
      oa * ie + oc * iff + oe,
      ob * ie + od * iff + of,
    ];
  }

  function resolveLengthPercentage(value, referenceLength) {
    return (value?.pixels ?? 0) + (value?.percentage ?? 0) * referenceLength;
  }

  function cssTransformMatrix(node, box) {
    const transform = node.transform;
    let matrix = [1, 0, 0, 1, 0, 0];
    for (const component of transform.components) {
      let next;
      switch (component.kind) {
        case "matrix":
          next = component.value;
          break;
        case "translate":
          next = [
            1,
            0,
            0,
            1,
            resolveLengthPercentage(component.x, box.w),
            resolveLengthPercentage(component.y, box.h),
          ];
          break;
        case "translateX":
          next = [
            1,
            0,
            0,
            1,
            resolveLengthPercentage(component.value, box.w),
            0,
          ];
          break;
        case "translateY":
          next = [
            1,
            0,
            0,
            1,
            0,
            resolveLengthPercentage(component.value, box.h),
          ];
          break;
        case "scale":
          next = [component.x, 0, 0, component.y, 0, 0];
          break;
        case "scaleX":
          next = [component.value, 0, 0, 1, 0, 0];
          break;
        case "scaleY":
          next = [1, 0, 0, component.value, 0, 0];
          break;
        case "rotate": {
          const cosine = Math.cos(component.radians);
          const sine = Math.sin(component.radians);
          next = [cosine, sine, -sine, cosine, 0, 0];
          break;
        }
        case "skew":
          next = [
            1,
            Math.tan(component.yRadians),
            Math.tan(component.xRadians),
            1,
            0,
            0,
          ];
          break;
        case "skewX":
          next = [1, 0, Math.tan(component.radians), 1, 0, 0];
          break;
        case "skewY":
          next = [1, Math.tan(component.radians), 0, 1, 0, 0];
          break;
        default:
          throw new Error(`Unknown CSS transform component: ${component.kind}`);
      }
      matrix = composeAffine(matrix, next);
    }
    const origin = node.transformOrigin ?? {
      x: { pixels: 0, percentage: 0.5 },
      y: { pixels: 0, percentage: 0.5 },
    };
    const originX = box.x + resolveLengthPercentage(origin.x, box.w);
    const originY = box.y + resolveLengthPercentage(origin.y, box.h);
    return composeAffine(
      [1, 0, 0, 1, originX, originY],
      composeAffine(matrix, [1, 0, 0, 1, -originX, -originY]),
    );
  }

  function resolveCssTransform(node, box) {
    const desired = cssTransformMatrix(node, box);
    const centerX = box.x + box.w / 2;
    const centerY = box.y + box.h / 2;
    return composeAffine(
      [1, 0, 0, 1, -centerX, -centerY],
      composeAffine(desired, [1, 0, 0, 1, centerX, centerY]),
    );
  }

  // Debug-only escape hatch: exposes the module's own engine instance so a
  // scratch script can read WASM memory directly (e.g. debug_trace_base(),
  // raw command-buffer bytes) without instantiating a second, separate engine
  // that wouldn't share memory with whatever renderScene/renderScenePixels
  // call already ran.
  function __debugEngine() {
    return engine;
  }

  await shapingRuntime.preload();
  await initializeAtlasRuntime();
  const engine = await loadEngine({ harfbuzzBytes, core });
  const textPreparationRuntime = engine.textPreparation;
  // The engine's per-node tables start in the fixed map (layout.js) and
  // move to an allocated block when a scene needs more nodes
  // (engine.wat node_tables_reserve). Every address into them is read
  // from the engine after each reservation; nothing here assumes the
  // initial map. A caller may still cap a renderer explicitly.
  let layoutBufferBase = engine.exports.layout_buffer_base();
  let computedBoxBufferBase = engine.exports.computed_box_buffer_base();
  let scrollTableBase = engine.exports.scroll_table_base();
  let scrollTableSize = engine.exports.scroll_table_size();
  let textRunDirBase = engine.exports.text_run_dir_base();
  let scrollDataBufferBase = engine.exports.scroll_data_buffer_base();
  let nodeCapacity = engine.exports.node_capacity();
  function ensureNodeCapacity(count) {
    if (count <= nodeCapacity) return;
    if (!engine.exports.node_tables_reserve(count)) {
      throw new RangeError(
        `Scene has ${count} nodes; the engine could not allocate node tables for it`,
      );
    }
    nodeCapacity = engine.exports.node_capacity();
    layoutBufferBase = engine.exports.layout_buffer_base();
    computedBoxBufferBase = engine.exports.computed_box_buffer_base();
    scrollTableBase = engine.exports.scroll_table_base();
    scrollTableSize = engine.exports.scroll_table_size();
    textRunDirBase = engine.exports.text_run_dir_base();
    scrollDataBufferBase = engine.exports.scroll_data_buffer_base();
  }

  function validateLayoutNodeCapacity(capacity) {
    if (
      capacity !== Infinity && (!Number.isSafeInteger(capacity) || capacity < 1)
    ) {
      throw new RangeError(
        `Layout node capacity must be a positive integer; received ${capacity}`,
      );
    }
    return capacity;
  }
  // Long-lived view over the shared engine+HarfBuzz memory. HarfBuzz heap
  // growth detaches it; the loader's growth notification re-derives it (the
  // one refresh rule — see src/wasm/loader.js).
  let view = new DataView(engine.memory.buffer);
  engine.onMemoryGrowth(() => {
    view = new DataView(engine.memory.buffer);
  });

  // White render background, shared by sandom render AND the Chrome SVG raster, so
  // the two pixel buffers compare against the same backdrop.
  const RENDER_BG = { r: 1, g: 1, b: 1, a: 1 };

  // The font registry supplies complete font bytes. A host resolver can read
  // installed fonts synchronously before Sandom enters synchronous layout.
  const fontFacesByBytes = new WeakMap();
  const fontFacesByLength = new Map();
  const fontBytesByIndex = new Map();
  const fontIsItalicFaceByIndex = new Map();
  let sceneGeneration = 0;

  function fontFaceForBytes(bytes) {
    let face = fontFacesByBytes.get(bytes);
    if (face !== undefined) return face;
    let candidates = fontFacesByLength.get(bytes.byteLength);
    if (candidates === undefined) {
      candidates = [];
      fontFacesByLength.set(bytes.byteLength, candidates);
    }
    // A newly loaded @font-face can own another buffer for the same file.
    // Compare content once, then use the byte-object fast path on later layouts.
    candidate: for (const candidate of candidates) {
      for (let i = 0; i < bytes.byteLength; i++) {
        if (candidate.bytes[i] !== bytes[i]) continue candidate;
      }
      face = candidate;
      break;
    }
    if (face === undefined) {
      face = { bytes, instances: new Map() };
      candidates.push(face);
    }
    fontFacesByBytes.set(bytes, face);
    return face;
  }

  function registerFontBytes(
    family,
    weight,
    { bytes, faceIndex = 0, italicFace, resourceHandle },
  ) {
    const face = fontFaceForBytes(bytes);
    bytes = face.bytes;
    const registeredWeight = isVariableFamily(family) ? weight : 0;
    const key = `${faceIndex}|${registeredWeight}|${italicFace ? 1 : 0}`;
    const existing = face.instances.get(key);
    if (existing !== undefined) {
      return resourceHandle === undefined
        ? existing
        : joinEngineResource(resourceHandle, existing, registeredWeight);
    }
    if (fontBytesByIndex.size >= FONT_TABLE_MAX_ENTRIES) {
      throw new RangeError(
        `FONT_TABLE overflow: more than ${FONT_TABLE_MAX_ENTRIES} distinct font instances in one renderer`,
      );
    }
    // Single shared memory: hb_malloc_for_test allocates in HarfBuzz's heap
    // region of engine.memory (above the layout reservation).
    const fontPtr = engine.exports.hb_malloc_for_test(bytes.length);
    const measurement = globalThis[domMeasurementKey];
    const transferStart = measurement ? performance.now() : 0;
    new Uint8Array(engine.memory.buffer, fontPtr, bytes.length).set(bytes);
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "font.bytes",
        direction: "host-to-engine",
        bytes: bytes.byteLength,
        allocations: 1,
        milliseconds: performance.now() - transferStart,
      });
    }
    const fontIndex = engine.exports.register_font(
      fontPtr,
      bytes.length,
      faceIndex,
      registeredWeight,
    );
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "font.register",
        direction: "host-to-engine",
        bytes: 16,
        crossings: 0,
      });
    }
    const metrics = readFontMetrics(bytes, { faceIndex });
    engine.exports.set_font_decoration_metrics(
      fontIndex,
      metrics.underlinePosition,
      metrics.underlineThickness,
      metrics.strikeoutPosition,
      metrics.strikeoutThickness,
    );
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "font.decoration",
        direction: "host-to-engine",
        bytes: 20,
        crossings: 0,
      });
    }
    face.instances.set(key, fontIndex);
    fontBytesByIndex.set(fontIndex, bytes);
    fontIsItalicFaceByIndex.set(fontIndex, italicFace);
    return resourceHandle === undefined
      ? fontIndex
      : joinEngineResource(resourceHandle, fontIndex, registeredWeight);
  }

  // (family, weight, style) -> engine font index, valid for one font
  // catalog revision: every text node of every frame resolves its face
  // here, and the registry lookup plus the byte-identity scan and the
  // resource join behind it were a measurable share of a text frame.
  const fontIndexMemo = new Map();
  let fontIndexMemoRevision = -1;
  function fontIndexMemoFor() {
    const revision = fontRegistry.revision;
    if (revision !== fontIndexMemoRevision) {
      fontIndexMemo.clear();
      fontIndexMemoRevision = revision;
    }
    return fontIndexMemo;
  }
  // Resolve CSS font declarations through the production registry, shape text
  // with HarfBuzz at the production variation coordinates, then fill the shared
  // bounded glyph manager. This is the public prewarm boundary for DOM clients.
  async function prewarmCssTextGlyphs({
    glyphResourceManager = getDefaultGlyphResourceManager(),
    instances,
    text,
  }) {
    const prewarmStartedAt = performance.now();
    if (!Array.isArray(instances)) {
      throw new TypeError("CSS glyph prewarm instances must be an array");
    }
    if (typeof text !== "string") {
      throw new TypeError("CSS glyph prewarm text must be a string");
    }
    if (
      glyphResourceManager === null ||
      typeof glyphResourceManager.prewarm !== "function"
    ) {
      throw new TypeError(
        "CSS glyph prewarm requires a glyph resource manager",
      );
    }

    const fontDigests = new WeakMap();
    const requestsByInstance = new Map();
    for (const [instanceIndex, instance] of instances.entries()) {
      const fontFamily = fontFamilyKeyForCssValue(instance?.fontFamily);
      const weight = fontWeightInCssUnits(instance?.fontWeight ?? 400);
      const fontSize = Number(instance?.fontSize);
      const deviceScale = Number(instance?.deviceScale ?? 1);
      const fontStyle = instance?.fontStyle ?? "normal";
      if (!Number.isFinite(weight) || weight < 1 || weight > 1000) {
        throw new RangeError(
          `CSS glyph prewarm instance ${instanceIndex} has an invalid font weight`,
        );
      }
      if (!Number.isFinite(fontSize) || fontSize <= 0) {
        throw new RangeError(
          `CSS glyph prewarm instance ${instanceIndex} has an invalid font size`,
        );
      }
      if (!Number.isFinite(deviceScale) || deviceScale <= 0) {
        throw new RangeError(
          `CSS glyph prewarm instance ${instanceIndex} has an invalid device scale`,
        );
      }
      if (fontStyle !== "normal" && fontStyle !== "italic") {
        throw new RangeError(
          `CSS glyph prewarm instance ${instanceIndex} has an invalid font style`,
        );
      }

      const fontIndex = fontIndexForSync(fontFamily, weight, fontStyle);
      const fontBytes = fontBytesByIndex.get(fontIndex);
      if (!fontBytes) {
        throw new Error(
          `CSS glyph prewarm resolved font index ${fontIndex} without font bytes`,
        );
      }
      let contentDigest = fontDigests.get(fontBytes);
      if (contentDigest === undefined) {
        contentDigest = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", fontBytes)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        fontDigests.set(fontBytes, contentDigest);
      }
      const opticalSize = fontSize;
      const devicePixelSize = fontSize * deviceScale;
      const instanceKey = JSON.stringify([
        contentDigest,
        weight,
        opticalSize,
        devicePixelSize,
      ]);
      if (requestsByInstance.has(instanceKey)) continue;
      const shaped = await shapeText(fontBytes, text, fontSize, {
        variations: [["wght", weight], ["opsz", opticalSize]],
      });
      requestsByInstance.set(instanceKey, {
        fontBytes,
        glyphIds: [...new Set(shaped.glyphs.map((glyph) => glyph.g))],
        weight,
        opticalSize,
        devicePixelSize,
        fontFamily,
        contentDigest,
      });
    }

    const requests = [...requestsByInstance.values()];
    const prewarmResult = await glyphResourceManager.prewarm(
      requests.map((request) => ({
        fontBytes: request.fontBytes,
        glyphIds: request.glyphIds,
        weight: request.weight,
        opticalSize: request.opticalSize,
        devicePixelSize: request.devicePixelSize,
      })),
    );
    return Object.freeze({
      fontInstanceCount: requests.length,
      requestedGlyphCount: prewarmResult.glyphPerformance.requestedGlyphCount,
      generatedGlyphCount: prewarmResult.glyphPerformance.generatedGlyphCount,
      reusedGlyphCount: prewarmResult.glyphPerformance.cacheHitGlyphCount,
      milliseconds: performance.now() - prewarmStartedAt,
      glyphGenerationMilliseconds:
        prewarmResult.glyphPerformance.totalMilliseconds,
      glyphPerformance: prewarmResult.glyphPerformance,
      cache: prewarmResult.cache,
      fontInstances: Object.freeze(requests.map((request) =>
        Object.freeze({
          fontFamily: request.fontFamily,
          contentDigest: request.contentDigest,
          weight: request.weight,
          opticalSize: request.opticalSize,
          devicePixelSize: request.devicePixelSize,
          glyphIds: Object.freeze([...request.glyphIds]),
        })
      )),
    });
  }

  // Resolve every text-bearing node's fontIndex before writeNode. IFC roots
  // need their own resolved font for the CSS strut; inline boxes need it for
  // descendant metrics and later decoration/alignment work.
  // A DOM-backed box names its face through the core's packed form (CSS
  // weight, style) and its family's CSS value; the registered index goes
  // back to the core (registerCoreFaces, in the same synchronous pass as
  // the record writes), whose record carries it. The CSS value keys through
  // this runtime's registry (the core's family table may hold another
  // document's or an earlier registry's answer); a value no family matches
  // takes the default family, as the scene writer's fallback did.
  const FACE_STYLE_NAMES = ["normal", "italic", "oblique"];
  function coreFace(node) {
    const packed = node._coreFont;
    return {
      css: node._coreFontCss,
      weight: (packed >>> 2) & 0x3ff,
      style: packed & 3,
    };
  }
  // Answers the core's face table for every DOM-backed box about to be
  // written. Runs synchronously before the writes: a font resource change
  // between the resolution and the write clears the core's family table.
  function registerCoreFaces(nodes) {
    const registered = new Set();
    for (const node of nodes) {
      if (
        !usesCoreRecord(node) || node._coreFont === undefined ||
        node.fontIndex === undefined
      ) continue;
      const key = `${node._coreFontCss}|${node._coreFont}`;
      if (registered.has(key)) continue;
      registered.add(key);
      const face = coreFace(node);
      core.setFontFace(
        face.css,
        face.weight,
        face.style,
        node.fontIndex,
      );
    }
  }

  function coreFaceFamilyKey(css, keys) {
    if (css === "") return fontFamilyKeyForCssValue(DEFAULT_FONT_FAMILY);
    let key = keys.get(css);
    if (key === undefined) {
      try {
        key = fontFamilyKeyForCssValue(css);
      } catch {
        key = fontFamilyKeyForCssValue(DEFAULT_FONT_FAMILY);
      }
      keys.set(css, key);
    }
    return key;
  }

  // Every text-bearing node's font index. Synchronous: the registry
  // answers from bytes it holds (fontFileFor), and a frame of a thousand
  // text nodes cannot afford a microtask each. A DOM-backed node is
  // annotated in place - its serialization is this frame's, and copying
  // it would evaluate the deferred text decode of every node - keyed by
  // its packed face so one lookup serves every node of a face.
  function resolveFontIndices(nodes) {
    const familyKeys = new Map();
    const faces = new Map();
    let out = null;
    for (let index = 0; index < nodes.length; index++) {
      const n = nodes[index];
      if (
        n.display !== "text" && n.display !== "inline" &&
        n.display !== "inline-block" && !n.inlineCtx
      ) {
        if (out !== null) out.push(n);
        continue;
      }
      if (usesCoreRecord(n) && n._coreFont !== undefined) {
        const faceKey = `${n._coreFontCss}|${n._coreFont}`;
        let fontIndex = faces.get(faceKey);
        if (fontIndex === undefined) {
          const face = coreFace(n);
          fontIndex = fontIndexForSync(
            coreFaceFamilyKey(face.css, familyKeys),
            face.weight,
            FACE_STYLE_NAMES[face.style],
          );
          faces.set(faceKey, fontIndex);
        }
        n.fontIndex = fontIndex;
        if (out !== null) out.push(n);
        continue;
      }
      const weight = fontWeightInCssUnits(n.fontWeight);
      const fontIndex = fontIndexForSync(
        n.fontFamily ?? fontFamilyKeyForCssValue(DEFAULT_FONT_FAMILY),
        weight,
        n.fontStyle ?? "normal",
      );
      if (out === null) out = nodes.slice(0, index);
      out.push({ ...n, fontIndex });
    }
    return out ?? nodes;
  }

  // Runtime faces already carry their bytes. Built-in faces are local,
  // deterministic repository assets and can be read synchronously under Deno;
  // browser callers still fail loudly if the asset has not loaded.
  function fontIndexForSync(family, weight, style) {
    const memo = fontIndexMemoFor();
    const key = `${family}|${weight}|${style}`;
    let fontIndex = memo.get(key);
    if (fontIndex === undefined) {
      fontIndex = registerFontBytes(
        family,
        weight,
        fontFileFor(family, weight, style),
      );
      memo.set(key, fontIndex);
    }
    return fontIndex;
  }

  // Image registration (Slice P5a/b): mirrors resolveFontIndices/fontIndexFor
  // above — one decode+register per distinct src, cached across scenes.
  // register_image's INDEX is caller-picked (unlike register_font's
  // auto-incremented handle — see IMAGE_TABLE's doc comment in layout.js),
  // so this module owns the counter. Each entry caches the NATIVE
  // ImageDescriptor for the color-managed WebGPU upload (src/rasterize.js
  // converts it into the mode's working encoding on the graphics processing
  // unit) plus a lazily derived eight-bit sRGB flattening for the degraded
  // WebGL 2 backend — the engine itself never sees pixel bytes, only
  // width/height (IMAGE_TABLE).
  const imageIndexBySrc = new Map(); // src (string path) -> imageIndex
  const imagePixelsByIndex = new Map(); // imageIndex -> { width, height, descriptor, pixels (lazy) }
  const imageIndexByCanvasSource = new WeakMap();
  const imageResourceHandles = new Map();
  const canvasResourceHandles = new Map();
  let resourceEngineScope = 0n;

  function joinEngineResource(resource, index, variant = 0) {
    resourceEngineScope ||= core.resourceEngineCreate();
    core.resourceEngineBind(
      resourceEngineScope,
      resource,
      index,
      variant,
    );
    return core.resourceEngineIndex(
      resourceEngineScope,
      core.resourceId(resource),
      variant,
    );
  }

  function imageResourceFor(src, resourceIdentifier) {
    const key = resourceIdentifier ?? src;
    let handle = imageResourceHandles.get(key);
    if (handle === undefined) {
      if (resourceIdentifier === undefined) {
        resourceEngineScope ||= core.resourceEngineCreate();
        handle = core.resourceRegisterOwned(
          1,
          resourceEngineScope,
          src,
        );
      } else {
        handle = core.resourceFindId(resourceIdentifier);
        core.resourceRetain(handle);
      }
      imageResourceHandles.set(key, handle);
    }
    return handle;
  }
  let nextImageIndex = 0;

  function registeredImageEntry(descriptor) {
    const resolved = prepareImageProfile(descriptor);
    return {
      width: resolved.width,
      height: resolved.height,
      descriptor: resolved,
      // Degraded-backend flattening, derived once on first request; the
      // WebGPU path never touches it. An ICC-resolved descriptor (linear
      // XYZ D65 float32, built above) flattens here directly - the same
      // lossy eight-bit sRGB bake the degraded backend gets for every
      // image, with out-of-gamut channels clamped at the encode.
      get pixels() {
        let value;
        if (
          resolved.sampleType === "float32" &&
          resolved.colorEncoding.primaries === "xyz-d65" &&
          resolved.colorEncoding.transferFunction === "linear"
        ) {
          const count = resolved.width * resolved.height;
          value = new Uint8Array(count * 4);
          for (let i = 0; i < count; i++) {
            const rgb = convertXyzToLinearRgb("srgb", [
              resolved.pixels[i * 4],
              resolved.pixels[i * 4 + 1],
              resolved.pixels[i * 4 + 2],
            ]);
            for (let channel = 0; channel < 3; channel++) {
              value[i * 4 + channel] = Math.round(
                Math.min(1, Math.max(0, encodeSrgbTransfer(rgb[channel]))) *
                  255,
              );
            }
            value[i * 4 + 3] = Math.round(
              Math.min(1, Math.max(0, resolved.pixels[i * 4 + 3])) * 255,
            );
          }
        } else {
          value = toSrgbRgba8(resolved).pixels;
        }
        Object.defineProperty(this, "pixels", { value });
        return value;
      },
    };
  }

  // (resource identifier or src) -> joined engine image index once the
  // image has decoded and registered. The miss path below read the file
  // from disk on every frame for every node showing it.
  const imageJoinByKey = new Map();
  async function imageIndexFor(
    src,
    resolveResource = null,
    resourceIdentifier,
  ) {
    const joinKey = resourceIdentifier ?? src;
    const joined = imageJoinByKey.get(joinKey);
    if (joined !== undefined) return joined;
    const resourceHandle = imageResourceFor(src, resourceIdentifier);
    try {
      let bytes;
      let cacheKey = src;
      if (resolveResource) {
        const resource = await resolveResource({
          requestedURL: src,
          kind: "image",
        });
        bytes = resource?.bytes;
        cacheKey = resource?.cacheKey ?? resource?.finalURL ?? src;
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError("Image resolver must return Uint8Array bytes");
        }
      } else {
        bytes = await readBinaryFile(src);
      }
      let imageIndex = imageIndexBySrc.get(cacheKey);
      if (imageIndex === undefined) {
        const entry = registeredImageEntry(await decodeImage(bytes));
        if (nextImageIndex >= IMAGE_TABLE_MAX_ENTRIES) {
          throw new RangeError(
            `IMAGE_TABLE overflow: more than ${IMAGE_TABLE_MAX_ENTRIES} images in one renderer`,
          );
        }
        imageIndex = nextImageIndex++;
        const measurement = globalThis[resourceMeasurementKey];
        engine.exports.register_image(imageIndex, entry.width, entry.height);
        if (measurement) {
          measurement.record({
            category: "resources",
            operation: "image.register",
            direction: "host-to-engine",
            bytes: 12,
            crossings: 0,
            allocations: 0,
            allocationBytes: 0,
          });
        }
        imageIndexBySrc.set(cacheKey, imageIndex);
        imagePixelsByIndex.set(imageIndex, entry);
        core.resourceUpdate(
          resourceHandle,
          1,
          entry.width,
          entry.height,
          true,
        );
      } else {
        const entry = imagePixelsByIndex.get(imageIndex);
        core.resourceUpdate(
          resourceHandle,
          1,
          entry.width,
          entry.height,
        );
      }
      const join = joinEngineResource(resourceHandle, imageIndex);
      imageJoinByKey.set(joinKey, join);
      return join;
    } catch (error) {
      core.resourceUpdate(resourceHandle, 2, 0, 0, false, 1);
      throw error;
    }
  }

  function canvasImageIndexFor(source) {
    if (
      source.resourceHandle !== undefined &&
      !canvasResourceHandles.has(source.sourceIdentifier)
    ) {
      core.resourceRetain(source.resourceHandle);
      canvasResourceHandles.set(source.sourceIdentifier, source.resourceHandle);
    }
    let imageIndex = imageIndexByCanvasSource.get(source);
    if (imageIndex === undefined) {
      if (nextImageIndex >= IMAGE_TABLE_MAX_ENTRIES) {
        throw new RangeError(
          `IMAGE_TABLE overflow: more than ${IMAGE_TABLE_MAX_ENTRIES} images in one renderer`,
        );
      }
      imageIndex = nextImageIndex++;
      imageIndexByCanvasSource.set(source, imageIndex);
    }
    const measurement = globalThis[resourceMeasurementKey];
    engine.exports.register_image(imageIndex, source.width, source.height);
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "canvas.register",
        direction: "host-to-engine",
        bytes: 12,
        crossings: 0,
        allocations: 0,
        allocationBytes: 0,
      });
    }
    imagePixelsByIndex.set(imageIndex, source);
    return source.resourceHandle === undefined
      ? imageIndex
      : joinEngineResource(source.resourceHandle, imageIndex);
  }

  function imagePixelsFor(imageIndex) {
    return imagePixelsByIndex.get(imageIndex);
  }

  // Synchronous counterpart of imageIndexFor — same "throw rather than
  // fall back to real async I/O" contract as fontIndexForSync above.
  function imageIndexForSync(src, resourceIdentifier) {
    if (imageIndexBySrc.has(src)) {
      const index = imageIndexBySrc.get(src);
      const entry = imagePixelsByIndex.get(index);
      const resource = imageResourceFor(src, resourceIdentifier);
      core.resourceUpdate(resource, 1, entry.width, entry.height);
      return joinEngineResource(resource, index);
    }
    throw new Error(
      `imageIndexForSync: image "${src}" not registered yet — synchronous layout-getters require the tree to have been rendered (or this image otherwise pre-warmed) at least once already`,
    );
  }

  // A node without an image, canvas source, background layer or mask keeps
  // its identity (and the array keeps its own when nothing at all needs an
  // index): copying a DOM-backed node evaluates its deferred text decode,
  // and a text-bearing page has thousands of them.
  function resolveImageIndicesSync(nodes, imageSources = new Map()) {
    let out = null;
    for (let index = 0; index < nodes.length; index++) {
      const n = nodes[index];
      let next = n;
      if (n.src) {
        next = {
          ...next,
          imageIndex: imageIndexForSync(n.src, n.resourceIdentifier),
        };
      }
      if (n.canvasSourceIdentifier !== undefined) {
        const source = imageSources.get(n.canvasSourceIdentifier);
        if (!source) {
          throw new Error(
            `Missing canvas image source ${n.canvasSourceIdentifier}`,
          );
        }
        next = { ...next, imageIndex: canvasImageIndexFor(source) };
      }
      if (n.backgroundImages && n.backgroundImages.length) {
        const resolvedLayers = n.backgroundImages.map((
          layer,
        ) => (layer.src
          ? {
            ...layer,
            imageIndex: imageIndexForSync(layer.src, layer.resourceIdentifier),
          }
          : layer)
        );
        next = { ...next, resolvedBackgroundImages: resolvedLayers };
      }
      if (n.masks && n.masks.length) {
        const resolvedMasks = n.masks.map((
          layer,
        ) => (layer.src
          ? {
            ...layer,
            imageIndex: imageIndexForSync(layer.src, layer.resourceIdentifier),
          }
          : layer)
        );
        next = { ...next, resolvedMasks };
      }
      if (next !== n && out === null) out = nodes.slice(0, index);
      if (out !== null) out.push(next);
    }
    return out ?? nodes;
  }

  // render()'s `images` option wants imageIndex -> { width, height, pixels }
  // (RGBA8) for the CMD_IMAGE GPU-texture-per-draw upload. UNLIKE
  // buildTextRenderResources, this doesn't need a command-buffer walk to
  // discover which images are actually used — imagePixelsByIndex already has
  // every registered image's decoded pixels, keyed by the same index
  // CMD_IMAGE commands reference, so the whole cache can be handed to
  // render() directly.
  function buildImageRenderResources() {
    return imagePixelsByIndex;
  }

  // SVG path registration (design/svg-rendering.md, Tier B): pathIndex is a purely JS-side
  // handle (never interpreted by WAT beyond forwarding it through
  // CMD_SVG_PATH, see LAYOUT_NODE_OFFSET_SVG_PATH_INDEX's doc in layout.js)
  // mapping to the (pathDef, fillRule) pair the rasterizer needs at draw
  // time to resolve an atlas UV. UNLIKE images, there's no WASM register_*
  // call — the shape's bbox (which WAT DOES need, to compute the dest rect)
  // is written directly into the SVG geometry pool by writeSvgShape, same
  // as every other Tier A shape's geometry.
  const svgPathIndexByKey = new Map(); // "pathDef|fillRule[|stroke...]" -> pathIndex
  const svgPathDefByIndex = new Map(); // pathIndex -> { pathDef, fillRule, stroke? }
  let nextSvgPathIndex = 0;
  const sharedSvgPathAtlas = new SvgPathAtlas();

  // Plain (not async) — no await in this body ever, unlike svgPathBbox
  // below it (which needs the wasm atlas module). Kept non-async
  // deliberately so the synchronous layout-getter fast path
  // (resolveSvgPathIndicesSync) can call it directly without an
  // async/sync split of its own; every existing call site already awaits
  // it inside an async function, where awaiting a non-Promise value is a
  // harmless passthrough.
  function svgPathIndexFor(pathDef, fillRule) {
    const key = `${pathDef}|${fillRule}`;
    if (svgPathIndexByKey.has(key)) return svgPathIndexByKey.get(key);
    const pathIndex = nextSvgPathIndex++;
    svgPathIndexByKey.set(key, pathIndex);
    svgPathDefByIndex.set(pathIndex, { pathDef, fillRule });
    return pathIndex;
  }

  // S5: a SEPARATE opaque index for the stroke's own filled-outline shape —
  // see LAYOUT_NODE_OFFSET_SVG_STROKE_PATH_INDEX's own comment in layout.js
  // for why this can't share NODE_SVG_PATH_INDEX's slot (fill and stroke
  // paint as two independent Chrome layers, each needing its own atlas
  // entry/CMD_SVG_PATH draw). Keyed by pathDef+fillRule+stroke params
  // together — a node's stroke can change independently of its fill, and
  // two DIFFERENT nodes sharing the same `d` but different stroke-width
  // must NOT share an atlas entry.
  // Plain (not async) — same rationale as svgPathIndexFor above.
  function svgStrokePathIndexFor(pathDef, fillRule, stroke) {
    const key = `${pathDef}|${fillRule}|stroke:${JSON.stringify(stroke)}`;
    if (svgPathIndexByKey.has(key)) return svgPathIndexByKey.get(key);
    const pathIndex = nextSvgPathIndex++;
    svgPathIndexByKey.set(key, pathIndex);
    svgPathDefByIndex.set(pathIndex, { pathDef, fillRule, stroke });
    return pathIndex;
  }

  // polygon/polyline (Tier B): points -> an equivalent `d`
  // string, then reuse EVERY bit of the path pipeline (SvgPathAtlas,
  // CMD_SVG_PATH, generate_path_msdf_var) unchanged — polygon closes with Z
  // (SVG semantics: always a closed fillable shape), polyline does not
  // (SVG semantics: an open, unclosed contour — still fillable per spec,
  // the fill just implicitly closes straight back to the start point, but
  // the STROKE, when S5 lands, must not draw that implicit closing edge).
  function pointsToPathDef(points, closed) {
    if (!points || points.length < 2) return "";
    const cmds = points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x} ${y}`);
    if (closed) cmds.push("Z");
    return cmds.join(" ");
  }

  // A Tier A shape's outline as an equivalent `d` string, or null for a
  // shape kind with no dashable outline. Tier A shapes (rect/circle/
  // ellipse/line) are lowered straight to engine.wat geometry — a filled
  // rounded box, plus a border-ring trick for the stroke — and that ring
  // has no notion of arc length, so it CANNOT dash: it either paints the
  // whole outline or none of it. Tier B (SvgPathAtlas) already dashes
  // correctly, because SkDashPath runs over the real outline before the
  // MSDF is generated. So a Tier A shape that actually carries a dash
  // spec is re-expressed as the equivalent path here and routed through
  // the Tier B pipeline instead (see resolveSvgPathIndices' own gate),
  // rather than teaching the WAT ring an arc-length parameterization it
  // has no geometry for.
  //
  // Contour start point and direction MATTER here and are not free
  // choices: a dash pattern is laid out from the contour's start along
  // its own direction, so a path that traces the same outline from a
  // different corner (or counter-clockwise) renders visibly different
  // dashes. Each shape below starts where SVG's own implicit equivalent
  // path starts and runs clockwise: rect at (x+rx, y), circle/ellipse at
  // the 3-o'clock point (cx+r, cy).
  function svgShapeToPathDef(node) {
    if (node.display === "svg-line") {
      return `M ${node.x1 ?? 0} ${node.y1 ?? 0} L ${node.x2 ?? 0} ${
        node.y2 ?? 0
      }`;
    }
    if (node.display === "svg-circle") {
      const cx = node.cx ?? 0, cy = node.cy ?? 0, r = node.r ?? 0;
      if (!(r > 0)) return null;
      // Two half-arcs: a single 360° arc is degenerate in SVG's arc syntax
      // (identical start and end point = "skip this segment" per spec).
      return `M ${cx + r} ${cy} A ${r} ${r} 0 0 1 ${
        cx - r
      } ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`;
    }
    if (node.display === "svg-ellipse") {
      const cx = node.cx ?? 0,
        cy = node.cy ?? 0,
        rx = node.rx ?? 0,
        ry = node.ry ?? 0;
      if (!(rx > 0) || !(ry > 0)) return null;
      return `M ${cx + rx} ${cy} A ${rx} ${ry} 0 0 1 ${
        cx - rx
      } ${cy} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy} Z`;
    }
    if (node.display === "svg-rect") {
      const x = node.x ?? 0,
        y = node.y ?? 0,
        w = node.width ?? 0,
        h = node.height ?? 0;
      if (!(w > 0) || !(h > 0)) return null;
      // SVG's own rx/ry auto-defaulting: either one alone supplies the
      // other, and both clamp to half the corresponding side.
      let rx = node.rx ?? node.ry ?? 0, ry = node.ry ?? node.rx ?? 0;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!(rx > 0) || !(ry > 0)) {
        return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${
          y + h
        } Z`;
      }
      return `M ${x + rx} ${y} L ${x + w - rx} ${y} A ${rx} ${ry} 0 0 1 ${
        x + w
      } ${y + ry}` +
        ` L ${x + w} ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
        ` L ${x + rx} ${y + h} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        ` L ${x} ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
    }
    return null;
  }

  // A Tier A shape carrying a real dash spec, re-expressed as the
  // equivalent Tier B path node (same fill, same stroke, same paint
  // order). Returns the node unchanged when it isn't Tier A, has no
  // usable stroke, or its dasharray normalizes away to "solid" — so the
  // ordinary Tier A lowering, which is cheaper and needs no atlas entry,
  // stays the path for every undashed shape.
  function dashedTierAAsPath(node) {
    if (!SVG_TIER_A_DASHABLE.has(node.display)) return node;
    const stroke = svgStrokeParamsFor(node);
    if (!stroke || stroke.dashArray === undefined) return node;
    const d = svgShapeToPathDef(node);
    if (!d) return node;
    return { ...node, display: "svg-path", d };
  }

  const SVG_TIER_A_DASHABLE = new Set([
    "svg-rect",
    "svg-circle",
    "svg-ellipse",
    "svg-line",
  ]);

  // The path's own bbox in SVG user units — needed by writeSvgShape at
  // EMISSION time (before any atlas entry's real on-screen size is known)
  // so WAT can compute the dest rect through the viewBox affine like every
  // other Tier A shape. generate_path_msdf_var's bbox output reflects pure
  // shape geometry, unaffected by the requested MSDF resolution, so any
  // arbitrary screenSize bucket works here — reuses sharedSvgPathAtlas
  // (a small warmup bucket) rather than a separate one-off wasm call, so
  // this doubles as real atlas warmup, not throwaway work.
  const BBOX_WARMUP_SCREEN_SIZE = 48;
  async function svgPathBbox(pathDef, fillRule) {
    await sharedSvgPathAtlas.ensurePaths([{
      pathDef,
      fillRule,
      screenSize: BBOX_WARMUP_SCREEN_SIZE,
    }]);
    const info = sharedSvgPathAtlas.getPath(
      pathDef,
      fillRule,
      BBOX_WARMUP_SCREEN_SIZE,
    );
    if (!info) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    return {
      xMin: info.bboxXMin,
      yMin: info.bboxYMin,
      xMax: info.bboxXMax,
      yMax: info.bboxYMax,
    };
  }

  // Synchronous counterpart of svgPathBbox — throws (via SvgPathAtlas's
  // own ensurePathsSync -> _ensureCreatedSync) if the msdfgen wasm module
  // hasn't loaded yet, same "pre-warm or fail loud" contract as
  // fontIndexForSync/imageIndexForSync above. Once the module IS loaded
  // (true after any prior render anywhere in the process), ensurePathsSync
  // itself has no further async dependency — the atlas cache-table writes
  // are plain synchronous wasm calls.
  function svgPathBboxSync(pathDef, fillRule) {
    sharedSvgPathAtlas.ensurePathsSync([{
      pathDef,
      fillRule,
      screenSize: BBOX_WARMUP_SCREEN_SIZE,
    }]);
    const info = sharedSvgPathAtlas.getPath(
      pathDef,
      fillRule,
      BBOX_WARMUP_SCREEN_SIZE,
    );
    if (!info) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    return {
      xMin: info.bboxXMin,
      yMin: info.bboxYMin,
      xMax: info.bboxXMax,
      yMax: info.bboxYMax,
    };
  }

  // S5: same warmup-bbox trick as svgPathBbox above, but for the STROKE's
  // own filled-outline shape — genuinely different (usually larger, and
  // asymmetrically so at miter joins) than the fill's bbox, so it can't be
  // approximated by inflating the fill bbox by a fixed strokeWidth/2 (real
  // Skia miter joins extend further, up to strokeWidth/2 * miterLimit —
  // see SkStrokeRec::GetInflationRadius). Reading the ACTUAL msdfgen-
  // computed bbox off the stroke's own generated shape is both simpler
  // and more accurate than reimplementing that formula here.
  async function svgStrokePathBbox(pathDef, fillRule, stroke) {
    await sharedSvgPathAtlas.ensurePaths([{
      pathDef,
      fillRule,
      screenSize: BBOX_WARMUP_SCREEN_SIZE,
      stroke,
    }]);
    const info = sharedSvgPathAtlas.getPath(
      pathDef,
      fillRule,
      BBOX_WARMUP_SCREEN_SIZE,
      stroke,
    );
    if (!info) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    return {
      xMin: info.bboxXMin,
      yMin: info.bboxYMin,
      xMax: info.bboxXMax,
      yMax: info.bboxYMax,
    };
  }

  function svgStrokePathBboxSync(pathDef, fillRule, stroke) {
    sharedSvgPathAtlas.ensurePathsSync([{
      pathDef,
      fillRule,
      screenSize: BBOX_WARMUP_SCREEN_SIZE,
      stroke,
    }]);
    const info = sharedSvgPathAtlas.getPath(
      pathDef,
      fillRule,
      BBOX_WARMUP_SCREEN_SIZE,
      stroke,
    );
    if (!info) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    return {
      xMin: info.bboxXMin,
      yMin: info.bboxYMin,
      xMax: info.bboxXMax,
      yMax: info.bboxYMax,
    };
  }

  // SVG stroke-dasharray's own error-recovery rule: an odd-length list
  // means "duplicate it to make it even" (e.g. [5] -> [5,5], [5,3,2] ->
  // [5,3,2,5,3,2]); a negative value or a list that's empty/sums to 0
  // means "treat as if stroke-dasharray were absent" (solid stroke). This
  // mirrors SVG's own dasharray normalization, applied once here so both
  // the atlas cache key and the wasm call see the SAME normalized array
  // sandom promises to render, not the raw author-provided one.
  function normalizeDashArray(dashArray) {
    if (!dashArray || dashArray.length === 0) return null;
    if (dashArray.some((v) => v < 0)) return null;
    const normalized = dashArray.length % 2 === 0
      ? dashArray
      : [...dashArray, ...dashArray];
    if (normalized.every((v) => v === 0)) return null;
    return normalized;
  }

  // A node's stroke params as SkStroke/SkDashPath expect them (numeric
  // cap/join, normalized dasharray), or null if the node has no usable
  // stroke at all (stroke:none/undefined, or strokeWidth<=0 — matches
  // writeSvgShape's own svgHasStroke gate in engine.wat for Tier A shapes,
  // kept here in JS since Tier B's stroke needs its own atlas entry BEFORE
  // emission, unlike Tier A's border-ring trick which reads the node
  // fields directly at emit time).
  function svgStrokeParamsFor(node) {
    if (node.stroke === undefined || node.stroke === "none") return null;
    const width = node.strokeWidth ?? 1;
    if (!(width > 0)) return null;
    return {
      width,
      cap: { butt: 0, round: 1, square: 2 }[node.strokeLinecap] ?? 0,
      join: { miter: 0, round: 1, bevel: 2 }[node.strokeLinejoin] ?? 0,
      miterLimit: node.strokeMiterlimit ?? 4,
      dashArray: normalizeDashArray(node.strokeDasharray) ?? undefined,
      dashPhase: node.strokeDashoffset ?? 0,
    };
  }

  async function resolveImageIndices(
    nodes,
    resolveResource = null,
    imageSources = new Map(),
  ) {
    // Copy-on-change, like resolveImageIndicesSync: a page of text has
    // thousands of nodes with no image of any kind, and copying a
    // DOM-backed node evaluates its deferred text decode.
    let out = null;
    for (let index = 0; index < nodes.length; index++) {
      const n = nodes[index];
      let next = n;
      if (n.src) {
        next = {
          ...next,
          imageIndex: await imageIndexFor(
            n.src,
            resolveResource,
            n.resourceIdentifier,
          ),
        };
      }
      if (n.canvasSourceIdentifier !== undefined) {
        const source = imageSources.get(n.canvasSourceIdentifier);
        if (!source) {
          throw new Error(
            `Missing canvas image source ${n.canvasSourceIdentifier}`,
          );
        }
        next = { ...next, imageIndex: canvasImageIndexFor(source) };
      }
      // background-image (P5c): independent of display type — a node can
      // have BOTH an <img> src (display:'image') and background-image
      // layers (any node) at once, hence the separate NODE_BACKGROUND_
      // IMAGE_INDEX-per-layer fields (see BG_LAYER_POOL's doc comment in
      // layout.js/engine.wat) instead of reusing NODE_IMAGE_INDEX.
      // node.backgroundImages is a list, CSS comma-list order (first =
      // TOP layer, matching author-facing CSS — the WAT emission side
      // reverses this since bottom-layer-paints-first per css-backgrounds-3
      // §3.8, not this resolution step).
      if (n.backgroundImages && n.backgroundImages.length) {
        const resolvedLayers = [];
        for (const layer of n.backgroundImages) {
          // A layer with no src is a legitimate authoring state (same
          // rationale as the <img> guard above) — writeBackgroundLayers'
          // own default (imageIndex ?? 0xFFFF) treats "no imageIndex" as
          // "none", so this layer still occupies a pool slot but paints
          // nothing (see $emitNodeRect's bgImageIndex != 0xFFFF guard).
          resolvedLayers.push(
            layer.src
              ? {
                ...layer,
                imageIndex: await imageIndexFor(
                  layer.src,
                  resolveResource,
                  layer.resourceIdentifier,
                ),
              }
              : layer,
          );
        }
        next = { ...next, resolvedBackgroundImages: resolvedLayers };
      }
      // mask-image (P11): the same per-layer src resolution as
      // backgroundImages above, into its own resolved list (a node can have
      // both — a background layer list and a mask layer list — and they
      // reach two different pools).
      if (n.masks && n.masks.length) {
        const resolvedMasks = [];
        for (const layer of n.masks) {
          resolvedMasks.push(
            layer.src
              ? {
                ...layer,
                imageIndex: await imageIndexFor(
                  layer.src,
                  resolveResource,
                  layer.resourceIdentifier,
                ),
              }
              : layer,
          );
        }
        next = { ...next, resolvedMasks };
      }
      // border-image (P14): one source per node, not a layer list — the
      // shorthand has no comma syntax. Its own resolved field rather than
      // reusing imageIndex, because a node can have BOTH an <img> src and a
      // border-image.
      if (n.borderImage && n.borderImage.src) {
        next = {
          ...next,
          resolvedBorderImage: {
            ...n.borderImage,
            imageIndex: await imageIndexFor(
              n.borderImage.src,
              resolveResource,
            ),
          },
        };
      }
      if (next !== n && out === null) out = nodes.slice(0, index);
      if (out !== null) out.push(next);
    }
    return out ?? nodes;
  }

  // svg-use (S6 step 2): a JS-side STRUCTURAL CLONE at scene-authoring time,
  // NOT a new runtime node kind or WAT concept at all (confirmed against
  // the real SVG 2 spec: "the 'use'
  // element does not itself establish a new viewport" when referencing a
  // plain shape — no clip, no new coordinate system, just a clone-in-place
  // with x/y composing as a plain translate appended AFTER the use's own
  // transform). Must run BEFORE every other preprocessing pass (resolveSvg
  // PathIndices included) since a cloned shape still needs its own path/bbox
  // resolved same as an authored one.
  //
  // This is NOT a 1:1 map like resolveImageIndices/resolveSvgPathIndices
  // above — a `svg-use` node's clone can be a WHOLE SUBTREE (any size), so
  // this REBUILDS the entire flat nodes array. The engine's OWN contiguity
  // rule is stricter than plain depth-first pre-order: a parent's DIRECT
  // children must occupy one contiguous block with NOTHING else (not even
  // a grandchild) interleaved between them (writeNode's own throw-on-
  // violation check; confirmed against this codebase's own existing
  // "reordered contiguous children" positive-control test, which places
  // EVERY node's direct children immediately, THEN appends each child's own
  // subtree afterward — level-order-per-branch, not strict pre-order). A
  // naive recursive pre-order rebuild (assign a child's index, then
  // immediately recurse into IT before moving to the next sibling) breaks
  // this the moment one child's own subtree has more than 1 node (exactly
  // what a svg-use child produces: a wrapper node PLUS its cloned
  // subtree) — the next sibling's freshly-assigned index would land AFTER
  // that whole subtree, no longer contiguous with the earlier siblings.
  // Fixed by processing nodes in a QUEUE (reserve every one of a node's
  // OWN direct children's indices as ONE contiguous block up front, then
  // queue each of THOSE children for its own later expansion) — this is
  // the same "reserve this level's slots before descending" shape a
  // level-order array-tree serialization already needs, applied here
  // specifically because svg-use is the first node kind whose own
  // "subtree" can be more than 1 node.
  //
  // Only handles a plain-shape href (step 2's own scope) — referencing an
  // `<svg>`/`<symbol>` (needs viewport/clip/width-height-override behavior)
  // is step 3, not yet implemented; that case is deliberately left
  // unhandled here (falls through to the generic clone below, which is
  // WRONG for that case — do not extend this function's scope without also
  // building step 3's own viewport-clip path).
  function resolveSvgUseNodes(nodes) {
    // Does this subtree (any depth) contain a svg-use node? If not, the
    // overwhelmingly common case (a scene with zero <use> at all) can skip
    // the whole rebuild and return the original array unchanged.
    if (!nodes.some((n) => n.display === "svg-use")) return nodes;

    const out = [];
    // Each queue entry is { newIndex, kind, ... } describing WORK still to
    // do at that already-reserved index — children not yet assigned/
    // reserved, so this level's siblings all got contiguous slots already.
    const queue = [];

    // Reserves ONE fresh contiguous slot for `originalIndex` (a node from
    // the ORIGINAL `nodes` array), queues its own children/expansion for
    // later, and returns the new index. Called once per entry in some
    // node's `children` array — so a sibling group's calls are all made
    // back-to-back, before any of THEIR OWN queued work runs, which is
    // exactly what keeps that sibling group contiguous.
    function reserveOriginal(originalIndex) {
      const n = nodes[originalIndex];
      const newIndex = out.length;
      out.push(null); // placeholder, filled in once this entry's queued work runs
      if (n.display === "svg-use") {
        if (n.href === undefined) {
          throw new Error(
            `resolveSvgUseNodes: node ${originalIndex} is svg-use with no href`,
          );
        }
        if (nodes[n.href] === undefined) {
          throw new Error(
            `resolveSvgUseNodes: node ${originalIndex}'s href=${n.href} does not exist`,
          );
        }
        if (nodes[n.href].display === "svg-use") {
          throw new Error(
            `resolveSvgUseNodes: node ${originalIndex}'s href=${n.href} is ITSELF a svg-use — chained <use> references are not supported`,
          );
        }
        queue.push({
          newIndex,
          kind: "use",
          useNode: n,
          sourceSceneNodeIndex: originalIndex,
        });
      } else {
        queue.push({
          newIndex,
          kind: "plain",
          src: n,
          sourceSceneNodeIndex: originalIndex,
        });
      }
      return newIndex;
    }
    // Same as reserveOriginal, but the referenced node came from a CLONE
    // (via a use's own href) rather than directly from `nodes` — kept as a
    // separate function (rather than a flag param) since a cloned node's
    // OWN children need to be reserved as clones too (recursive cloning),
    // never re-interpreting a clone's descendant as ANOTHER use reference
    // (chained <use> is unsupported, see reserveOriginal's own guard).
    function reserveClone(originalIndex, sourceSceneNodeIndex) {
      const src = nodes[originalIndex];
      const newIndex = out.length;
      out.push(null);
      queue.push({
        newIndex,
        kind: "clone",
        src,
        sourceSceneNodeIndex,
      });
      return newIndex;
    }

    reserveOriginal(0); // scene root — always lands at out[0], the same convention sceneHtml's renderNode(0) already relies on
    // BFS drain: `queue` only ever grows by exactly the reserved children
    // of whatever's dequeued next — since every reserve* call ALSO reserves
    // its OWN contiguous slot immediately (not deferred), draining the
    // queue in FIFO order naturally interleaves each level's worth of
    // reservations correctly across sibling subtrees.
    while (queue.length) {
      const entry = queue.shift();
      if (entry.kind === "plain") {
        const { src } = entry;
        const newChildren = src.children && src.children.length
          ? src.children.map((childIndex) => reserveOriginal(childIndex))
          : undefined;
        out[entry.newIndex] = {
          ...src,
          _inspectionSourceNodeIndex: entry.sourceSceneNodeIndex,
          ...(newChildren ? { children: newChildren } : {}),
        };
      } else if (entry.kind === "clone") {
        const { src } = entry;
        const newChildren = src.children && src.children.length
          ? src.children.map((childIndex) =>
            reserveClone(childIndex, entry.sourceSceneNodeIndex)
          )
          : undefined;
        out[entry.newIndex] = {
          ...src,
          _inspectionSourceNodeIndex: entry.sourceSceneNodeIndex,
          ...(newChildren ? { children: newChildren } : {}),
        };
      } else {
        // 'use': x/y (spec: "an additional translate(x,y), appended to the
        // RIGHT side of the transformation list") composes AFTER the use's
        // own transform, i.e. this node's own affine is `useTransform ∘
        // translate(x,y)`, matching composeAffine's own "outer ∘ inner"
        // convention (useTransform is outer, the x/y translate is inner,
        // closest to the referenced geometry). CONFIRMED against the real
        // spec text (not assumed) that x/y behave IDENTICALLY here whether
        // or not the reference establishes a viewport — no special case
        // needed for that part.
        const { useNode } = entry;
        const xy = {
          transform: { translate: { x: useNode.x ?? 0, y: useNode.y ?? 0 } },
        };
        const composed = composeAffine(
          resolveTransform(useNode),
          resolveTransform(xy),
        );
        const referenced = nodes[useNode.href];
        if (
          referenced.display === "svg" || referenced.display === "svg-symbol"
        ) {
          // S6 step 3: referencing a viewport-establishing element (a real
          // <svg> used as a definition, or a <symbol>) is genuinely
          // DIFFERENT from a plain-shape reference — confirmed via spec:
          // "the width and height properties on the 'use' element
          // override the values for the corresponding properties on a
          // referenced 'svg' or 'symbol' element" (falling back to the
          // referenced element's own value, then 100%/auto if neither
          // specifies one — the SAME fallback chain $resolveReplacedSize
          // already implements for an ordinary svg root's own width/
          // height, so passing `undefined` through when NEITHER side sets
          // one reaches that existing behavior for free, no new fallback
          // logic needed here). Per the confirmed design conclusion (no
          // new WAT-side kind needed): synthesize a CONCRETE display:'svg'
          // node carrying the composed transform, the resolved width/
          // height, and the referenced element's OWN viewBox/
          // preserveAspectRatio (properties of the referenced CONTENT,
          // never overridden by the use) — by the time WAT ever sees this
          // tree, it's just an ordinary svg root; <symbol>'s own "never
          // rendered unless referenced" semantics fall out entirely from
          // this node simply not existing in `nodes` at all until NOW.
          const newChildren = referenced.children && referenced.children.length
            ? referenced.children.map((childIndex) =>
              reserveClone(childIndex, entry.sourceSceneNodeIndex)
            )
            : undefined;
          out[entry.newIndex] = {
            display: "svg",
            transform: composed,
            width: useNode.width ?? referenced.width,
            height: useNode.height ?? referenced.height,
            boxSizing: referenced.boxSizing,
            viewBox: referenced.viewBox,
            preserveAspectRatio: referenced.preserveAspectRatio,
            ...(newChildren ? { children: newChildren } : {}),
            _inspectionSourceNodeIndex: entry.sourceSceneNodeIndex,
          };
        } else {
          // Plain shape/group reference (step 2's own case): wrap the
          // clone in a synthetic svg-group carrying the composed
          // transform. The clone's own root gets reserved as this
          // wrapper's ONLY child — reserveClone (not reserveOriginal)
          // since everything from here down is a copy, not an original
          // scene node.
          const clonedRootIndex = reserveClone(
            useNode.href,
            entry.sourceSceneNodeIndex,
          );
          out[entry.newIndex] = {
            display: "svg-group",
            transform: composed,
            children: [clonedRootIndex],
            _inspectionSourceNodeIndex: entry.sourceSceneNodeIndex,
          };
        }
      }
    }
    return out;
  }

  // Order-modified document order (CSS `order`, flex+grid — the Grid plan's
  // L1 ordering item). A flex or grid container's items lay out, place into
  // the automatic grid, and paint in ascending `order`, then tree order. The
  // engine consumes children strictly as a contiguous buffer block
  // (firstChild + count), so buffer order IS item order for layout, grid
  // automatic placement, and the paint walk alike — reordering the sibling
  // subtrees here, at scene-preprocessing time, gives all three consumers ONE
  // stable ordering with no engine-side `order` concept and no wire field.
  //
  // Same full-rebuild shape as resolveSvgUseNodes above (a sibling reorder
  // moves whole subtrees, which the contiguity rule turns into a rebuild),
  // including its fast path: a scene where every flex/grid sibling group is
  // already non-decreasing in `order` (the overwhelmingly common zero-`order`
  // case, and every serializeToScene scene — its own finalize step already
  // sorted) returns the original array unchanged, keeping caller-side index
  // maps valid. Array.prototype.sort is stable per specification, so equal
  // `order` values keep tree order.
  //
  // DOM source order and accessibility order are untouched: this reorders
  // only the render-scene array, never the DOM.
  const ORDER_CONTAINER_DISPLAYS = new Set([
    "flex",
    "inline-flex",
    "grid",
    "inline-grid",
  ]);

  function resolveOrderModifiedChildren(nodes) {
    let reorderNeeded = false;
    for (const n of nodes) {
      if (!n.children || n.children.length < 2) continue;
      if (!ORDER_CONTAINER_DISPLAYS.has(n.layoutDisplay ?? n.display)) continue;
      let previous = -Infinity;
      for (const childIndex of n.children) {
        const value = nodes[childIndex].order ?? 0;
        if (value < previous) {
          reorderNeeded = true;
          break;
        }
        previous = value;
      }
      if (reorderNeeded) break;
    }
    if (!reorderNeeded) return nodes;

    const out = [];
    const queue = [];
    function reserve(originalIndex) {
      const newIndex = out.length;
      out.push(null);
      queue.push({ newIndex, originalIndex });
      return newIndex;
    }
    reserve(0);
    while (queue.length) {
      const { newIndex, originalIndex } = queue.shift();
      const src = nodes[originalIndex];
      let childIndices = src.children;
      if (
        childIndices && childIndices.length > 1 &&
        ORDER_CONTAINER_DISPLAYS.has(src.layoutDisplay ?? src.display)
      ) {
        childIndices = childIndices.slice().sort(
          (a, b) => (nodes[a].order ?? 0) - (nodes[b].order ?? 0),
        );
      }
      const newChildren = childIndices && childIndices.length
        ? childIndices.map((childIndex) => reserve(childIndex))
        : undefined;
      out[newIndex] = {
        ...src,
        _inspectionSourceNodeIndex: src._inspectionSourceNodeIndex ??
          originalIndex,
        ...(newChildren ? { children: newChildren } : {}),
      };
    }
    return out;
  }

  // svg-path/svg-polygon/svg-polyline nodes need pathIndex + bbox resolved
  // BEFORE writeSvgShape (which is called synchronously inside a forEach,
  // unlike this async resolution step) — same "resolve async refs into a
  // plain field first" shape as resolveImageIndices above. polygon/polyline
  // derive their `d` from `points` (see pointsToPathDef) and are resolved
  // through the EXACT SAME path pipeline as svg-path — no separate atlas
  // entry point, no separate CMD opcode.
  // A DOM-backed path's definition, fill rule, and stroke: the core lowered
  // the path (a polygon's or polyline's points included) into the scene
  // node's `d`, and its record carries the fill rule and stroke paint.
  function coreSvgPath(node) {
    if (!node._coreSvgRequest) {
      throw new Error("DOM path lacks its producing native SVG request");
    }
    return node._coreSvgRequest;
  }

  // The path definition, fill rule, and stroke params of a path, polygon,
  // or polyline node, or null for any other node (or one without a path).
  function svgPathOf(n) {
    if (usesCoreRecord(n)) {
      if (n.d === undefined) return null;
      return coreSvgPath(n);
    }
    let d = n.d;
    if (n.display === "svg-polygon") {
      d = pointsToPathDef(n.points, /*closed=*/ true);
    } else if (n.display === "svg-polyline") {
      d = pointsToPathDef(n.points, /*closed=*/ false);
    } else if (n.display !== "svg-path") return null;
    if (!d) return null;
    return {
      d,
      fillRule: n.fillRule === "evenodd" ? "evenodd" : "nonzero",
      stroke: svgStrokeParamsFor(n),
    };
  }

  async function resolveSvgPathIndices(nodes) {
    let out = null;
    for (let index = 0; index < nodes.length; index++) {
      const raw = nodes[index];
      const n = dashedTierAAsPath(raw);
      const path = svgPathOf(n);
      if (path === null) {
        if (n !== raw && out === null) out = nodes.slice(0, index);
        if (out !== null) out.push(n);
        continue;
      }
      const { d, fillRule } = path;
      const pathIndex = await svgPathIndexFor(d, fillRule);
      const bbox = await svgPathBbox(d, fillRule);
      let next = { ...n, resolvedPathIndex: pathIndex, resolvedPathBbox: bbox };
      // S5: a stroked path/polygon/polyline ALSO needs the stroke's own
      // atlas entry + bbox, resolved here (before writeSvgShape, which
      // runs synchronously) exactly like the fill path above — see
      // svgStrokePathIndexFor's own comment for why this can't share the
      // fill's pathIndex/bbox.
      const stroke = path.stroke;
      if (stroke) {
        const strokePathIndex = await svgStrokePathIndexFor(
          d,
          fillRule,
          stroke,
        );
        const strokeBbox = await svgStrokePathBbox(d, fillRule, stroke);
        next = {
          ...next,
          resolvedStrokePathIndex: strokePathIndex,
          resolvedStrokePathBbox: strokeBbox,
        };
      }
      if (out === null) out = nodes.slice(0, index);
      out.push(next);
    }
    return out ?? nodes;
  }

  // Synchronous counterpart of resolveSvgPathIndices — throws (via
  // svgPathBboxSync/svgStrokePathBboxSync -> ensurePathsSync) if the
  // msdfgen wasm module hasn't loaded yet, same "pre-warm or fail loud"
  // contract as the font/image sync resolvers above.
  function resolveSvgPathIndicesSync(nodes) {
    let out = null;
    for (let index = 0; index < nodes.length; index++) {
      const raw = nodes[index];
      const n = dashedTierAAsPath(raw);
      const path = svgPathOf(n);
      let next = n;
      if (path !== null) {
        const { d, fillRule } = path;
        const pathIndex = svgPathIndexFor(d, fillRule);
        const bbox = svgPathBboxSync(d, fillRule);
        next = { ...n, resolvedPathIndex: pathIndex, resolvedPathBbox: bbox };
        const stroke = path.stroke;
        if (stroke) {
          const strokePathIndex = svgStrokePathIndexFor(d, fillRule, stroke);
          const strokeBbox = svgStrokePathBboxSync(d, fillRule, stroke);
          next = {
            ...next,
            resolvedStrokePathIndex: strokePathIndex,
            resolvedStrokePathBbox: strokeBbox,
          };
        }
      }
      // A scene without any path keeps its array; every node without one
      // keeps its identity (see resolveImageIndicesSync).
      if (next !== raw && out === null) out = nodes.slice(0, index);
      if (out !== null) out.push(next);
    }
    return out ?? nodes;
  }

  function resolvePolygonCoordinate(value, dimension) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.endsWith("%")) {
      const percent = Number.parseFloat(value);
      if (Number.isFinite(percent)) return dimension * percent / 100;
    }
    throw new Error(
      `clipPath polygon: unsupported coordinate ${JSON.stringify(value)}`,
    );
  }

  function polygonClipPathDef(points, box) {
    if (!Array.isArray(points) || points.length < 3) {
      throw new Error(
        "clipPath polygon: points must contain at least three coordinate pairs",
      );
    }
    return points.map((point, index) => {
      if (!Array.isArray(point) || point.length !== 2) {
        throw new Error(`clipPath polygon: point ${index} must be [x, y]`);
      }
      const x = resolvePolygonCoordinate(point[0], box.w);
      const y = resolvePolygonCoordinate(point[1], box.h);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    }).concat("Z").join(" ");
  }

  async function resolveClipPathIndices(nodes, boxes, deviceScale) {
    const out = [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const clipPath = node.clipPath;
      if (
        !clipPath || (clipPath.kind !== "polygon" && clipPath.kind !== "path")
      ) {
        out.push(node);
        continue;
      }
      const fillRule = clipPath.fillRule === "evenodd" ? "evenodd" : "nonzero";
      const pathDef = clipPath.kind === "polygon"
        ? polygonClipPathDef(clipPath.points, boxes[index])
        : clipPath.d;
      if (typeof pathDef !== "string" || pathDef.trim() === "") {
        throw new Error(
          `clipPath ${clipPath.kind}: a non-empty path is required`,
        );
      }
      const pathIndex = svgPathIndexFor(pathDef, fillRule);
      const bbox = await svgPathBbox(pathDef, fillRule);
      out.push({
        ...node,
        clipPath: {
          ...clipPath,
          resolvedPathIndex: pathIndex,
          resolvedPathBbox: bbox,
          resolvedCoordinateScale: 1,
        },
      });
    }
    return out;
  }

  function resolveClipPathIndicesSync(nodes, boxes) {
    return nodes.map((node, index) => {
      const clipPath = node.clipPath;
      if (
        !clipPath || (clipPath.kind !== "polygon" && clipPath.kind !== "path")
      ) return node;
      const fillRule = clipPath.fillRule === "evenodd" ? "evenodd" : "nonzero";
      const pathDef = clipPath.kind === "polygon"
        ? polygonClipPathDef(clipPath.points, boxes[index])
        : clipPath.d;
      if (typeof pathDef !== "string" || pathDef.trim() === "") {
        throw new Error(
          `clipPath ${clipPath.kind}: a non-empty path is required`,
        );
      }
      const pathIndex = svgPathIndexFor(pathDef, fillRule);
      const bbox = svgPathBboxSync(pathDef, fillRule);
      return {
        ...node,
        clipPath: {
          ...clipPath,
          resolvedPathIndex: pathIndex,
          resolvedPathBbox: bbox,
          resolvedCoordinateScale: 1,
        },
      };
    });
  }

  // After emit_commands has written CMD_TEXT commands (which reference
  // fontIndex directly, matching the font TABLE's index — not a CSS weight),
  // build exactly the atlases + glyph IDs those commands need, so render()'s
  // MSDF lookup has real glyph outlines to draw. Returns { atlases,
  // glyphBuffer } ready to pass straight into render()'s options.
  async function buildTextRenderResources(
    cmdView,
    bytesWritten,
    deviceScale = 1,
    glyphResourceManager = getDefaultGlyphResourceManager(),
    generationBackend = { kind: "cpu" },
  ) {
    const preparationStartedAt = performance.now();
    // "fontIndex|weight|opszCss" -> Set<glyphId>. The command stream
    // carries CSS-px font sizes (the engine lays out in CSS px), so
    // opszCss = FSIZE directly — the same value $shapeTextRun feeds hb's
    // opsz axis. GlyphAtlas.keyFor clamps to the font's own axis
    // range (and ignores opsz entirely for opsz-less fonts), so above-max
    // sizes share one instance, matching Chrome's clamp.
    const glyphIdsByFontWeightOpsz = new Map();
    // FRAME SNAPSHOT (see renderScenePixels): copy the glyph bytes
    // SYNCHRONOUSLY, before this function's first await — a synchronous
    // layout getter can re-emit the shared engine's glyph buffer while
    // atlas generation is parked below, and this buffer is also returned
    // to the caller, who reads it across further awaits (raster,
    // createPaintArtifact).
    // Only the bytes this emission wrote; the buffer moves when the
    // engine grows its text pools, so its base is read per emission.
    const glyphBufferBase = engine.exports.glyph_buffer_base();
    const glyphBuffer = new Uint8Array(
      engine.memory.buffer.slice(
        glyphBufferBase,
        glyphBufferBase + engine.exports.glyph_bytes(),
      ),
    );
    const glyphView = new DataView(
      glyphBuffer.buffer,
      glyphBuffer.byteOffset,
      glyphBuffer.byteLength,
    );

    // Walk EVERY command, advancing by the shared size rule — this walk must
    // survive any stream the engine emits (clip pushes, opacity/blend groups,
    // …), not just the opcodes it reads. The previous version stopped at the
    // first opcode it didn't know, so a CMD_PUSH_CLIP anywhere before a text
    // command starved every later text of its atlas → zero glyph ink under
    // overflow:hidden (BUG-text-not-painting-under-overflow-hidden).
    let off = 0;
    while (off < bytesWritten) {
      const opcode = cmdView.getUint8(off);
      if (opcode === CMD_TEXT) {
        const gcount = cmdView.getUint16(off + CMD_TEXT_OFFSET_GCOUNT, true);
        const goff = cmdView.getUint32(off + CMD_TEXT_OFFSET_GOFF, true);
        const fontIndex = cmdView.getUint16(off + CMD_TEXT_OFFSET_FONT, true);
        const weight = cmdView.getUint8(off + CMD_TEXT_OFFSET_WEIGHT) * 100;
        const fsize = cmdView.getFloat32(off + CMD_TEXT_OFFSET_FSIZE, true);
        const opszCss = fsize;
        // The CSS-px size also rides the group key for the MSDF
        // texel-budget bucket. An MSDF atlas samples correctly at any
        // raster scale, so the budget deliberately does NOT follow the
        // density: glyph resources are density-invariant and a density
        // change never regenerates a glyph (raster-scale plan, decision
        // item 5). Deep zooms sample the CSS-size budget; MSDF degrades
        // gradually there, the same trade a browser's pinch zoom makes.
        const key = `${fontIndex}|${weight}|${opszCss}|${fsize}`;
        let set = glyphIdsByFontWeightOpsz.get(key);
        if (!set) {
          set = new Set();
          glyphIdsByFontWeightOpsz.set(key, set);
        }
        for (let gi = 0; gi < gcount; gi++) {
          const glyphId = glyphView.getUint16(
            goff + gi * GLYPH_ENTRY_SIZE + GLYPH_OFFSET_ID,
            true,
          );
          if (glyphId !== GLYPH_ID_INVISIBLE) set.add(glyphId);
        }
      }
      off += commandByteSize(cmdView, off);
    }

    const resourceRequests = [];
    const fontIndices = [];
    for (const [key, glyphIds] of glyphIdsByFontWeightOpsz) {
      const [fontIndexString, weightString, opticalSizeString, fontSizeString] =
        key.split("|");
      const fontIndex = Number(fontIndexString);
      const weight = Number(weightString);
      const opticalSize = Number(opticalSizeString);
      const fontSize = Number(fontSizeString);
      const fontBytes = fontBytesByIndex.get(fontIndex);
      if (!fontBytes) {
        throw new Error(
          `no registered font bytes for fontIndex ${fontIndex} — CMD_TEXT references a font this harness never registered`,
        );
      }
      resourceRequests.push({
        fontBytes,
        glyphIds,
        weight,
        opticalSize,
        devicePixelSize: fontSize,
      });
      fontIndices.push(fontIndex);
    }
    const glyphLease = await glyphResourceManager.acquire(resourceRequests, {
      generationBackend,
    });
    const atlases = new Map();
    for (let index = 0; index < glyphLease.atlases.length; index++) {
      const fontIndex = fontIndices[index];
      atlases.set(fontIndex, {
        atlas: glyphLease.atlases[index],
        italicFace: fontIsItalicFaceByIndex.get(fontIndex) ?? false,
      });
    }
    const phaseMilliseconds = {
      ...glyphLease.glyphPerformance.phaseMilliseconds,
    };
    phaseMilliseconds.otherPreparationMilliseconds += Math.max(
      0,
      performance.now() - preparationStartedAt -
        glyphLease.glyphPerformance.totalMilliseconds,
    );
    const glyphPerformance = {
      requestedGlyphCount: glyphLease.glyphPerformance.requestedGlyphCount,
      cacheHitGlyphCount: glyphLease.glyphPerformance.cacheHitGlyphCount,
      generatedGlyphCount: glyphLease.glyphPerformance.generatedGlyphCount,
      outputTexelCount: glyphLease.glyphPerformance.outputTexelCount,
      generatedGlyphs: glyphLease.glyphPerformance.generatedGlyphs.map(
        ({ requestIndex, ...glyph }) => ({
          fontIndex: fontIndices[requestIndex],
          ...glyph,
        }),
      ),
      generationBackend: glyphLease.glyphPerformance.generationBackend,
      directAtlasPopulation: glyphLease.glyphPerformance.directAtlasPopulation,
      phaseMilliseconds,
    };
    return { atlases, glyphBuffer, glyphLease, glyphPerformance };
  }

  // After emit_commands has written CMD_SVG_PATH commands, ensure
  // sharedSvgPathAtlas has an MSDF generated at the ACTUAL on-screen scale
  // each command implies — an atlas entry generated at the wrong scale
  // bucket renders blurry/aliased (see SvgPathAtlas's own scale-bucket doc
  // in atlas.js). destW/destH is the RAW bbox, not the on-screen footprint:
  // WAT stores the viewBox/CSS-transform affine SEPARATELY in the command's
  // own transform block rather than pre-applying it to the dest rect (see
  // design/svg-rendering.md invariant 3), so this must fold that
  // affine's linear-part scale in before taking the max dimension. Returns
  // the atlas ready to pass straight into render()'s svgPathAtlas option.
  async function buildSvgPathRenderResources(
    cmdView,
    bytesWritten,
    deviceScale = 1,
  ) {
    const entries = [];
    let off = 0;
    while (off < bytesWritten) {
      const opcode = cmdView.getUint8(off);
      if (opcode === CMD_SVG_PATH) {
        const flags = cmdView.getUint8(off + CMD_SVG_PATH_OFFSET_FLAGS);
        const pathIndex = cmdView.getUint16(
          off + CMD_SVG_PATH_OFFSET_INDEX,
          true,
        );
        const destW = cmdView.getFloat32(off + CMD_SVG_PATH_OFFSET_W, true) *
          deviceScale;
        const destH = cmdView.getFloat32(off + CMD_SVG_PATH_OFFSET_H, true) *
          deviceScale;
        // design/svg-rendering.md invariant 3: destW/destH is the RAW
        // bbox — the command's own affine (transform block, when present) is
        // stored SEPARATELY, not pre-applied to the dest rect. Fold its
        // linear part's per-axis scale magnitude in so screenSize reflects
        // the true on-screen footprint under a scaling viewBox (e.g. a small
        // viewBox in a large viewport) or a scaling CSS transform on an
        // ancestor, not just the identity case every prior gallery/test
        // happened to use.
        let scaleX = 1, scaleY = 1;
        if (flags & CMD_SVG_PATH_FLAG_TRANSFORM) {
          const a = cmdView.getFloat32(off + CMD_SVG_PATH_OFFSET_XFORM, true);
          const b = cmdView.getFloat32(
            off + CMD_SVG_PATH_OFFSET_XFORM + 4,
            true,
          );
          const c = cmdView.getFloat32(
            off + CMD_SVG_PATH_OFFSET_XFORM + 8,
            true,
          );
          const d = cmdView.getFloat32(
            off + CMD_SVG_PATH_OFFSET_XFORM + 12,
            true,
          );
          scaleX = Math.hypot(a, b);
          scaleY = Math.hypot(c, d);
        }
        const def = svgPathDefByIndex.get(pathIndex);
        if (def) {
          entries.push({
            pathIndex,
            pathDef: def.pathDef,
            fillRule: def.fillRule,
            stroke: def.stroke,
            destW,
            destH,
            scaleX,
            scaleY,
          });
        }
      } else if (opcode === CMD_PUSH_CLIP) {
        const count = cmdView.getUint8(off + CMD_PUSH_CLIP_OFFSET_COUNT);
        for (let index = 0; index < count; index++) {
          const entry = off + CMD_PUSH_CLIP_HEADER_SIZE +
            index * CLIP_ENTRY_SIZE;
          const flags = cmdView.getUint8(entry + CLIP_ENTRY_OFFSET_FLAGS);
          if (!(flags & CLIP_ENTRY_FLAG_PATH_MASK)) continue;
          const payload = entry + CLIP_ENTRY_OFFSET_RADII;
          const pathIndex = cmdView.getUint32(payload, true);
          const coordinateScale = cmdView.getFloat32(payload + 4, true) *
            deviceScale;
          const destW = (cmdView.getFloat32(payload + 16, true) -
            cmdView.getFloat32(payload + 8, true)) * coordinateScale;
          const destH = (cmdView.getFloat32(payload + 20, true) -
            cmdView.getFloat32(payload + 12, true)) * coordinateScale;
          let scaleX = 1;
          let scaleY = 1;
          if (flags & CLIP_ENTRY_FLAG_AFFINE) {
            const a = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE,
              true,
            );
            const b = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE + 4,
              true,
            );
            const c = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE + 8,
              true,
            );
            const d = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE + 12,
              true,
            );
            scaleX = Math.hypot(a, b);
            scaleY = Math.hypot(c, d);
          }
          const def = svgPathDefByIndex.get(pathIndex);
          if (def) {
            entries.push({
              pathIndex,
              pathDef: def.pathDef,
              fillRule: def.fillRule,
              destW,
              destH,
              scaleX,
              scaleY,
            });
          }
        }
      }
      off += commandByteSize(cmdView, off);
    }
    if (entries.length === 0) {
      sharedSvgPathAtlas.rebuildAtlas();
      return sharedSvgPathAtlas;
    }

    // screenSize is the on-screen footprint's max dimension — destW/destH
    // (the raw bbox) scaled by the command's own affine, when one is
    // present. No-transform commands keep today's behavior exactly (factor
    // 1×1).
    const ensureEntries = entries.map((
      { pathIndex, pathDef, fillRule, stroke, destW, destH, scaleX, scaleY },
    ) => ({
      pathIndex,
      pathDef,
      fillRule,
      stroke,
      screenSize: Math.max(destW * scaleX, destH * scaleY),
    }));
    await sharedSvgPathAtlas.ensurePaths(ensureEntries);
    sharedSvgPathAtlas.rebuildAtlas();
    return sharedSvgPathAtlas;
  }

  const col = (c) => c || { r: 0, g: 0, b: 0, a: 0 };

  // Spec sugar → the engine's per-side form (Slice P2). `borderColor` is
  // either ONE color {r,g,b,a} (all four sides) or per-side colors
  // { top, right, bottom, left } (a missing side is transparent). The engine
  // and rasterizer only ever see the four-slot form.
  function normalizedBorderColors(node) {
    const c = node.borderColor;
    if (
      c && (c.top !== undefined || c.right !== undefined ||
        c.bottom !== undefined || c.left !== undefined)
    ) {
      return {
        top: col(c.top),
        right: col(c.right),
        bottom: col(c.bottom),
        left: col(c.left),
      };
    }
    const uniform = col(c);
    return { top: uniform, right: uniform, bottom: uniform, left: uniform };
  }

  // `borderStyle` (P7) is either ONE style string (all four sides) or
  // per-side strings { top, right, bottom, left } (a missing side is
  // solid). Same spec-sugar shape as normalizedBorderColors above.
  const BORDER_STYLE_NAME_TO_VALUE = {
    solid: BORDER_STYLE_SOLID,
    double: BORDER_STYLE_DOUBLE,
    dashed: BORDER_STYLE_DASHED,
    dotted: BORDER_STYLE_DOTTED,
    inset: BORDER_STYLE_INSET,
    outset: BORDER_STYLE_OUTSET,
    groove: BORDER_STYLE_GROOVE,
    ridge: BORDER_STYLE_RIDGE,
    none: BORDER_STYLE_NONE,
    hidden: BORDER_STYLE_HIDDEN,
  };
  function borderStyleValue(name) {
    if (name === undefined) return BORDER_STYLE_SOLID;
    const value = BORDER_STYLE_NAME_TO_VALUE[name];
    if (value === undefined) {
      throw new Error(`borderStyle: unknown style ${JSON.stringify(name)}`);
    }
    return value;
  }
  function normalizedBorderStyles(node) {
    const s = node.borderStyle;
    if (typeof s === "object" && s !== null) {
      return {
        top: borderStyleValue(s.top),
        right: borderStyleValue(s.right),
        bottom: borderStyleValue(s.bottom),
        left: borderStyleValue(s.left),
      };
    }
    const uniform = borderStyleValue(s);
    return { top: uniform, right: uniform, bottom: uniform, left: uniform };
  }

  // `borderRadius` is either ONE number (all corners, circular) or per-corner
  // { topLeft, topRight, bottomRight, bottomLeft } (a missing corner is
  // square). CSS corner order everywhere. P10: each corner value can ALSO be
  // {rx, ry} instead of a plain number, for a genuinely ELLIPTICAL corner
  // (CSS `border-radius: h / v` syntax) — a plain number is shorthand for
  // rx===ry. A percentage ("50%") resolves against the BORDER BOX at
  // emission time, where the used size is known: it travels to the engine
  // as a NEGATIVE value (radii are never negative in CSS, so the sign bit
  // is free) and $clampRectRadii resolves rx against the box width and ry
  // against the box height before the css-backgrounds-3 §5.4 clamp.
  // Returns {topLeft: {rx,ry}, topRight: {rx,ry}, ...}.
  function radiusComponent(v) {
    if (typeof v === "string") {
      const match = /^([\d.]+)%$/.exec(v.trim());
      if (!match) throw new Error(`borderRadius: unsupported value "${v}"`);
      return -Number(match[1]);
    }
    return v || 0;
  }
  function cornerRxRy(v) {
    if (v === undefined || v === null) return { rx: 0, ry: 0 };
    if (typeof v === "object") {
      return { rx: radiusComponent(v.rx), ry: radiusComponent(v.ry) };
    }
    const component = radiusComponent(v);
    return { rx: component, ry: component };
  }
  function normalizedBorderRadii(node) {
    const r = node.borderRadius;
    // A per-corner spec has at least one of the four corner keys; {rx,ry} on
    // its own (no corner keys) is P10's UNIFORM-ellipse shorthand instead —
    // same rx/ry pair replicated to all four corners.
    if (typeof r === "object" && r !== null) {
      const isPerCorner = "topLeft" in r || "topRight" in r ||
        "bottomRight" in r || "bottomLeft" in r;
      if (isPerCorner) {
        return {
          topLeft: cornerRxRy(r.topLeft),
          topRight: cornerRxRy(r.topRight),
          bottomRight: cornerRxRy(r.bottomRight),
          bottomLeft: cornerRxRy(r.bottomLeft),
        };
      }
    }
    const uniform = cornerRxRy(r);
    return {
      topLeft: uniform,
      topRight: uniform,
      bottomRight: uniform,
      bottomLeft: uniform,
    };
  }

  // float / clear DSL values → u8 enums (design/floats.md). Unknown
  // values throw rather than silently writing 0 — same fail-loud convention
  // as blendMode.
  function floatByte(value) {
    if (value === undefined || value === "none") return FLOAT_NONE;
    if (value === "left") return FLOAT_LEFT;
    if (value === "right") return FLOAT_RIGHT;
    throw new Error(`unknown float: ${value}`);
  }

  function clearByte(value) {
    if (value === undefined || value === "none") return CLEAR_NONE;
    if (value === "left") return CLEAR_LEFT;
    if (value === "right") return CLEAR_RIGHT;
    if (value === "both") return CLEAR_BOTH;
    throw new Error(`unknown clear: ${value}`);
  }

  function usesCoreRecord(node) {
    return node._coreBox !== undefined;
  }



  // Authored values and DOM-backed rows join one native publication. The host
  // completes only asynchronous font, image, and path resource references.
  function publishCoreFrame(nodes, patchIndex = null) {
    const publication = publishDirectSceneInput(
      core, nodes, imagePixelsFor, patchIndex,
    );
    if (publication === 0) return false;
    let imageCount = 0;
    for (const node of nodes) {
      if (usesCoreRecord(node)) {
        imageCount += node.resolvedBackgroundImages?.length ?? 0;
      }
    }
    const input = core.engineRecordFrameInput(
      nodes.length,
      imageCount,
      patchIndex === null ? null : { publication, index: patchIndex },
    );
    if (input === null) return false;
    const { view: inputView } = input;
    // DOM and engine share this instance: publish directly into final records.
    writeEngineFrameInput(inputView, input.header, {
      count: nodes.length,
      imageCount,
      publication,
      flags: 1,
      sceneGeneration,
    });
    let imageCursor = 0;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const row = input.rows + index * EngineFrameResolutionSize;
      let flags = 0;
      // Scene capture precedes asynchronous font resource resolution: the
      // resolved renderer table index lands over the native record, like
      // the image and path joins; a retained zero would shape the first
      // frame against the fallback face.
      if (node.fontIndex !== undefined) {
        flags |= 1;
        inputView.setUint32(
          row + EngineFrameResolutionFields.fontIndex,
          node.fontIndex,
          true,
        );
      }
      if (node.imageIndex !== undefined) {
        flags |= 2;
        inputView.setUint32(
          row + EngineFrameResolutionFields.imageIndex,
          node.imageIndex,
          true,
        );
      }
      if (usesCoreRecord(node) && node.resolvedPathIndex !== undefined) {
        flags |= 4;
        inputView.setUint32(
          row + EngineFrameResolutionFields.pathIndex,
          node.resolvedPathIndex,
          true,
        );
        const fill = node.resolvedPathBbox ??
          { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
        inputView.setFloat64(
          row + EngineFrameResolutionFields.fillBounds0,
          fill.xMin,
          true,
        );
        inputView.setFloat64(
          row + EngineFrameResolutionFields.fillBounds1,
          fill.yMin,
          true,
        );
        inputView.setFloat64(
          row + EngineFrameResolutionFields.fillBounds2,
          fill.xMax,
          true,
        );
        inputView.setFloat64(
          row + EngineFrameResolutionFields.fillBounds3,
          fill.yMax,
          true,
        );
        if (node.resolvedStrokePathIndex !== undefined) {
          flags |= 8;
          inputView.setUint32(
            row + EngineFrameResolutionFields.strokePathIndex,
            node.resolvedStrokePathIndex,
            true,
          );
          const stroke = node.resolvedStrokePathBbox ??
            { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
          inputView.setFloat64(
            row + EngineFrameResolutionFields.strokeBounds0,
            stroke.xMin,
            true,
          );
          inputView.setFloat64(
            row + EngineFrameResolutionFields.strokeBounds1,
            stroke.yMin,
            true,
          );
          inputView.setFloat64(
            row + EngineFrameResolutionFields.strokeBounds2,
            stroke.xMax,
            true,
          );
          inputView.setFloat64(
            row + EngineFrameResolutionFields.strokeBounds3,
            stroke.yMax,
            true,
          );
        }
      }
      const layers = usesCoreRecord(node) ? node.resolvedBackgroundImages : null;
      if (layers?.length) {
        flags |= 16;
        inputView.setUint32(
          row + EngineFrameResolutionFields.backgroundImages,
          imageCursor,
          true,
        );
        inputView.setUint32(
          row + EngineFrameResolutionFields.backgroundImageCount,
          layers.length,
          true,
        );
        for (const layer of layers) {
          inputView.setUint32(
            input.images + imageCursor * 4,
            layer.imageIndex ?? 0xffff,
            true,
          );
          imageCursor++;
        }
      }
      inputView.setUint32(row + EngineFrameResolutionFields.flags, flags, true);
    }
    const frame = core.engineRecordFrame();
    if (frame === null) return false;
    frame.patchIndex = patchIndex;
    return frame;
  }

  // Prepared text remains retained for inspection; publication and generation
  // comparison of its source spans are native.
  let currentTextBatch = null;
  function backgroundLayerList(node) {
    const layers = node.resolvedBackgroundImages ?? node.backgroundImages;
    const attachment = node.backgroundAttachment ?? "scroll";
    if (!layers?.length) {
      return node.backgroundGradient && attachment !== "scroll"
        ? [{ gradient: node.backgroundGradient, attachment }]
        : null;
    }
    return node.backgroundGradient
      ? [...layers, { gradient: node.backgroundGradient, attachment }]
      : layers;
  }

  function edgeQuad(spec, fallback) {
    const v = spec === undefined ? fallback : spec;
    const a = Array.isArray(v) ? v : [v];
    if (a.length === 1) return [a[0], a[0], a[0], a[0]];
    if (a.length === 2) return [a[0], a[1], a[0], a[1]];
    if (a.length === 3) return [a[0], a[1], a[2], a[1]];
    return [a[0], a[1], a[2], a[3]];
  }



  // ---- spec → CSS/HTML (the Chrome side) ----
  function cssSize(v) {
    if (v === undefined || v === "auto") return "auto";
    if (typeof v === "number") return `${v}px`;
    if (
      v && typeof v === "object" &&
      Number.isFinite(v.pixels) && Number.isFinite(v.percentage)
    ) {
      const sign = v.percentage < 0 ? "-" : "+";
      return `calc(${v.pixels}px ${sign} ${Math.abs(v.percentage * 100)}%)`;
    }
    return v;
  }
  const rgba = (c) =>
    c && c.a > 0
      ? `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${
        Math.round(c.b * 255)
      },${c.a})`
      : "transparent";

  // svg shape children (design/svg-rendering.md): SVG presentation attributes
  // (cx/r/x/width/fill/...) are NOT CSS properties — applying nodeCss's
  // ordinary width/height/etc. declarations to a <rect>/<circle> element
  // would be meaningless (SVG geometry attributes, not boxes). sceneHtml's
  // renderNode emits real SVG attributes directly instead; nodeCss
  // contributes nothing for these nodes.
  // svg-symbol (S6 step 3): a DEFINITION-only node, never itself linked
  // into any `children` array (only ever reached via a use.href index) —
  // nodeCss should treat it as a no-op just like every other member here,
  // since <symbol> gets display:none unconditionally per the UA
  // stylesheet regardless of any CSS declared on it.
  // svg-use (S6 steps 2-3): its own x/y/width/height/transform are ALL
  // real SVG attributes on the <use> element itself (renderNode's own
  // svg-use branch emits them directly) — applying nodeCss's ordinary
  // width:/height:/transform: CSS declarations ON TOP would double-apply
  // sizing/positioning that's already fully expressed via attributes
  // (found as a real bug: a real Chrome oracle test showed both instances
  // shifted/resized wrong until this was added).
  const SVG_SHAPE_DISPLAY_NAMES_CSS = new Set([
    "svg-rect",
    "svg-circle",
    "svg-ellipse",
    "svg-line",
    "svg-path",
    "svg-polygon",
    "svg-polyline",
    "svg-group",
    "svg-symbol",
    "svg-use",
  ]);

  // Shared by nodeCss's own filter: and backdrop-filter: declarations — CSS
  // space-separated function list, list order preserved AS-IS (matches
  // writeFilterList's own list-order-is-chaining-order convention). amount
  // is unitless for color-matrix functions (CSS accepts a bare number OR
  // percentage — this DSL's own `amount` is always the unitless/fraction
  // form, e.g. 1 not 100%) except hue-rotate (angle, deg — writeFilterList
  // converts to radians on the WASM side, this oracle-CSS side stays in
  // degrees since that's what the `deg` unit expects), blur (length, px —
  // this DSL's own `amount` IS sigma directly, which is also exactly what
  // CSS's own blur() length argument means, so no conversion needed here),
  // and drop-shadow (CSS's own `drop-shadow(dx dy sigma color)` shorthand —
  // NOTE: unlike box-shadow, drop-shadow's blur argument in CSS is ALSO
  // literally sigma, same "no radius/2 mapping" convention as blur() itself,
  // confirmed by writeFilterList's own doc comment for the WASM-side
  // payload).
  function filterListCss(filters) {
    return filters.map((f) => {
      if (f.type === "hue-rotate") return `hue-rotate(${f.amount ?? 0}deg)`;
      if (f.type === "blur") return `blur(${f.amount ?? 0}px)`;
      if (f.type === "drop-shadow") {
        const c = f.color ?? { r: 0, g: 0, b: 0, a: 1 };
        return `drop-shadow(${f.dx ?? 0}px ${f.dy ?? 0}px ${f.sigma ?? 0}px ${
          rgba(c)
        })`;
      }
      return `${f.type}(${f.amount ?? 1})`;
    }).join(" ");
  }

  // One CSS <gradient> function from this DSL's {kind, repeating, angle,
  // center, shape, size, stops} shape — shared by background-image and
  // P11's mask-image, which take the identical gradient object.
  function cssGradientImage(g) {
    const stopsCss = g.stops.map((s) =>
      `${rgba(s.color)} ${(s.position ?? 0) * 100}%`
    ).join(", ");
    const repeatingPrefix = g.repeating ? "repeating-" : "";
    // css-images-4 <color-interpolation-method>: emitted only when the DSL
    // names one, so every pre-existing scene keeps its exact CSS text.
    const hueClause = g.hueMethod && g.hueMethod !== "shorter"
      ? ` ${g.hueMethod} hue`
      : "";
    const interpolationCss = g.interpolationSpace
      ? ` in ${g.interpolationSpace}${hueClause}`
      : "";
    if (g.kind === "linear") {
      return `${repeatingPrefix}linear-gradient(${
        g.angle ?? 0
      }deg${interpolationCss}, ${stopsCss})`;
    }
    // css's <position> takes bare length/percent components (no 'x'/'y'
    // suffix) in x-then-y order — same values this scene DSL's own
    // `center` field already carries, just needing unit suffixes for a
    // plain number (matches cssSize's own length-vs-percent convention).
    const [centerXSpec, centerYSpec] = g.center ?? ["50%", "50%"];
    const centerCss = `${cssSize(centerXSpec)} ${cssSize(centerYSpec)}`;
    if (g.kind === "conic") {
      return `${repeatingPrefix}conic-gradient(from ${
        g.angle ?? 0
      }deg at ${centerCss}${interpolationCss}, ${stopsCss})`;
    }
    if (g.kind !== "radial") {
      throw new Error(`cssGradientImage: unknown gradient kind "${g.kind}"`);
    }
    const shapeCss = g.shape ?? "ellipse";
    // css-images-3's <radial-size> grammar: an EXPLICIT circle takes a
    // single <length> (not a pair) — `circle 60px 60px` is invalid CSS and
    // Chrome silently drops the whole declaration on a parse failure
    // (found exactly this way: an explicit-circle demo scene rendered a
    // real gradient in sandom but a completely BLANK box in Chrome — not
    // an engine bug, a CSS syntax mistake in this emission code). An
    // explicit ellipse still takes the rx/ry pair.
    const sizeCss = Array.isArray(g.size)
      ? (g.shape === "circle"
        ? cssSize(g.size[0])
        : `${cssSize(g.size[0])} ${cssSize(g.size[1] ?? g.size[0])}`)
      : (g.size ?? "farthest-corner");
    return `${repeatingPrefix}radial-gradient(${shapeCss} ${sizeCss} at ${centerCss}${interpolationCss}, ${stopsCss})`;
  }

  function nodeCss(n) {
    if (SVG_SHAPE_DISPLAY_NAMES_CSS.has(n.display)) return "";
    const d = [];
    d.push("box-sizing:" + (n.boxSizing === 1 ? "border-box" : "content-box"));
    // n.bfc is a BFC-establishment-only test knob (Chrome has no "BFC but
    // don't clip" property, so overflow:hidden is the trigger either way);
    // n.overflow:'hidden' (Slice P1) is the real, visually-clipping case —
    // see chrome-oracle.js's matching nodeCss comment for the full reasoning.
    if (n.bfc) d.push("overflow:hidden");
    else if (n.overflow !== undefined) d.push(`overflow:${n.overflow}`);
    // clip-path (P9): real CSS basic-shape syntax for the Chrome-oracle
    // side, from the same scene fields writeClipPath encodes for the
    // engine. Value formatting: numbers are px, strings ('50%',
    // 'closest-side', 'farthest-side') pass through verbatim.
    if (n.clipPath) {
      const cp = n.clipPath;
      const len = (v) => (typeof v === "number" ? `${v}px` : v);
      if (cp.kind === "inset") {
        let inset = `inset(${len(cp.top ?? 0)} ${len(cp.right ?? 0)} ${
          len(cp.bottom ?? 0)
        } ${len(cp.left ?? 0)}`;
        const corners = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
        const cornerRadii = corners.map((corner) => {
          const v = cp.radii ? (cp.radii[corner] ?? 0) : (cp.radius ?? 0);
          return typeof v === "object"
            ? { rx: v.rx ?? 0, ry: v.ry ?? 0 }
            : { rx: v, ry: v };
        });
        if (cornerRadii.some((r) => r.rx > 0 || r.ry > 0)) {
          const anyElliptical = cornerRadii.some((r) => r.rx !== r.ry);
          inset += anyElliptical
            ? ` round ${cornerRadii.map((r) => `${r.rx}px`).join(" ")} / ${
              cornerRadii.map((r) => `${r.ry}px`).join(" ")
            }`
            : ` round ${cornerRadii.map((r) => `${r.rx}px`).join(" ")}`;
        }
        d.push(`clip-path:${inset})`);
      } else if (cp.kind === "circle") {
        d.push(
          `clip-path:circle(${len(cp.r ?? "closest-side")} at ${
            len(cp.cx ?? "50%")
          } ${len(cp.cy ?? "50%")})`,
        );
      } else if (cp.kind === "ellipse") {
        d.push(
          `clip-path:ellipse(${len(cp.rx ?? "closest-side")} ${
            len(cp.ry ?? "closest-side")
          } at ${len(cp.cx ?? "50%")} ${len(cp.cy ?? "50%")})`,
        );
      } else if (cp.kind === "polygon") {
        const fillRule = cp.fillRule === "evenodd" ? "evenodd, " : "";
        const points = cp.points.map(([x, y]) => `${len(x)} ${len(y)}`).join(
          ", ",
        );
        d.push(`clip-path:polygon(${fillRule}${points})`);
      } else if (cp.kind === "path") {
        const fillRule = cp.fillRule === "evenodd" ? "evenodd, " : "";
        d.push(`clip-path:path(${fillRule}"${cp.d.replaceAll('"', '\\"')}")`);
      }
    }
    // Text declarations (Slice 6; multi-family since T4). font-family MUST
    // match the font sandom shapes with (the registry maps the node's
    // fontFamily key to the same test-assets file both sides use) for the
    // pixel/box comparison to mean anything; the gallery/pixel-test harness
    // is responsible for loading the matching @font-face for the Chrome
    // side (fontFaceCss in examples/font-registry.js).
    if (
      n.display === "text" || n.display === "inline" ||
      n.display === "inline-block" || n.inlineCtx
    ) {
      d.push(
        `font-family:${
          fontFamilyCssValue(
            n.fontFamily ?? fontFamilyKeyForCssValue(DEFAULT_FONT_FAMILY),
          )
        }`,
      );
      d.push(`font-size:${n.fontSize ?? DEFAULT_FONT_SIZE}px`);
      d.push(`font-weight:${fontWeightInCssUnits(n.fontWeight)}`);
      d.push(`font-style:${n.fontStyle ?? "normal"}`);
      d.push(`text-align:${n.textAlign ?? "left"}`);
      d.push(`text-decoration:${n.textDecoration ?? "none"}`);
      d.push(`text-overflow:${n.textOverflow ?? "clip"}`);
      if (n.verticalAlign !== undefined) {
        const verticalAlign = typeof n.verticalAlign === "object"
          ? `${n.verticalAlign.px}px`
          : n.verticalAlign;
        d.push(`vertical-align:${verticalAlign}`);
      }
      // Text color defaults to opaque black (CSS initial), NOT transparent —
      // mirrors writeNode's same special case for NODE_TEXT_COLOR.
      d.push("color:" + rgba(n.color || { r: 0, g: 0, b: 0, a: 1 }));
      const lh = n.lineHeight;
      if (lh === undefined || lh === "normal") d.push("line-height:normal");
      else if (typeof lh === "number") d.push(`line-height:${lh}`);
      else if (typeof lh === "object" && typeof lh.px === "number") {
        d.push(`line-height:${lh.px}px`);
      }
    }
    if (
      typeof n.display === "string" &&
      (n.display === "table" || n.display === "inline-table" ||
        n.display.startsWith("table-"))
    ) {
      d.push(`display:${n.display}`);
      if (n.tableLayout !== undefined) d.push(`table-layout:${n.tableLayout}`);
      if (n.borderCollapse !== undefined) {
        d.push(`border-collapse:${n.borderCollapse}`);
      }
      if (n.borderSpacing !== undefined) {
        const spacing = Array.isArray(n.borderSpacing)
          ? n.borderSpacing
          : [n.borderSpacing];
        d.push(
          `border-spacing:${spacing.map((value) => `${value}px`).join(" ")}`,
        );
      }
      if (n.captionSide !== undefined) d.push(`caption-side:${n.captionSide}`);
      if (n.emptyCells !== undefined) d.push(`empty-cells:${n.emptyCells}`);
    }
    // Flex container declarations.
    if (n.display === "flex" || n.display === "inline-flex") {
      d.push(`display:${n.display}`);
      if (n.flexDirection) d.push(`flex-direction:${n.flexDirection}`);
      if (n.justifyContent) d.push(`justify-content:${n.justifyContent}`);
      if (n.alignItems) d.push(`align-items:${n.alignItems}`);
      if (n.flexWrap) d.push(`flex-wrap:${n.flexWrap}`);
      if (n.gap !== undefined) d.push(`gap:${n.gap}px`);
      if (n.rowGap !== undefined) d.push(`row-gap:${n.rowGap}px`);
      if (n.columnGap !== undefined) d.push(`column-gap:${n.columnGap}px`);
    }
    if (n.display === "grid" || n.display === "inline-grid") {
      d.push(`display:${n.display}`);
      d.push(
        `grid-template-columns:${
          Array.isArray(n.gridTemplateColumns)
            ? n.gridTemplateColumns.map(gridTrackCss).join(" ")
            : n.gridTemplateColumns || "none"
        }`,
      );
      d.push(
        `grid-template-rows:${
          Array.isArray(n.gridTemplateRows)
            ? n.gridTemplateRows.map(gridTrackCss).join(" ")
            : n.gridTemplateRows || "none"
        }`,
      );
      if (n.gridTemplateAreas !== undefined) {
        d.push(
          `grid-template-areas:${
            n.gridTemplateAreas.map((row) => `"${row}"`).join(" ")
          }`,
        );
      }
      if (n.gridAutoColumns !== undefined) {
        d.push(`grid-auto-columns:${gridTrackCss(n.gridAutoColumns)}`);
      }
      if (n.gridAutoRows !== undefined) {
        d.push(`grid-auto-rows:${gridTrackCss(n.gridAutoRows)}`);
      }
      if (n.gridAutoFlow !== undefined) {
        d.push(`grid-auto-flow:${n.gridAutoFlow}`);
      }
      if (n.gap !== undefined) d.push(`gap:${cssSize(n.gap)}`);
      if (n.rowGap !== undefined) d.push(`row-gap:${cssSize(n.rowGap)}`);
      if (n.columnGap !== undefined) {
        d.push(`column-gap:${cssSize(n.columnGap)}`);
      }
      if (n.alignItems !== undefined) d.push(`align-items:${n.alignItems}`);
      if (n.justifyItems !== undefined) {
        d.push(`justify-items:${n.justifyItems}`);
      }
      if (n.alignContent !== undefined) {
        d.push(`align-content:${n.alignContent}`);
      }
      if (n.justifyContent !== undefined) {
        d.push(`justify-content:${n.justifyContent}`);
      }
    }
    // Flex item declarations (only meaningful when parent is flex; harmless else).
    if (n.flexGrow !== undefined) d.push(`flex-grow:${n.flexGrow}`);
    if (n.flexShrink !== undefined) d.push(`flex-shrink:${n.flexShrink}`);
    if (n.flexBasis !== undefined) d.push(`flex-basis:${cssSize(n.flexBasis)}`);
    if (n.alignSelf !== undefined) d.push(`align-self:${n.alignSelf}`);
    if (n.order !== undefined) d.push(`order:${n.order}`);
    if (n.gridRowStart !== undefined) {
      d.push(`grid-row-start:${n.gridRowStart}`);
    }
    if (n.gridRowEnd !== undefined) d.push(`grid-row-end:${n.gridRowEnd}`);
    if (n.gridColumnStart !== undefined) {
      d.push(`grid-column-start:${n.gridColumnStart}`);
    }
    if (n.gridColumnEnd !== undefined) {
      d.push(`grid-column-end:${n.gridColumnEnd}`);
    }
    if (n.gridArea !== undefined) d.push(`grid-area:${n.gridArea}`);
    if (n.justifySelf !== undefined) d.push(`justify-self:${n.justifySelf}`);
    // float / clear (design/floats.md). floatByte/clearByte validate
    // the same values writeNode accepts, so oracle HTML can never diverge
    // from what the engine side was given.
    if (n.float !== undefined) {
      floatByte(n.float);
      d.push(`float:${n.float}`);
    }
    if (n.clear !== undefined) {
      clearByte(n.clear);
      d.push(`clear:${n.clear}`);
    }
    d.push("width:" + cssSize(n.width));
    d.push("height:" + cssSize(n.height));
    if (n.aspectRatio !== undefined) d.push(`aspect-ratio:${n.aspectRatio}`);
    if (n.minWidth !== undefined) d.push("min-width:" + cssSize(n.minWidth));
    if (n.minHeight !== undefined) d.push("min-height:" + cssSize(n.minHeight));
    if (n.maxWidth !== undefined) d.push("max-width:" + cssSize(n.maxWidth));
    if (n.maxHeight !== undefined) d.push("max-height:" + cssSize(n.maxHeight));
    const m = n.margin || {};
    d.push(
      "margin-top:" + (n.marginTop === "auto" ? "auto" : `${m.top || 0}px`),
    );
    d.push(
      "margin-bottom:" +
        (n.marginBottom === "auto" ? "auto" : `${m.bottom || 0}px`),
    );
    d.push(
      "margin-left:" + (n.marginLeft === "auto" ? "auto" : `${m.left || 0}px`),
    );
    d.push(
      "margin-right:" +
        (n.marginRight === "auto" ? "auto" : `${m.right || 0}px`),
    );
    const p = n.padding || {};
    d.push(
      `padding:${p.top || 0}px ${p.right || 0}px ${p.bottom || 0}px ${
        p.left || 0
      }px`,
    );
    const b = n.border || {};
    // border-style (P7): per-side longhand from the same spec sugar the
    // engine gets (uniform string or {top,right,bottom,left}); default solid.
    if (n.borderStyle === undefined) {
      d.push(`border-style:solid`);
    } else if (typeof n.borderStyle === "object" && n.borderStyle !== null) {
      d.push(
        `border-style:${n.borderStyle.top ?? "solid"} ${
          n.borderStyle.right ?? "solid"
        } ${n.borderStyle.bottom ?? "solid"} ${n.borderStyle.left ?? "solid"}`,
      );
    } else {
      d.push(`border-style:${n.borderStyle}`);
    }
    d.push(
      `border-width:${b.top || 0}px ${b.right || 0}px ${b.bottom || 0}px ${
        b.left || 0
      }px`,
    );
    const nodeBorderColors = normalizedBorderColors(n);
    d.push(
      `border-color:${rgba(nodeBorderColors.top)} ${
        rgba(nodeBorderColors.right)
      } ${rgba(nodeBorderColors.bottom)} ${rgba(nodeBorderColors.left)}`,
    );
    if (n.borderRadius !== undefined) {
      const nodeRadii = normalizedBorderRadii(n);
      const corners = [
        nodeRadii.topLeft,
        nodeRadii.topRight,
        nodeRadii.bottomRight,
        nodeRadii.bottomLeft,
      ];
      // A negative component is the percentage encoding (see cornerRxRy):
      // emit the CSS percentage form for the oracle.
      const radiusCss = (component) =>
        component < 0 ? `${-component}%` : `${component}px`;
      const xValues = corners.map((c) => radiusCss(c.rx)).join(" ");
      // P10: only emit the CSS `/` elliptical syntax when a corner is
      // actually elliptical (rx!==ry) — keeps existing circular-only scenes'
      // generated CSS unchanged (easier to read/diff).
      const isElliptical = corners.some((c) => c.rx !== c.ry);
      d.push(
        isElliptical
          ? `border-radius:${xValues} / ${
            corners.map((c) => radiusCss(c.ry)).join(" ")
          }`
          : `border-radius:${xValues}`,
      );
    }
    d.push("background:" + rgba(n.bg));
    // background-clip / background-origin: emitted whenever set so the
    // Chrome oracle sees the same value the engine reads (background-clip
    // was never emitted here before — P10's own tests were pixel asserts,
    // not oracle comparisons, so the gap never surfaced). Defaults need no
    // emission: Chrome's initial values (clip border-box, origin
    // padding-box) match the engine's zeroed-struct behavior.
    if (n.backgroundClip !== undefined) {
      d.push(`background-clip:${n.backgroundClip}`);
    }
    if (n.backgroundOrigin !== undefined) {
      d.push(`background-origin:${n.backgroundOrigin}`);
    }
    // P4 (gradients): CSS's background-image is INDEPENDENT of background-
    // color (the `background:` shorthand above only ever set the color, per
    // rgba(n.bg) — a plain color function, not a gradient-aware one), so
    // this is a separate declaration, matching real CSS layering.
    // Only the FUSED case here — once the gradient lowers into the layer
    // list, nodeCssBackgroundImages emits it as one entry of a single
    // comma-separated background-image, which is the only way the ordering
    // between it and the other layers can be expressed at all.
    if (n.backgroundGradient && !backgroundLayerList(n)) {
      d.push(`background-image:${cssGradientImage(n.backgroundGradient)}`);
    }
    // box-shadow (P3): CSS shorthand order is [inset] offsetX offsetY
    // [blur] [spread] color — offsetX/offsetY/blur/spread are ALL required
    // positionally even when 0 (CSS's own grammar has no way to omit blur
    // while supplying spread), same plain-px-number convention as this
    // scene DSL's other length fields (no unit suffixes needed for box-
    // shadow's own length values). List order is preserved AS-IS (this
    // scene DSL's own array order === CSS's comma-separated list order,
    // per writeShadows' own doc comment on index 0 = first-listed).
    if (n.boxShadows?.length) {
      const shadowsCss = n.boxShadows.map((s) =>
        `${s.inset ? "inset " : ""}${s.offsetX ?? 0}px ${s.offsetY ?? 0}px ${
          s.blur ?? 0
        }px ${s.spread ?? 0}px ${rgba(s.color)}`
      ).join(", ");
      d.push(`box-shadow:${shadowsCss}`);
    }
    // text-shadow (P6): same list-order preservation as box-shadow above.
    if (n.textShadows?.length) {
      const textShadowsCss = n.textShadows.map((sh) =>
        `${sh.offsetX ?? 0}px ${sh.offsetY ?? 0}px ${sh.blur ?? 0}px ${
          rgba(sh.color || { r: 0, g: 0, b: 0, a: 1 })
        }`
      ).join(", ");
      d.push(`text-shadow:${textShadowsCss}`);
    }
    // filter (P8) / backdrop-filter (P8b): see filterListCss's own comment
    // for the CSS mapping rules.
    if (n.filter?.length) {
      d.push(`filter:${filterListCss(n.filter)}`);
    }
    // backdrop-filter (P8b): SAME CSS function-list grammar as filter (see
    // filterListCss's own comment) — the only difference is which property
    // it lands on.
    if (n.backdropFilter?.length) {
      d.push(`backdrop-filter:${filterListCss(n.backdropFilter)}`);
    }
    if (n.position === 1) d.push("position:relative");
    if (n.position === 2) d.push("position:absolute");
    if (n.position === 3) d.push("position:fixed");
    if (n.zIndex !== undefined) d.push(`z-index:${n.zIndex}`);
    for (const side of ["top", "right", "bottom", "left"]) {
      if (n[side] !== undefined) d.push(`${side}:${cssSize(n[side])}`);
    }
    if (n.opacity !== undefined) d.push(`opacity:${n.opacity}`);
    if (n.transform !== undefined) {
      const [a, b, c, dd, e, f] = resolveTransform(n);
      d.push(`transform:matrix(${a},${b},${c},${dd},${e},${f})`);
    }
    if (n.blendMode !== undefined) d.push(`mix-blend-mode:${n.blendMode}`);
    if (n.display === "image") {
      d.push(`object-fit:${n.objectFit ?? "fill"}`);
      const [posX, posY] = n.objectPosition ?? ["50%", "50%"];
      d.push(
        `object-position:${typeof posX === "number" ? posX + "px" : posX} ${
          typeof posY === "number" ? posY + "px" : posY
        }`,
      );
    }
    if (n.imageRendering !== undefined) {
      d.push(`image-rendering:${n.imageRendering}`);
    }
    return d.join(";");
  }

  // Minimal HTML-escaping for text node content — the only characters that
  // can break attribute/element parsing in the plain-text positions this
  // content is inserted into.
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Images (like fonts, see font-registry.js's fontDataUri) are embedded as
  // data: URIs so the Chrome oracle pane can load them without a file server.
  // The MIME comes from the BYTES (imageMimeType), never from the extension
  // or a hardcoded default. Chrome sniffs images and renders a JPEG the same
  // under any declared type (measured — see imageMimeType's own comment), so
  // this changes no pixels today; it is here because the alternative is a
  // data: URI that states something untrue about its own payload.
  const imageDataUriCache = new Map();
  async function imageDataUri(src) {
    if (imageDataUriCache.has(src)) return imageDataUriCache.get(src);
    const bytes = await readBinaryFile(src);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const uri = `data:${imageMimeType(bytes)};base64,${btoa(bin)}`;
    imageDataUriCache.set(src, uri);
    return uri;
  }

  // background-image CSS (Slice P5c) — separate from nodeCss (which stays
  // synchronous) since the src->data:URI conversion is async, same reason
  // <img>'s src attribute is built inside sceneHtml's own async renderNode
  // rather than nodeCss. CSS list order matches node.backgroundImages'
  // own order directly (unlike the WAT/pool side, which reverses it for
  // paint order — CSS's own multi-background syntax is authored top-first
  // too, so no reordering is needed here).
  async function nodeCssBackgroundImages(n) {
    // The SAME effective list the pool gets, so the two sides cannot
    // disagree about whether a backgroundGradient is fused or a layer. When
    // it fuses, nodeCss already emitted it as its own background-image
    // declaration and this returns '' — the two paths are mutually
    // exclusive by construction, which also fixes the pre-existing case
    // where both emitted `background-image` and the second silently won.
    const layers = backgroundLayerList(n);
    if (!layers) return "";
    const d = [];
    const images = [],
      sizes = [],
      positions = [],
      repeats = [],
      blendModes = [];
    for (const layer of layers) {
      if (layer.src) images.push(`url(${await imageDataUri(layer.src)})`);
      else if (layer.gradient) images.push(cssGradientImage(layer.gradient));
      else images.push("none");
      const [sizeW, sizeH] = layer.size ?? ["auto", "auto"];
      if (sizeW === "cover" || sizeW === "contain") sizes.push(sizeW);
      else sizes.push(`${cssSize(sizeW)} ${cssSize(sizeH)}`);
      const [posX, posY] = layer.position ?? ["0%", "0%"];
      positions.push(`${cssSize(posX)} ${cssSize(posY)}`);
      const [repeatX, repeatY] = layer.repeat ?? ["repeat", "repeat"];
      repeats.push(repeatX === repeatY ? repeatX : `${repeatX} ${repeatY}`);
      blendModes.push(layer.blendMode ?? "normal");
    }
    d.push(`background-image:${images.join(",")}`);
    d.push(`background-size:${sizes.join(",")}`);
    d.push(`background-position:${positions.join(",")}`);
    d.push(`background-repeat:${repeats.join(",")}`);
    if (blendModes.some((m) => m !== "normal")) {
      d.push(`background-blend-mode:${blendModes.join(",")}`);
    }
    return d.join(";");
  }

  // border-image CSS (P14) — async for the same src->data:URI reason as
  // nodeCssBackgroundImages above, and emitted as LONGHANDS for the same
  // reason nodeCssMasks does: sandom consumes resolved style values, so
  // there is no shorthand parser under test, and longhands keep every edge
  // value explicit in the oracle CSS.
  //
  // The value forms have to round-trip EXACTLY as authored, because that is
  // the whole comparison: a bare `4` in border-image-width means four times
  // the border-width, while `4px` is a length — emitting one as the other
  // would make the oracle agree with a different feature.
  async function nodeCssBorderImage(n) {
    if (!n.borderImage || !n.borderImage.src) return "";
    const spec = n.borderImage;
    const d = [`border-image-source:url(${await imageDataUri(spec.src)})`];

    const sliceQuad = edgeQuad(spec.slice, 100);
    // CSS orders the slice shorthand top/right/bottom/left, same as our quad.
    d.push(
      `border-image-slice:${sliceQuad.join(" ")}${spec.fill ? " fill" : ""}`,
    );

    const widthQuad = edgeQuad(spec.width, 1);
    d.push(`border-image-width:${widthQuad.join(" ")}`);

    const outsetQuad = edgeQuad(spec.outset, 0);
    d.push(`border-image-outset:${outsetQuad.join(" ")}`);

    const [repeatX, repeatY] = Array.isArray(spec.repeat)
      ? (spec.repeat.length === 1
        ? [spec.repeat[0], spec.repeat[0]]
        : spec.repeat)
      : [spec.repeat ?? "stretch", spec.repeat ?? "stretch"];
    d.push(`border-image-repeat:${repeatX} ${repeatY}`);

    return d.join(";");
  }

  // mask CSS (P11) — async for the same src->data:URI reason as
  // nodeCssBackgroundImages above, and emitted as LONGHANDS rather than the
  // `mask` shorthand: sandom consumes resolved style values, so there is no
  // shorthand parser under test here, and longhands keep each per-layer
  // list explicit in the oracle CSS. List order matches node.masks
  // directly (the pool side reverses; CSS is authored top-first).
  // Unprefixed only: the oracle Chrome implements the css-masking-1
  // longhands natively, and adding -webkit- aliases would only risk a
  // differently-parsed keyword set silently overriding them.
  async function nodeCssMasks(n) {
    if (!n.masks || !n.masks.length) return "";
    const images = [], sizes = [], positions = [], repeats = [];
    const modes = [], origins = [], clips = [], composites = [];
    for (const layer of n.masks) {
      if (layer.src) images.push(`url(${await imageDataUri(layer.src)})`);
      else if (layer.gradient) images.push(cssGradientImage(layer.gradient));
      else images.push("none");
      const [sizeW, sizeH] = layer.size ?? ["auto", "auto"];
      if (sizeW === "cover" || sizeW === "contain") sizes.push(sizeW);
      else sizes.push(`${cssSize(sizeW)} ${cssSize(sizeH)}`);
      const [posX, posY] = layer.position ?? ["0%", "0%"];
      positions.push(`${cssSize(posX)} ${cssSize(posY)}`);
      const [repeatX, repeatY] = layer.repeat ?? ["repeat", "repeat"];
      repeats.push(repeatX === repeatY ? repeatX : `${repeatX} ${repeatY}`);
      modes.push(layer.mode ?? "match-source");
      origins.push(layer.origin ?? "border-box");
      clips.push(layer.clip ?? "border-box");
      composites.push(layer.composite ?? "add");
    }
    return [
      `mask-image:${images.join(",")}`,
      `mask-size:${sizes.join(",")}`,
      `mask-position:${positions.join(",")}`,
      `mask-repeat:${repeats.join(",")}`,
      `mask-mode:${modes.join(",")}`,
      `mask-origin:${origins.join(",")}`,
      `mask-clip:${clips.join(",")}`,
      `mask-composite:${composites.join(",")}`,
    ].join(";");
  }

  async function sceneHtml(scene) {
    const cssRules = await Promise.all(scene.nodes.map(async (n, i) => {
      const extra = [
        await nodeCssBackgroundImages(n),
        await nodeCssMasks(n),
        await nodeCssBorderImage(n),
      ].filter(Boolean);
      return `.s${scene.id}-n${i}{${
        [nodeCss(n), ...extra].filter(Boolean).join(";")
      }}`;
    }));
    const css = cssRules.join("\n");
    // S6 step 3: tracks which definition-only svg/svg-symbol nodes have
    // already had their markup emitted into SOME svg root's <defs> — a
    // definition can be referenced by more than one <use> (the same
    // multi-reference case step 2 already proved for plain shapes), and
    // each one must emit its OWN markup exactly ONCE, not once per
    // reference (unlike gradients, whose defsAccumulator entries are never
    // deduped since each gets its own freshly-generated id).
    const emittedDefinitionIndices = new Set();
    // preserveAspectRatio: sandom's DSL keyword ('none' or absent-for-default)
    // maps directly to the SVG attribute's own keyword vocabulary — no
    // translation needed beyond the CSS/SVG default ('xMidYMid meet' when
    // the attribute is simply omitted).
    // Plain length-or-percent resolver against a basis (JS-side port of
    // engine.wat's own $resolveLength, needed here since gradient <defs>
    // markup is generated in JS at oracle-build time, not resolved by the
    // engine at emission time — same numeric contract, just a different
    // caller).
    function resolveLengthOrPercent(spec, basis) {
      if (typeof spec === "number") return spec;
      if (typeof spec === "string" && spec.endsWith("%")) {
        return parseFloat(spec) / 100 * basis;
      }
      throw new Error(`resolveLengthOrPercent: bad spec "${spec}"`);
    }

    // JS port of engine.wat's $resolveRadialGradientGeometry — same 4
    // extent-keyword formulas (including the closest-corner/farthest-corner
    // closed-form ellipse-radii derivation css-images-3 deliberately leaves
    // unspecified, derived from scratch and verified numerically when
    // FIRST written for the engine — see that function's own comment in
    // engine.wat for the derivation/verification detail; ported verbatim
    // here rather than re-derived a second time).
    // cx/cy: center relative to the shape's own top-left (NOT absolute
    // page coordinates) — matches $resolveRadialGradientGeometry's own
    // (cx,cy) parameter meaning.
    function resolveRadialEndingShapeJs(cx, cy, shape, sizeSpec, w, h) {
      if (Array.isArray(sizeSpec)) {
        return { rx: sizeSpec[0] ?? 0, ry: sizeSpec[1] ?? sizeSpec[0] ?? 0 };
      }
      const sizeKeyword = sizeSpec ?? "farthest-corner";
      const left = cx, right = w - cx, top = cy, bottom = h - cy;
      const isCircle = shape === "circle";
      if (sizeKeyword === "closest-side") {
        if (isCircle) {
          const r = Math.min(left, right, top, bottom);
          return { rx: r, ry: r };
        }
        return { rx: Math.min(left, right), ry: Math.min(top, bottom) };
      }
      if (sizeKeyword === "farthest-side") {
        if (isCircle) {
          const r = Math.max(left, right, top, bottom);
          return { rx: r, ry: r };
        }
        return { rx: Math.max(left, right), ry: Math.max(top, bottom) };
      }
      const closest = sizeKeyword === "closest-corner";
      const cornerL = closest ? Math.min(left, right) : Math.max(left, right);
      const cornerV = closest ? Math.min(top, bottom) : Math.max(top, bottom);
      const ratioRx = cornerL, ratioRy = cornerV;
      if (isCircle) {
        const r = Math.sqrt(cornerL * cornerL + cornerV * cornerV);
        return { rx: r, ry: r };
      }
      if (ratioRx === 0) return { rx: 0, ry: cornerV };
      const ry = Math.sqrt(
        cornerV * cornerV + (cornerL * ratioRy / ratioRx) ** 2,
      );
      const rx = ry * (ratioRx / ratioRy);
      return { rx, ry };
    }

    // Gradient <defs> accumulator (SVG gradients) — NOT shared closure
    // state (a prior version used one shared array + counter for the whole
    // sceneHtml() call, which raced: renderNode recurses through
    // Promise.all, so TWO SIBLING svg roots' subtrees run concurrently, and
    // whichever root's own "read svgGradientDefs.length" line happened to
    // run AFTER the other root's shape already pushed its own gradient
    // would silently print the WRONG root's gradients into its own <defs>
    // — found via a live-browser-tab visual review showing genuinely wrong
    // gradient POSITIONS/colors per shape, not a display/color-profile
    // difference as first suspected). Each svg root now creates its OWN
    // fresh accumulator array (see the 'svg' root branch below) and passes
    // it down through renderNode/svgFillAttr/svgGradientDef explicitly —
    // sibling svg roots' concurrent subtrees can never see each other's
    // pushes. svgGradientIdCounter stays a single shared per-sceneHtml()
    // counter (harmless to race on a plain increment for uniqueness
    // purposes only — worst case two ids interleave differently across
    // runs, never producing a COLLISION or cross-contaminating which
    // gradient markup lands in which root's own accumulator array).
    let svgGradientIdCounter = 0;
    const svgGradientIdPrefix = String(scene.id ?? "scene").replace(
      /[^A-Za-z0-9_-]/g,
      "-",
    );

    // Convert this scene DSL's {kind,angle,center,shape,size,stops} shape
    // (the SAME object shape CSS's own backgroundGradient uses — see
    // writeGradientStops' own comment) into a REAL SVG gradient element,
    // in userSpaceOnUse coordinates so the resolved geometry EXACTLY
    // matches what $resolveLinearGradientGeometry/$resolveRadialGradient
    // Geometry compute in engine.wat (verified numerically before writing
    // this: userSpaceOnUse reproduces css-images-3's own w/h-dependent
    // gradient-length formula exactly; objectBoundingBox's unit-square
    // normalization would visibly DISTORT a non-square shape's gradient
    // direction/length, since it flattens aspect ratio away).
    // shapeX/Y/W/H: the shape's own resolved bounding box in the SAME
    // user-space coordinates its own geometry attributes use (e.g. a rect's
    // x/y/width/height, or a circle's cx-r/cy-r/2r/2r). defsAccumulator:
    // THIS shape's own enclosing svg root's private array (see the 'svg'
    // root branch below) — pushed into directly, never the shared
    // svgGradientDefs closure this function used before the sibling-race
    // fix (see that variable's own removal comment above).
    function svgGradientDef(
      gradient,
      shapeX,
      shapeY,
      shapeW,
      shapeH,
      defsAccumulator,
    ) {
      const id =
        `sandom-${svgGradientIdPrefix}-svg-grad-${svgGradientIdCounter++}`;
      const stopsMarkup = gradient.stops.map((s) => {
        const c = col(s.color);
        return `<stop offset="${(s.position ?? 0) * 100}%" stop-color="rgb(${
          Math.round(c.r * 255)
        },${Math.round(c.g * 255)},${
          Math.round(c.b * 255)
        })" stop-opacity="${c.a}"></stop>`;
      }).join("");
      if (gradient.kind === "linear") {
        // Same direction+length formula this project's own
        // $resolveLinearGradientGeometry implements (css-images-3 SS3.1,
        // 0deg=up/clockwise convention) — see that function's own doc
        // comment in engine.wat for the derivation/verification.
        const rad = (gradient.angle ?? 0) * Math.PI / 180;
        const dx = Math.sin(rad), dy = -Math.cos(rad);
        const length = Math.abs(shapeW * Math.sin(rad)) +
          Math.abs(shapeH * Math.cos(rad));
        const cx = shapeX + shapeW / 2, cy = shapeY + shapeH / 2;
        const halfLen = length / 2;
        const x1 = cx - dx * halfLen, y1 = cy - dy * halfLen;
        const x2 = cx + dx * halfLen, y2 = cy + dy * halfLen;
        defsAccumulator.push(
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopsMarkup}</linearGradient>`,
        );
      } else if (gradient.kind === "radial") {
        // SVG's native <radialGradient> is CIRCULAR ONLY (cx/cy/r, no rx/ry
        // — confirmed via direct spec research before assuming otherwise:
        // SVG has no elliptical radial-gradient attribute at all). An
        // elliptical shape gets a non-uniform gradientTransform scale
        // instead — center the transform's own scale on the gradient's
        // OWN center point (a plain scale from origin would also shift
        // the center, which a translate-scale-translate-back fold avoids).
        const [centerXSpec, centerYSpec] = gradient.center ?? ["50%", "50%"];
        const cx = shapeX + resolveLengthOrPercent(centerXSpec, shapeW);
        const cy = shapeY + resolveLengthOrPercent(centerYSpec, shapeH);
        // Ending-shape radii: reuse this project's OWN already-verified
        // radial-geometry resolution (writeGradientStops' sibling function
        // resolveRadialEndingShape, extracted below) rather than
        // re-deriving the 4 extent-keyword formulas a second time here.
        const { rx, ry } = resolveRadialEndingShapeJs(
          cx - shapeX,
          cy - shapeY,
          gradient.shape ?? "ellipse",
          gradient.size,
          shapeW,
          shapeH,
        );
        const isCircle = Math.abs(rx - ry) < 1e-4;
        const transformAttr = isCircle
          ? ""
          : ` gradientTransform="translate(${cx} ${cy}) scale(1 ${
            ry / rx
          }) translate(${-cx} ${-cy})"`;
        const r = isCircle ? rx : rx; // the (pre-transform) circle radius is rx either way — ry comes from the non-uniform Y scale
        defsAccumulator.push(
          `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}"${transformAttr}>${stopsMarkup}</radialGradient>`,
        );
      }
      return id;
    }

    function svgFillAttr(
      fill,
      gradient,
      shapeX,
      shapeY,
      shapeW,
      shapeH,
      defsAccumulator,
    ) {
      if (gradient) {
        const id = svgGradientDef(
          gradient,
          shapeX,
          shapeY,
          shapeW,
          shapeH,
          defsAccumulator,
        );
        return ` fill="url(#${id})"`;
      }
      if (fill === undefined) return ""; // SVG default fill is black — omitting the attribute IS the default.
      if (fill === "none") return ' fill="none"';
      return ` fill="${rgba(fill)}"`;
    }
    // stroke (S3): SVG default is 'none' — omitting the attribute IS the
    // default, same convention as svgFillAttr above. strokeWidth similarly
    // omits when unset (SVG default is 1, but only meaningful with a stroke).
    function svgStrokeAttrs(stroke, strokeWidth, dasharray, dashoffset) {
      if (stroke === undefined || stroke === "none") return "";
      const widthAttr = strokeWidth !== undefined
        ? ` stroke-width="${strokeWidth}"`
        : "";
      const dashAttr = dasharray && dasharray.length
        ? ` stroke-dasharray="${dasharray.join(",")}"`
        : "";
      const dashOffsetAttr = dashoffset !== undefined
        ? ` stroke-dashoffset="${dashoffset}"`
        : "";
      return ` stroke="${
        rgba(stroke)
      }"${widthAttr}${dashAttr}${dashOffsetAttr}`;
    }
    // S6 step 3: emits a DEFINITION-only node's markup (a <symbol>, or a
    // plain <svg> used purely as a <use> target) directly into `into`
    // (some enclosing svg root's own defsAccumulator) — called on-demand
    // the FIRST time a <use> references this index, deduped via
    // `emittedDefinitionIndices` (module-scope Set, see its own comment).
    // This does NOT go through the normal renderNode(i) top-down walk at
    // all (a definition node is never reachable via any `children` array,
    // per this slice's own "excluded from the normal top-down render walk"
    // design) — it's the ONLY place in this file that ever reads one of
    // these nodes' own markup.
    async function renderDefinitionNode(href, into) {
      if (emittedDefinitionIndices.has(href)) return;
      emittedDefinitionIndices.add(href);
      const n = scene.nodes[href];
      const kids = (await Promise.all(
        (n.children || []).map((childIndex) => renderNode(childIndex, into)),
      )).join("");
      const attrs = [`id="s${scene.id}-n${href}"`];
      if (n.viewBox) attrs.push(`viewBox="${n.viewBox.join(" ")}"`);
      if (n.preserveAspectRatio) {
        attrs.push(`preserveAspectRatio="${n.preserveAspectRatio}"`);
      }
      // <symbol> gets display:none unconditionally via the UA stylesheet
      // (confirmed via spec text), regardless of placement — no <defs>
      // wrapper needed for THAT part specifically, but it's harmless/
      // conventional to nest it inside one anyway (which `into` already
      // is, once the caller wraps its contents in <defs>...</defs>).
      // A plain <svg> used purely as a definition has NO such automatic
      // rule, so it relies entirely on living inside <defs> (which,
      // per spec, "are not rendered directly" — see struct.html's DefsElement)
      // to stay hidden from direct rendering.
      const tag = n.display === "svg-symbol" ? "symbol" : "svg";
      into.push(`<${tag} ${attrs.join(" ")}>${kids}</${tag}>`);
    }
    // defsAccumulator (S7): null outside any svg root's subtree (the
    // overwhelmingly common case — text/image/flex/block nodes never touch
    // it); set to a FRESH array by the 'svg' root branch below, then
    // threaded through this same parameter to every descendant's own
    // recursive renderNode call, so sibling svg roots' concurrent subtrees
    // (Promise.all runs them interleaved, not sequentially) each only ever
    // see their OWN gradients, never a sibling's — see the accumulator
    // variable's own removal comment above for the race this replaces.
    async function renderNode(i, defsAccumulator = null) {
      const n = scene.nodes[i];
      if (n.display === "text") {
        return `<div class="s${scene.id}-n${i}">${
          escapeHtml(n.text ?? "")
        }</div>`;
      }
      if (n.display === "image") {
        const src = n.src ? await imageDataUri(n.src) : "";
        return `<img class="s${scene.id}-n${i}" src="${src}">`;
      }
      // svg root (design/svg-rendering.md): a real <svg> element — width/height/
      // viewBox/preserveAspectRatio are genuine SVG attributes (also styled
      // via nodeCss's ordinary width/height CSS declarations, since CSS
      // sizing DOES apply to <svg> as a replaced element — both are present
      // and Chrome reconciles them per the replaced-element sizing spec,
      // same as sandom's own engine does).
      if (n.display === "svg") {
        // A fresh accumulator PER svg root (S7) — NOT the incoming
        // defsAccumulator param (an svg root is never itself nested inside
        // another svg root's own gradient scope in this DSL; each root
        // owns its own <defs>).
        const ownDefsAccumulator = [];
        const kids = (await Promise.all((n.children || []).map((childIndex) =>
          renderNode(childIndex, ownDefsAccumulator)
        ))).join("");
        const attrs = [`class="s${scene.id}-n${i}"`];
        if (n.viewBox) {
          attrs.push(`viewBox="${n.viewBox.join(" ")}"`);
        }
        if (n.preserveAspectRatio) {
          attrs.push(`preserveAspectRatio="${n.preserveAspectRatio}"`);
        }
        // S7: any gradient fills collected from descendant shapes (rendered
        // before this line via the recursive renderNode above) need a real
        // <defs> host — SVG resolves url(#id) references anywhere in the
        // document, but <defs> is the conventional non-rendering container.
        const defsMarkup = ownDefsAccumulator.length
          ? `<defs>${ownDefsAccumulator.join("")}</defs>`
          : "";
        return `<svg ${attrs.join(" ")}>${defsMarkup}${kids}</svg>`;
      }
      // <g>: a real <g> element — no box, no viewport, no
      // clip, just grouping + an optional transform. n.transform reuses
      // the EXACT SAME representation ordinary CSS nodes use ({scale,
      // rotate, translate} or a 6-value affine array — resolveTransform())
      // rather than a raw SVG transform-list string; SVG's own matrix(a,b,
      // c,d,e,f) transform function uses the IDENTICAL parameter order and
      // formula as CSS's matrix() (new_x = a·x + c·y + e, new_y = b·x +
      // d·y + f — confirmed against the SVG Transforms spec before
      // assuming this), so the same resolveTransform() output converts
      // directly with no reordering. defsAccumulator is passed straight
      // through unchanged (a <g> never owns its own gradient <defs> scope
      // — only an svg ROOT does, per the S7 accumulator-race fix's own
      // "one fresh array per svg root, not per arbitrary container" design).
      if (n.display === "svg-group") {
        const kids = (await Promise.all((n.children || []).map((childIndex) =>
          renderNode(childIndex, defsAccumulator)
        ))).join("");
        const transformAttr = n.transform !== undefined
          ? (() => {
            const [a, b, c, dd, e, f] = resolveTransform(n);
            return ` transform="matrix(${a} ${b} ${c} ${dd} ${e} ${f})"`;
          })()
          : "";
        return `<g class="s${scene.id}-n${i}"${transformAttr}>${kids}</g>`;
      }
      // <use>: a REAL <use href="#..."> element —
      // deliberately NOT pre-expanded here (unlike the WAT/sandom-pixels
      // path, which DOES structurally clone via resolveSvgUseNodes before
      // this function ever runs, since <use> is a JS-authoring-time concept
      // with no WAT-side equivalent). Emitting a real <use> here is the
      // whole point of this oracle test: it proves sandom's own approach is
      // actually EQUIVALENT to Chrome's native <use> semantics, not just
      // internally self-consistent against itself.
      // n.href indexes scene.nodes directly (same convention as n.children).
      // Two cases: (1) the referenced node renders SOMEWHERE of its own
      // (step 2's plain-shape case — nothing extra needed here, its own id
      // already resolves); (2) the referenced node is a DEFINITION-only
      // svg/svg-symbol (step 3), never itself reachable via any `children`
      // array — renderDefinitionNode emits its markup on demand, into the
      // SAME defsAccumulator this <use>'s own enclosing svg root already
      // owns (deduped, so N sibling <use>s sharing one definition still
      // only emit it once).
      if (n.display === "svg-use") {
        const referenced = scene.nodes[n.href];
        if (
          referenced.display === "svg" || referenced.display === "svg-symbol"
        ) {
          await renderDefinitionNode(n.href, defsAccumulator);
        }
        const xAttr = n.x !== undefined ? ` x="${n.x}"` : "";
        const yAttr = n.y !== undefined ? ` y="${n.y}"` : "";
        const widthAttr = n.width !== undefined ? ` width="${n.width}"` : "";
        const heightAttr = n.height !== undefined
          ? ` height="${n.height}"`
          : "";
        const transformAttr = n.transform !== undefined
          ? (() => {
            const [a, b, c, dd, e, f] = resolveTransform(n);
            return ` transform="matrix(${a} ${b} ${c} ${dd} ${e} ${f})"`;
          })()
          : "";
        return `<use class="s${scene.id}-n${i}" href="#s${scene.id}-n${n.href}"${xAttr}${yAttr}${widthAttr}${heightAttr}${transformAttr}></use>`;
      }
      // svg shapes (design/svg-rendering.md): real SVG presentation attributes, not
      // CSS (see nodeCss's own guard above for why). Carries BOTH class
      // (the gallery's own .s{scene}-n{index} comparison convention) and id
      // (S6 step 2: a real id is what <use href="#..."> below needs to
      // resolve — same s{scene}-n{index} string, just also as a real id).
      if (n.display === "svg-circle") {
        const r = n.r ?? 0;
        const fillAttr = svgFillAttr(
          n.fill,
          n.svgFillGradient,
          (n.cx ?? 0) - r,
          (n.cy ?? 0) - r,
          2 * r,
          2 * r,
          defsAccumulator,
        );
        return `<circle id="s${scene.id}-n${i}" class="s${scene.id}-n${i}" cx="${
          n.cx ?? 0
        }" cy="${n.cy ?? 0}" r="${r}"${fillAttr}${
          svgStrokeAttrs(
            n.stroke,
            n.strokeWidth,
            n.strokeDasharray,
            n.strokeDashoffset,
          )
        }></circle>`;
      }
      if (n.display === "svg-ellipse") {
        const rx = n.rx ?? 0, ry = n.ry ?? 0;
        const fillAttr = svgFillAttr(
          n.fill,
          n.svgFillGradient,
          (n.cx ?? 0) - rx,
          (n.cy ?? 0) - ry,
          2 * rx,
          2 * ry,
          defsAccumulator,
        );
        return `<ellipse id="s${scene.id}-n${i}" class="s${scene.id}-n${i}" cx="${
          n.cx ?? 0
        }" cy="${n.cy ?? 0}" rx="${rx}" ry="${ry}"${fillAttr}${
          svgStrokeAttrs(
            n.stroke,
            n.strokeWidth,
            n.strokeDasharray,
            n.strokeDashoffset,
          )
        }></ellipse>`;
      }
      if (n.display === "svg-rect") {
        const rxAttr = n.rx !== undefined ? ` rx="${n.rx}"` : "";
        const ryAttr = n.ry !== undefined ? ` ry="${n.ry}"` : "";
        const fillAttr = svgFillAttr(
          n.fill,
          n.svgFillGradient,
          n.x ?? 0,
          n.y ?? 0,
          n.width ?? 0,
          n.height ?? 0,
          defsAccumulator,
        );
        return `<rect id="s${scene.id}-n${i}" class="s${scene.id}-n${i}" x="${
          n.x ?? 0
        }" y="${n.y ?? 0}" width="${n.width ?? 0}" height="${
          n.height ?? 0
        }"${rxAttr}${ryAttr}${fillAttr}${
          svgStrokeAttrs(
            n.stroke,
            n.strokeWidth,
            n.strokeDasharray,
            n.strokeDashoffset,
          )
        }></rect>`;
      }
      if (n.display === "svg-line") {
        // line (S3) has no fill attribute at all — SVG semantics, zero area
        // unstroked (see writeSvgShape's own comment). stroke-linecap
        // defaults to 'butt' when unset, same as sandom's own LINE_CAP default.
        const capAttr = n.strokeLinecap !== undefined
          ? ` stroke-linecap="${n.strokeLinecap}"`
          : "";
        return `<line class="s${scene.id}-n${i}" x1="${n.x1 ?? 0}" y1="${
          n.y1 ?? 0
        }" x2="${n.x2 ?? 0}" y2="${n.y2 ?? 0}"${
          svgStrokeAttrs(
            n.stroke,
            n.strokeWidth,
            n.strokeDasharray,
            n.strokeDashoffset,
          )
        }${capAttr}></line>`;
      }
      if (n.display === "svg-path") {
        // S4 (Tier B): the `d` string passes through UNCHANGED — same string
        // sandom's own MSDF pipeline parses via buildShapeFromSvgPath, so
        // Chrome and sandom render literally the same path definition.
        const fillRuleAttr = n.fillRule === "evenodd"
          ? ` fill-rule="evenodd"`
          : "";
        // S7 step 2: a gradient fill needs the path's own bounding box (the
        // SAME space $writeGradientExtension resolves geom0..3 against in
        // engine.wat — see writeSvgShape's own bbox-warmup comment). Only
        // computed when actually needed — a plain color/none fill (the
        // overwhelmingly common case) skips this extra msdfgen round-trip
        // entirely, same "don't pay for what you don't use" discipline as
        // resolveSvgPathIndices' own stroke-bbox branch.
        let fillAttr;
        if (n.svgFillGradient) {
          const bbox = await svgPathBbox(
            n.d ?? "",
            n.fillRule === "evenodd" ? "evenodd" : "nonzero",
          );
          fillAttr = svgFillAttr(
            n.fill,
            n.svgFillGradient,
            bbox.xMin,
            bbox.yMin,
            bbox.xMax - bbox.xMin,
            bbox.yMax - bbox.yMin,
            defsAccumulator,
          );
        } else {
          fillAttr = svgFillAttr(n.fill);
        }
        return `<path class="s${scene.id}-n${i}" d="${
          n.d ?? ""
        }"${fillRuleAttr}${fillAttr}${
          svgStrokeAttrs(
            n.stroke,
            n.strokeWidth,
            n.strokeDasharray,
            n.strokeDashoffset,
          )
        }></path>`;
      }
      if (n.display === "svg-polygon" || n.display === "svg-polyline") {
        // The Chrome side renders a REAL <polygon>/<polyline> element (its
        // own `points` attribute, not sandom's derived `d` string) — this
        // is what proves pointsToPathDef's lowering is actually equivalent
        // to SVG's own polygon/polyline semantics, not just internally
        // self-consistent.
        const tag = n.display === "svg-polygon" ? "polygon" : "polyline";
        const pointsAttr = (n.points ?? []).map(([x, y]) => `${x},${y}`).join(
          " ",
        );
        const fillRuleAttr = n.fillRule === "evenodd"
          ? ` fill-rule="evenodd"`
          : "";
        // S7 step 2: same bbox-on-demand pattern as svg-path above — derive
        // the SAME `d` string resolveSvgPathIndices itself derives from
        // `points` (pointsToPathDef), so the bbox msdfgen computes here is
        // identical to what the engine actually emitted geometry against.
        let fillAttr;
        if (n.svgFillGradient) {
          const d = pointsToPathDef(
            n.points,
            /*closed=*/ n.display === "svg-polygon",
          );
          const bbox = await svgPathBbox(
            d,
            n.fillRule === "evenodd" ? "evenodd" : "nonzero",
          );
          fillAttr = svgFillAttr(
            n.fill,
            n.svgFillGradient,
            bbox.xMin,
            bbox.yMin,
            bbox.xMax - bbox.xMin,
            bbox.yMax - bbox.yMin,
            defsAccumulator,
          );
        } else {
          fillAttr = svgFillAttr(n.fill);
        }
        return `<${tag} class="s${scene.id}-n${i}" points="${pointsAttr}"${fillRuleAttr}${fillAttr}${
          svgStrokeAttrs(
            n.stroke,
            n.strokeWidth,
            n.strokeDasharray,
            n.strokeDashoffset,
          )
        }></${tag}>`;
      }
      // design/inline-layout.md: an inlineCtx:true container's DISPLAY_TEXT/
      // DISPLAY_INLINE children render as real inline <span>s sharing this
      // DIV's own line boxes — NOT independent block-level <div>s (the
      // ordinary display:'text' branch above, correct for a BARE leaf, is
      // wrong here: it would give Chrome N separate one-line paragraphs
      // instead of one paragraph with N runs). No whitespace between
      // sibling <span> tags in the generated markup — an accidental
      // newline/indent there would be a MARKUP-level space Chrome's own
      // whitespace collapsing would then fold in, not a real content space;
      // callers wanting a real inter-item space put it INSIDE an item's own
      // text (matching sandomInlineFragmentRects' own convention).
      if (n.display === "inline-block") {
        const kids = (await Promise.all((n.children || []).map((childIndex) =>
          renderNode(childIndex, defsAccumulator)
        ))).join("");
        return `<span class="s${scene.id}-n${i}">${kids}</span>`;
      }
      if (n.display === "inline") {
        const kids =
          (await Promise.all((n.children || []).map(async (childIndex) => {
            const child = scene.nodes[childIndex];
            if (child.display === "text") {
              return `<span class="s${scene.id}-n${childIndex}">${
                escapeHtml(child.text ?? "")
              }</span>`;
            }
            return renderNode(childIndex, defsAccumulator);
          }))).join("");
        return `<span class="s${scene.id}-n${i}">${kids}</span>`;
      }
      if (n.inlineCtx) {
        const kids =
          (await Promise.all((n.children || []).map(async (childIndex) => {
            const child = scene.nodes[childIndex];
            if (child.display === "text") {
              return `<span class="s${scene.id}-n${childIndex}">${
                escapeHtml(child.text ?? "")
              }</span>`;
            }
            return renderNode(childIndex, defsAccumulator);
          }))).join("");
        return `<div class="s${scene.id}-n${i}">${kids}</div>`;
      }
      const kids = (await Promise.all(
        (n.children || []).map((childIndex) =>
          renderNode(childIndex, defsAccumulator)
        ),
      )).join("");
      return `<div class="s${scene.id}-n${i}">${kids}</div>`;
    }
    return { css, html: await renderNode(0) };
  }

  // Scale every length-valued field in a node by `scale`. Percentages, auto,
  // and dimensionless ratios (flexGrow/flexShrink, alignSelf) pass through.
  // Mirrors test/oracle/sandom-layout.js's scaleNode so a spec written for the
  // layout oracle works here too. The scale parameter encodes Blink's
  // LayoutZoomFactor — see test/oracle/README.md for the full model:
  // Blink lays out in PHYSICAL LU (1/64 of a physical pixel). We match by
  // pre-scaling all input lengths so the engine sees physical-pixel inputs,
  // then rasterizing at the matching device resolution.
  function scaleLen(v, s) {
    if (v === undefined || v === "auto") return v;
    if (typeof v === "number") return v * s;
    return v; // 'min-content' / 'max-content' / 'NN%' pass through
  }
  function scaleEdges(e, s) {
    if (!e) return e;
    return {
      top: (e.top || 0) * s,
      right: (e.right || 0) * s,
      bottom: (e.bottom || 0) * s,
      left: (e.left || 0) * s,
    };
  }

  // A gradient's own px lengths, pre-scaled for deviceScale. Only `center`
  // and an explicit radial `size: [rx, ry]` carry lengths — an angle and
  // stop positions (0..1 fractions) are resolution-independent, and the
  // extent KEYWORDS resolve against the box at emission time.
  function scaleGradient(gradient, s) {
    return {
      ...gradient,
      ...(gradient.center
        ? { center: gradient.center.map((v) => scaleLen(v, s)) }
        : {}),
      ...(Array.isArray(gradient.size)
        ? { size: gradient.size.map((v) => scaleLen(v, s)) }
        : {}),
    };
  }

  function scaleNode(node, s) {
    if (s === 1) return node;
    const out = { ...node };
    for (
      const k of [
        "width",
        "height",
        "minWidth",
        "minHeight",
        "maxWidth",
        "maxHeight",
        "top",
        "right",
        "bottom",
        "left",
        "fontSize",
        "letterSpacing",
        "scrollTop",
        "scrollLeft",
      ]
    ) {
      if (k in node) out[k] = scaleLen(node[k], s);
    }
    // SVG shape geometry: x/y (svg-rect),
    // cx/cy/r (svg-circle), cx/cy/rx/ry (svg-ellipse, and svg-rect's own
    // rounded-corner rx/ry), x1/y1/x2/y2 (svg-line) — all plain numbers in
    // the shape's own user-unit space (1 unit = 1 CSS px when no viewBox is
    // set, same convention svg-rect's width/height already scale under via
    // the generic length-field loop above). These fields are exclusive to
    // SVG shape nodes (confirmed: no other display kind reads x/y/cx/cy/r/
    // rx/ry/x1/y1/x2/y2), so scaling them unconditionally here is safe.
    // Mirrors clipPath's own cx/cy/r/rx/ry scaling a few lines below —
    // same field names, same "user-space geometry tracks deviceScale"
    // requirement, just for the shape's own top-level fields instead of a
    // nested clipPath object.
    for (
      const k of ["x", "y", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2"]
    ) {
      if (typeof node[k] === "number") out[k] = node[k] * s;
    }
    if (typeof node.svgTextX === "number") out.svgTextX = node.svgTextX * s;
    if (typeof node.svgTextY === "number") out.svgTextY = node.svgTextY * s;
    // SVG stroke fields: a follow-on
    // to the geometry fix above, found via a real stroke gallery scene —
    // that fix's own regression test used fill-only shapes and never
    // exercised a stroke, missing this. strokeWidth/strokeDashoffset are
    // plain numbers; strokeDasharray is an ARRAY of numbers, each scaled
    // individually (same "map over each entry" shape boxShadows/
    // textShadows already use elsewhere in this function).
    if (typeof node.strokeWidth === "number") {
      out.strokeWidth = node.strokeWidth * s;
    }
    if (typeof node.strokeDashoffset === "number") {
      out.strokeDashoffset = node.strokeDashoffset * s;
    }
    if (Array.isArray(node.strokeDasharray)) {
      out.strokeDasharray = node.strokeDasharray.map((v) => v * s);
    }
    // viewBox (design/svg-rendering.md invariant 2): all four entries
    // are author-unit lengths (minX/minY included — they're offsets in the
    // same user-unit space, not just width/height) and must pre-scale like
    // every other length field, so $computeViewBoxTransform's affine (built
    // from the root's DEVICE-px content box over this array) stays
    // deviceScale-free: (s*viewport)/(s*viewBox) = viewport/viewBox, applied
    // to s*geometry = correct. A new array — resolveSvgUseNodes runs before
    // scaleNode in renderScenePixels, so synthesized DISPLAY_SVG_ROOT clones
    // (which copy the referenced node's viewBox) are already flattened in
    // and get scaled here too, no special-casing needed.
    if (Array.isArray(node.viewBox)) {
      out.viewBox = node.viewBox.map((v) => v * s);
    }
    if ("margin" in node) out.margin = scaleEdges(node.margin, s);
    if ("padding" in node) out.padding = scaleEdges(node.padding, s);
    if ("border" in node) out.border = scaleEdges(node.border, s);
    if (typeof node.borderSpacing === "number") {
      out.borderSpacing = node.borderSpacing * s;
    } else if (Array.isArray(node.borderSpacing)) {
      out.borderSpacing = node.borderSpacing.map((value) => value * s);
    }
    for (const property of ["gridTemplateColumns", "gridTemplateRows"]) {
      if (!(property in node)) continue;
      out[property] = Array.isArray(node[property])
        ? node[property].map((track) => scaleGridTrack(track, s))
        : scaleGridTrack(node[property], s);
    }
    if ("gridAutoColumns" in node) {
      out.gridAutoColumns = scaleGridTrack(node.gridAutoColumns, s);
    }
    if ("gridAutoRows" in node) {
      out.gridAutoRows = scaleGridTrack(node.gridAutoRows, s);
    }
    // border-image (P14): only the LENGTH forms scale to physical px.
    //
    // `slice` never does — it is source-image space, and the source does not
    // grow with deviceScale. Bare numbers in `width`/`outset` never do
    // either: they are multiples of border-width, which has already been
    // scaled on the line above, so scaling them again would square the
    // factor. Percentages resolve against the (already physical) border box.
    // Only an explicit 'Npx' is a length in CSS px that must become physical.
    if (node.borderImage) {
      const scalePx = (
        v,
      ) => (typeof v === "string" && v.endsWith("px")
        ? `${parseFloat(v) * s}px`
        : v);
      const scaleQuad = (q) => (Array.isArray(q) ? q.map(scalePx) : scalePx(q));
      const bi = { ...node.borderImage };
      if ("width" in bi) bi.width = scaleQuad(bi.width);
      if ("outset" in bi) bi.outset = scaleQuad(bi.outset);
      out.borderImage = bi;
    }
    if ("borderRadius" in node) {
      const r = node.borderRadius;
      // Percentages ("50%" strings and the negative encoded form) are
      // scale-invariant: pass them through untouched.
      if (typeof r === "number") {
        out.borderRadius = r >= 0 ? r * s : r;
      } else if (typeof r === "string") {
        out.borderRadius = r;
      } else if (typeof r === "object" && r !== null) {
        const isPerCorner = "topLeft" in r || "topRight" in r ||
          "bottomRight" in r || "bottomLeft" in r;
        if (isPerCorner) {
          // Per-corner form (Slice P2) — a corner is either a plain length or,
          // as of P10, an elliptical {rx,ry} pair.
          out.borderRadius = {};
          for (
            const corner of ["topLeft", "topRight", "bottomRight", "bottomLeft"]
          ) {
            const v = r[corner];
            if (v === undefined) continue;
            const scaleComponent = (value) =>
              typeof value === "string" || value < 0 ? value : value * s;
            out.borderRadius[corner] = typeof v === "object"
              ? { rx: scaleComponent(v.rx || 0), ry: scaleComponent(v.ry || 0) }
              : scaleComponent(v);
          }
        } else {
          // P10 uniform-ellipse shorthand: {rx,ry} with no corner keys.
          out.borderRadius = {
            rx: typeof r.rx === "string" || r.rx < 0 ? r.rx : (r.rx || 0) * s,
            ry: typeof r.ry === "string" || r.ry < 0 ? r.ry : (r.ry || 0) * s,
          };
        }
      }
    }
    // textShadows (P6): offsets and blur are lengths.
    if ("textShadows" in node) {
      out.textShadows = node.textShadows.map((sh) => ({
        ...sh,
        offsetX: (sh.offsetX ?? 0) * s,
        offsetY: (sh.offsetY ?? 0) * s,
        blur: (sh.blur ?? 0) * s,
      }));
    }
    // boxShadows (P3): offsets, blur, and spread are all lengths.
    if ("boxShadows" in node) {
      out.boxShadows = node.boxShadows.map((sh) => ({
        ...sh,
        offsetX: (sh.offsetX ?? 0) * s,
        offsetY: (sh.offsetY ?? 0) * s,

        blur: (sh.blur ?? 0) * s,
        spread: (sh.spread ?? 0) * s,
      }));
    }
    // outline (P10): width and offset are lengths.
    if ("outline" in node) {
      out.outline = {
        ...node.outline,
        ...(typeof node.outline.width === "number"
          ? { width: node.outline.width * s }
          : {}),
        ...(typeof node.outline.offset === "number"
          ? { offset: node.outline.offset * s }
          : {}),
      };
    }
    // objectPosition (P5b): only the LENGTH form (a plain number) is a real
    // length needing pre-scaling; a percent string is resolution-independent.
    if ("objectPosition" in node) {
      out.objectPosition = node.objectPosition.map((v) => scaleLen(v, s));
    }
    // Background/mask LAYERS: each layer's size/position can independently
    // mix length and percent forms (e.g. size:[40,'auto']) — same
    // per-value scaleLen treatment as objectPosition above, applied
    // per-layer. 'cover'/'contain'/'auto' keywords pass through scaleLen
    // unchanged (its own guard only touches actual numbers).
    const scaleLayer = (layer) => ({
      ...layer,
      ...(layer.size ? { size: layer.size.map((v) => scaleLen(v, s)) } : {}),
      ...(layer.position
        ? { position: layer.position.map((v) => scaleLen(v, s)) }
        : {}),
      ...(layer.gradient ? { gradient: scaleGradient(layer.gradient, s) } : {}),
    });
    if ("backgroundImages" in node) {
      out.backgroundImages = node.backgroundImages.map(scaleLayer);
    }
    if ("masks" in node) out.masks = node.masks.map(scaleLayer);
    // A gradient's OWN px lengths (a radial `center: [40, '50%']`, an
    // explicit `size: [30, 20]`) are CSS px like any other length and must
    // pre-scale too. This was a live P4 gap for backgroundGradient — px
    // centers rendered at half position at deviceScale 2, unnoticed because
    // percent forms, the common case, are resolution-independent. It stops
    // being merely a gap once a backgroundGradient can LOWER into a layer
    // (backgroundLayerList): the same declaration would otherwise scale
    // differently depending on whether an unrelated sibling layer exists.
    if (node.backgroundGradient) {
      out.backgroundGradient = scaleGradient(node.backgroundGradient, s);
    }
    if (node.svgFillGradient) {
      out.svgFillGradient = scaleGradient(node.svgFillGradient, s);
    }
    // clipPath (P9): numbers are px lengths (pre-scale like every other
    // length); percent strings and closest/farthest-side keywords are
    // resolution-independent and pass through. radius/radii mirror
    // borderRadius's own px-only scaling above.
    if ("clipPath" in node && node.clipPath) {
      const clipPath = { ...node.clipPath };
      for (
        const key of [
          "top",
          "right",
          "bottom",
          "left",
          "cx",
          "cy",
          "r",
          "rx",
          "ry",
        ]
      ) {
        if (typeof clipPath[key] === "number") {
          clipPath[key] = clipPath[key] * s;
        }
      }
      if (clipPath.kind === "polygon" && Array.isArray(clipPath.points)) {
        clipPath.points = clipPath.points.map(([x, y]) => [
          typeof x === "number" ? x * s : x,
          typeof y === "number" ? y * s : y,
        ]);
      }
      if (clipPath.kind === "path" && typeof clipPath.d === "string") {
        const tokens = clipPath.d.match(
          /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g,
        ) ?? [];
        const parameterCounts = {
          M: 2,
          L: 2,
          H: 1,
          V: 1,
          C: 6,
          S: 4,
          Q: 4,
          T: 2,
          A: 7,
          Z: 0,
        };
        let currentCommand = null;
        let parameterIndex = 0;
        clipPath.d = tokens.map((token) => {
          if (/^[a-zA-Z]$/.test(token)) {
            currentCommand = token.toUpperCase();
            parameterIndex = 0;
            return token;
          }
          if (!currentCommand || !(currentCommand in parameterCounts)) {
            throw new Error(
              `clipPath path: unsupported SVG path command near ${
                JSON.stringify(token)
              }`,
            );
          }
          const unscaledArcParameter = currentCommand === "A" &&
            (parameterIndex === 2 || parameterIndex === 3 ||
              parameterIndex === 4);
          const result = unscaledArcParameter
            ? Number(token)
            : Number(token) * s;
          parameterIndex = (parameterIndex + 1) %
            parameterCounts[currentCommand];
          return String(result);
        }).join(" ");
      }
      if (typeof clipPath.radius === "number") {
        clipPath.radius = clipPath.radius * s;
      }
      if (clipPath.radii) {
        const radii = {};
        for (
          const corner of ["topLeft", "topRight", "bottomRight", "bottomLeft"]
        ) {
          const v = clipPath.radii[corner];
          if (v === undefined) continue;
          radii[corner] = typeof v === "object"
            ? { rx: (v.rx || 0) * s, ry: (v.ry || 0) * s }
            : v * s;
        }
        clipPath.radii = radii;
      }
      out.clipPath = clipPath;
    }
    if ("gap" in node) {
      out.gap = typeof node.gap === "number"
        ? node.gap * s
        : node.gap && typeof node.gap === "object" &&
            Number.isFinite(node.gap.pixels) &&
            Number.isFinite(node.gap.percentage)
        ? { ...node.gap, pixels: node.gap.pixels * s }
        : node.gap;
    }
    if ("rowGap" in node) {
      out.rowGap = typeof node.rowGap === "number"
        ? node.rowGap * s
        : node.rowGap && typeof node.rowGap === "object" &&
            Number.isFinite(node.rowGap.pixels) &&
            Number.isFinite(node.rowGap.percentage)
        ? { ...node.rowGap, pixels: node.rowGap.pixels * s }
        : node.rowGap;
    }
    if ("columnGap" in node) {
      out.columnGap = typeof node.columnGap === "number"
        ? node.columnGap * s
        : node.columnGap && typeof node.columnGap === "object" &&
            Number.isFinite(node.columnGap.pixels) &&
            Number.isFinite(node.columnGap.percentage)
        ? { ...node.columnGap, pixels: node.columnGap.pixels * s }
        : node.columnGap;
    }
    if ("flexBasis" in node && typeof node.flexBasis === "number") {
      out.flexBasis = node.flexBasis * s;
    }
    // lineHeight: a unitless number (CSS line-height:1.5) must NOT scale (it's
    // a ratio against fontSize, already scaled) — only the explicit LENGTH
    // form ({px: N}) is a real length needing the same pre-scaling.
    if (
      "lineHeight" in node && typeof node.lineHeight === "object" &&
      typeof node.lineHeight.px === "number"
    ) {
      out.lineHeight = { px: node.lineHeight.px * s };
    }
    if (
      "verticalAlign" in node && typeof node.verticalAlign === "object" &&
      typeof node.verticalAlign.px === "number"
    ) {
      out.verticalAlign = { px: node.verticalAlign.px * s };
    }
    // transform (Slice 8B): only the TRANSLATION component is a length (needs
    // the same physical-px pre-scaling every other length field gets);
    // rotate (degrees) and scale (a dimensionless ratio) must NOT scale —
    // scaling them would make a Retina render's fan/rotation look different
    // from a 1x render of the identical CSS, which is wrong (found via a
    // real gallery bug: node.transform wasn't touched here at all, so at
    // deviceScale 2 the translate offset landed at half its intended CSS-px
    // distance, visibly compressing the whole composition toward center).
    if ("transform" in node) {
      const t = node.transform;
      if (t.kind === "cssTransform") {
        const scaleLengthPercentage = (length) => ({
          ...length,
          pixels: (length.pixels ?? 0) * s,
        });
        out.transform = {
          ...t,
          components: t.components.map((component) => {
            if (component.kind === "translate") {
              return {
                ...component,
                x: scaleLengthPercentage(component.x),
                y: scaleLengthPercentage(component.y),
              };
            }
            if (
              component.kind === "translateX" || component.kind === "translateY"
            ) {
              return {
                ...component,
                value: scaleLengthPercentage(component.value),
              };
            }
            if (component.kind === "matrix") {
              return {
                ...component,
                value: component.value.map((entry, index) =>
                  index >= 4 ? entry * s : entry
                ),
              };
            }
            return component;
          }),
        };
        if (node.transformOrigin) {
          out.transformOrigin = {
            ...node.transformOrigin,
            x: scaleLengthPercentage(node.transformOrigin.x),
            y: scaleLengthPercentage(node.transformOrigin.y),
          };
        }
      } else if (Array.isArray(t)) {
        out.transform = [t[0], t[1], t[2], t[3], t[4] * s, t[5] * s];
      } else {
        out.transform = { ...t };
        if (t.translate) {
          out.transform.translate = {
            x: (t.translate.x ?? 0) * s,
            y: (t.translate.y ?? 0) * s,
          };
        }
      }
    }
    return out;
  }
  // Lay out a scene and return the raw RGBA pixels + computed boxes. No PNG
  // encoding (callers that want a PNG should use renderScene). This is the
  // fastest path for in-browser playgrounds that draw directly to a canvas via
  // putImageData.
  //
  // deviceScale (default 1) controls the LayoutZoomFactor / DPR scaling that
  // matches Blink's physical-LU layout. When set to N>1, every input length is
  // multiplied by N (so the engine lays out in physical pixels at N× resolution)
  // and the rasterizer paints an N× pixel buffer. The caller is then expected to
  // display the canvas at the CSS-pixel size (set canvas.style.width/height to
  // scene.width/scene.height) so the result downscales crisply on a Retina /
  // high-DPI display, matching how Chrome paints its own layout output.
  // Returned width/height are the PHYSICAL dimensions of the pixel buffer.
  // Write a scene's nodes, run layout + emission, and return a COPY of the
  // raw command bytes (the engine reuses its buffer on the next call) — for
  // command-level tests that assert emitted FORMAT contents rather than
  // pixels (test/layout_border_test.js). Rect/clip scenes only (no text
  // resource building).
  function physicalBorderBoxes(nodes) {
    return nodes.map((_, index) => {
      const base = computedBoxBufferBase + index * BOX_SIZE;
      return {
        x: view.getInt32(base + BOX_OFFSET_X, true) / LAYOUT_UNIT,
        y: view.getInt32(base + BOX_OFFSET_Y, true) / LAYOUT_UNIT,
        w: view.getInt32(base + BOX_OFFSET_WIDTH, true) / LAYOUT_UNIT,
        h: view.getInt32(base + BOX_OFFSET_HEIGHT, true) / LAYOUT_UNIT,
      };
    });
  }


  function provisionalClipLayout(
    scene,
    nodes,
    layoutNodeCapacity,
    generationReservation = null,
  ) {
    if (
      !nodes.some((node) =>
        node.clipPath?.kind === "polygon" || node.clipPath?.kind === "path"
      )
    ) {
      return null;
    }
    const provisional = nodes.map((node) =>
      node.clipPath?.kind === "polygon" || node.clipPath?.kind === "path"
        ? { ...node, clipPath: undefined }
        : node
    );
    writeSceneNodesAndTileConfig(
      scene,
      provisional,
      null,
      layoutNodeCapacity,
      generationReservation,
      false,
    );
    engine.exports.layout(provisional.length, scene.width, scene.height);
    return physicalBorderBoxes(provisional);
  }

  async function emitSceneCommands(
    scene,
    {
      resolveResource = null,
      deviceScale = 1,
      layoutNodeCapacity = Infinity,
      commitTextRunKeys,
    } = {},
    generationReservation = null,
    emitPaintCommands = true,
  ) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
    // The engine lays out in CSS pixels; deviceScale is raster-only and
    // never reaches layout or emission. Reset the persistent engine
    // global (opsz reads it during shaping).
    engine.exports.set_device_scale(1);
    const used = resolveOrderModifiedChildren(resolveSvgUseNodes(scene.nodes));
    const globalPreparation = used !== scene.nodes;
    let nodes = await resolveImageIndices(
      await resolveFontIndices(await resolveSvgPathIndices(used)),
      resolveResource,
      scene.imageSources,
    );
    const boxes = provisionalClipLayout(
      scene,
      nodes,
      layoutNodeCapacity,
      generationReservation,
    );
    if (boxes) nodes = await resolveClipPathIndices(nodes, boxes, deviceScale);
    writeSceneNodesAndTileConfig(
      scene,
      nodes,
      null,
      layoutNodeCapacity,
      generationReservation,
      commitTextRunKeys,
    );
    if (!emitPaintCommands) {
      engine.exports.layout(
        nodes.length,
        scene.width,
        scene.height,
      );
      return { view: null, bytesWritten: 0, nodes, globalPreparation };
    }
    engine.exports.set_paint_artifact_capture(0);
    // QUERY emit: leave the render pipeline's persistent damage state
    // (tile dirty map, painted-box mirror, watermarks, retained-buffer
    // record) untouched — see the engine's $queryEmitMode comment.
    engine.exports.set_query_emit(1);
    let bytesWritten;
    try {
      bytesWritten = engine.exports.emit_commands(nodes.length);
    } finally {
      engine.exports.set_query_emit(0);
    }
    const copy = engine.memory.buffer.slice(
      COMMAND_BUFFER_BASE,
      COMMAND_BUFFER_BASE + bytesWritten,
    );
    return { view: new DataView(copy), bytesWritten, nodes, globalPreparation };
  }

  // Shared write step between emitSceneCommands and its synchronous
  // counterpart below — factored out once a second (sync) caller existed,
  // not before (this project's own "don't build shared abstractions ahead
  function writeSceneNodesAndTileConfig(
    scene,
    nodes,
    changedNodeIndices = null,
    layoutNodeCapacity = Infinity,
    generationReservation = null,
    commitTextRunKeys = generationReservation === null,
    forceGenerationNodeIndices = null,
    scrollOnlyNodeIndices = null,
    retained = false,
  ) {
    // Every engine write invalidates the previous owner's incremental
    // claim; an owned render re-claims after ITS write (renderScenePixels).
    engineWriteOwner = null;
    engineWriteClaims.set(
      engine.memory,
      (engineWriteClaims.get(engine.memory) ?? 0) + 1,
    );
    if (nodes.length > layoutNodeCapacity) {
      throw new RangeError(
        `Scene has ${nodes.length} nodes; layout capacity is ${layoutNodeCapacity}`,
      );
    }
    if (!retained) {
      ensureNodeCapacity(nodes.length);
      registerCoreFaces(nodes);
    } else {
      registerCoreFaces(
        Array.from(changedNodeIndices, (index) => nodes[index]),
      );
    }
    if (generationReservation && !generationReservation.consumed) {
      generationReservation.consumed = true;
      const currentGeneration = view.getUint32(
        HEADER_BASE + HEADER_OFFSET_GENERATION,
        true,
      );
      const drifted = generationReservation.published
        ? currentGeneration !== generationReservation.generation
        : currentGeneration + 1 !== generationReservation.generation;
      if (drifted) {
        // A QUERY emit interleaved between the reservation and this
        // write: synchronous layout getters can barge into the awaits of
        // an async analytical pass on the shared engine, advancing the
        // generation and overwriting the pre-stamped analytical state.
        // The reservation's prediction is stale, not corrupt — re-derive
        // it: advance to a fresh generation and re-stamp the analytical
        // baseline with the ACTUAL number. The full node write below
        // rebuilds everything else from the caller's own scene.
        sceneGeneration = engine.exports.advance_generation() >>> 0;
        stampAnalyticalState(generationReservation.nodeCount, sceneGeneration);
      } else if (generationReservation.published) {
        sceneGeneration = generationReservation.generation;
      } else {
        sceneGeneration = engine.exports.advance_generation() >>> 0;
        if (sceneGeneration !== generationReservation.generation) {
          throw new Error(
            `Prepared analytical generation ${generationReservation.generation} ` +
              `advanced to ${sceneGeneration}`,
          );
        }
      }
    } else {
      sceneGeneration = engine.exports.advance_generation() >>> 0;
    }
    let sparseValid = true;
    if (!retained) {
      publishCoreFrame(nodes);
      currentTextBatch?.release();
      currentTextBatch = null;
    }
    let textBatch = retained
      ? currentTextBatch
      : textPreparationRuntime.prepareTextBatch(nodes);
    try {
      let resultsBase = nodes.length ? textBatch.resultsBase() : 0;
      const finishRows = (patchIndex = null) => {
        const selected = patchIndex !== null ||
          forceGenerationNodeIndices?.size || scrollOnlyNodeIndices?.size;
        let rows = 0;
        let rowCount = 0;
        if (selected) {
          rowCount = patchIndex === null ? nodes.length : 1;
          rows = core.exports.abi_allocate(Math.max(1, rowCount) * EngineFrameFinishRowSize);
          if (!rows) core.throwIfError();
          const rowView = new DataView(core.refreshBytes().buffer);
          let cursor = rows;
          for (let row = 0; row < rowCount; row++) {
            const index = patchIndex ?? row;
            rowView.setUint32(cursor + EngineFrameFinishRowFields.index, index, true);
            rowView.setUint32(cursor + EngineFrameFinishRowFields.flags,
              (forceGenerationNodeIndices?.has(index) ? 1 : 0) |
                (scrollOnlyNodeIndices?.has(index) ? 2 : 0), true);
            cursor += EngineFrameFinishRowSize;
          }
        }
        return core.status(
          "engine_record_finish", resultsBase, nodes.length,
          commitTextRunKeys ? 1 : 0, rows, rowCount,
        ) !== 0;
      };
      if (retained) {
        // Publication exposes only the current patch's fact and input.
        // Finish it before publishing the next row overwrites those values.
        // A rejected publication (null) leaves the rows unusable; pool
        // drift (false) only forbids retained reuse of the prepared frame.
        // Text preparation reads the whole publication: a patched text row
        // re-prepares the batch before its finish reads the row's result.
        for (const index of changedNodeIndices) {
          if (publishCoreFrame([nodes[index]], index) === false) return null;
          if (nodes[index].display === "text") {
            const prepared = textPreparationRuntime.prepareTextBatch(nodes);
            textBatch.release();
            textBatch = prepared;
            resultsBase = textBatch.resultsBase();
          }
          if (!finishRows(index)) sparseValid = false;
        }
      } else {
        sparseValid = finishRows();
      }
      if (globalThis.__engineRecordProbe) {
        for (const index of retained ? changedNodeIndices : nodes.keys()) {
          const base = layoutBufferBase + index * LAYOUT_NODE_SIZE;
          globalThis.__engineRecordProbe(
            index, nodes[index], engine.bytes.slice(base, base + LAYOUT_NODE_SIZE),
            engine.bytes,
          );
        }
      }
    } finally {
      currentTextBatch = textBatch;
    }
    view.setUint32(TILE_CONFIG_BASE + 0x00, 64, true);
    view.setUint32(TILE_CONFIG_BASE + 0x04, Math.ceil(scene.width / 64), true);
    view.setUint32(TILE_CONFIG_BASE + 0x08, Math.ceil(scene.height / 64), true);
    view.setUint32(TILE_CONFIG_BASE + 0x0C, scene.width, true);
    view.setUint32(TILE_CONFIG_BASE + 0x10, scene.height, true);
    return sparseValid;
  }

  // Synchronous counterpart of emitSceneCommands — matches a real
  // browser's SYNCHRONOUS layout-getter properties exactly (offsetWidth
  // etc., src/dom/layout-getters.js), per project ruling. Throws (via
  // resolveFontIndices/resolveImageIndicesSync/resolveSvgPathIndicesSync)
  // if the tree references a font/image/SVG-path not already registered —
  // see each sync resolver's own comment for why that's the correct,
  // honest contract rather than silently blocking or guessing wrong. Font
  // indices take the shared resolver: it has been synchronous since the
  // async fontIndexFor went away, and the copy its duplicate made per
  // text node evaluated every node's deferred text decode.
  function emitSceneCommandsSync(
    scene,
    { layoutNodeCapacity = Infinity, commitTextRunKeys, discardCommands = false } = {},
    generationReservation = null,
    emitPaintCommands = true,
  ) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
    engine.exports.set_device_scale(1);
    const used = resolveOrderModifiedChildren(resolveSvgUseNodes(scene.nodes));
    // Mirrors prepareFull: only a normalization that changes the row index
    // space invalidates every sparse delta of the frame that reuses this.
    const globalPreparation = used !== scene.nodes;
    let nodes = resolveSvgPathIndicesSync(
      resolveImageIndicesSync(resolveFontIndices(used), scene.imageSources),
    );
    const boxes = provisionalClipLayout(
      scene,
      nodes,
      layoutNodeCapacity,
      generationReservation,
    );
    if (boxes) nodes = resolveClipPathIndicesSync(nodes, boxes);
    writeSceneNodesAndTileConfig(
      scene,
      nodes,
      null,
      layoutNodeCapacity,
      generationReservation,
      commitTextRunKeys,
    );
    if (!emitPaintCommands) {
      engine.exports.layout(nodes.length, scene.width, scene.height);
      return { view: null, bytesWritten: 0, nodes, globalPreparation };
    }
    engine.exports.set_paint_artifact_capture(0);
    // QUERY emit — same contract as emitSceneCommands above.
    engine.exports.set_query_emit(1);
    let bytesWritten;
    try {
      bytesWritten = engine.exports.emit_commands(nodes.length);
    } finally {
      engine.exports.set_query_emit(0);
    }
    if (discardCommands) {
      return { view: null, bytesWritten, nodes, globalPreparation };
    }
    const copy = engine.memory.buffer.slice(
      COMMAND_BUFFER_BASE,
      COMMAND_BUFFER_BASE + bytesWritten,
    );
    return { view: new DataView(copy), bytesWritten, nodes, globalPreparation };
  }

  // Reads every node's computed border-box + content-box (CSS px) off the
  // engine's box buffer after a layout pass — shared by layoutTreeBoxes
  // and layoutTreeBoxesSync below. Indexed EXACTLY like scene.nodes (not
  // the internally-resolved array, which resolveSvgUseNodes can grow via
  // <use> synthesis — irrelevant here since DOM-layer callers index by
  // serializeToScene's own 1:1 indexOf map).
  function readSceneBoxes(scene, deviceScale = 1) {
    const scale = LAYOUT_UNIT * deviceScale;
    const measurement = globalThis[domMeasurementKey];
    const start = measurement ? performance.now() : 0;
    let decodedBytes = 0;
    const boxes = scene.nodes.map((_, i) => {
      const b = computedBoxBufferBase + i * BOX_SIZE;
      const scrollData = scrollDataBufferBase + i * SCROLL_DATA_ENTRY_SIZE;
      // The node's record decides the scroll origin and the client width
      // (its direction byte and border widths), for scene-written and
      // core-written boxes alike.
      const record = layoutBufferBase + i * LAYOUT_NODE_SIZE;
      const effectiveLeft =
        view.getInt32(scrollData + SCROLL_DATA_OFFSET_EFFECTIVE_LEFT, true) /
        scale;
      const originAtHigh =
        engine.bytes[record + LAYOUT_NODE_OFFSET_DIRECTION_RTL] === 1;
      // Fourteen i32 loads plus the direction byte; the RTL branch below
      // performs two additional i32 and two f32 loads.
      if (measurement) decodedBytes += 57 + (originAtHigh ? 16 : 0);
      return {
        x: view.getInt32(b + BOX_OFFSET_X, true) / scale,
        y: view.getInt32(b + BOX_OFFSET_Y, true) / scale,
        w: view.getInt32(b + BOX_OFFSET_WIDTH, true) / scale,
        h: view.getInt32(b + BOX_OFFSET_HEIGHT, true) / scale,
        cx: view.getInt32(b + BOX_OFFSET_CONTENT_X, true) / scale,
        cy: view.getInt32(b + BOX_OFFSET_CONTENT_Y, true) / scale,
        cw: view.getInt32(b + BOX_OFFSET_CONTENT_W, true) / scale,
        ch: view.getInt32(b + BOX_OFFSET_CONTENT_H, true) / scale,
        scrollLeft: originAtHigh
          ? effectiveLeft -
            Math.max(
              0,
              view.getInt32(scrollData + SCROLL_DATA_OFFSET_WIDTH, true) /
                  scale -
                (view.getInt32(b + BOX_OFFSET_WIDTH, true) / scale -
                  view.getFloat32(
                      record + LAYOUT_NODE_OFFSET_BORDER_LEFT,
                      true,
                    ) / deviceScale -
                  view.getFloat32(
                      record + LAYOUT_NODE_OFFSET_BORDER_RIGHT,
                      true,
                    ) / deviceScale),
            )
          : effectiveLeft,
        scrollTop:
          view.getInt32(scrollData + SCROLL_DATA_OFFSET_EFFECTIVE_TOP, true) /
          scale,
        scrollWidth: Math.round(
          view.getInt32(scrollData + SCROLL_DATA_OFFSET_WIDTH, true) / scale,
        ),
        scrollHeight: Math.round(
          view.getInt32(scrollData + SCROLL_DATA_OFFSET_HEIGHT, true) / scale,
        ),
        stickyLeft:
          view.getInt32(scrollData + SCROLL_DATA_OFFSET_STICKY_LEFT, true) /
          scale,
        stickyTop:
          view.getInt32(scrollData + SCROLL_DATA_OFFSET_STICKY_TOP, true) /
          scale,
      };
    });
    if (measurement) {
      measurement.record({
        category: "geometry",
        operation: "boxes.decode",
        direction: "engine-to-host",
        bytes: decodedBytes,
        allocations: boxes.length + 1,
        milliseconds: performance.now() - start,
      });
    }
    // The core snapshots the rows these boxes were read from (one
    // memory): the geometry builder's box source, taken here because the
    // engine's buffers are transient across the awaits that follow.
    if (typeof engine.core?.status === "function") {
      attachBoxSnapshot(boxes, engine.core, 1);
    }
    return boxes;
  }

  // A standalone analytical layout must not inherit geometry or cache
  // validity from a prior call: the engine may hold another scene whose
  // records happen to match this one's at some index, and that node would
  // keep the other scene's box (and its post-layout transform). Force
  // every node into the next generation and clear the output tables, so
  // the engine computes a complete standalone result. An analytical pass
  // over the scene the engine ALREADY holds skips this (see
  // layoutTreeBoxesSync): the record diff is then authoritative, exactly
  // as it is for a frame.
  function stampAnalyticalState(nodeCount, forcedGeneration) {
    core.status("engine_record_analytical_reset", nodeCount, forcedGeneration);
  }

  function resetAnalyticalLayoutState(nodeCount, inheritRetained = false) {
    const currentGeneration = view.getUint32(
      HEADER_BASE + HEADER_OFFSET_GENERATION,
      true,
    );
    const generationReservation = currentGeneration === 0xFFFF_FFFF
      ? {
        generation: engine.exports.advance_generation() >>> 0,
        published: true,
        consumed: false,
        nodeCount,
      }
      : {
        generation: currentGeneration + 1,
        published: false,
        consumed: false,
        nodeCount,
      };
    if (!inheritRetained) {
      stampAnalyticalState(nodeCount, generationReservation.generation);
    }
    return generationReservation;
  }

  // An analytical layout over the scene the claim owner renders is that
  // owner's next frame in all but name: it inherits the retained layout
  // (only the rows whose records changed relay out), commits text identity
  // like a frame write, and the rows it leaves in the engine are recorded
  // so the frame that takes this scene skips writing them again
  // (renderScenePixelsNow's reuseSyncLayoutWrite). Without a claim the
  // layout stands alone: forced generation, cleared output tables.
  function analyticalWriteOptions(scene, options) {
    const owner = options.engineWriteOwner ?? null;
    const inherited = owner !== null && engineWriteOwner === owner;
    const generationReservation = resetAnalyticalLayoutState(
      scene.nodes.length,
      inherited,
    );
    return { owner, inherited, generationReservation };
  }

  function finishAnalyticalWrite(scene, { owner, inherited }, written) {
    const boxes = readSceneBoxes(scene);
    // The write above dropped the claim (every engine write does). This
    // scene came from the claimant's own tree, so hand it back: the next
    // frame keeps its incremental node set instead of rewriting every
    // record because a layout ran between the two.
    if (owner !== null) engineWriteOwner = owner;
    syncLayoutWrite = inherited
      ? {
        owner,
        sceneNodes: scene.nodes,
        nodes: written.nodes,
        globalPreparation: written.globalPreparation,
        width: scene.width,
        height: scene.height,
        writeClaim: engineWriteClaims.get(engine.memory),
        coreWriteRevision: core.engineFrameRevision,
        resourceRevision: core.status("resource_revision"),
        fontRevision: fontRegistry.revision,
      }
      : null;
    return boxes;
  }

  // Lay out a scene (deviceScale=1) and return every node's computed border-box
  // and content-box in CSS pixels. The layout-getter family uses this shared
  // mechanism: serialize, run layout, and read the node's box. It reuses
  // emitSceneCommands for its layout side effect rather than duplicating a
  // second layout path. The emitted commands are discarded.
  async function layoutTreeBoxes(scene, options = {}) {
    // The generation reservation and the box read assume exclusive engine
    // access; a live surface's render loop would interleave otherwise
    // (writeSceneNodesAndTileConfig rejects the advanced generation loudly).
    return await runExclusiveEngineOperation(async () => {
      const analytical = analyticalWriteOptions(scene, options);
      const written = await emitSceneCommands(
        scene,
        analytical.inherited ? { ...options, commitTextRunKeys: true } : options,
        analytical.generationReservation,
        false,
      );
      return finishAnalyticalWrite(scene, analytical, written);
    });
  }

  // Synchronous counterpart of layoutTreeBoxes — matches a real browser's
  // synchronous offsetWidth/getBoundingClientRect/etc. exactly. Throws if
  // the tree references an unregistered font/image/SVG-path (see
  function layoutTreeBoxesSync(scene, options = {}) {
    const analytical = analyticalWriteOptions(scene, options);
    // emitPaintCommands stays ON for the analytical path: a non-atomic
    // inline box's computed box is the union of its per-line fragment
    // rects, and that union is produced by the emit walk
    // ($emitInlineLineDecorations) — layout alone leaves inline boxes
    // zero-sized. The command bytes themselves are discarded.
    const written = emitSceneCommandsSync(
      scene,
      analytical.inherited
        ? { ...options, commitTextRunKeys: true, discardCommands: true }
        : { ...options, discardCommands: true },
      analytical.generationReservation,
      true,
    );
    return finishAnalyticalWrite(scene, analytical, written);
  }

  function artifactBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value));
  }

  function freezeArtifactValue(value) {
    if (Array.isArray(value)) {
      value.forEach(freezeArtifactValue);
      return Object.freeze(value);
    }
    if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
      Object.values(value).forEach(freezeArtifactValue);
      return Object.freeze(value);
    }
    return value;
  }

  function edgeValue(node, group, side) {
    return node?.[group]?.[side] ?? 0;
  }

  function expandedBox(box, top, right, bottom, left) {
    return {
      x: box.x - left,
      y: box.y - top,
      width: box.width + left + right,
      height: box.height + top + bottom,
    };
  }

  function textMetricsForNode(nodeIndex) {
    const nodeBase = layoutBufferBase + nodeIndex * LAYOUT_NODE_SIZE;
    const fontIndex = view.getUint16(
      nodeBase + LAYOUT_NODE_OFFSET_FONT_INDEX,
      true,
    );
    const fontBase = FONT_TABLE_BASE + fontIndex * FONT_TABLE_ENTRY_SIZE;
    const unitsPerEm = view.getUint32(
      fontBase + FONT_TABLE_OFFSET_UPEM,
      true,
    );
    const fontSize = view.getFloat32(
      nodeBase + LAYOUT_NODE_OFFSET_FONT_SIZE,
      true,
    );
    const scale = Math.fround(fontSize / unitsPerEm);
    const metricPixels = (units) =>
      Math.fround(Math.floor(units * scale + 0.5));
    const ascender = metricPixels(
      view.getInt32(fontBase + FONT_TABLE_OFFSET_ASCENDER, true),
    );
    const descender = -metricPixels(
      -view.getInt32(fontBase + FONT_TABLE_OFFSET_DESCENDER, true),
    );
    const lineGap = Math.fround(
      view.getInt32(fontBase + FONT_TABLE_OFFSET_LINE_GAP, true) * scale,
    );
    const lineHeightTag = view.getUint8(
      nodeBase + LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG,
    );
    const authoredLineHeight = view.getFloat32(
      nodeBase + LAYOUT_NODE_OFFSET_LINE_HEIGHT,
      true,
    );
    let lineHeight;
    if (lineHeightTag === LINE_HEIGHT_NORMAL) {
      lineHeight = Math.fround(ascender - descender + lineGap);
    } else if (lineHeightTag === LINE_HEIGHT_LENGTH) {
      lineHeight = Math.round(authoredLineHeight * LAYOUT_UNIT) / LAYOUT_UNIT;
    } else if (lineHeightTag === LINE_HEIGHT_NUMBER) {
      lineHeight = Math.floor(
        Math.fround(authoredLineHeight * fontSize) * LAYOUT_UNIT,
      ) / LAYOUT_UNIT;
    } else {
      throw new Error(
        `layout artifact: unknown line-height tag ${lineHeightTag}`,
      );
    }
    const lineHeightUnits = Math.round(lineHeight * LAYOUT_UNIT);
    const fontHeightUnits = Math.round(
      Math.fround(ascender - descender) * LAYOUT_UNIT,
    );
    const halfLeadingUnits = Math.trunc(
      (lineHeightUnits - fontHeightUnits) / 2,
    );
    const baseline = (halfLeadingUnits >> 6) + ascender;
    return { baseline, lineHeight };
  }

  function readLayoutArtifact(scene, nodes) {
    const parentIndices = new Array(nodes.length).fill(null);
    nodes.forEach((node, nodeIndex) => {
      for (const childIndex of node.children ?? []) {
        parentIndices[childIndex] = nodeIndex;
      }
    });
    const scrollBoxes = readSceneBoxes({ nodes });
    const boxes = nodes.map((node, nodeIndex) => {
      const boxBase = computedBoxBufferBase + nodeIndex * BOX_SIZE;
      const borderBox = {
        x: view.getInt32(boxBase + BOX_OFFSET_X, true) / LAYOUT_UNIT,
        y: view.getInt32(boxBase + BOX_OFFSET_Y, true) / LAYOUT_UNIT,
        width: view.getInt32(boxBase + BOX_OFFSET_WIDTH, true) / LAYOUT_UNIT,
        height: view.getInt32(boxBase + BOX_OFFSET_HEIGHT, true) / LAYOUT_UNIT,
      };
      const contentBox = {
        x: view.getInt32(boxBase + BOX_OFFSET_CONTENT_X, true) / LAYOUT_UNIT,
        y: view.getInt32(boxBase + BOX_OFFSET_CONTENT_Y, true) / LAYOUT_UNIT,
        width: view.getInt32(boxBase + BOX_OFFSET_CONTENT_W, true) /
          LAYOUT_UNIT,
        height: view.getInt32(boxBase + BOX_OFFSET_CONTENT_H, true) /
          LAYOUT_UNIT,
      };
      const paddingBox = expandedBox(
        contentBox,
        edgeValue(node, "padding", "top"),
        edgeValue(node, "padding", "right"),
        edgeValue(node, "padding", "bottom"),
        edgeValue(node, "padding", "left"),
      );
      const marginBox = expandedBox(
        borderBox,
        edgeValue(node, "margin", "top"),
        edgeValue(node, "margin", "right"),
        edgeValue(node, "margin", "bottom"),
        edgeValue(node, "margin", "left"),
      );
      return {
        nodeIndex,
        parentIndex: parentIndices[nodeIndex],
        childIndices: [...(node.children ?? [])],
        marginBox,
        borderBox,
        paddingBox,
        contentBox,
        scroll: {
          left: scrollBoxes[nodeIndex].scrollLeft,
          top: scrollBoxes[nodeIndex].scrollTop,
          width: scrollBoxes[nodeIndex].scrollWidth,
          height: scrollBoxes[nodeIndex].scrollHeight,
        },
      };
    });
    const lineBoxes = [];
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      const runBase = textRunDirBase + nodeIndex * TEXT_RUN_ENTRY_SIZE;
      const lineOffset = view.getUint32(
        runBase + TEXT_RUN_OFFSET_LINE_OFFSET,
        true,
      );
      const lineCount = view.getUint16(
        runBase + TEXT_RUN_OFFSET_LINE_COUNT,
        true,
      );
      if (lineCount === 0) continue;
      const metrics = textMetricsForNode(nodeIndex);
      const contentBox = boxes[nodeIndex].contentBox;
      const textAlign = nodes[nodeIndex].textAlign ?? "left";
      for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
        // lineOffset is the ABSOLUTE byte address of this node's span
        // ($layoutText stores its $textLineCursor grab directly); the
        // engine's own readers pass it to $textLineRec unchanged.
        const lineBase = lineOffset + lineIndex * TEXT_LINE_ENTRY_SIZE;
        const lineX = contentBox.x +
          view.getFloat32(lineBase + TEXT_LINE_OFFSET_X, true);
        const lineY = contentBox.y +
          view.getFloat32(lineBase + TEXT_LINE_OFFSET_Y, true);
        const width = view.getFloat32(lineBase + TEXT_LINE_OFFSET_WIDTH, true);
        const availableWidth = view.getFloat32(
          lineBase + TEXT_LINE_OFFSET_AVAIL,
          true,
        );
        // x is the line's band left; the glyphs start after the text-align
        // shift, mirroring the paint emitter's math exactly.
        const alignmentSlack = Math.max(availableWidth - width, 0);
        const alignedX = textAlign === "center"
          ? lineX + alignmentSlack / 2
          : textAlign === "right"
          ? lineX + alignmentSlack
          : lineX;
        lineBoxes.push({
          nodeIndex,
          lineIndex,
          x: lineX,
          y: lineY,
          alignedX,
          width,
          height: metrics.lineHeight,
          availableWidth,
          baseline: lineY + metrics.baseline,
          firstGlyph: view.getUint32(
            lineBase + TEXT_LINE_OFFSET_FIRST_GLYPH,
            true,
          ),
          glyphCount: view.getUint32(
            lineBase + TEXT_LINE_OFFSET_GLYPH_COUNT,
            true,
          ),
        });
      }
    }
    const value = {
      kind: "layout",
      viewport: { width: scene.width, height: scene.height },
      boxes,
      lineBoxes,
    };
    return freezeArtifactValue({ ...value, bytes: artifactBytes(value) });
  }

  async function createLayoutArtifact(
    scene,
    {
      resolveResource = null,
      layoutNodeCapacity = Infinity,
    } = {},
  ) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
    return await runExclusiveEngineOperation(async () => {
      engine.exports.set_device_scale(1);
      const nodes = await resolveFontIndices(
        await resolveImageIndices(
          resolveOrderModifiedChildren(resolveSvgUseNodes(scene.nodes)),
          resolveResource,
          scene.imageSources,
        ),
      );
      const generationReservation = resetAnalyticalLayoutState(nodes.length);
      writeSceneNodesAndTileConfig(
        scene,
        nodes,
        null,
        layoutNodeCapacity,
        generationReservation,
      );
      engine.exports.layout(nodes.length, scene.width, scene.height);
      return readLayoutArtifact(scene, nodes);
    });
  }

  const COMMAND_NAMES = new Map([
    [CMD_RECT, "rectangle"],
    [CMD_TEXT, "text"],
    [CMD_IMAGE, "image"],
    [CMD_BOX_SHADOW, "box-shadow"],
    [CMD_PUSH_CLIP, "push-clip"],
    [CMD_POP_CLIP, "pop-clip"],
    [CMD_PUSH_OPACITY, "push-opacity"],
    [CMD_POP_OPACITY, "pop-opacity"],
    [CMD_SVG_PATH, "svg-path"],
    [CMD_PUSH_BACKDROP_FILTER, "push-backdrop-filter"],
    [CMD_POP_BACKDROP_FILTER, "pop-backdrop-filter"],
    [CMD_PUSH_MASK, "push-mask"],
    [CMD_PUSH_MASK_LAYER, "push-mask-layer"],
    [CMD_POP_MASK_LAYER, "pop-mask-layer"],
    [CMD_PUSH_BACKGROUND, "push-background"],
    [CMD_PUSH_BLEND_LAYER, "push-blend-layer"],
    [CMD_POP_BLEND_LAYER, "pop-blend-layer"],
    [CMD_POP_BACKGROUND, "pop-background"],
    [CMD_SET_NODE, "set-node"],
  ]);

  const GROUP_PAIRS = new Map([
    [CMD_PUSH_OPACITY, CMD_POP_OPACITY],
    [CMD_PUSH_BACKDROP_FILTER, CMD_POP_BACKDROP_FILTER],
    [CMD_PUSH_MASK_LAYER, CMD_POP_MASK_LAYER],
    [CMD_PUSH_BLEND_LAYER, CMD_POP_BLEND_LAYER],
    [CMD_PUSH_BACKGROUND, CMD_POP_BACKGROUND],
  ]);

  const BLEND_MODE_NAMES_BY_VALUE = Object.freeze(
    Object.fromEntries(
      Object.entries(BLEND_MODE_NAMES).map(([name, value]) => [value, name]),
    ),
  );

  function decodeClipEntries(commandView, commandOffset, deviceScale = 1) {
    const count = commandView.getUint8(
      commandOffset + CMD_PUSH_CLIP_OFFSET_COUNT,
    );
    const entries = [];
    for (let index = 0; index < count; index++) {
      const entryOffset = commandOffset + CMD_PUSH_CLIP_HEADER_SIZE +
        index * CLIP_ENTRY_SIZE;
      const flags = commandView.getUint8(entryOffset + CLIP_ENTRY_OFFSET_FLAGS);
      entries.push({
        flags,
        x: commandView.getFloat32(entryOffset + CLIP_ENTRY_OFFSET_X, true) /
          deviceScale,
        y: commandView.getFloat32(entryOffset + CLIP_ENTRY_OFFSET_Y, true) /
          deviceScale,
        width: commandView.getFloat32(entryOffset + CLIP_ENTRY_OFFSET_W, true) /
          deviceScale,
        height:
          commandView.getFloat32(entryOffset + CLIP_ENTRY_OFFSET_H, true) /
          deviceScale,
        radii: Array.from(
          { length: 8 },
          (_, radiusIndex) =>
            commandView.getFloat32(
              entryOffset + CLIP_ENTRY_OFFSET_RADII + radiusIndex * 4,
              true,
            ) / deviceScale,
        ),
        affine: (flags & CLIP_ENTRY_FLAG_AFFINE) !== 0
          ? Array.from(
            { length: 6 },
            (_, affineIndex) => {
              const value = commandView.getFloat32(
                entryOffset + CLIP_ENTRY_OFFSET_AFFINE + affineIndex * 4,
                true,
              );
              return affineIndex < 4 ? value : value / deviceScale;
            },
          )
          : null,
        pathMask: (flags & CLIP_ENTRY_FLAG_PATH_MASK) !== 0,
      });
    }
    return entries;
  }

  function decodeCommandGeometry(commandView, commandOffset, opcode) {
    if (opcode === CMD_RECT) {
      return {
        x: commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_X, true),
        y: commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_Y, true),
        width: commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_W, true),
        height: commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_H, true),
      };
    }
    if (opcode === CMD_TEXT) {
      return {
        x: commandView.getFloat32(commandOffset + CMD_TEXT_OFFSET_X, true),
        y: commandView.getFloat32(commandOffset + CMD_TEXT_OFFSET_Y, true),
        baseline: commandView.getFloat32(
          commandOffset + CMD_TEXT_OFFSET_BL,
          true,
        ),
      };
    }
    if (opcode === CMD_IMAGE) {
      return {
        x: commandView.getFloat32(commandOffset + CMD_IMAGE_OFFSET_X, true),
        y: commandView.getFloat32(commandOffset + CMD_IMAGE_OFFSET_Y, true),
        width: commandView.getFloat32(commandOffset + CMD_IMAGE_OFFSET_W, true),
        height: commandView.getFloat32(
          commandOffset + CMD_IMAGE_OFFSET_H,
          true,
        ),
      };
    }
    if (opcode === CMD_SVG_PATH) {
      return {
        x: commandView.getFloat32(commandOffset + CMD_SVG_PATH_OFFSET_X, true),
        y: commandView.getFloat32(commandOffset + CMD_SVG_PATH_OFFSET_Y, true),
        width: commandView.getFloat32(
          commandOffset + CMD_SVG_PATH_OFFSET_W,
          true,
        ),
        height: commandView.getFloat32(
          commandOffset + CMD_SVG_PATH_OFFSET_H,
          true,
        ),
      };
    }
    if (opcode === CMD_BOX_SHADOW) {
      return {
        x: commandView.getFloat32(
          commandOffset + CMD_BOX_SHADOW_OFFSET_X,
          true,
        ),
        y: commandView.getFloat32(
          commandOffset + CMD_BOX_SHADOW_OFFSET_Y,
          true,
        ),
        width: commandView.getFloat32(
          commandOffset + CMD_BOX_SHADOW_OFFSET_W,
          true,
        ),
        height: commandView.getFloat32(
          commandOffset + CMD_BOX_SHADOW_OFFSET_H,
          true,
        ),
      };
    }
    return null;
  }

  const utf8Decoder = new TextDecoder();
  // UTF-16 code unit offset at each UTF-8 byte offset of a run's bytes;
  // null when every byte is ASCII. Cached on the run's byte array.
  const utf16OffsetTables = new WeakMap();
  function utf16OffsetsOf(bytes) {
    let table = utf16OffsetTables.get(bytes);
    if (table !== undefined) return table;
    table = null;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 0x80) {
        table = new Uint32Array(bytes.length + 1);
        let units = 0;
        for (let k = 0; k < bytes.length; k++) {
          table[k] = units;
          const byte = bytes[k];
          // A code unit begins at every non-continuation byte; a 4-byte
          // sequence (astral) is a surrogate pair.
          if ((byte & 0xc0) !== 0x80) units += byte >= 0xf0 ? 2 : 1;
        }
        table[bytes.length] = units;
        break;
      }
    }
    utf16OffsetTables.set(bytes, table);
    return table;
  }

  // glyphs and glyphAdvances of a text operation, built on first read
  // and then plain data properties. Glyph cluster bounds are UTF-8 byte
  // offsets into the run; the artifact reports UTF-16 code unit offsets.
  function defineLazyGlyphs(operation, source, deviceScale) {
    const build = () => {
      const { entries, count, x, fontSize, unitsPerEm, preparedBytes } = source;
      const view = new DataView(
        entries.buffer,
        entries.byteOffset,
        entries.byteLength,
      );
      const units = utf16OffsetsOf(preparedBytes);
      const glyphAdvances = new Array(count);
      const glyphs = new Array(count);
      for (let index = 0; index < count; index++) {
        const entryOffset = index * GLYPH_ENTRY_SIZE;
        const xOffset = view.getFloat32(
          entryOffset + GLYPH_OFFSET_X_OFFSET,
          true,
        );
        const advance = view.getFloat32(
          entryOffset + GLYPH_OFFSET_X_ADVANCE,
          true,
        );
        const sourceStart = view.getUint32(
          entryOffset + GLYPH_OFFSET_CLUSTER_START,
          true,
        );
        const sourceEnd = view.getUint32(
          entryOffset + GLYPH_OFFSET_CLUSTER_END,
          true,
        );
        const logicalAdvance = advance * fontSize / unitsPerEm / deviceScale;
        glyphAdvances[index] = logicalAdvance;
        glyphs[index] = Object.freeze({
          x: (x + xOffset * fontSize / unitsPerEm) / deviceScale,
          width: logicalAdvance,
          sourceStart: units === null ? sourceStart : units[sourceStart],
          sourceEnd: units === null ? sourceEnd : units[sourceEnd],
        });
      }
      Object.defineProperties(operation, {
        glyphAdvances: {
          value: glyphAdvances,
          enumerable: true,
          writable: true,
          configurable: true,
        },
        glyphs: {
          value: Object.freeze(glyphs),
          enumerable: true,
          writable: true,
          configurable: true,
        },
      });
    };
    Object.defineProperties(operation, {
      glyphCount: { value: source.count, enumerable: true, configurable: true },
      glyphAdvances: {
        get() {
          build();
          return operation.glyphAdvances;
        },
        enumerable: true,
        configurable: true,
      },
      glyphs: {
        get() {
          build();
          return operation.glyphs;
        },
        enumerable: true,
        configurable: true,
      },
    });
  }

  function createPaintArtifact(
    commandView,
    bytesWritten,
    scene,
    emittedNodes,
    deviceScale,
    glyphBuffer,
    frameTextRuns,
  ) {
    const glyphView = new DataView(
      glyphBuffer.buffer,
      glyphBuffer.byteOffset,
      glyphBuffer.byteLength,
    );
    const boxes = [];
    const operations = [];
    const compositingGroups = [];
    const clipStack = [];
    const compositingGroupStack = [];
    let currentNodeIndex = null;
    let currentRunIndex = null;
    let currentClipEntries = [];
    let commandIndex = 0;
    for (let byteOffset = 0; byteOffset < bytesWritten; commandIndex++) {
      const opcode = commandView.getUint8(byteOffset);
      if (opcode === CMD_SET_NODE) {
        const emittedNodeIndex = commandView.getUint32(
          byteOffset + CMD_SET_NODE_OFFSET_INDEX,
          true,
        );
        currentRunIndex = emittedNodeIndex;
        currentNodeIndex = frameTextRuns[emittedNodeIndex]?.sourceId ??
          emittedNodes[emittedNodeIndex]?._inspectionSourceNodeIndex ??
          emittedNodeIndex;
      } else if (opcode === CMD_PUSH_CLIP) {
        currentClipEntries = decodeClipEntries(
          commandView,
          byteOffset,
          deviceScale,
        );
        clipStack.push(currentClipEntries);
      } else if (opcode === CMD_POP_CLIP) {
        if (clipStack.length === 0) {
          throw new Error("paint artifact: clip stack underflow");
        }
        clipStack.pop();
        currentClipEntries = clipStack.at(-1) ?? [];
      }

      if (GROUP_PAIRS.has(opcode)) {
        const group = {
          identifier: `paint-group-${compositingGroups.length}`,
          kind: COMMAND_NAMES.get(opcode).slice(5),
          nodeIndex: currentNodeIndex,
          startCommandIndex: commandIndex,
          endCommandIndex: null,
          startOperationIndex: operations.length,
          endOperationIndex: null,
        };
        if (opcode === CMD_PUSH_OPACITY) {
          const flags = commandView.getUint8(
            byteOffset + CMD_PUSH_OPACITY_OFFSET_FLAGS,
          );
          group.opacity = commandView.getFloat32(
            byteOffset + CMD_PUSH_OPACITY_OFFSET_ALPHA,
            true,
          );
          group.blendMode = BLEND_MODE_NAMES_BY_VALUE[
            (flags & CMD_PUSH_OPACITY_FLAG_BLEND_MASK) >>
            CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT
          ];
          group.stackingContext = true;
        } else if (opcode === CMD_PUSH_BLEND_LAYER) {
          group.blendMode = BLEND_MODE_NAMES_BY_VALUE[
            commandView.getUint8(
              byteOffset + CMD_PUSH_BLEND_LAYER_OFFSET_MODE,
            )
          ];
          group.stackingContext = false;
        } else {
          group.stackingContext = opcode === CMD_PUSH_BACKDROP_FILTER;
        }
        compositingGroups.push(group);
        compositingGroupStack.push({
          group,
          popOpcode: GROUP_PAIRS.get(opcode),
        });
      } else if (
        compositingGroupStack.length > 0 &&
        opcode === compositingGroupStack.at(-1).popOpcode
      ) {
        const { group } = compositingGroupStack.pop();
        group.endCommandIndex = commandIndex;
        group.endOperationIndex = operations.length - 1;
      }

      const geometry = decodeCommandGeometry(commandView, byteOffset, opcode);
      if (
        opcode === CMD_RECT || opcode === CMD_TEXT || opcode === CMD_IMAGE ||
        opcode === CMD_SVG_PATH || opcode === CMD_BOX_SHADOW
      ) {
        if (currentNodeIndex === null) {
          // Diagnostic depth matters here: this fires when a draw command
          // appears before any CMD_SET_NODE marker — historically a
          // symptom of another emit clobbering the shared buffers while a
          // frame was parked at an await (fixed by the frame snapshot in
          // renderScenePixels), so name the command and its geometry.
          const preceding = [];
          for (let o = 0; o < byteOffset;) {
            const k = commandView.getUint8(o);
            preceding.push(COMMAND_NAMES.get(k) ?? `op${k}`);
            o += commandByteSize(commandView, o);
          }
          throw new Error(
            `paint artifact: ${COMMAND_NAMES.get(opcode)} has no scene node ` +
              `(command ${commandIndex}, geometry ${
                JSON.stringify(geometry)
              }, ` +
              `preceding: ${preceding.join(" ")})`,
          );
        }
        const textFlags = opcode === CMD_TEXT
          ? commandView.getUint8(byteOffset + CMD_TEXT_OFFSET_FLAGS)
          : 0;
        let logicalRectangle;
        let textMetrics = null;
        let lazyGlyphs = null;
        if (opcode === CMD_TEXT) {
          const glyphCount = commandView.getUint16(
            byteOffset + CMD_TEXT_OFFSET_GCOUNT,
            true,
          );
          const glyphOffset = commandView.getUint32(
            byteOffset + CMD_TEXT_OFFSET_GOFF,
            true,
          );
          const fontSize = commandView.getFloat32(
            byteOffset + CMD_TEXT_OFFSET_FSIZE,
            true,
          );
          const unitsPerEm = commandView.getUint16(
            byteOffset + CMD_TEXT_OFFSET_UPEM,
            true,
          );
          let width = 0;
          let clusterStart = Number.MAX_SAFE_INTEGER;
          let clusterEnd = 0;
          for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex++) {
            const entryOffset = glyphOffset + glyphIndex * GLYPH_ENTRY_SIZE;
            const xOffset = glyphView.getFloat32(
              entryOffset + GLYPH_OFFSET_X_OFFSET,
              true,
            );
            const advance = glyphView.getFloat32(
              entryOffset + GLYPH_OFFSET_X_ADVANCE,
              true,
            );
            width = Math.max(width, xOffset + advance);
            clusterStart = Math.min(
              clusterStart,
              glyphView.getUint32(
                entryOffset + GLYPH_OFFSET_CLUSTER_START,
                true,
              ),
            );
            clusterEnd = Math.max(
              clusterEnd,
              glyphView.getUint32(entryOffset + GLYPH_OFFSET_CLUSTER_END, true),
            );
          }
          if (!frameTextRuns[currentRunIndex]) {
            throw new Error(
              `paint artifact: text command under node ${currentRunIndex} (${
                emittedNodes[currentRunIndex]?.display ?? "absent"
              }), which carries no prepared text run`,
            );
          }
          const preparedBytes = frameTextRuns[currentRunIndex].bytes;
          const text = glyphCount === 0 ? "" : utf8Decoder.decode(
            preparedBytes.subarray(clusterStart, clusterEnd),
          );
          // The per-glyph objects (glyphs, glyphAdvances) are built on
          // first read from a copy of the command's glyph entries: a frame
          // reads them only for text nodes whose geometry it cannot keep
          // from the previous frame (render-surface), and a frame of a
          // thousand runs would otherwise build them all.
          lazyGlyphs = {
            entries: glyphBuffer.slice(
              glyphOffset,
              glyphOffset + glyphCount * GLYPH_ENTRY_SIZE,
            ),
            count: glyphCount,
            x: geometry.x,
            fontSize,
            unitsPerEm,
            preparedBytes,
          };
          const baseline = commandView.getFloat32(
            byteOffset + CMD_TEXT_OFFSET_BL,
            true,
          );
          textMetrics = {
            text,
            fontSize: fontSize / deviceScale,
            lineHeight: commandView.getFloat32(
              byteOffset + CMD_TEXT_OFFSET_LH,
              true,
            ) / deviceScale,
            ascent: commandView.getFloat32(
              byteOffset + CMD_TEXT_OFFSET_ASCENT,
              true,
            ) / deviceScale,
            descent: commandView.getFloat32(
              byteOffset + CMD_TEXT_OFFSET_DESCENT,
              true,
            ) / deviceScale,
            baseline: {
              x: geometry.x / deviceScale,
              y: (geometry.y + baseline) / deviceScale,
            },
          };
          logicalRectangle = {
            x: geometry.x / deviceScale,
            y: geometry.y / deviceScale,
            width: width * fontSize / unitsPerEm / deviceScale,
            height: commandView.getFloat32(
              byteOffset + CMD_TEXT_OFFSET_LH,
              true,
            ) / deviceScale,
          };
        } else {
          logicalRectangle = {
            x: geometry.x / deviceScale,
            y: geometry.y / deviceScale,
            width: geometry.width / deviceScale,
            height: geometry.height / deviceScale,
          };
        }

        let affine = null;
        let affineOffset = null;
        if (
          opcode === CMD_RECT &&
          (commandView.getUint8(byteOffset + CMD_RECT_OFFSET_FLAGS) &
              CMD_RECT_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_RECT_OFFSET_XFORM;
        } else if (
          opcode === CMD_TEXT &&
          (textFlags & CMD_TEXT_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_TEXT_OFFSET_XFORM;
        } else if (
          opcode === CMD_IMAGE &&
          (commandView.getUint8(byteOffset + CMD_IMAGE_OFFSET_FLAGS) &
              CMD_IMAGE_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_IMAGE_OFFSET_XFORM;
        } else if (
          opcode === CMD_SVG_PATH &&
          (commandView.getUint8(byteOffset + CMD_SVG_PATH_OFFSET_FLAGS) &
              CMD_SVG_PATH_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_SVG_PATH_OFFSET_XFORM;
        } else if (
          opcode === CMD_BOX_SHADOW &&
          (commandView.getUint8(byteOffset + CMD_BOX_SHADOW_OFFSET_FLAGS) &
              CMD_BOX_SHADOW_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_BOX_SHADOW_OFFSET_XFORM;
        }
        if (affineOffset !== null) {
          affine = Array.from({ length: 6 }, (_, index) => {
            const value = commandView.getFloat32(
              byteOffset + affineOffset + index * 4,
              true,
            );
            return index < 4 ? value : value / deviceScale;
          });
        }

        const activeGroups = compositingGroupStack.map(({ group }) => group);
        const activeOpacityGroups = activeGroups.filter((group) =>
          group.opacity !== undefined
        );
        const activeBlendGroup = activeGroups.findLast((group) =>
          group.blendMode !== undefined
        );
        const operation = {
          operationIndex: operations.length,
          commandIndex,
          kind: opcode === CMD_TEXT &&
              (textFlags & CMD_TEXT_FLAG_TEXT_SHADOW) !== 0
            ? "text-shadow"
            : COMMAND_NAMES.get(opcode),
          nodeIndex: currentNodeIndex,
          logicalRectangle,
          ...(textMetrics === null ? {} : textMetrics),
          affine,
          clipEntries: currentClipEntries,
          opacity: activeOpacityGroups.reduce(
            (opacity, group) => opacity * group.opacity,
            1,
          ),
          blendMode: activeBlendGroup?.blendMode ?? "normal",
          compositingGroupIdentifiers: activeGroups.map((group) =>
            group.identifier
          ),
          stackingContextIdentifiers: activeGroups
            .filter((group) => group.stackingContext)
            .map((group) => group.identifier),
        };
        if (lazyGlyphs !== null) {
          defineLazyGlyphs(operation, lazyGlyphs, deviceScale);
        }
        operations.push(operation);

        if (
          opcode === CMD_RECT || opcode === CMD_IMAGE ||
          opcode === CMD_SVG_PATH
        ) {
          boxes.push({
            kind: "shape",
            box: logicalRectangle,
            affine,
          });
        } else if (
          opcode === CMD_TEXT &&
          (textFlags & CMD_TEXT_FLAG_TEXT_SHADOW) === 0
        ) {
          boxes.push({
            kind: "text-run",
            box: logicalRectangle,
            affine,
          });
        }
      }
      byteOffset += commandByteSize(commandView, byteOffset);
    }
    // Clip pushes replace the complete raster state. A terminal state needs
    // no restoring pop because the command stream is discarded after replay.
    if (compositingGroupStack.length !== 0) {
      throw new Error("paint artifact: unclosed compositing group");
    }
    return {
      kind: "paint",
      viewport: { width: scene.width, height: scene.height },
      boxes,
      operations,
      compositingGroups,
    };
  }

  async function createDisplayListArtifact(scene) {
    const emitted = await runExclusiveEngineOperation(() =>
      emitSceneCommands(scene)
    );
    const commands = [];
    const groups = [];
    const clipStack = [];
    const groupStack = [];
    for (let byteOffset = 0; byteOffset < emitted.bytesWritten;) {
      const opcode = emitted.view.getUint8(byteOffset);
      const byteLength = commandByteSize(emitted.view, byteOffset);
      const commandIndex = commands.length;
      let clipEntries = null;
      if (opcode === CMD_PUSH_CLIP) {
        clipEntries = decodeClipEntries(emitted.view, byteOffset);
        clipStack.push(clipEntries);
      } else if (opcode === CMD_POP_CLIP) {
        if (clipStack.length === 0) {
          throw new Error("display-list artifact: clip stack underflow");
        }
        clipStack.pop();
      }
      if (GROUP_PAIRS.has(opcode)) {
        const group = {
          kind: COMMAND_NAMES.get(opcode).slice(5),
          startCommandIndex: commandIndex,
          endCommandIndex: null,
        };
        groups.push(group);
        groupStack.push({ group, popOpcode: GROUP_PAIRS.get(opcode) });
      } else if (
        groupStack.length > 0 &&
        opcode === groupStack[groupStack.length - 1].popOpcode
      ) {
        groupStack.pop().group.endCommandIndex = commandIndex;
      }
      commands.push({
        commandIndex,
        byteOffset,
        byteLength,
        opcode,
        name: COMMAND_NAMES.get(opcode),
        clipDepth: clipStack.length,
        groupDepth: groupStack.length,
        clipEntries,
        geometry: decodeCommandGeometry(emitted.view, byteOffset, opcode),
      });
      byteOffset += byteLength;
    }
    // A terminal clip state is valid; only a later unmatched pop is malformed.
    if (groupStack.length !== 0) {
      throw new Error("display-list artifact: unclosed group stack");
    }
    const value = {
      kind: "display-list",
      viewport: { width: scene.width, height: scene.height },
      commands,
      groups,
    };
    return freezeArtifactValue({
      ...value,
      bytes: new Uint8Array(
        emitted.view.buffer,
        emitted.view.byteOffset,
        emitted.bytesWritten,
      ),
    });
  }

  function createInvalidationArtifact(frame, tileSize = 64) {
    if (!Number.isInteger(tileSize) || tileSize <= 0) {
      throw new TypeError("tileSize must be a positive integer");
    }
    const columns = Math.ceil(frame.width / tileSize);
    const rows = Math.ceil(frame.height / tileSize);
    const tileMap = new Array(columns * rows).fill(false);
    const dirtyRectangles = (frame.dirtyRectangles ?? frame.dirtyRects ?? [])
      .map(
        (rectangle) => ({
          ...rectangle,
          reason: rectangle.reason ?? frame.invalidationReason ??
            (frame.frameSequence === 1
              ? "initial-render"
              : "render-state-change"),
        }),
      );
    for (const rectangle of dirtyRectangles) {
      const firstColumn = Math.floor(rectangle.x / tileSize);
      const lastColumn = Math.ceil((rectangle.x + rectangle.w) / tileSize);
      const firstRow = Math.floor(rectangle.y / tileSize);
      const lastRow = Math.ceil((rectangle.y + rectangle.h) / tileSize);
      for (let row = firstRow; row < lastRow; row++) {
        for (let column = firstColumn; column < lastColumn; column++) {
          if (row >= 0 && row < rows && column >= 0 && column < columns) {
            tileMap[row * columns + column] = true;
          }
        }
      }
    }
    const value = {
      kind: "invalidation",
      frameSequence: frame.frameSequence ?? null,
      viewport: { width: frame.width, height: frame.height },
      tileSize,
      columns,
      rows,
      tileMap,
      dirtyRectangles,
    };
    return freezeArtifactValue({ ...value, bytes: artifactBytes(value) });
  }


  // Pooled render contexts, keyed by canvas size.
  //
  // createRenderContext() builds a fresh WebGPU device, compiles every
  // shader module and rebuilds every pipeline and buffer pool. Measured:
  // 21.9 ms, against 14.0 ms for the render itself and 0.3 ms for the WAT
  // engine's whole layout+emit pass. Calling it per scene therefore threw
  // away more than half of every render's cost rebuilding state that never
  // changes — structurally the same per-call-setup mistake the Chrome
  // oracle had before it was pooled, one layer down.
  //
  // Keyed by size because a context owns a mainTexture and a readback ring
  // of exactly those dimensions. Reuse across scenes of the SAME size is
  // what the context was always built for — the video/stream paths already
  // drive one context across thousands of frames — and every render here
  // is non-incremental, so mainTexture is cleared on entry and nothing
  // carries over.
  //
  // Bounded LRU: a long run touches many scene sizes and each context pins
  // a device's worth of GPU memory. There is no context-level teardown, so
  // eviction destroys the device, which releases its textures, buffers and
  // pipelines together.
  const renderContexts = new Map(); // "WxH" -> { ctx, queue }; insertion order = LRU
  // 16, chosen by measurement, not by reasoning about working-set size.
  // The obvious argument says "size it above the real working set" — the
  // pixel sweep alone touches 28 (14 scene sizes x 2 densities) — but each
  // pooled context pins a whole WebGPU device, and holding many of them is
  // itself expensive. Measured on the same 26-file batch: cap 48 -> 29.0s,
  // cap 24 -> 18.9s, cap 16 -> 19.4s, cap 12 -> 18.9s, cap 8 -> 19.8s. The
  // curve is flat from 8 to 24 and falls off a cliff past it; 48 ran 50%
  // SLOWER than 12.
  //
  // Raising it does not help the sweep anyway: that test renders each size
  // about twice, so there is little to reuse no matter how much is retained
  // (16.4s before pooling, 16.1s after, at every cap tried). Its cost is
  // the box-parity pass and the 2x pass, not context setup — see
  // design/paint-coverage.md's oracle follow-up.
  const MAX_RENDER_CONTEXTS = 16;

  // Renders are SERIALIZED per context. Two concurrent renders sharing one
  // context would interleave on its uniform pools and instance buffer —
  // the exact hazard rasterize.js documents at its rect uniform pool, which
  // has already shipped twice there. Nothing in the tree renders
  // concurrently today (checked), so this costs nothing now and makes the
  // pool safe for the first caller who tries.
  async function withRenderContext(
    width,
    height,
    fn,
    graphicsBackend = "auto",
  ) {
    const key = `${width}x${height}:${graphicsBackend}`;
    let entry = renderContexts.get(key);
    if (entry) {
      renderContexts.delete(key); // refresh LRU position
    } else {
      entry = {
        ctx: await createRenderContext({
          width,
          height,
          graphicsBackend,
          sharedStateOwner: graphicsStateOwner,
        }),
        queue: Promise.resolve(),
      };
    }
    renderContexts.set(key, entry);

    while (renderContexts.size > MAX_RENDER_CONTEXTS) {
      const oldestKey = renderContexts.keys().next().value;
      if (oldestKey === key) break; // never evict the one we are about to use
      const evicted = renderContexts.get(oldestKey);
      renderContexts.delete(oldestKey);
      await evicted.queue; // let any queued render finish first
      await destroyRenderContext(evicted.ctx);
    }

    const run = entry.queue.then(() => fn(entry.ctx));
    // Keep the chain alive past a failing render, or one thrown error would
    // poison every later render through this context.
    entry.queue = run.then(() => {}, () => {});
    return run;
  }

  // A pooled context releases its per-context GPU resources; the shared
  // WebGPU device (rasterize.js createSharedWebgpuState) stays with this
  // runtime's graphicsStateOwner until releaseRenderContexts runs.
  async function destroyRenderContext(ctx) {
    await ctx.destroy();
  }

  // Drop every pooled context, then release the shared WebGPU device once
  // no live context references it. Nothing in the repo needs this today; it
  // exists so a long-lived embedder can reclaim GPU memory deliberately
  // rather than waiting for the process to exit.
  async function releaseRenderContexts() {
    for (const entry of renderContexts.values()) {
      await entry.queue;
      await destroyRenderContext(entry.ctx);
    }
    renderContexts.clear();
    await releaseSharedWebgpuStates(graphicsStateOwner);
    await releaseSharedWebgl2State(graphicsStateOwner);
    await shutdownDefaultGlyphResourceManager();
    for (const handle of imageResourceHandles.values()) {
      core.resourceRelease(handle);
    }
    imageResourceHandles.clear();
    for (const handle of canvasResourceHandles.values()) {
      core.resourceRelease(handle);
    }
    canvasResourceHandles.clear();
    currentTextBatch?.release();
    currentTextBatch = null;
    if (resourceEngineScope !== 0n) {
      core.resourceEngineRelease(resourceEngineScope);
    }
    resourceEngineScope = 0n;
  }
  async function renderScenePixels(scene, deviceScale = 1, renderOptions = {}) {
    try {
      return await renderScenePixelsNow(scene, deviceScale, renderOptions);
    } catch (error) {
      releaseRetainedPreparation(renderOptions.engineWriteOwner);
      engineWriteOwner = null;
      throw error;
    }
  }

  async function renderScenePixelsNow(
    scene,
    deviceScale = 1,
    renderOptions = {},
  ) {
    const {
      prepareEngine,
      renderContext,
      glyphResourceManager = getDefaultGlyphResourceManager(),
      changedNodeIndices = null,
      mutationNodeIndices: _mutationNodeIndices = null,
      forceGenerationNodeIndices = null,
      scrollOnlyNodeIndices = null,
      engineWriteOwner: renderWriteOwner = null,
      retainedPreparationAllowed = false,
      timeMilliseconds: _timeMilliseconds,
      capturePaintArtifact = false,
      captureTextGeometry = false,
      authoritativeDirtyTiles = false,
      graphicsBackend = "auto",
      resolveResource = null,
      onPerformance = null,
      layoutNodeCapacity = Infinity,
      // Visible-region rasterization (raster-scale plan, slice 3): the
      // CSS-pixel rectangle of the scene the raster target covers.
      // null covers the full scene. Layout and emission are unaffected;
      // the walker offsets and culls, and the target holds
      // visible size × deviceScale device pixels.
      visibleRectangle = null,
      ...rasterOptions
    } = renderOptions;
    const captureNodeMarkers = capturePaintArtifact || captureTextGeometry;
    validateLayoutNodeCapacity(layoutNodeCapacity);
    if (visibleRectangle !== null) {
      const { x, y, width, height } = visibleRectangle;
      if (
        !(width > 0) || !(height > 0) || !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        throw new RangeError(
          "visibleRectangle requires finite x/y and positive width/height",
        );
      }
    }
    const logicalTargetWidth = visibleRectangle?.width ?? scene.width;
    const logicalTargetHeight = visibleRectangle?.height ?? scene.height;
    if (!renderContext) {
      return await withRenderContext(
        logicalTargetWidth * deviceScale,
        logicalTargetHeight * deviceScale,
        (context) =>
          renderScenePixels(scene, deviceScale, {
            ...renderOptions,
            renderContext: context,
            glyphResourceManager,
            graphicsBackend,
          }),
        graphicsBackend,
      );
    }
    const renderWallStartedAt = performance.now();
    const previous = renderWriteOwner &&
      retainedPreparations.get(renderWriteOwner);
    const resourceRevision = core.status("resource_revision");
    const fontRevision = fontRegistry.revision;
    const changed = changedNodeIndices === null
      ? null
      : new Set(changedNodeIndices);
    for (const index of forceGenerationNodeIndices ?? []) changed?.add(index);
    for (const index of changed ?? []) {
      if (
        !Number.isInteger(index) || index < 0 || index >= scene.nodes.length
      ) {
        throw new RangeError(
          `Changed node index ${index} is outside a scene of ${scene.nodes.length} nodes`,
        );
      }
    }
    const provenanceMatches = scene.changedRows == null ||
      (scene.publicationRevision !== undefined &&
        (scene.publicationRevision === previous?.publicationRevision ||
          (scene.previousPublicationRevision !== undefined &&
            scene.previousPublicationRevision !== 0n &&
            scene.previousPublicationRevision ===
              previous?.publicationRevision)));
    let sparse = retainedPreparationAllowed && !!previous?.valid &&
      changed !== null && provenanceMatches &&
      engineWriteOwner === renderWriteOwner &&
      previous.writeClaim === engineWriteClaims.get(engine.memory) &&
      previous.coreWriteRevision === core.engineFrameRevision &&
      previous.nodes.length === scene.nodes.length &&
      previous.resourceRevision === resourceRevision &&
      previous.fontRevision === fontRevision &&
      previous.resolveResource === resolveResource &&
      previous.deviceScale === deviceScale &&
      previous.glyphResourceManager === glyphResourceManager &&
      previous.width === scene.width && previous.height === scene.height &&
      !capturePaintArtifact &&
      previous.captureNodeMarkers === captureNodeMarkers &&
      (!captureTextGeometry || previous.textGeometryArtifact !== null) &&
      (!scene.imageSources?.size ||
        previous.imageSources === scene.imageSources);
    if (previous) previous.valid = false;
    // The engine holds the previous preparation's rows under this owner's
    // claim. Two ways to avoid publishing every row again:
    // - sparse: the retained frame patches commands in place (background,
    //   opacity), no layout, no emission walk;
    // - patched: the changed rows are published as patches, then the frame
    //   lays out and emits in full. The layout is incremental by row
    //   generation and the emission walk is cheap; the full publication
    //   was the cost. Text rows are allowed (the write re-prepares text);
    //   rows that change the index space or a row's normalization are not.
    let patched = sparse && !previous.globalPreparation && changed.size > 0;
    let patchedTextRows = 0;
    if (sparse && changed.size) {
      if (previous.globalPreparation) sparse = false;
      for (const index of changed) {
        const node = scene.nodes[index];
        const old = previous.nodes[index];
        if (
          needsGlobalPreparation(node) || needsGlobalPreparation(old) ||
          (node.children?.length ?? 0) !== (old.children?.length ?? 0) ||
          node.children?.[0] !== old.children?.[0] ||
          (!usesCoreRecord(node) && node.children !== old.children)
        ) {
          sparse = false;
          patched = false;
          break;
        }
        if (node.display === "text" || old.display === "text") {
          sparse = false;
          if (node.display === "text") patchedTextRows++;
        }
      }
    }
    // Each patched text row re-prepares the whole text batch.
    if (patchedTextRows > 8) patched = false;
    let visitedNodeCount = 0;
    let nodes;
    let globalPreparation = previous?.globalPreparation ?? false;
    const resolveRows = async (rows) => {
      visitedNodeCount += rows.length;
      return await resolveImageIndices(
        resolveFontIndices(await resolveSvgPathIndices(rows)),
        resolveResource,
        scene.imageSources,
      );
    };
    const prepareFull = async () => {
      const used = resolveOrderModifiedChildren(
        resolveSvgUseNodes(scene.nodes),
      );
      nodes = await resolveRows(used);
      // Only a normalization that changes the row index space invalidates
      // every sparse delta. Unrelated grid/clip/transform nodes retain their
      // prepared inputs; actual layout drift is checked natively below.
      globalPreparation = used !== scene.nodes;
      const clipBoxes = provisionalClipLayout(scene, nodes, layoutNodeCapacity);
      if (clipBoxes) {
        nodes = await resolveClipPathIndices(nodes, clipBoxes, deviceScale);
      }
      visitedNodeCount += nodes.length;
      writeSceneNodesAndTileConfig(
        scene,
        nodes,
        null,
        layoutNodeCapacity,
        null,
        true,
        forceGenerationNodeIndices,
        null,
        false,
      );
    };
    if (sparse || patched) {
      const indices = [...changed];
      const resolved = await resolveRows(
        indices.map((index) => scene.nodes[index]),
      );
      // A synchronous query may run during resource resolution. Never publish
      // a sparse delta into somebody else's rows or relocated pool spans.
      const held = engineWriteOwner === renderWriteOwner &&
        previous.writeClaim === engineWriteClaims.get(engine.memory) &&
        previous.coreWriteRevision === core.engineFrameRevision &&
          resourceRevision === core.status("resource_revision") &&
        fontRevision === fontRegistry.revision;
      sparse &&= held;
      patched &&= held;
      if (held) {
        nodes = previous.nodes;
        for (let i = 0; i < indices.length; i++) {
          nodes[indices[i]] = resolved[i];
        }
      }
    }
    // Publish and index the allocated raster target, not the fractional
    // CSS-size × density request. CSS layout and raster scale stay unchanged.
    const pxW = renderContext.width;
    const pxH = renderContext.height;
    // The engine lays out in CSS pixels; deviceScale is a raster-time
    // scale (see buildBatches). $deviceScale is a persistent engine
    // global — reset it to 1 so a stream from an older caller cannot
    // leak a stale value into text shaping (opsz reads it).
    engine.exports.set_device_scale(1);
    engine.exports.clear_tile_dirty_map();
    engine.exports.set_paint_artifact_capture(captureNodeMarkers ? 1 : 0);
    engine.exports.set_retained_frame_enabled(
      renderWriteOwner !== null ? 1 : 0,
    );
    // A frame taking the serialization a synchronous layout getter produced
    // (render-surface's _takeSyncLayout) finds the engine already holding
    // those rows: the getter wrote them under this owner's claim and no
    // write happened since. Rows the surface restated after the getter ran
    // (scroll requests) and rows whose generation the surface forces are
    // published again as a patch; everything else stands.
    const reuseSyncLayoutWrite = async () => {
      const written = syncLayoutWrite;
      if (written === null) return false;
      syncLayoutWrite = null;
      const source = scene.syncLayoutSource ?? scene.nodes;
      if (
        written.sceneNodes !== source || written.owner !== renderWriteOwner ||
        written.width !== scene.width || written.height !== scene.height ||
        written.nodes.length !== scene.nodes.length
      ) return false;
      const patchIndices = new Set(scene.syncLayoutScrollIndices ?? []);
      for (const index of forceGenerationNodeIndices ?? []) {
        patchIndices.add(index);
      }
      const indices = [...patchIndices];
      const resolved = indices.length === 0 ? [] : await resolveRows(
        indices.map((index) => scene.nodes[index]),
      );
      // Resolution may await; a query or another frame may have written.
      if (
        engineWriteOwner !== renderWriteOwner ||
        written.writeClaim !== engineWriteClaims.get(engine.memory) ||
        written.coreWriteRevision !== core.engineFrameRevision ||
        written.resourceRevision !== core.status("resource_revision") ||
        written.fontRevision !== fontRegistry.revision
      ) return false;
      globalPreparation = written.globalPreparation;
      if (indices.length === 0) {
        nodes = written.nodes;
        return true;
      }
      nodes = written.nodes.slice();
      for (let i = 0; i < indices.length; i++) nodes[indices[i]] = resolved[i];
      visitedNodeCount += indices.length;
      // Rows are stamped as a full write would stamp them (no scroll-only
      // flag): pool drift is irrelevant to the full emission that follows,
      // only a rejected publication sends the frame back to a full write.
      return writeSceneNodesAndTileConfig(
        scene,
        nodes,
        patchIndices,
        layoutNodeCapacity,
        null,
        true,
        forceGenerationNodeIndices,
        null,
        true,
      ) !== null;
    };
    // One patch write serves both: the retained frame needs it with every
    // pool unchanged (true); the patched frame needs only an accepted
    // publication (not null), then lays out and emits in full.
    let rowsPatched = false;
    if (sparse || patched) {
      visitedNodeCount += changed.size;
      const written = writeSceneNodesAndTileConfig(
        scene,
        nodes,
        changed,
        layoutNodeCapacity,
        null,
        true,
        forceGenerationNodeIndices,
        null,
        true,
      );
      rowsPatched = written !== null;
      // The rows the patch left alone still retain the publication they
      // were lowered from; move them to this build's publication so the
      // older ones can be freed (one publication per build otherwise
      // accumulates until the next full write).
      if (
        rowsPatched &&
        scene.publicationRevision !== previous.publicationRevision
      ) {
        const publication = scene.nodes.find((node) =>
          node._corePublication !== undefined
        )?._corePublication;
        if (publication !== undefined) {
          core.status("engine_direct_rebase", publication.handle);
        }
      }
      sparse &&= written === true;
      if (sparse) {
        sparse = engine.exports.retained_frame_begin(
          nodes.length,
          scene.width,
          scene.height,
        ) === 1;
        if (sparse) {
          for (const index of changed) {
            if (engine.exports.retained_frame_validate_node(index) !== 1) {
              sparse = false;
              break;
            }
          }
        }
      }
    }
    if (!sparse && !rowsPatched && !(await reuseSyncLayoutWrite())) {
      await prepareFull();
    }
    // Resource resolution can run synchronous layout queries while awaited.
    // Restore this frame's native modes after that shared-engine boundary.
    engine.exports.set_device_scale(1);
    engine.exports.set_paint_artifact_capture(captureNodeMarkers ? 1 : 0);
    engine.exports.set_retained_frame_enabled(
      renderWriteOwner !== null ? 1 : 0,
    );
    engineWriteOwner = renderWriteOwner;
    const preparation =
      prepareEngine?.({ engine, view, nodes, physicalScene: scene }) ?? {};
    // Publication restores authored values. Sample animations before comparing
    // their paint values with the previous frame's sampled command state.
    if (sparse) {
      for (const index of changed) {
        if (engine.exports.retained_frame_node(index) !== 1) {
          sparse = false;
          break;
        }
      }
    }
    let bytes = sparse ? engine.exports.retained_frame_end() : -1;
    const retainedCommands = bytes >= 0;
    if (!retainedCommands) bytes = engine.exports.emit_commands(nodes.length);
    const commandRevision = engine.exports.command_revision();
    const layoutRevision = engine.exports.layout_revision();
    const writeClaim = engineWriteClaims.get(engine.memory);
    const coreWriteRevision = core.engineFrameRevision;
    const preparedResourceRevision = core.status("resource_revision");
    const preparedFontRevision = fontRegistry.revision;
    const ranges = retainedCommands
      ? Array.from(
        { length: engine.exports.retained_command_changes_count() },
        (_, index) => ({
          offset: engine.exports.retained_command_change_offset(index),
          byteLength: engine.exports.retained_command_change_size(index),
        }),
      )
      : null;
    const rasterResourceRevision = retainedCommands
      ? previous.rasterResourceRevision
      : {};
    rasterOptions.commandRetention = renderWriteOwner === null ? null : {
      owner: renderWriteOwner,
      revision: commandRevision,
      baseRevision: retainedCommands ? previous.commandRevision : null,
      ranges,
      resourceRevision: rasterResourceRevision,
    };
    if (retainedCommands && rasterOptions.dirtyTiles === undefined) {
      rasterOptions.dirtyTiles = new Uint8Array(
        Math.ceil(pxW / 64) * Math.ceil(pxH / 64),
      );
    }
    if (rasterOptions.dirtyTiles && !authoritativeDirtyTiles) {
      // The engine's dirty map covers 64-CSS-px tiles over the logical
      // scene; the raster grid covers 64-device-px tiles over the
      // physical target (the visible region at the raster scale).
      // Convert each dirty logical tile into the physical tiles its
      // scaled, origin-shifted rectangle covers.
      const damageMeasurement = globalThis[domMeasurementKey];
      const damageStart = damageMeasurement ? performance.now() : 0;
      const combinedDirtyTiles = rasterOptions.dirtyTiles.slice();
      const dirtyMapAddress = engine.exports.tile_dirty_map_base();
      const logicalColumns = Math.ceil(scene.width / 64);
      const logicalRows = Math.ceil(scene.height / 64);
      const physicalColumns = Math.ceil(pxW / 64);
      const physicalRows = Math.ceil(pxH / 64);
      const originDeviceX = (visibleRectangle?.x ?? 0) * deviceScale;
      const originDeviceY = (visibleRectangle?.y ?? 0) * deviceScale;
      const identityGrid = deviceScale === 1 && originDeviceX === 0 &&
        originDeviceY === 0;
      for (let index = 0; index < logicalColumns * logicalRows; index++) {
        const byte = view.getUint8(dirtyMapAddress + (index >>> 3));
        if (!(byte & (1 << (index & 7)))) continue;
        if (identityGrid) {
          if (index < combinedDirtyTiles.length) combinedDirtyTiles[index] = 1;
          continue;
        }
        const logicalColumn = index % logicalColumns;
        const logicalRow = (index / logicalColumns) | 0;
        const deviceLeft = logicalColumn * 64 * deviceScale - originDeviceX;
        const deviceRight = (logicalColumn + 1) * 64 * deviceScale -
          originDeviceX;
        const deviceTop = logicalRow * 64 * deviceScale - originDeviceY;
        const deviceBottom = (logicalRow + 1) * 64 * deviceScale -
          originDeviceY;
        if (deviceRight <= 0 || deviceBottom <= 0) continue;
        const firstColumn = Math.max(0, Math.floor(deviceLeft / 64));
        const lastColumn = Math.min(
          physicalColumns - 1,
          Math.ceil(deviceRight / 64) - 1,
        );
        const firstRow = Math.max(0, Math.floor(deviceTop / 64));
        const lastRow = Math.min(
          physicalRows - 1,
          Math.ceil(deviceBottom / 64) - 1,
        );
        for (let row = firstRow; row <= lastRow; row++) {
          for (let column = firstColumn; column <= lastColumn; column++) {
            const physicalIndex = row * physicalColumns + column;
            if (physicalIndex < combinedDirtyTiles.length) {
              combinedDirtyTiles[physicalIndex] = 1;
            }
          }
        }
      }
      if (damageMeasurement) {
        damageMeasurement.record({
          category: "damage",
          operation: "dirty-tiles.merge",
          direction: "engine-to-host",
          bytes: logicalColumns * logicalRows,
          allocations: 1,
          allocationBytes: combinedDirtyTiles.byteLength,
          milliseconds: performance.now() - damageStart,
        });
      }
      rasterOptions.dirtyTiles = combinedDirtyTiles;
    }
    // Geometry capture needs owned text runs only on a full frame. Certified
    // paint-only replay keeps the immutable geometry artifact, so neither
    // text run copying nor command decoding repeats during animation.
    const frameTextRuns = captureNodeMarkers && !retainedCommands
      ? currentTextBatch.copyRuns()
      : [];
    const inspection = preparation.inspect?.();
    // FRAME SNAPSHOT — the frame owns its bytes. A synchronous layout
    // getter (getBoundingClientRect → layoutTreeBoxesSync →
    // emitSceneCommandsSync) can barge into the SHARED engine while this
    // render is parked at an await below; it re-emits the command,
    // glyph, gradient-stop, and scroll buffers for a DIFFERENT scene.
    // The promise chain (runExclusiveEngineOperation) cannot serialize a
    // synchronous caller, so live views over engine memory across awaits
    // are corrupted frames waiting to happen (found via react_select:
    // createPaintArtifact walked another emit's marker-free stream).
    // Copy everything the rest of this frame reads, before ANY await.
    const cmdView = retainedCommands ? previous.cmdView : new DataView(
      engine.memory.buffer.slice(
        COMMAND_BUFFER_BASE,
        COMMAND_BUFFER_BASE + bytes,
      ),
    );
    if (retainedCommands) {
      const commandBytes = new Uint8Array(
        cmdView.buffer,
        cmdView.byteOffset,
        cmdView.byteLength,
      );
      for (const range of ranges) {
        commandBytes.set(
          engine.bytes.subarray(
            COMMAND_BUFFER_BASE + range.offset,
            COMMAND_BUFFER_BASE + range.offset + range.byteLength,
          ),
          range.offset,
        );
      }
    }
    const gradientStopPool = retainedCommands
      ? previous.gradientStopPool
      : new DataView(
        engine.memory.buffer.slice(
          GRADIENT_STOP_POOL_BASE,
          GRADIENT_STOP_POOL_BASE + GRADIENT_STOP_POOL_SIZE,
        ),
      );
    const scrollTable = retainedCommands
      ? previous.scrollTable
      : new Float32Array(
        engine.memory.buffer.slice(
          scrollTableBase,
          scrollTableBase + scrollTableSize,
        ),
      );
    // The layout boxes too: a render orphaned by a rejected Promise.all
    // (the Chrome side of a two-backend comparison failing first) keeps
    // running and re-lays-out ITS scene into the computed-box buffer
    // while this frame rasterizes, so a box read after the raster await
    // returned another scene's rectangle at the same node index.
    // Boxes are CSS px natively (the engine lays out in CSS pixels).
    // Full records (content box, effective scroll offsets, scroll ranges,
    // sticky) so the render surface can treat these as the effective-state
    // source of truth.
    const retainedBoxes = retainedCommands &&
      layoutRevision === previous.layoutRevision;
    const boxes = retainedBoxes
      ? retainBoxSnapshot(previous.boxes)
      : readSceneBoxes({ nodes });
    // Generate glyph atlases on the CPU for every raster backend. The WebGPU
    // atlas generator is not cross-browser safe: Chrome produced empty atlases,
    // Firefox produced partial atlases, and Safari produced complete atlases.
    if (!retainedCommands) releaseRetainedPreparation(renderWriteOwner);
    const textResources = retainedCommands
      ? previous.textResources
      : await buildTextRenderResources(
        cmdView,
        bytes,
        deviceScale,
        glyphResourceManager,
        { kind: "cpu" },
      );
    const { atlases, glyphBuffer, glyphLease } = textResources;
    const glyphPerformance = retainedCommands
      ? {
        ...textResources.glyphPerformance,
        cacheHitGlyphCount: textResources.glyphPerformance.requestedGlyphCount,
        generatedGlyphCount: 0,
        outputTexelCount: 0,
        generatedGlyphs: [],
        generationBackend: "cache-reuse",
        directAtlasPopulation: false,
        phaseMilliseconds: emptyGlyphPhaseMilliseconds(),
        totalMilliseconds: 0,
      }
      : textResources.glyphPerformance;
    let svgPathAtlas;
    let paintArtifact = null;
    let textGeometryArtifact = null;
    let rasterMilliseconds = 0;
    let result;
    try {
      const rasterStartedAt = performance.now();
      // The command stream is CSS px natively; the paint artifact's
      // logical rectangles need no division.
      const capturedArtifact = capturePaintArtifact ||
          (captureTextGeometry && !retainedCommands)
        ? createPaintArtifact(
          cmdView,
          bytes,
          scene,
          nodes,
          1,
          glyphBuffer,
          frameTextRuns,
        )
        : null;
      paintArtifact = capturePaintArtifact ? capturedArtifact : null;
      if (captureTextGeometry) {
        if (retainedCommands) {
          textGeometryArtifact = previous.textGeometryArtifact;
        } else {
          const operations = [];
          for (const operation of capturedArtifact.operations) {
            if (operation.kind !== "text") continue;
            // Geometry deliberately has no opacity/blend inspection fields:
            // those may change while these owned glyph/rectangle facts do not.
            operations.push(Object.freeze({
              kind: "text",
              nodeIndex: operation.nodeIndex,
              logicalRectangle: Object.freeze({
                ...operation.logicalRectangle,
              }),
              affine: operation.affine === null
                ? null
                : Object.freeze([...operation.affine]),
              glyphCount: operation.glyphCount,
              glyphs: operation.glyphs,
            }));
          }
          textGeometryArtifact = Object.freeze({
            kind: "text-geometry",
            operations: Object.freeze(operations),
          });
        }
      }
      const images = buildImageRenderResources();
      svgPathAtlas = retainedCommands
        ? previous.svgPathAtlas
        : await buildSvgPathRenderResources(
          cmdView,
          bytes,
          deviceScale,
        );
      // gradientStopPool and scrollTable come from the frame snapshot
      // above — readRect (rasterize.js) and the CMD_SET_SCROLL walker
      // read them as options, never engine memory directly.
      result = renderContext
        ? await render(renderContext, cmdView, bytes, {
          background: RENDER_BG,
          atlases,
          glyphBuffer,
          images,
          svgPathAtlas,
          gradientStopPool,
          scrollTable,
          deviceScale,
          visibleRectangle,
          glyphPerformance,
          ...rasterOptions,
        })
        : await withRenderContext(
          pxW,
          pxH,
          (context) =>
            render(context, cmdView, bytes, {
              background: RENDER_BG,
              atlases,
              glyphBuffer,
              images,
              svgPathAtlas,
              gradientStopPool,
              scrollTable,
              deviceScale,
              visibleRectangle,
              glyphPerformance,
              ...rasterOptions,
            }),
          graphicsBackend,
        );
      rasterMilliseconds = performance.now() - rasterStartedAt;
    } finally {
      if (!retainedCommands && (!result || renderWriteOwner === null)) {
        glyphLease.release();
      }
      if (!result) releaseBoxSnapshot(boxes);
      try {
        preparation.cleanup?.();
      } catch (error) {
        if (!retainedCommands && result && renderWriteOwner !== null) {
          glyphLease.release();
        }
        if (result) releaseBoxSnapshot(boxes);
        throw error;
      }
    }
    if (renderWriteOwner !== null) {
      // Keep the independently copied request atlases, not source-revision
      // pins: another surface must be able to acquire newly needed glyphs
      // while this surface is idle with a retained command snapshot.
      glyphLease.releaseSourcePins();
      if (!retainedBoxes) {
        for (const box of boxes) if (box) Object.freeze(box);
        Object.freeze(boxes);
      }
      if (retainedCommands && !retainedBoxes) {
        releaseBoxSnapshot(previous.boxes);
      }
      retainedPreparations.set(renderWriteOwner, {
        valid: writeClaim === engineWriteClaims.get(engine.memory) &&
          engineWriteOwner === renderWriteOwner &&
          coreWriteRevision === core.engineFrameRevision &&
          preparedResourceRevision ===
            core.status("resource_revision") &&
          preparedFontRevision === fontRegistry.revision,
        nodes: retainedCommands ? nodes : nodes.slice(),
        boxes: retainedBoxes ? boxes : retainBoxSnapshot(boxes),
        textResources,
        svgPathAtlas,
        cmdView,
        gradientStopPool,
        scrollTable,
        captureNodeMarkers,
        textGeometryArtifact,
        commandRevision,
        layoutRevision,
        rasterResourceRevision,
        resourceRevision: preparedResourceRevision,
        fontRevision: preparedFontRevision,
        resolveResource,
        deviceScale,
        glyphResourceManager,
        coreWriteRevision,
        width: scene.width,
        height: scene.height,
        writeClaim,
        publicationRevision: scene.publicationRevision,
        imageSources: scene.imageSources,
        globalPreparation,
      });
    }
    // Copy the readback so the context-owned ring/persistent buffer can be
    // reused by the next frame while the caller holds this one.
    const pixels = result.pixels ? new Float32Array(result.pixels) : null;
    // The shared manager retains the unpinned revision for other rendering APIs.
    // The pixel buffer is at physical resolution; boxes were read before
    // the raster await above.
    const phaseMilliseconds = Object.freeze({
      ...glyphPerformance.phaseMilliseconds,
    });
    const glyphPerformanceRecord = Object.freeze({
      requestedGlyphCount: glyphPerformance.requestedGlyphCount,
      cacheHitGlyphCount: glyphPerformance.cacheHitGlyphCount,
      generatedGlyphCount: glyphPerformance.generatedGlyphCount,
      outputTexelCount: glyphPerformance.outputTexelCount,
      generatedGlyphs: Object.freeze(
        glyphPerformance.generatedGlyphs.map((glyph) => Object.freeze(glyph)),
      ),
      generationBackend: glyphPerformance.generationBackend,
      directAtlasPopulation: glyphPerformance.directAtlasPopulation,
      phaseMilliseconds,
      totalMilliseconds: Object.values(phaseMilliseconds).reduce(
        (total, milliseconds) => total + milliseconds,
        0,
      ),
    });
    const performanceRecord = Object.freeze({
      glyphs: glyphPerformanceRecord,
      preparation: Object.freeze({
        visitedNodeCount,
        decodedBoxCount: retainedBoxes ? 0 : nodes.length,
        retained: retainedCommands,
      }),
      rasterPreparation: result.rasterPreparation,
      rasterMilliseconds,
      wallMilliseconds: performance.now() - renderWallStartedAt,
    });
    if (onPerformance !== null) onPerformance(performanceRecord);
    // The result IS the working ImageDescriptor (float32 rgba in the mode's
    // working encoding, premultiplied - see rasterize.js's
    // workingRenderResult) plus boxes, performance, and dirty tracking.
    // readback: "none" returns the direct textureImage instead.
    return {
      ...(pixels
        ? {
          pixels,
          rowStride: result.rowStride,
          channelLayout: result.channelLayout,
          sampleType: result.sampleType,
          bitsPerSample: result.bitsPerSample,
          colorEncoding: result.colorEncoding,
          alphaMode: result.alphaMode,
          metadata: result.metadata,
        }
        : {
          device: result.device,
          textureImage: result.textureImage,
        }),
      graphicsBackend: renderContext.kind,
      graphicsBackendInfo: renderContext.backendInfo,
      boxes,
      ...(paintArtifact ? { paintArtifact } : {}),
      ...(textGeometryArtifact ? { textGeometryArtifact } : {}),
      performance: performanceRecord,
      width: pxW,
      height: pxH,
      deviceScale,
      dirtyRects: result.dirtyRects,
      readbackByteLength: result.readbackByteLength,
    };
  }

  const ANIMATION_PROPERTY_SCENE_FIELDS = Object.freeze({
    width: "width",
    "min-width": "minWidth",
    "max-width": "maxWidth",
    height: "height",
    "min-height": "minHeight",
    "max-height": "maxHeight",
    left: "left",
    right: "right",
    top: "top",
    bottom: "bottom",
    "flex-basis": "flexBasis",
  });

  function sceneAnimationLengthPercentage(value, propertyName) {
    if (typeof value === "number") {
      return { kind: "lengthPercentage", pixels: value, percentage: 0 };
    }
    if (typeof value === "string" && value.endsWith("%")) {
      return {
        kind: "lengthPercentage",
        pixels: 0,
        percentage: Number.parseFloat(value) / 100,
      };
    }
    if (
      value && typeof value === "object" &&
      Number.isFinite(value.pixels) && Number.isFinite(value.percentage)
    ) {
      return {
        kind: "lengthPercentage",
        pixels: value.pixels,
        percentage: value.percentage,
      };
    }
    const initial = {
      width: "auto",
      "min-width": "zero",
      "max-width": "none",
      height: "auto",
      "min-height": "zero",
      "max-height": "none",
      left: "auto",
      right: "auto",
      top: "auto",
      bottom: "auto",
      "flex-basis": "auto",
    }[propertyName];
    return { kind: "keyword", keyword: value ?? initial };
  }

  // The animation-facing value of a property in an engine record (a
  // DOM-backed box: the engine's record before this frame, or the core's
  // record for it), in the shapes animationValueForSceneNode produces.
  const ANIMATION_PROPERTY_RECORD_SIZES = Object.freeze({
    width: [
      LAYOUT_NODE_OFFSET_WIDTH_TAG,
      LAYOUT_NODE_OFFSET_WIDTH,
      LAYOUT_NODE_OFFSET_WIDTH_PERCENT,
    ],
    "min-width": [
      LAYOUT_NODE_OFFSET_MIN_W_TAG,
      LAYOUT_NODE_OFFSET_MIN_WIDTH,
      LAYOUT_NODE_OFFSET_MIN_WIDTH_PERCENT,
    ],
    "max-width": [
      LAYOUT_NODE_OFFSET_MAX_W_TAG,
      LAYOUT_NODE_OFFSET_MAX_WIDTH,
      LAYOUT_NODE_OFFSET_MAX_WIDTH_PERCENT,
    ],
    height: [
      LAYOUT_NODE_OFFSET_HEIGHT_TAG,
      LAYOUT_NODE_OFFSET_HEIGHT,
      LAYOUT_NODE_OFFSET_HEIGHT_PERCENT,
    ],
    "min-height": [
      LAYOUT_NODE_OFFSET_MIN_H_TAG,
      LAYOUT_NODE_OFFSET_MIN_HEIGHT,
      LAYOUT_NODE_OFFSET_MIN_HEIGHT_PERCENT,
    ],
    "max-height": [
      LAYOUT_NODE_OFFSET_MAX_H_TAG,
      LAYOUT_NODE_OFFSET_MAX_HEIGHT,
      LAYOUT_NODE_OFFSET_MAX_HEIGHT_PERCENT,
    ],
    left: [
      LAYOUT_NODE_OFFSET_INSET_LEFT_TAG,
      LAYOUT_NODE_OFFSET_INSET_LEFT,
      LAYOUT_NODE_OFFSET_INSET_LEFT_PERCENT,
    ],
    right: [
      LAYOUT_NODE_OFFSET_INSET_RIGHT_TAG,
      LAYOUT_NODE_OFFSET_INSET_RIGHT,
      LAYOUT_NODE_OFFSET_INSET_RIGHT_PERCENT,
    ],
    top: [
      LAYOUT_NODE_OFFSET_INSET_TOP_TAG,
      LAYOUT_NODE_OFFSET_INSET_TOP,
      LAYOUT_NODE_OFFSET_INSET_TOP_PERCENT,
    ],
    bottom: [
      LAYOUT_NODE_OFFSET_INSET_BOTTOM_TAG,
      LAYOUT_NODE_OFFSET_INSET_BOTTOM,
      LAYOUT_NODE_OFFSET_INSET_BOTTOM_PERCENT,
    ],
    "flex-basis": [
      LAYOUT_NODE_OFFSET_FLEX_BASIS_TAG,
      LAYOUT_NODE_OFFSET_FLEX_BASIS,
      LAYOUT_NODE_OFFSET_FLEX_BASIS_PERCENT,
    ],
  });
  function animationValueForRecord(bytes, recordView, base, propertyName, box) {
    const sizeField = ANIMATION_PROPERTY_RECORD_SIZES[propertyName];
    if (sizeField !== undefined) {
      const [tagOffset, valueOffset, percentOffset] = sizeField;
      const tag = bytes[base + tagOffset];
      const value = recordView.getFloat32(base + valueOffset, true);
      if (tag === SIZE_TAG_LENGTH) {
        return sceneAnimationLengthPercentage(value, propertyName);
      }
      if (tag === SIZE_TAG_PERCENT) {
        return sceneAnimationLengthPercentage(`${value}%`, propertyName);
      }
      if (tag === SIZE_TAG_CALC_PAIR) {
        return sceneAnimationLengthPercentage(
          {
            pixels: value,
            percentage: recordView.getFloat32(base + percentOffset, true),
          },
          propertyName,
        );
      }
      if (tag === SIZE_TAG_MIN_CONTENT) {
        return { kind: "keyword", keyword: "min-content" };
      }
      if (tag === SIZE_TAG_MAX_CONTENT) {
        return { kind: "keyword", keyword: "max-content" };
      }
      return sceneAnimationLengthPercentage(undefined, propertyName);
    }
    if (propertyName === "opacity") {
      return {
        kind: "scalar",
        value: recordView.getFloat32(base + LAYOUT_NODE_OFFSET_OPACITY, true),
      };
    }
    if (propertyName === "background-color") {
      const value = [];
      for (let k = 0; k < 4; k++) {
        value.push(
          recordView.getFloat32(
            base + LAYOUT_NODE_OFFSET_BG_COLOR + k * 4,
            true,
          ),
        );
      }
      return { kind: "color", value };
    }
    if (propertyName === "visibility") {
      return {
        kind: "keyword",
        keyword: bytes[base + LAYOUT_NODE_OFFSET_VISIBILITY_HIDDEN] === 1
          ? "hidden"
          : "visible",
      };
    }
    if (propertyName === "transform") {
      // The record folds the function list into one affine, which CSS
      // cannot interpolate component-wise. A serialization that carries the
      // CSS form is read through animationValueForSceneNode instead; this
      // is the endpoint of last resort, for a node whose previous
      // serialization predates its transition declaration.
      return {
        kind: "transform",
        components: [{
          kind: "matrix",
          value: recordCssTransform(bytes, recordView, base, box),
        }],
      };
    }
    throw new TypeError(
      `Cannot animate unsupported property "${propertyName}"`,
    );
  }

  // A record's transform in the engine's resolved form (engine.wat
  // $resolveCssTransform): the box-linear translation applied for the box's
  // size and the list folded around transform-origin.
  function recordCssTransform(bytes, recordView, base, box) {
    const f32 = (offset) => recordView.getFloat32(base + offset, true);
    const [a, b, c, d] = [0, 4, 8, 12].map((k) =>
      f32(LAYOUT_NODE_OFFSET_TRANSFORM + k)
    );
    let e = f32(LAYOUT_NODE_OFFSET_TRANSFORM + 16);
    let f = f32(LAYOUT_NODE_OFFSET_TRANSFORM + 20);
    if (
      bytes[base + LAYOUT_NODE_OFFSET_TRANSFORM_KIND] ===
        TRANSFORM_KIND_RESOLVED
    ) {
      return [a, b, c, d, e, f];
    }
    const w = box?.w ?? 0;
    const h = box?.h ?? 0;
    e += f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT) * w +
      f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT + 4) * h;
    f += f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT + 8) * w +
      f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT + 12) * h;
    const dx = f32(LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X) +
      (f32(LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT) - 0.5) * w;
    const dy = f32(LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y) +
      (f32(LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT) - 0.5) * h;
    return [a, b, c, d, e + dx - (a * dx + c * dy), f + dy - (b * dx + d * dy)];
  }

  function animationValueForSceneNode(node, propertyName) {
    if (propertyName in ANIMATION_PROPERTY_SCENE_FIELDS) {
      return sceneAnimationLengthPercentage(
        node[ANIMATION_PROPERTY_SCENE_FIELDS[propertyName]],
        propertyName,
      );
    }
    if (propertyName === "opacity") {
      return { kind: "scalar", value: node.opacity ?? 1 };
    }
    if (propertyName === "background-color") {
      const color = node.bg ?? { r: 0, g: 0, b: 0, a: 0 };
      return { kind: "color", value: [color.r, color.g, color.b, color.a] };
    }
    if (propertyName === "visibility") {
      return { kind: "keyword", keyword: node.visibility ?? "visible" };
    }
    if (propertyName === "transform") {
      // CSS Transforms: `none` is the identity for interpolation, i.e. an
      // empty function list the other endpoint's identity functions pad out
      // (engine.wat $animationSampleTransform) — not a matrix() function,
      // which would force the mismatched-list decomposition fallback and
      // turn a rotation into a chord.
      const transform = node.transform;
      return {
        kind: "transform",
        components: transform?.cssText === "none"
          ? []
          : transform?.components ?? [],
      };
    }
    throw new TypeError(
      `Cannot animate unsupported property "${propertyName}"`,
    );
  }

  async function createPersistentSceneRenderer(options) {
    const {
      graphicsDevice: selectedGraphicsDevice = graphicsDevice,
      ...rendererOptions
    } = options;
    const isolatedCore = new DomCore();
    const isolatedFonts = createFontRegistry({
      core: isolatedCore,
      sourceRegistry: fontRegistry,
    });
    let isolatedRuntime;
    try {
      isolatedRuntime = await createSceneRendererRuntime({
        core: isolatedCore,
        harfbuzzBytes,
        msdfgenBytes,
        fontRegistry: isolatedFonts,
        codecRuntime,
        graphicsDevice: selectedGraphicsDevice,
      });
      const renderer = await isolatedRuntime.createSceneRendererForCurrentModule(
        rendererOptions,
      );
      return Object.freeze({
        ...renderer,
        async shutdown() {
          try {
            await renderer.shutdown();
            await isolatedRuntime.releaseRenderContexts();
          } finally {
            isolatedFonts.dispose();
          }
        },
      });
    } catch (error) {
      try {
        await isolatedRuntime?.releaseRenderContexts();
      } finally {
        isolatedFonts.dispose();
      }
      throw error;
    }
  }

  function sceneNodeSignature(node) {
    // Plain JSON: a node carries no BigInt (a native SVG request's uint64
    // identity is serialized as its decimal string), and a replacer call
    // per key was a measurable share of the frame.
    return JSON.stringify(node);
  }

  async function createSceneRendererForCurrentModule({
    width,
    height,
    deviceScale = 1,
    graphicsBackend = "auto",
    graphicsDevice: selectedGraphicsDevice = graphicsDevice,
    renderMode = undefined,
    renderPrecision = undefined,
    glyphResourceManager = getDefaultGlyphResourceManager(),
    layoutNodeCapacity = Infinity,
  }) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
    if (
      selectedGraphicsDevice !== null &&
      (typeof selectedGraphicsDevice?.createBuffer !== "function" ||
        typeof selectedGraphicsDevice?.queue?.submit !== "function")
    ) {
      throw new TypeError("graphicsDevice must be a GPUDevice");
    }
    const rendererGraphicsStateOwner = selectedGraphicsDevice === graphicsDevice
      ? graphicsStateOwner
      : { webgpuDevice: selectedGraphicsDevice };
    // Visible-region rasterization: the CSS-px rectangle of the scene
    // the raster target covers; null covers the full scene. Owned here
    // because the render context's physical size follows it.
    let visibleRectangle = null;
    let physicalWidth = width * deviceScale;
    let physicalHeight = height * deviceScale;
    async function rebuildContext() {
      physicalWidth = (visibleRectangle?.width ?? width) * deviceScale;
      physicalHeight = (visibleRectangle?.height ?? height) * deviceScale;
      context = await createRenderContext({
        width: physicalWidth,
        height: physicalHeight,
        graphicsBackend,
        sharedStateOwner: rendererGraphicsStateOwner,
        ...(renderMode !== undefined ? { renderMode } : {}),
        ...(renderPrecision !== undefined ? { renderPrecision } : {}),
      });
    }
    let context = await createRenderContext({
      width: physicalWidth,
      height: physicalHeight,
      graphicsBackend,
      sharedStateOwner: rendererGraphicsStateOwner,
      ...(renderMode !== undefined ? { renderMode } : {}),
      ...(renderPrecision !== undefined ? { renderPrecision } : {}),
    });
    let shutDown = false;
    let previousNodeSignatures = null;
    let previousStyleGeneration = 0;
    let previousSceneNodes = null;
    let previousPublicationRevision;
    let previousBoxes = null;
    let automaticTransitionsActive = false;
    let previousRenderTime = null;
    const animationEventListeners = new Set();
    const animations = createAnimationController(engine, {
      onEvent(event) {
        for (const listener of animationEventListeners) listener(event);
      },
    });
    function renderFrame(scene, renderOptions, readback) {
      // Serialize renders across every renderer sharing this runtime's
      // engine (see engineRenderChain above).
      return runExclusiveEngineOperation(() =>
        renderFrameNow(scene, renderOptions, readback)
      );
    }
    async function renderFrameNow(scene, renderOptions, readback) {
      if (shutDown) throw new Error("persistent scene renderer is shut down");
      acquireEngineAnimations(animations);
      if (scene.width !== width || scene.height !== height) {
        throw new RangeError(
          `persistent scene renderer expected ${width}x${height}, got ${scene.width}x${scene.height}`,
        );
      }
      // A caller that KNOWS which nodes changed (the render surface's
      // scroll-only frames declare the scrolled node indices) skips the
      // change detection; only the declared nodes' signatures refresh so
      // the next undeclared frame diffs correctly. Scroll offsets never
      // change ancestor layout, so ancestor refresh is skipped too.
      //
      // A DOM-backed scene carries its publication's changed row list: a
      // row absent from it has an engine record byte-identical to the
      // previous publication's at the same index, and every host-side
      // input (resources, scroll requests, text, structure) reaches the
      // renderer through the mutation set or the record. That list is the
      // change set; no JSON signature is built. A hand-authored scene keeps
      // the signature diff.
      const declared = renderOptions.declaredChangedNodeIndices ?? null;
      const lowered = scene.changedRows == null
        ? null
        : scene.publicationRevision !== undefined &&
            scene.publicationRevision === previousPublicationRevision
        ? []
        : scene.changedRows;
      const havePrevious = lowered !== null
        ? previousSceneNodes !== null
        : previousNodeSignatures !== null;
      let changedNodeIndices;
      if (declared !== null && havePrevious) {
        changedNodeIndices = new Set(declared);
        if (lowered === null) {
          for (const index of declared) {
            previousNodeSignatures[index] = sceneNodeSignature(
              scene.nodes[index],
            );
          }
        }
      } else {
        if (lowered !== null) {
          changedNodeIndices = havePrevious ? new Set(lowered) : null;
        } else {
          const nextNodeSignatures = scene.nodes.map(sceneNodeSignature);
          changedNodeIndices = havePrevious
            ? new Set(
              nextNodeSignatures.flatMap((signature, index) =>
                signature === previousNodeSignatures[index] ? [] : [index]
              ),
            )
            : null;
          previousNodeSignatures = nextNodeSignatures;
          // A DOM-backed box's style lives in the core, outside its
          // signature: a style generation change refreshes every core-written
          // node (write-if-changed keeps the unchanged ones' generations).
          const styleGeneration = scene.styleGeneration ?? 0;
          if (
            changedNodeIndices !== null &&
            styleGeneration !== previousStyleGeneration
          ) {
            for (let index = 0; index < scene.nodes.length; index++) {
              if (usesCoreRecord(scene.nodes[index])) {
                changedNodeIndices.add(index);
              }
            }
          }
          previousStyleGeneration = styleGeneration;
        }
      }
      const mutationNodeIndices = renderOptions.mutationNodeIndices ?? null;
      if (changedNodeIndices !== null && mutationNodeIndices?.size) {
        for (const mutationNodeIndex of mutationNodeIndices) {
          if (mutationNodeIndex >= scene.nodes.length) {
            throw new RangeError(
              `Mutation node index ${mutationNodeIndex} is outside a scene of ${scene.nodes.length} nodes`,
            );
          }
          changedNodeIndices.add(mutationNodeIndex);
        }
      }
      const renderTime = renderOptions.timeMilliseconds ?? performance.now();
      const transitionStartTime = previousRenderTime ?? renderTime;
      const startedTransitions = [];
      if (previousSceneNodes !== null && changedNodeIndices?.size) {
        for (const nodeIndex of changedNodeIndices) {
          const previousNode = previousSceneNodes[nodeIndex];
          const nextNode = scene.nodes[nodeIndex];
          if (!previousNode || !nextNode?.transitionDefinitions?.length) {
            continue;
          }
          // A DOM-backed box's values live in its immutable native capture.
          // Read both transition endpoints from those captured record bytes:
          // the engine buffer is shared and may have been overwritten by a
          // synchronous layout getter since the preceding frame.
          const recordView = (record) =>
            new DataView(record.buffer, record.byteOffset, record.byteLength);
          const previousRecord = previousNode._coreRecord ?? null;
          const nextRecord = nextNode._coreRecord ?? null;
          // The transform is the exception: the record folds the function
          // list into one affine, so its endpoints come from the CSS form
          // the same serialization captured (serialize.js), which is just
          // as immutable and is what CSS interpolates.
          //
          // Both endpoints take the same form or neither does: the CSS
          // list and the folded affine are different spellings of one
          // value, and comparing one against the other would report a
          // change where there is none. A serialization taken before the
          // element declared its transition carries no list, so that pair
          // compares — and interpolates — as affines.
          const carriesCssTransform = (propertyName) =>
            propertyName === "transform" &&
            previousNode.transform !== undefined &&
            nextNode.transform !== undefined;
          const previousValue = (propertyName) =>
            carriesCssTransform(propertyName)
              ? animationValueForSceneNode(previousNode, propertyName)
              : previousRecord !== null
              ? animationValueForRecord(
                previousRecord,
                recordView(previousRecord),
                0,
                propertyName,
                previousBoxes[nodeIndex],
              )
              : usesCoreRecord(previousNode)
              ? animationValueForRecord(
                engine.bytes,
                view,
                layoutBufferBase + nodeIndex * LAYOUT_NODE_SIZE,
                propertyName,
                previousBoxes[nodeIndex],
              )
              : animationValueForSceneNode(previousNode, propertyName);
          const nextValue = (propertyName) =>
            nextRecord !== null && !carriesCssTransform(propertyName)
              ? animationValueForRecord(
                nextRecord,
                recordView(nextRecord),
                0,
                propertyName,
                previousBoxes[nodeIndex],
              )
              : animationValueForSceneNode(nextNode, propertyName);
          for (const definition of nextNode.transitionDefinitions) {
            const propertyNames = animationTransitionProperties(
              definition.propertyName,
            );
            for (const propertyName of propertyNames) {
              let previousTarget;
              let nextTarget;
              try {
                previousTarget = previousValue(propertyName);
                nextTarget = nextValue(propertyName);
              } catch (error) {
                if (!(error instanceof TypeError)) throw error;
                continue;
              }
              if (
                !animationTransitionChanged(
                  previousTarget,
                  nextTarget,
                  definition.duration,
                  definition.delay,
                )
              ) continue;
              const timing = {
                duration: definition.duration,
                delay: definition.delay,
                easing: definition.easing,
                startTime: transitionStartTime,
              };
              if (propertyName === "transform") {
                // The base the track restores at its end, and the vector
                // the reversing-shortening rule measures progress along,
                // are matrices: the resolved affine of the end value. It
                // folds the CSS form whenever the node carries one — a
                // retained transform-only frame keeps the record it was
                // serialized with, so the record is the weaker source.
                const targetMatrix =
                  nextNode.transform?.kind === "cssTransform" &&
                    previousBoxes[nodeIndex] !== undefined
                    ? resolveCssTransform(nextNode, previousBoxes[nodeIndex])
                    : nextRecord !== null
                    ? recordCssTransform(
                      nextRecord,
                      recordView(nextRecord),
                      0,
                      previousBoxes[nodeIndex],
                    )
                    : resolveTransform(nextNode);
                timing.baseTarget = {
                  kind: "transform",
                  components: [{ kind: "matrix", value: targetMatrix }],
                };
                // The before-change function list is the CSS start value;
                // the controller falls back to the node's live affine while
                // an earlier transform effect is still sampling it.
                timing.startValue = previousTarget;
              }
              animations.transition(
                nodeIndex,
                propertyName,
                nextTarget,
                timing,
              );
              startedTransitions.push({ nodeIndex, propertyName, ...timing });
            }
          }
        }
      }
      let animationTickResult = null;
      const callerPrepareEngine = renderOptions.prepareEngine;
      const result = await renderScenePixels(scene, deviceScale, {
        ...renderOptions,
        readback,
        changedNodeIndices,
        engineWriteOwner: animations,
        retainedPreparationAllowed: callerPrepareEngine === undefined,
        glyphResourceManager,
        layoutNodeCapacity,
        prepareEngine(state) {
          const preparation = callerPrepareEngine?.(state) ?? {};
          if (
            renderOptions.timeMilliseconds !== undefined ||
            automaticTransitionsActive ||
            startedTransitions.length > 0
          ) {
            animationTickResult = animations.tick(
              renderOptions.timeMilliseconds ?? transitionStartTime,
            );
          }
          return preparation;
        },
        renderContext: context,
        visibleRectangle,
      });
      previousSceneNodes = scene.nodes;
      previousPublicationRevision = scene.publicationRevision;
      previousBoxes = result.boxes;
      previousRenderTime = renderTime;
      automaticTransitionsActive =
        (animationTickResult?.liveTrackCount ?? 0) > 0;
      return {
        ...result,
        animationActive: automaticTransitionsActive,
        startedTransitions,
      };
    }

    return Object.freeze({
      async resize(nextWidth, nextHeight, nextDeviceScale = deviceScale) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        if (
          width === nextWidth && height === nextHeight &&
          deviceScale === nextDeviceScale
        ) return;
        if (!(nextWidth > 0) || !(nextHeight > 0) || !(nextDeviceScale > 0)) {
          throw new RangeError(
            "persistent scene renderer dimensions and device scale must be positive",
          );
        }
        const densityOnlyResize = width === nextWidth &&
          height === nextHeight;
        await context.destroy();
        width = nextWidth;
        height = nextHeight;
        deviceScale = nextDeviceScale;
        await rebuildContext();
        // A density-only resize is raster-only: layout, the scene cache,
        // and the node signatures stay valid because the engine lays out
        // in CSS pixels and deviceScale never reaches it. Only a logical
        // size change invalidates them.
        if (!densityOnlyResize) {
          previousNodeSignatures = null;
          previousSceneNodes = null;
          previousBoxes = null;
          automaticTransitionsActive = false;
        }
      },
      /** Selects the CSS-px rectangle of the scene the raster target
       * covers, or the full scene with null. Raster-only: layout, the
       * scene cache, and the node signatures stay valid; only the
       * render context and the raster target are replaced. */
      async setVisibleRectangle(rectangle) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        if (rectangle !== null) {
          const { x, y, width: w, height: h } = rectangle;
          if (
            !(w > 0) || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y)
          ) {
            throw new RangeError(
              "visibleRectangle requires finite x/y and positive width/height",
            );
          }
        }
        const previous = visibleRectangle;
        if (
          previous === rectangle ||
          (previous !== null && rectangle !== null &&
            previous.x === rectangle.x && previous.y === rectangle.y &&
            previous.width === rectangle.width &&
            previous.height === rectangle.height)
        ) return;
        visibleRectangle = rectangle === null ? null : {
          x: Number(rectangle.x),
          y: Number(rectangle.y),
          width: Number(rectangle.width),
          height: Number(rectangle.height),
        };
        await context.destroy();
        await rebuildContext();
      },
      // The resolved raster backend ("webgpu" | "webgl2"). Presentation
      // consumers branch on this: only the webgpu backend can return a
      // GPU texture image; the webgl2 backend always reads back pixels.
      get graphicsBackend() {
        return context.kind;
      },
      // The token this renderer claims the engine's layout buffer with.
      // A synchronous layout getter over the tree this renderer renders
      // passes it to layoutTreeBoxesSync, which then inherits the
      // retained layout instead of relaying out the whole page, and hands
      // the claim back so the next frame keeps its incremental node set.
      get engineWriteToken() {
        return animations;
      },
      render(scene, renderOptions = {}) {
        return renderFrame(scene, renderOptions, "float32");
      },
      renderTexture(scene, renderOptions = {}) {
        return renderFrame(scene, renderOptions, "none");
      },
      // Permanent engine stage counters (presented-frame refactor
      // verification contract): layout computes vs cache hits and command
      // emission reuses, read from the live engine instance.
      engineCounters() {
        return Object.freeze({
          layoutComputeCount: engine.exports.layout_compute_count(),
          layoutCacheHitCount: engine.exports.layout_cache_hit_count(),
          emissionReuseCount: engine.exports.emission_reuse_count(),
        });
      },
      nodeGeneration(index) {
        if (!Number.isInteger(index) || index < 0) {
          throw new RangeError(
            `nodeGeneration index must be a non-negative integer, got ${index}`,
          );
        }
        return view.getUint32(
          layoutBufferBase + index * LAYOUT_NODE_SIZE +
            LAYOUT_NODE_OFFSET_CHANGED_GEN,
          true,
        );
      },
      animate(nodeIndex, keyframes, timing, declarationOptions = {}) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        // A freshly declared track publishes immediately; take the
        // animation occupancy so a sibling renderer's tick cannot sample
        // it onto the sibling's scene nodes.
        acquireEngineAnimations(animations);
        return animations.animate(
          nodeIndex,
          keyframes,
          timing,
          declarationOptions,
        );
      },
      transition(nodeIndex, propertyName, target, timing) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        acquireEngineAnimations(animations);
        return animations.transition(nodeIndex, propertyName, target, timing);
      },
      tick(timeMilliseconds) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        acquireEngineAnimations(animations);
        return animations.tick(timeMilliseconds);
      },
      remapAnimations(indexMap) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        if (previousSceneNodes !== null) {
          const remappedPreviousSceneNodes = [];
          for (const [previousIndex, nextIndex] of indexMap) {
            remappedPreviousSceneNodes[nextIndex] =
              previousSceneNodes[previousIndex];
          }
          previousSceneNodes = remappedPreviousSceneNodes;
          if (previousBoxes !== null) {
            const remappedPreviousBoxes = [];
            for (const [previousIndex, nextIndex] of indexMap) {
              remappedPreviousBoxes[nextIndex] = previousBoxes[previousIndex];
            }
            previousBoxes = remappedPreviousBoxes;
          }
        }
        return animations.remapNodes(indexMap);
      },
      onAnimationEvent(listener) {
        if (typeof listener !== "function") {
          throw new TypeError("animation event listener must be a function");
        }
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        animationEventListeners.add(listener);
        return () => animationEventListeners.delete(listener);
      },
      replaceAnimationBase(nodeIndex, propertyName, target) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return animations.replaceBase(nodeIndex, propertyName, target);
      },
      async shutdown() {
        if (shutDown) return;
        shutDown = true;
        // Release every engine animation track this renderer still owns;
        // on a shared engine the table outlives the renderer.
        animations.cancelAll();
        if (engineAnimationOccupant === animations) {
          engineAnimationOccupant = null;
        }
        if (engineWriteOwner === animations) engineWriteOwner = null;
        releaseRetainedPreparation(animations);
        await context.destroy();
        if (rendererGraphicsStateOwner !== graphicsStateOwner) {
          await releaseSharedWebgpuStates(rendererGraphicsStateOwner);
          await releaseSharedWebgl2State(rendererGraphicsStateOwner);
        }
      },
    });
  }

  // Lay out + render the WAT side. Returns raw RGBA pixels, the PNG, and the
  // computed boxes (px). The pixels are exactly what the gallery encodes to PNG —
  // the test diffs these against the browser raster.
  // renderOptions: extra options merged into the rasterizer's render() call
  // (e.g. textGamma for the mask-gamma calibration sweep).
  async function renderScene(scene, renderOptions = {}) {
    // renderScene always renders at CSS-px scale (1:1) — UNLIKE
    // renderScenePixels, which takes an explicit deviceScale and calls
    // set_device_scale(deviceScale) itself (see its own comment: the WAT
    // engine's opsz/font-optical-sizing:auto computation reads $deviceScale,
    // a PERSISTENT global that is never reset between calls). Found as a
    // real, pre-existing bug (not deviceScale-2-specific to this function —
    // it's a MISSING reset): renderScene never called set_device_scale at
    // all, so it silently inherited whatever $deviceScale a PRIOR
    // renderScenePixels(scene, 2) call in the same process left behind,
    // corrupting text shaping (glyph advances computed with the wrong
    // opsz) for every renderScene call after it. Reproduced with a plain
    // rect-only renderScenePixels(scene, 2) call (no text, no images)
    // followed by any renderScene call in the same process.
    engine.exports.set_device_scale(1);
    const {
      graphicsBackend = "auto",
      glyphResourceManager = getDefaultGlyphResourceManager(),
      renderContext = null,
      onPerformance = null,
      output = null,
      layoutNodeCapacity = Infinity,
      ...rasterOptions
    } = renderOptions;
    validateLayoutNodeCapacity(layoutNodeCapacity);
    if (!renderContext) {
      return await withRenderContext(
        scene.width,
        scene.height,
        (context) =>
          renderScene(scene, {
            ...renderOptions,
            renderContext: context,
            glyphResourceManager,
            graphicsBackend,
          }),
        graphicsBackend,
      );
    }
    const renderWallStartedAt = performance.now();
    let nodes = await resolveSvgPathIndices(
      await resolveImageIndices(
        await resolveFontIndices(
          resolveOrderModifiedChildren(resolveSvgUseNodes(scene.nodes)),
        ),
        null,
        scene.imageSources,
      ),
    );
    const clipBoxes = provisionalClipLayout(
      scene,
      nodes,
      layoutNodeCapacity,
    );
    if (clipBoxes) nodes = await resolveClipPathIndices(nodes, clipBoxes, 1);
    writeSceneNodesAndTileConfig(scene, nodes, null, layoutNodeCapacity);
    engine.exports.set_paint_artifact_capture(0);
    engine.exports.set_retained_frame_enabled(0);
    const bytes = engine.exports.emit_commands(nodes.length);
    // FRAME SNAPSHOT (see renderScenePixels): the frame owns its bytes;
    // a synchronous layout getter can re-emit the shared buffers while
    // this render is parked at an await below.
    const cmdView = new DataView(
      engine.memory.buffer.slice(
        COMMAND_BUFFER_BASE,
        COMMAND_BUFFER_BASE + bytes,
      ),
    );
    const gradientStopPool = new DataView(
      engine.memory.buffer.slice(
        GRADIENT_STOP_POOL_BASE,
        GRADIENT_STOP_POOL_BASE + GRADIENT_STOP_POOL_SIZE,
      ),
    );
    const scrollTable = new Float32Array(
      engine.memory.buffer.slice(
        scrollTableBase,
        scrollTableBase + scrollTableSize,
      ),
    );
    // Keep persistent rendering on the same cross-browser CPU atlas path.
    const { atlases, glyphBuffer, glyphLease, glyphPerformance } =
      await buildTextRenderResources(
        cmdView,
        bytes,
        1,
        glyphResourceManager,
        { kind: "cpu" },
      );
    let result;
    let rasterMilliseconds = 0;
    try {
      const images = buildImageRenderResources();
      const svgPathAtlas = await buildSvgPathRenderResources(cmdView, bytes);
      // gradientStopPool and scrollTable come from the frame snapshot.
      const rasterStartedAt = performance.now();
      result = await render(renderContext, cmdView, bytes, {
        background: RENDER_BG,
        atlases,
        glyphBuffer,
        images,
        svgPathAtlas,
        gradientStopPool,
        scrollTable,
        glyphPerformance,
        ...rasterOptions,
      });
      rasterMilliseconds = performance.now() - rasterStartedAt;
    } finally {
      glyphLease.release();
    }
    // The result is the working ImageDescriptor plus boxes and performance.
    // Encoded bytes are never an implicit side effect: the caller supplies
    // an explicit OutputRequest (e.g. { output: { format: "png" } }) and
    // receives `encodedBytes` through the central output transform
    // (src/output/image.js). The rgba8unorm speed mode rejects wide-gamut
    // and high-dynamic-range requests there.
    const pixels = new Float32Array(result.pixels);
    const encodedBytes = output
      ? await encodeImage(
        {
          pixels,
          width: scene.width,
          height: scene.height,
          rowStride: result.rowStride,
          channelLayout: result.channelLayout,
          sampleType: result.sampleType,
          bitsPerSample: result.bitsPerSample,
          colorEncoding: result.colorEncoding,
          alphaMode: result.alphaMode,
          metadata: result.metadata,
        },
        output,
        {
          renderPrecision: renderContext.renderPrecision,
          encodeJxlOutput: codecRuntime.encodeJxlOutput,
          encodePngOutput: codecRuntime.encodePngOutput,
        },
      )
      : null;

    const boxes = nodes.map((_, i) => {
      const b = computedBoxBufferBase + i * BOX_SIZE;
      return {
        x: view.getInt32(b + BOX_OFFSET_X, true) / LAYOUT_UNIT,
        y: view.getInt32(b + BOX_OFFSET_Y, true) / LAYOUT_UNIT,
        w: view.getInt32(b + BOX_OFFSET_WIDTH, true) / LAYOUT_UNIT,
        h: view.getInt32(b + BOX_OFFSET_HEIGHT, true) / LAYOUT_UNIT,
      };
    });
    const performanceRecord = Object.freeze({
      glyphs: glyphPerformance,
      rasterMilliseconds,
      wallMilliseconds: performance.now() - renderWallStartedAt,
    });
    if (onPerformance !== null) onPerformance(performanceRecord);
    return {
      pixels,
      rowStride: result.rowStride,
      channelLayout: result.channelLayout,
      sampleType: result.sampleType,
      bitsPerSample: result.bitsPerSample,
      colorEncoding: result.colorEncoding,
      alphaMode: result.alphaMode,
      metadata: result.metadata,
      ...(encodedBytes ? { encodedBytes } : {}),
      boxes,
      performance: performanceRecord,
      width: scene.width,
      height: scene.height,
    };
  }

  return Object.freeze({
    core,
    __debugEngine,
    RENDER_BG,
    cssTransformMatrix,
    prewarmCssTextGlyphs,
    imagePixelsFor,
    sharedSvgPathAtlas,
    normalizedBorderColors,
    normalizedBorderStyles,
    normalizedBorderRadii,
    floatByte,
    clearByte,
    sceneHtml,
    scaleNode,
    emitSceneCommands,
    emitSceneCommandsSync,
    layoutTreeBoxes,
    layoutTreeBoxesSync,
    createLayoutArtifact,
    createDisplayListArtifact,
    createInvalidationArtifact,
    releaseRenderContexts,
    getDefaultGlyphResourceManager,
    shutdownDefaultGlyphResourceManager,
    renderScenePixels,
    createPersistentSceneRenderer,
    createSceneRendererForCurrentModule,
    renderScene,
    fontRegistry,
    shapingRuntime,
    atlasRuntime,
    codecRuntime,
    assetIdentities: Object.freeze({
      harfbuzz: harfbuzzBytes,
      msdfgen: msdfgenBytes,
      engine,
      atlasModule: atlasRuntime.moduleIdentity(),
    }),
  });
}

const defaultSceneRendererRuntime = await createSceneRendererRuntime({
  core: sharedDomCore,
  fontRegistry: defaultFontRegistry,
});

export const getDefaultGlyphResourceManager = (...arguments_) =>
  defaultSceneRendererRuntime.getDefaultGlyphResourceManager(...arguments_);
export const shutdownDefaultGlyphResourceManager = (...arguments_) =>
  defaultSceneRendererRuntime.shutdownDefaultGlyphResourceManager(
    ...arguments_,
  );

export const __debugEngine = (...arguments_) =>
  defaultSceneRendererRuntime.__debugEngine(...arguments_);
export const RENDER_BG = defaultSceneRendererRuntime.RENDER_BG;
export const cssTransformMatrix = (...arguments_) =>
  defaultSceneRendererRuntime.cssTransformMatrix(...arguments_);
export const prewarmCssTextGlyphs = (...arguments_) =>
  defaultSceneRendererRuntime.prewarmCssTextGlyphs(...arguments_);
export const imagePixelsFor = (...arguments_) =>
  defaultSceneRendererRuntime.imagePixelsFor(...arguments_);
export const sharedSvgPathAtlas =
  defaultSceneRendererRuntime.sharedSvgPathAtlas;
export const normalizedBorderColors = (...arguments_) =>
  defaultSceneRendererRuntime.normalizedBorderColors(...arguments_);
export const normalizedBorderStyles = (...arguments_) =>
  defaultSceneRendererRuntime.normalizedBorderStyles(...arguments_);
export const normalizedBorderRadii = (...arguments_) =>
  defaultSceneRendererRuntime.normalizedBorderRadii(...arguments_);
export const floatByte = (...arguments_) =>
  defaultSceneRendererRuntime.floatByte(...arguments_);
export const clearByte = (...arguments_) =>
  defaultSceneRendererRuntime.clearByte(...arguments_);
export const sceneHtml = (...arguments_) =>
  defaultSceneRendererRuntime.sceneHtml(...arguments_);
export const scaleNode = (...arguments_) =>
  defaultSceneRendererRuntime.scaleNode(...arguments_);
export const emitSceneCommands = (...arguments_) =>
  defaultSceneRendererRuntime.emitSceneCommands(...arguments_);
export const emitSceneCommandsSync = (...arguments_) =>
  defaultSceneRendererRuntime.emitSceneCommandsSync(...arguments_);
export const layoutTreeBoxes = (...arguments_) =>
  defaultSceneRendererRuntime.layoutTreeBoxes(...arguments_);
export const layoutTreeBoxesSync = (...arguments_) =>
  defaultSceneRendererRuntime.layoutTreeBoxesSync(...arguments_);
export const createLayoutArtifact = (...arguments_) =>
  defaultSceneRendererRuntime.createLayoutArtifact(...arguments_);
export const createDisplayListArtifact = (...arguments_) =>
  defaultSceneRendererRuntime.createDisplayListArtifact(...arguments_);
export const createInvalidationArtifact = (...arguments_) =>
  defaultSceneRendererRuntime.createInvalidationArtifact(...arguments_);
export const releaseRenderContexts = (...arguments_) =>
  defaultSceneRendererRuntime.releaseRenderContexts(...arguments_);
export const renderScenePixels = (...arguments_) =>
  defaultSceneRendererRuntime.renderScenePixels(...arguments_);
export const createPersistentSceneRenderer = (...arguments_) =>
  defaultSceneRendererRuntime.createPersistentSceneRenderer(...arguments_);
export const createSceneRendererForCurrentModule = (...arguments_) =>
  defaultSceneRendererRuntime.createSceneRendererForCurrentModule(
    ...arguments_,
  );
export const renderScene = (...arguments_) =>
  defaultSceneRendererRuntime.renderScene(...arguments_);
export async function createSandomRuntime(options = {}) {
  return await __createSandomRuntimeFromPrepared(
    await prepareSandomRuntimeOptions(options),
  );
}

export async function __createSandomRuntimeFromPrepared(prepared) {
  const {
    explicitAssets,
    resolveSystemFontFamily,
    harfbuzzSource,
    msdfgenSource,
    codecSources,
    harfbuzzBytes,
    msdfgenBytes,
  } = prepared;
  const webPDecoder = createWebPDecoder(
    explicitAssets
      ? { getWebPBytes: lazyAssetBytes(codecSources.webp, "webp") }
      : {},
  );
  const jpegXlCodec = createJpegXlCodec(
    explicitAssets
      ? { getJpegXlBytes: lazyAssetBytes(codecSources.jpegXl, "jpegXl") }
      : {},
  );
  const codecRuntime = createImageCodecRuntime({
    getJpegBytes: explicitAssets
      ? lazyAssetBytes(codecSources.jpeg, "jpeg")
      : null,
    getPngBytes: explicitAssets
      ? lazyAssetBytes(codecSources.png, "png")
      : null,
    decodeWebP: webPDecoder.decodeWebP,
    decodeJXL: jpegXlCodec.decodeJXL,
    encodeJxlOutput: jpegXlCodec.encodeJxlOutput,
  });

  const sceneRendererRuntime = await createSceneRendererRuntime({
    harfbuzzBytes,
    msdfgenBytes,
    resolveSystemFontFamily,
    codecRuntime,
  });
  const domModule = await import("./dom/dom.js");
  const createRuntimeDOM = (domOptions = {}) =>
    domModule.createSandomDOM({
      ...domOptions,
      sceneRendererRuntime,
      fontRegistry: sceneRendererRuntime.fontRegistry,
    });
  const runtime = {
    assets: Object.freeze({
      mode: explicitAssets ? "explicit" : "module-relative",
      harfbuzz: harfbuzzSource,
      msdfgen: msdfgenSource,
      codecs: Object.freeze({ ...codecSources }),
    }),
    renderComponent(options) {
      return domModule.renderComponent(options, {
        createSandomDOM: createRuntimeDOM,
        core: sceneRendererRuntime.core,
        fontRegistry: sceneRendererRuntime.fontRegistry,
      });
    },
    createSandomDOM: createRuntimeDOM,
    loadFont: (...arguments_) =>
      sceneRendererRuntime.fontRegistry.loadFont(...arguments_),
    renderScene: sceneRendererRuntime.renderScene,
    renderScenePixels: sceneRendererRuntime.renderScenePixels,
    createPersistentSceneRenderer:
      sceneRendererRuntime.createPersistentSceneRenderer,
    createLayoutArtifact: sceneRendererRuntime.createLayoutArtifact,
    createDisplayListArtifact: sceneRendererRuntime.createDisplayListArtifact,
    prewarmCssTextGlyphs: sceneRendererRuntime.prewarmCssTextGlyphs,
    releaseRenderContexts: sceneRendererRuntime.releaseRenderContexts,
  };
  return Object.freeze(runtime);
}
