// Shared render-command walker (WebGL 2 degraded backend, Slice 1).
//
// This module owns the backend-neutral FIRST PASS of rendering: it decodes
// the engine's binary command stream into an ordered list of `batches` —
// plain JS objects with Float32Array instance data — that a raster backend
// (WebGPU in src/rasterize.js, WebGL 2 in src/rasterize-webgl2.js) then
// executes. There is exactly ONE decoder: both backends consume
// buildBatches(); neither re-walks the command stream. The walker throws on
// every unknown opcode (see the loop's own comment for the desync history).
//
// Backend-neutral resource and effect normalization also lives here. GPU
// objects, upload timing, shader execution and asynchronous resource completion
// remain in the host/backends.

import {
  clipUniformFloats,
  MAX_SHADER_CLIP_ENTRIES,
} from "./gpu-composition-clip.js";
import {
  BLEND_NORMAL,
  CLIP_ENTRY_FLAG_AFFINE,
  CLIP_ENTRY_FLAG_ENABLED_X,
  CLIP_ENTRY_FLAG_ENABLED_Y,
  CLIP_ENTRY_FLAG_PATH_MASK,
  CLIP_ENTRY_OFFSET_AFFINE,
  CLIP_ENTRY_OFFSET_FLAGS,
  CLIP_ENTRY_OFFSET_H,
  CLIP_ENTRY_OFFSET_RADII,
  CLIP_ENTRY_OFFSET_SCROLL_REF,
  CLIP_ENTRY_OFFSET_W,
  CLIP_ENTRY_OFFSET_X,
  CLIP_ENTRY_OFFSET_Y,
  CLIP_ENTRY_SIZE,
  CMD_BOX_SHADOW,
  CMD_BOX_SHADOW_FLAG_INSET,
  CMD_BOX_SHADOW_FLAG_TRANSFORM,
  CMD_BOX_SHADOW_INSET_EXT_SIZE,
  CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_H,
  CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_RADII,
  CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_W,
  CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_X,
  CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_Y,
  CMD_BOX_SHADOW_OFFSET_BLUR_SIGMA,
  CMD_BOX_SHADOW_OFFSET_COLOR,
  CMD_BOX_SHADOW_OFFSET_FLAGS,
  CMD_BOX_SHADOW_OFFSET_H,
  CMD_BOX_SHADOW_OFFSET_RADII,
  CMD_BOX_SHADOW_OFFSET_W,
  CMD_BOX_SHADOW_OFFSET_X,
  CMD_BOX_SHADOW_OFFSET_XFORM,
  CMD_BOX_SHADOW_OFFSET_Y,
  CMD_BOX_SHADOW_SIZE,
  CMD_BOX_SHADOW_SIZE_XFORM,
  CMD_IMAGE,
  CMD_IMAGE_FLAG_ABUT_BOTTOM,
  CMD_IMAGE_FLAG_ABUT_LEFT,
  CMD_IMAGE_FLAG_ABUT_RIGHT,
  CMD_IMAGE_FLAG_ABUT_TOP,
  CMD_IMAGE_FLAG_NO_PIXEL_SNAP,
  CMD_IMAGE_FLAG_PIXELATED,
  CMD_IMAGE_FLAG_TRANSFORM,
  CMD_IMAGE_OFFSET_FLAGS,
  CMD_IMAGE_OFFSET_H,
  CMD_IMAGE_OFFSET_INDEX,
  CMD_IMAGE_OFFSET_UV_H,
  CMD_IMAGE_OFFSET_UV_W,
  CMD_IMAGE_OFFSET_UV_X,
  CMD_IMAGE_OFFSET_UV_Y,
  CMD_IMAGE_OFFSET_W,
  CMD_IMAGE_OFFSET_X,
  CMD_IMAGE_OFFSET_XFORM,
  CMD_IMAGE_OFFSET_Y,
  CMD_IMAGE_SIZE,
  CMD_IMAGE_SIZE_XFORM,
  CMD_POP_BACKDROP_FILTER,
  CMD_POP_BACKDROP_FILTER_SIZE,
  CMD_POP_BACKGROUND,
  CMD_POP_BACKGROUND_SIZE,
  CMD_POP_BLEND_LAYER,
  CMD_POP_BLEND_LAYER_SIZE,
  CMD_POP_CLIP,
  CMD_POP_CLIP_SIZE,
  CMD_POP_MASK_LAYER,
  CMD_POP_MASK_LAYER_SIZE,
  CMD_POP_OPACITY,
  CMD_POP_OPACITY_SIZE,
  CMD_PUSH_BACKDROP_FILTER,
  CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENT_COUNT,
  CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENTS,
  CMD_PUSH_BACKGROUND,
  CMD_PUSH_BACKGROUND_SIZE,
  CMD_PUSH_BLEND_LAYER,
  CMD_PUSH_BLEND_LAYER_OFFSET_MODE,
  CMD_PUSH_BLEND_LAYER_SIZE,
  CMD_PUSH_CLIP,
  CMD_PUSH_CLIP_HEADER_SIZE,
  CMD_PUSH_CLIP_OFFSET_COUNT,
  CMD_PUSH_MASK,
  CMD_PUSH_MASK_LAYER,
  CMD_PUSH_MASK_LAYER_OFFSET_COMPOSITE,
  CMD_PUSH_MASK_LAYER_OFFSET_MODE,
  CMD_PUSH_MASK_LAYER_SIZE,
  CMD_PUSH_MASK_SIZE,
  CMD_PUSH_OPACITY,
  CMD_PUSH_OPACITY_FLAG_BLEND_MASK,
  CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT,
  CMD_PUSH_OPACITY_FLAG_MASK,
  CMD_PUSH_OPACITY_OFFSET_ALPHA,
  CMD_PUSH_OPACITY_OFFSET_FLAGS,
  CMD_PUSH_OPACITY_OFFSET_SEGMENT_COUNT,
  CMD_PUSH_OPACITY_OFFSET_SEGMENTS,
  CMD_PUSH_OPACITY_SEGMENT_KIND_BLUR,
  CMD_PUSH_OPACITY_SEGMENT_KIND_DROP_SHADOW,
  CMD_PUSH_OPACITY_SEGMENT_KIND_MATRIX,
  CMD_PUSH_OPACITY_SEGMENT_OFFSET_KIND,
  CMD_PUSH_OPACITY_SEGMENT_OFFSET_PAYLOAD,
  CMD_PUSH_OPACITY_SEGMENT_SIZE,
  CMD_RECT,
  CMD_RECT_FLAG_BORDER,
  CMD_RECT_FLAG_FILL,
  CMD_RECT_FLAG_GRADIENT,
  CMD_RECT_FLAG_NO_PIXEL_SNAP,
  CMD_RECT_FLAG_TRANSFORM,
  CMD_RECT_GRADIENT_EXT_SIZE,
  CMD_RECT_GRADIENT_OFFSET_GEOM,
  CMD_RECT_GRADIENT_OFFSET_KIND,
  CMD_RECT_GRADIENT_OFFSET_STOP_COUNT,
  CMD_RECT_GRADIENT_OFFSET_STOP_OFFSET,
  CMD_RECT_OFFSET_BORDER_BOTTOM,
  CMD_RECT_OFFSET_BORDER_COLOR_BOTTOM,
  CMD_RECT_OFFSET_BORDER_COLOR_LEFT,
  CMD_RECT_OFFSET_BORDER_COLOR_RIGHT,
  CMD_RECT_OFFSET_BORDER_COLOR_TOP,
  CMD_RECT_OFFSET_BORDER_LEFT,
  CMD_RECT_OFFSET_BORDER_RIGHT,
  CMD_RECT_OFFSET_BORDER_STYLES,
  CMD_RECT_OFFSET_BORDER_TOP,
  CMD_RECT_OFFSET_FILL,
  CMD_RECT_OFFSET_FLAGS,
  CMD_RECT_OFFSET_H,
  CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_X,
  CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_Y,
  CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_X,
  CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_Y,
  CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X,
  CMD_RECT_OFFSET_RADIUS_TOP_LEFT_Y,
  CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_X,
  CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_Y,
  CMD_RECT_OFFSET_W,
  CMD_RECT_OFFSET_X,
  CMD_RECT_OFFSET_XFORM,
  CMD_RECT_OFFSET_Y,
  CMD_RECT_SIZE,
  CMD_SET_NODE,
  CMD_SET_NODE_SIZE,
  CMD_SET_SCROLL,
  CMD_SET_SCROLL_OFFSET_REF,
  CMD_SET_SCROLL_SIZE,
  CMD_SVG_PATH,
  CMD_SVG_PATH_FLAG_GRADIENT,
  CMD_SVG_PATH_FLAG_TRANSFORM,
  CMD_SVG_PATH_GRADIENT_OFFSET_GEOM,
  CMD_SVG_PATH_GRADIENT_OFFSET_KIND,
  CMD_SVG_PATH_GRADIENT_OFFSET_STOP_COUNT,
  CMD_SVG_PATH_GRADIENT_OFFSET_STOP_OFFSET,
  CMD_SVG_PATH_OFFSET_COLOR,
  CMD_SVG_PATH_OFFSET_FLAGS,
  CMD_SVG_PATH_OFFSET_H,
  CMD_SVG_PATH_OFFSET_INDEX,
  CMD_SVG_PATH_OFFSET_W,
  CMD_SVG_PATH_OFFSET_X,
  CMD_SVG_PATH_OFFSET_XFORM,
  CMD_SVG_PATH_OFFSET_Y,
  CMD_SVG_PATH_SIZE,
  CMD_SVG_PATH_SIZE_XFORM,
  CMD_TEXT,
  CMD_TEXT_FLAG_TEXT_SHADOW,
  CMD_TEXT_FLAG_TRANSFORM,
  CMD_TEXT_OFFSET_BL,
  CMD_TEXT_OFFSET_COLOR,
  CMD_TEXT_OFFSET_FLAGS,
  CMD_TEXT_OFFSET_FONT,
  CMD_TEXT_OFFSET_FSIZE,
  CMD_TEXT_OFFSET_GCOUNT,
  CMD_TEXT_OFFSET_GOFF,
  CMD_TEXT_OFFSET_LH,
  CMD_TEXT_OFFSET_STYLE,
  CMD_TEXT_OFFSET_UPEM,
  CMD_TEXT_OFFSET_WEIGHT,
  CMD_TEXT_OFFSET_X,
  CMD_TEXT_OFFSET_XFORM,
  CMD_TEXT_OFFSET_Y,
  CMD_TEXT_SHADOW_OFFSET_BLUR_SIGMA,
  CMD_TEXT_SHADOW_OFFSET_COLOR,
  CMD_TEXT_SHADOW_OFFSET_OFFSET_X,
  CMD_TEXT_SHADOW_OFFSET_OFFSET_Y,
  CMD_TEXT_SIZE,
  CMD_TEXT_SIZE_XFORM,
  cmdBoxShadowInsetClipOffset,
  cmdBoxShadowSize,
  cmdPushBackdropFilterOwnShapeOffset,
  cmdPushBackdropFilterSize,
  cmdPushClipSize,
  cmdPushOpacitySize,
  cmdSvgPathSize,
  cmdTextShadowExtOffset,
  cmdTextSize,
  GLYPH_ENTRY_SIZE,
  GLYPH_ID_INVISIBLE,
  GLYPH_OFFSET_ID,
  GLYPH_OFFSET_X_ADVANCE,
  GLYPH_OFFSET_X_OFFSET,
  GRADIENT_HUE_NAMES,
  GRADIENT_SPACE_NAMES,
  GRADIENT_STOP_ENTRY_SIZE,
  GRADIENT_STOP_OFFSET_COLOR,
  GRADIENT_STOP_OFFSET_MISSING,
  GRADIENT_STOP_OFFSET_POSITION,
} from "./wasm/layout.js";
import { loadColorKernel } from "./wasm/color-kernel.js";
import { prepareGradientStops } from "./gradient-interpolation.js";

// HDR boundary conversion (wide-color plan, package 4). Authored scene
// colors travel the engine and command stream in extended sign-mirrored
// encoded sRGB (parseColor's output - standard mode's working encoding).
// The high-dynamic-range mode composites in linear Rec. 2020, so THIS
// walker - the one shared decoder - converts every authored color once,
// on read. Exported for the one authored color that bypasses the command
// stream (render()'s clear color). Lazy: standard mode never
// instantiates this kernel.
let hdrColorKernel = null;
export function convertEncodedSrgbColor4ToWorkingRec2020(color) {
  const kernel = hdrColorKernel ??= loadColorKernel();
  const working = kernel.convertLinearRgbToWorking("srgb", [
    kernel.decodeSrgbTransfer(color[0]),
    kernel.decodeSrgbTransfer(color[1]),
    kernel.decodeSrgbTransfer(color[2]),
  ]);
  return [working[0], working[1], working[2], color[3]];
}

// Gradient storage-buffer strides (P4) — shared by createRenderContext
// (buffer allocation/pooling) and render() (per-batch writes), so these
// live at module scope rather than inside either function. Both values
// are the REAL, empirically-verified WGSL array element stride (see the
// rect shader's GradientRecord/GradientStop comments for how — a real
// compute-shader round-trip test against this project's actual WebGPU
// pipeline, not just spec reading — 32 B either way, though for
// different reasons: GradientRecord's 8 all-scalar fields pack with no
// padding; GradientStop's vec4f+f32 rounds UP from a 20 B bare-struct
// size because WGSL rounds an array's element stride to a multiple of
// its largest member's alignment).
const GRADIENT_RECORD_STRIDE = 48;
const GRADIENT_STOP_STRIDE = 32;

// box-shadow (P3) instance stride, shared by pipeline creation and the
// batching loop's accumulator — see boxShadowPipeline's own comment for
// the field layout (rectPos, rectSize, color, radiiX, radiiY, transform,
// blurSigma, isInset, borderBoxRect, borderBoxRadiiX/Y).
const BOX_SHADOW_INSTANCE_FLOATS = 36;
// ==========================================================================
// Clip-list evaluation (oriented-clip redesign) — shared by every draw
// shader (rect, text, svgPath, image, boxShadow). The clip state is a
// LIST of entries (see layout.js's CMD_PUSH_CLIP / CLIP_ENTRY_* docs);
// a pixel is visible iff it's inside EVERY entry, each evaluated in its
// own coordinate space via the entry's inverse affine. readClipEntries
// (below, JS) decodes the wire entries and normalizes axis-aligned
// affines (pure translate/scale) back into plain screen-space rects, so
// those keep the pre-redesign pixel-exact hard-edge behavior; only a
// genuinely rotated/skewed clip takes the SDF path, whose fwidth-based
// AA handles the local->screen mapping automatically (fwidth is the
// SCREEN-space derivative of the LOCAL-space distance).
// ==========================================================================
// The "no clip at all" state (oriented-clip redesign). Clip states are
// IMMUTABLE after decode — a batch snapshot is a plain reference, and the
// clip stack is pure save/restore (each CMD_PUSH_CLIP carries the
// COMPLETE state; the engine's $clipListAppend is the single intersection
// authority — the pre-redesign intersectClip mirror is gone).
// `bounds` is the state's conservative screen-space extent (see
// clipStateBounds); null bounds nothing.
const EMPTY_CLIP_STATE = { entries: [], bounds: null };

// Invert an affine [a, b, c, d, e, f] (column-vector convention: x' =
// a*x + c*y + e, y' = b*x + d*y + f — same as curXform*/CSS matrix()).
function invertAffine(m) {
  const [a, b, c, d, e, f] = m;
  const determinant = a * d - b * c;
  if (determinant === 0) {
    throw new Error(
      "readClipEntries: clip entry affine is singular (zero determinant)",
    );
  }
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

// Both composite shaders consume the same six vec4 rows. Resolve the completed
// path atlas entry here; texture creation and binding remain backend-owned.
export function pathMaskUniformFloats(mask, svgPathAtlas) {
  const pathInfo = svgPathAtlas?.getPathByIndex(mask.pathMask.pathIndex);
  if (!pathInfo) {
    throw new Error(
      `render: unresolved clip path atlas index ${mask.pathMask.pathIndex}`,
    );
  }
  const { range } = svgPathAtlas.getMsdfParams();
  const forwardAffine = invertAffine(mask.inverseAffine);
  const scaleX = Math.hypot(forwardAffine[0], forwardAffine[1]);
  const scaleY = Math.hypot(forwardAffine[2], forwardAffine[3]);
  const pathWidth = mask.pathMask.bboxXMax - mask.pathMask.bboxXMin;
  const pathHeight = mask.pathMask.bboxYMax - mask.pathMask.bboxYMin;
  const screenSize = Math.max(
    pathWidth * mask.pathMask.coordinateScale * scaleX,
    pathHeight * mask.pathMask.coordinateScale * scaleY,
  );
  const textureSize = Math.max(pathInfo.pixelW, pathInfo.pixelH);
  const pixelRange = range * screenSize / textureSize;
  return [
    1,
    mask.pathMask.coordinateScale,
    pixelRange,
    0,
    mask.x,
    mask.y,
    mask.w,
    mask.h,
    mask.pathMask.bboxXMin,
    mask.pathMask.bboxYMin,
    mask.pathMask.bboxXMax,
    mask.pathMask.bboxYMax,
    pathInfo.u + range / svgPathAtlas.atlasWidth,
    pathInfo.v + range / svgPathAtlas.atlasHeight,
    pathInfo.uW - 2 * range / svgPathAtlas.atlasWidth,
    pathInfo.vH - 2 * range / svgPathAtlas.atlasHeight,
    mask.inverseAffine[0],
    mask.inverseAffine[1],
    mask.inverseAffine[2],
    mask.inverseAffine[3],
    mask.inverseAffine[4],
    mask.inverseAffine[5],
    0,
    0,
  ];
}

// Repack a row-major 4x5 filter matrix into four coefficient vec4 rows followed
// by the constant column, the common WebGPU/WebGL2 composite shader layout.
export function filterMatrixUniformFloats(matrix) {
  return [
    matrix[0],
    matrix[1],
    matrix[2],
    matrix[3],
    matrix[5],
    matrix[6],
    matrix[7],
    matrix[8],
    matrix[10],
    matrix[11],
    matrix[12],
    matrix[13],
    matrix[15],
    matrix[16],
    matrix[17],
    matrix[18],
    matrix[4],
    matrix[9],
    matrix[14],
    matrix[19],
  ];
}

// Three box widths approximate a Gaussian (Filter Effects §9.14); each backend
// executes one horizontal and one vertical pass for every width.
export function blurBoxWidths(sigma) {
  const d = Math.floor(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5);
  return d % 2 === 1 ? [d, d, d] : [d, d, d + 1];
}

// Decode a CMD_PUSH_CLIP's entry list into the shaders' form, resolving
// each entry's evaluation MODE up front:
//   0 = skip (neither axis enabled — the empty count-0 push never even
//       produces an entry, so this only guards malformed input)
//   1 = hard axis-aligned screen-space rect test, binary, no AA —
//       pixel-exact parity with the pre-redesign axis-aligned behavior
//   2 = SDF (rounded corners and/or a genuinely oriented affine),
//       antialiased over ~1 screen pixel
// AXIS-ALIGNED AFFINE NORMALIZATION: an entry whose affine has no
// rotation/skew (b == 0, c == 0) and positive scale folds EXACTLY into
// its rect and radii (x' = a*x + e, w' = a*w, rx' = a*rx, ...) — pure
// math, not an approximation — so translate/scale-only transformed clips
// come out as ordinary screen-space rects and keep the hard-edge path.
// entriesBase points at the FIRST entry directly (not a command header) —
// CMD_PUSH_CLIP's own caller passes offset+CMD_PUSH_CLIP_HEADER_SIZE (see
// readClipEntries below); CMD_PUSH_BACKDROP_FILTER's own trailing own-shape
// entry (P8b) reads via this directly, since it has no per-entry header/
// count at all (always exactly one entry).
function readClipEntriesAt(
  buf,
  entriesBase,
  count,
  scrollTable = null,
  s = 1,
  originX = 0,
  originY = 0,
) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const p = entriesBase + i * CLIP_ENTRY_SIZE;
    const flags = buf.getUint8(p + CLIP_ENTRY_OFFSET_FLAGS);
    let x = buf.getFloat32(p + CLIP_ENTRY_OFFSET_X, true) * s;
    let y = buf.getFloat32(p + CLIP_ENTRY_OFFSET_Y, true) * s;
    let w = buf.getFloat32(p + CLIP_ENTRY_OFFSET_W, true) * s;
    let h = buf.getFloat32(p + CLIP_ENTRY_OFFSET_H, true) * s;
    // D2 piece B: each entry carries the scroll-table reference whose
    // offset positions it (entries under different scrollers coexist in
    // one pushed list). Non-affine geometry is screen-space: shift x/y.
    // Affine geometry is local-space: shift the affine's translation
    // (below, after the affine is read).
    const scrollRef = buf.getUint16(p + CLIP_ENTRY_OFFSET_SCROLL_REF, true);
    let entryScrollX = -originX, entryScrollY = -originY;
    if (scrollTable !== null && scrollRef !== 0) {
      entryScrollX = scrollTable[scrollRef * 2] * s - originX;
      entryScrollY = scrollTable[scrollRef * 2 + 1] * s - originY;
    }
    if ((flags & CLIP_ENTRY_FLAG_AFFINE) === 0) {
      x += entryScrollX;
      y += entryScrollY;
    }
    const radiiX = [], radiiY = [];
    for (let corner = 0; corner < 4; corner++) {
      radiiX.push(
        buf.getFloat32(p + CLIP_ENTRY_OFFSET_RADII + corner * 8, true) * s,
      );
      radiiY.push(
        buf.getFloat32(p + CLIP_ENTRY_OFFSET_RADII + corner * 8 + 4, true) * s,
      );
    }
    let affine = null;
    if (flags & CLIP_ENTRY_FLAG_AFFINE) {
      affine = [];
      for (let component = 0; component < 6; component++) {
        affine.push(
          buf.getFloat32(p + CLIP_ENTRY_OFFSET_AFFINE + component * 4, true),
        );
      }
      // The affine's a-d components are dimensionless; only the
      // translation is a length. x/y/w/h above are LOCAL space for an
      // affine entry, but scaling local geometry and the translation by
      // the same factor composes to the same screen shape.
      affine[4] = affine[4] * s + entryScrollX;
      affine[5] = affine[5] * s + entryScrollY;
      if (flags & CLIP_ENTRY_FLAG_PATH_MASK) {
        const payload = p + CLIP_ENTRY_OFFSET_RADII;
        entries.push({
          x,
          y,
          w,
          h,
          radiiX: [0, 0, 0, 0],
          radiiY: [0, 0, 0, 0],
          mode: 0,
          axisBits: 0,
          inverseAffine: invertAffine(affine),
          pathMask: {
            pathIndex: buf.getUint32(payload, true),
            // coordinateScale maps path user units to pixels; the raster
            // scale rides it.
            coordinateScale: buf.getFloat32(payload + 4, true) * s,
            bboxXMin: buf.getFloat32(payload + 8, true),
            bboxYMin: buf.getFloat32(payload + 12, true),
            bboxXMax: buf.getFloat32(payload + 16, true),
            bboxYMax: buf.getFloat32(payload + 20, true),
          },
        });
        continue;
      }
      if (
        affine[1] === 0 && affine[2] === 0 && affine[0] > 0 && affine[3] > 0
      ) {
        x = affine[0] * x + affine[4];
        y = affine[3] * y + affine[5];
        w = affine[0] * w;
        h = affine[3] * h;
        for (let corner = 0; corner < 4; corner++) {
          radiiX[corner] *= affine[0];
          radiiY[corner] *= affine[3];
        }
        affine = null;
      }
    }
    if (flags & CLIP_ENTRY_FLAG_PATH_MASK) {
      const payload = p + CLIP_ENTRY_OFFSET_RADII;
      entries.push({
        x,
        y,
        w,
        h,
        radiiX: [0, 0, 0, 0],
        radiiY: [0, 0, 0, 0],
        mode: 0,
        axisBits: 0,
        inverseAffine: [1, 0, 0, 1, 0, 0],
        pathMask: {
          pathIndex: buf.getUint32(payload, true),
          coordinateScale: buf.getFloat32(payload + 4, true) * s,
          bboxXMin: buf.getFloat32(payload + 8, true),
          bboxYMin: buf.getFloat32(payload + 12, true),
          bboxXMax: buf.getFloat32(payload + 16, true),
          bboxYMax: buf.getFloat32(payload + 20, true),
        },
      });
      continue;
    }
    const enabledX = (flags & CLIP_ENTRY_FLAG_ENABLED_X) !== 0;
    const enabledY = (flags & CLIP_ENTRY_FLAG_ENABLED_Y) !== 0;
    if (affine !== null && !(enabledX && enabledY)) {
      // A single-axis clip under a rotated/skewed transform has no
      // representable hard test and nothing in the engine emits one —
      // fail loud rather than guess.
      throw new Error(
        "readClipEntries: single-axis clip entry with a non-axis-aligned affine",
      );
    }
    const maxRadius = Math.max(...radiiX, ...radiiY);
    const sdf = enabledX && enabledY && (maxRadius > 0 || affine !== null);
    const mode = (!enabledX && !enabledY) ? 0 : (sdf ? 2 : 1);
    const axisBits = (enabledX ? 1 : 0) | (enabledY ? 2 : 0);
    entries.push({
      x,
      y,
      w,
      h,
      radiiX,
      radiiY,
      mode,
      axisBits,
      inverseAffine: affine === null
        ? [1, 0, 0, 1, 0, 0]
        : invertAffine(affine),
    });
  }
  return entries;
}

function readClipEntries(
  buf,
  offset,
  count,
  scrollTable = null,
  s = 1,
  originX = 0,
  originY = 0,
) {
  return readClipEntriesAt(
    buf,
    offset + CMD_PUSH_CLIP_HEADER_SIZE,
    count,
    scrollTable,
    s,
    originX,
    originY,
  );
}

// Conservative screen-space bounds of a clip state: the intersection of
// its axis-aligned entries' rectangles, per enabled axis. A rounded
// entry's SDF lies inside its rectangle, so the rectangle bounds it; an
// oriented or path-mask entry bounds nothing. A draw whose own bounds
// miss these produces no fragment, so the walker drops it before it
// costs an instance — a scrolled-away run under an overflow clip is
// never decoded into the frame.
function clipStateBounds(entries) {
  let minX = -Infinity, minY = -Infinity, maxX = Infinity, maxY = Infinity;
  for (const entry of entries) {
    if (entry.pathMask || entry.mode === 0) continue;
    const [a, b, c, d, e, f] = entry.inverseAffine;
    if (a !== 1 || b !== 0 || c !== 0 || d !== 1 || e !== 0 || f !== 0) {
      continue;
    }
    if (entry.axisBits & 1) {
      minX = Math.max(minX, entry.x);
      maxX = Math.min(maxX, entry.x + entry.w);
    }
    if (entry.axisBits & 2) {
      minY = Math.max(minY, entry.y);
      maxY = Math.min(maxY, entry.y + entry.h);
    }
  }
  if (
    minX === -Infinity && minY === -Infinity && maxX === Infinity &&
    maxY === Infinity
  ) return null;
  return { minX, minY, maxX, maxY };
}

// One float32x4 color from the command buffer. convertColor4 (HDR
// boundary, see buildBatches) applies when the walker converts authored
// colors into the high-dynamic-range working encoding.
function readColor4(buf, offset, convertColor4 = null) {
  const color = [
    buf.getFloat32(offset, true),
    buf.getFloat32(offset + 4, true),
    buf.getFloat32(offset + 8, true),
    buf.getFloat32(offset + 12, true),
  ];
  return convertColor4 === null ? color : convertColor4(color);
}

// gradientStopPool: a DataView over GRADIENT_STOP_POOL's live WASM bytes,
// passed down from render()'s own options (see its own comment) — readRect
// only ever sees the command stream itself (`buf`) plus whatever pooled
// resources its caller resolved beforehand, same pattern as
// atlases/images/svgPathAtlas (this function has no other way to reach
// engine memory: rasterize.js is deliberately memory-isolated from the
// WAT engine, everything it needs arrives as an explicit argument).
// Shared gradient-extension decode (P4/S7): both CMD_RECT and CMD_SVG_PATH
// (S7 step 2) carry the SAME 24-byte extension shape at a flag-dependent
// offset — one shared decoder rather than two copies that could drift.
// kindOff/stopCountOff/stopOffsetOff/geomOff are that command's own
// CMD_*_GRADIENT_OFFSET_* constants (identical VALUES across both commands
// today, but passed explicitly rather than assumed, since nothing enforces
// two independently-declared constant sets staying numerically identical).
// Reverse maps: wire id -> identifier name.
const GRADIENT_SPACE_IDS = Object.fromEntries(
  Object.entries(GRADIENT_SPACE_NAMES).map(([name, id]) => [id, name]),
);
const GRADIENT_HUE_IDS = Object.fromEntries(
  Object.entries(GRADIENT_HUE_NAMES).map(([name, id]) => [id, name]),
);

function readGradientExtension(
  buf,
  extOffset,
  gradientStopPool,
  kindOff,
  stopCountOff,
  stopOffsetOff,
  geomOff,
  convertColor4,
  s = 1,
) {
  const stopCount = buf.getUint8(extOffset + stopCountOff);
  const stopOffset = buf.getUint32(extOffset + stopOffsetOff, true);
  const rawStops = [];
  for (let i = 0; i < stopCount; i++) {
    const stopBase = stopOffset + i * GRADIENT_STOP_ENTRY_SIZE;
    rawStops.push({
      position: gradientStopPool.getFloat32(
        stopBase + GRADIENT_STOP_OFFSET_POSITION,
        true,
      ),
      // Authored extended encoded sRGB, straight alpha - NOT converted
      // here even in HDR mode: interpolation happens in the authored
      // space, and the shader converts the INTERPOLATED result into the
      // mode's working encoding (gradientColorToWorking).
      color: readColor4(
        gradientStopPool,
        stopBase + GRADIENT_STOP_OFFSET_COLOR,
      ),
      missingComponents: gradientStopPool.getUint32(
        stopBase + GRADIENT_STOP_OFFSET_MISSING,
        true,
      ),
    });
  }
  // Interpolation byte (packed space + hue method) at ext byte 3. The
  // stops convert into the interpolation space HERE, once per gradient;
  // hue fixup and missing-component resolution bake into the prepared
  // stops so the shader's walk stays a plain premultiplied lerp.
  const interpolationBits = buf.getUint8(extOffset + kindOff + 3);
  const spaceId = interpolationBits & 0x0f;
  const hueId = (interpolationBits >> 4) & 0x03;
  const interpolationSpace = GRADIENT_SPACE_IDS[spaceId];
  const hueMethod = GRADIENT_HUE_IDS[hueId];
  if (interpolationSpace === undefined) {
    throw new Error(
      `gradient extension: unknown interpolation space id ${spaceId}`,
    );
  }
  const stops = prepareGradientStops(rawStops, spaceId, hueId);
  const kind = buf.getUint8(extOffset + kindOff);
  // geom0..3 are PER-KIND (BG_KIND encoding: 1=linear, 2=radial,
  // 3=conic; bit 7 = repeating — the shader dispatch in rasterize.js is
  // the authority): linear{dx,dy,length,pad} — dx/dy is a dimensionless
  // unit direction, only length is px; radial{cx,cy,rx,ry} — all px;
  // conic{cx,cy,fromAngle,pad} — center px, angle radians. The raster
  // scale applies to the px fields only.
  const gradientKind = kind & 0x7f;
  const linear = gradientKind === 1;
  const conic = gradientKind === 3;
  const geom0 = buf.getFloat32(extOffset + geomOff, true);
  const geom1 = buf.getFloat32(extOffset + geomOff + 4, true);
  const geom2 = buf.getFloat32(extOffset + geomOff + 8, true);
  const geom3 = buf.getFloat32(extOffset + geomOff + 12, true);
  return {
    kind,
    // tiled (background-origin): the positioning area differs from the
    // painted rect — the shader wraps the sample position modulo the
    // origin rect below. Flags byte sits right after stopCount in both
    // ext layouts (CMD_RECT_GRADIENT_OFFSET_FLAGS).
    tiled: (buf.getUint8(extOffset + kindOff + 2) & 1) !== 0,
    geom0: linear ? geom0 : geom0 * s,
    geom1: linear ? geom1 : geom1 * s,
    geom2: conic ? geom2 : geom2 * s,
    geom3: gradientKind === 2 ? geom3 * s : geom3,
    // geom4..7: the ORIGIN RECT {dx, dy, w, h} (background-origin) —
    // rides straight into GradientRecord's second 4-float row.
    geom4: buf.getFloat32(extOffset + geomOff + 16, true) * s,
    geom5: buf.getFloat32(extOffset + geomOff + 20, true) * s,
    geom6: buf.getFloat32(extOffset + geomOff + 24, true) * s,
    geom7: buf.getFloat32(extOffset + geomOff + 28, true) * s,
    interpolationSpace,
    hueMethod,
    spaceId,
    // The shader converts the interpolated color into the mode's working
    // encoding; this flag selects linear Rec. 2020 over encoded sRGB.
    hdr: convertColor4 !== null,
    stops,
  };
}

function readRect(
  buf,
  offset,
  gradientStopPool,
  convertColor4,
  scrollX = 0,
  scrollY = 0,
  s = 1,
) {
  const flags = buf.getUint8(offset + CMD_RECT_OFFSET_FLAGS);
  const hasTransform = (flags & CMD_RECT_FLAG_TRANSFORM) !== 0;
  // Gradient extension (P4): its presence shifts every subsequent
  // command's offset, so `size` below must already account for it
  // regardless of whether gradient data is actually decoded (every
  // command-stream walker must agree on size — see CMD_RECT_FLAG_
  // GRADIENT's own comment).
  const hasGradient = (flags & CMD_RECT_FLAG_GRADIENT) !== 0;
  let gradient = null;
  if (hasGradient) {
    const extOffset = offset + CMD_RECT_OFFSET_XFORM + (hasTransform ? 24 : 0);
    gradient = readGradientExtension(
      buf,
      extOffset,
      gradientStopPool,
      CMD_RECT_GRADIENT_OFFSET_KIND,
      CMD_RECT_GRADIENT_OFFSET_STOP_COUNT,
      CMD_RECT_GRADIENT_OFFSET_STOP_OFFSET,
      CMD_RECT_GRADIENT_OFFSET_GEOM,
      convertColor4,
      s,
    );
  }
  // paintMode (P5c border-order fix): FLAG_FILL/FLAG_BORDER are normally
  // both set (paintMode 0 = fill+border, the default emitted everywhere).
  // WAT emits FILL-without-BORDER / BORDER-without-FILL as two separate
  // commands only for a node that has both a border and background-image
  // layers, so background-image can paint between them.
  const hasFill = (flags & CMD_RECT_FLAG_FILL) !== 0;
  const hasBorder = (flags & CMD_RECT_FLAG_BORDER) !== 0;
  const paintMode = (hasFill && !hasBorder)
    ? 1
    : (!hasFill && hasBorder)
    ? 2
    : 0;
  // border styles (P7): the packed 4-bit-per-side u16 rides to the shader
  // as one float (0..65535 is f32-exact); 0 = all solid.
  const borderStyles = buf.getUint16(
    offset + CMD_RECT_OFFSET_BORDER_STYLES,
    true,
  );
  // Pixel snapping, identical rule and identical reason to CMD_IMAGE's (see
  // render()'s own CMD_IMAGE batching): Chrome rounds a box's paint rect to
  // whole pixels in the element's pre-transform space and paints hard
  // edges, so a box at top:20.5px occupies rows 21-40, not 20-39 and not an
  // antialiased 20-40. Each edge is rounded independently and the size is
  // derived from the two rounded edges, which keeps abutting boxes abutting.
  //
  // The snap happens on the CSS-PIXEL grid, BEFORE the raster scale — the
  // raster-scale density decision of 2026-08-24: layout and pixel snapping
  // are computed once in CSS pixels, and density only multiplies the
  // raster. This matches the rasterScale-N oracle, where Chrome snaps its
  // LZF-1 paint on the CSS grid and the compositor scales the result.
  // Snapping after the multiply (the device grid) put edges on odd device
  // pixels no CSS-grid snap can produce — the grid-fractional @2x parity
  // failures.
  //
  // Applies to bordered and rounded boxes too: Blink snaps the border BOX
  // and applies the border widths and radii to the snapped rect
  // (RoundedBorderGeometry::PixelSnappedRoundedBorder), so with the
  // whole-number widths that dominate real content the inner ring and the
  // corner arcs come out on the same grid Chrome puts them on — verified
  // against a real Chrome render for a 4px border and a 6px radius at
  // top:20.5px, both of which land exactly where Chrome's do afterwards.
  //
  // CMD_RECT_FLAG_NO_PIXEL_SNAP opts a draw out. SVG shapes are the only
  // thing that sets it: their geometry is vector geometry in user space and
  // Chrome antialiases it rather than quantising it — see that constant's
  // own comment in layout.js for the measurement.
  const snap = (flags & CMD_RECT_FLAG_NO_PIXEL_SNAP) === 0;
  const cssX = buf.getFloat32(offset + CMD_RECT_OFFSET_X, true);
  const cssY = buf.getFloat32(offset + CMD_RECT_OFFSET_Y, true);
  const cssW = buf.getFloat32(offset + CMD_RECT_OFFSET_W, true);
  const cssH = buf.getFloat32(offset + CMD_RECT_OFFSET_H, true);
  const x = snap ? Math.round(cssX) * s : cssX * s;
  const y = snap ? Math.round(cssY) * s : cssY * s;
  const w = snap ? (Math.round(cssX + cssW) - Math.round(cssX)) * s : cssW * s;
  const h = snap ? (Math.round(cssY + cssH) - Math.round(cssY)) * s : cssH * s;
  const fill = readColor4(buf, offset + CMD_RECT_OFFSET_FILL, convertColor4);
  // Per-side colors and widths go to the shader AS FOUR VALUES each
  // (Slice P2) — the old max()-collapse to a single width rendered any
  // asymmetric-width border wrong (all four sides at the widest side's
  // width) and made per-side color meaningless.
  const borderColorTop = readColor4(
    buf,
    offset + CMD_RECT_OFFSET_BORDER_COLOR_TOP,
    convertColor4,
  );
  const borderColorRight = readColor4(
    buf,
    offset + CMD_RECT_OFFSET_BORDER_COLOR_RIGHT,
    convertColor4,
  );
  const borderColorBottom = readColor4(
    buf,
    offset + CMD_RECT_OFFSET_BORDER_COLOR_BOTTOM,
    convertColor4,
  );
  const borderColorLeft = readColor4(
    buf,
    offset + CMD_RECT_OFFSET_BORDER_COLOR_LEFT,
    convertColor4,
  );
  const bt = buf.getFloat32(offset + CMD_RECT_OFFSET_BORDER_TOP, true) * s;
  const br = buf.getFloat32(offset + CMD_RECT_OFFSET_BORDER_RIGHT, true) * s;
  const bb = buf.getFloat32(offset + CMD_RECT_OFFSET_BORDER_BOTTOM, true) * s;
  const bl = buf.getFloat32(offset + CMD_RECT_OFFSET_BORDER_LEFT, true) * s;
  // P10: radii are (rx,ry) pairs per corner — a circular corner is simply
  // rx==ry (every pre-P10 caller writes the same value to both).
  const radiusTopLeftX = buf.getFloat32(
    offset + CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X,
    true,
  ) * s;
  const radiusTopLeftY = buf.getFloat32(
    offset + CMD_RECT_OFFSET_RADIUS_TOP_LEFT_Y,
    true,
  ) * s;
  const radiusTopRightX = buf.getFloat32(
    offset + CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_X,
    true,
  ) * s;
  const radiusTopRightY = buf.getFloat32(
    offset + CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_Y,
    true,
  ) * s;
  const radiusBottomRightX = buf.getFloat32(
    offset + CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_X,
    true,
  ) * s;
  const radiusBottomRightY = buf.getFloat32(
    offset + CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_Y,
    true,
  ) * s;
  const radiusBottomLeftX = buf.getFloat32(
    offset + CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_X,
    true,
  ) * s;
  const radiusBottomLeftY = buf.getFloat32(
    offset + CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_Y,
    true,
  ) * s;
  // D2 piece B (scroll-layer compositing): the shader applies the affine
  // unconditionally (identity default), so the current scroll offset
  // rides the translation components — final = M(payload) + scroll.
  let ta = 1, tb = 0, tc = 0, td = 1, te = scrollX, tf = scrollY;
  if (hasTransform) {
    ta = buf.getFloat32(offset + CMD_RECT_OFFSET_XFORM, true);
    tb = buf.getFloat32(offset + CMD_RECT_OFFSET_XFORM + 4, true);
    tc = buf.getFloat32(offset + CMD_RECT_OFFSET_XFORM + 8, true);
    td = buf.getFloat32(offset + CMD_RECT_OFFSET_XFORM + 12, true);
    te = buf.getFloat32(offset + CMD_RECT_OFFSET_XFORM + 16, true) * s +
      scrollX;
    tf = buf.getFloat32(offset + CMD_RECT_OFFSET_XFORM + 20, true) * s +
      scrollY;
  }
  return {
    size: CMD_RECT_SIZE + (hasTransform ? 24 : 0) +
      (hasGradient ? CMD_RECT_GRADIENT_EXT_SIZE : 0),
    // radiiX and radiiY are two CONTIGUOUS vec4s (tl,tr,br,bl each), matching
    // the GPU pipeline's fixed byte-offset attributes — NOT interleaved
    // per-corner (rx,ry) pairs.
    data: [
      x,
      y,
      w,
      h,
      ...fill,
      ...borderColorTop,
      ...borderColorRight,
      ...borderColorBottom,
      ...borderColorLeft,
      bt,
      br,
      bb,
      bl,
      radiusTopLeftX,
      radiusTopRightX,
      radiusBottomRightX,
      radiusBottomLeftX,
      radiusTopLeftY,
      radiusTopRightY,
      radiusBottomRightY,
      radiusBottomLeftY,
      ta,
      tb,
      tc,
      td,
      te,
      tf,
      paintMode,
      borderStyles,
    ],
    // P4: null when this rect has no gradient (the common case) — the
    // batching loop pushes this straight into currentRectGradients,
    // parallel to `data` above (see that array's own comment).
    gradient,
  };
}

// Decode one CMD_BOX_SHADOW record (P3). For INSET shadows, also decodes
// the border-box extension (the node's own unspread rect+radii, for the
// shader's outer clip — see layout.js's own doc comment on why inset
// needs this SECOND rect+radii distinct from the main one, which for
// inset holds the spread-deflated "hole" boundary instead).
function readBoxShadow(
  buf,
  offset,
  convertColor4,
  scrollX = 0,
  scrollY = 0,
  s = 1,
) {
  const flags = buf.getUint8(offset + CMD_BOX_SHADOW_OFFSET_FLAGS);
  const isInset = (flags & CMD_BOX_SHADOW_FLAG_INSET) !== 0;
  const hasTransform = (flags & CMD_BOX_SHADOW_FLAG_TRANSFORM) !== 0;
  const x = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_X, true) * s;
  const y = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_Y, true) * s;
  const w = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_W, true) * s;
  const h = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_H, true) * s;
  // Wire format is INTERLEAVED (rx,ry) per corner (CMD_PUSH_CLIP's own
  // convention) — de-interleave into the two-contiguous-vec4 shape the
  // GPU pipeline's vertex attributes expect, same as readRect does for
  // CMD_RECT's own (differently-encoded) radii fields.
  const radiusTopLeftX = buf.getFloat32(
    offset + CMD_BOX_SHADOW_OFFSET_RADII,
    true,
  ) * s;
  const radiusTopLeftY = buf.getFloat32(
    offset + CMD_BOX_SHADOW_OFFSET_RADII + 4,
    true,
  ) * s;
  const radiusTopRightX = buf.getFloat32(
    offset + CMD_BOX_SHADOW_OFFSET_RADII + 8,
    true,
  ) * s;
  const radiusTopRightY = buf.getFloat32(
    offset + CMD_BOX_SHADOW_OFFSET_RADII + 12,
    true,
  ) * s;
  const radiusBottomRightX = buf.getFloat32(
    offset + CMD_BOX_SHADOW_OFFSET_RADII + 16,
    true,
  ) * s;
  const radiusBottomRightY = buf.getFloat32(
    offset + CMD_BOX_SHADOW_OFFSET_RADII + 20,
    true,
  ) * s;
  const radiusBottomLeftX = buf.getFloat32(
    offset + CMD_BOX_SHADOW_OFFSET_RADII + 24,
    true,
  ) * s;
  const radiusBottomLeftY = buf.getFloat32(
    offset + CMD_BOX_SHADOW_OFFSET_RADII + 28,
    true,
  ) * s;
  const color = readColor4(
    buf,
    offset + CMD_BOX_SHADOW_OFFSET_COLOR,
    convertColor4,
  );
  const blurSigma = buf.getFloat32(
    offset + CMD_BOX_SHADOW_OFFSET_BLUR_SIGMA,
    true,
  ) * s;
  // D2 piece B: scroll rides the affine translation (see readRect).
  let ta = 1, tb = 0, tc = 0, td = 1, te = scrollX, tf = scrollY;
  if (hasTransform) {
    ta = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_XFORM, true);
    tb = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_XFORM + 4, true);
    tc = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_XFORM + 8, true);
    td = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_XFORM + 12, true);
    te = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_XFORM + 16, true) * s +
      scrollX;
    tf = buf.getFloat32(offset + CMD_BOX_SHADOW_OFFSET_XFORM + 20, true) * s +
      scrollY;
  }
  // Outset shadows have no border-box extension — the instance's own
  // "border box" fields simply mirror the main rect/radii (a no-op
  // clip/inversion for the shader when isInset is 0, see BOX_SHADOW_
  // SHADER's own fragment-shader branch).
  let borderBoxX = x, borderBoxY = y, borderBoxW = w, borderBoxH = h;
  let borderRadiusTopLeftX = radiusTopLeftX,
    borderRadiusTopLeftY = radiusTopLeftY;
  let borderRadiusTopRightX = radiusTopRightX,
    borderRadiusTopRightY = radiusTopRightY;
  let borderRadiusBottomRightX = radiusBottomRightX,
    borderRadiusBottomRightY = radiusBottomRightY;
  let borderRadiusBottomLeftX = radiusBottomLeftX,
    borderRadiusBottomLeftY = radiusBottomLeftY;
  if (isInset) {
    const extOffset = offset + cmdBoxShadowInsetClipOffset(hasTransform);
    borderBoxX = buf.getFloat32(
      extOffset + CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_X,
      true,
    ) * s;
    borderBoxY = buf.getFloat32(
      extOffset + CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_Y,
      true,
    ) * s;
    borderBoxW = buf.getFloat32(
      extOffset + CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_W,
      true,
    ) * s;
    borderBoxH = buf.getFloat32(
      extOffset + CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_H,
      true,
    ) * s;
    const r = extOffset + CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_RADII;
    borderRadiusTopLeftX = buf.getFloat32(r, true) * s;
    borderRadiusTopLeftY = buf.getFloat32(r + 4, true) * s;
    borderRadiusTopRightX = buf.getFloat32(r + 8, true) * s;
    borderRadiusTopRightY = buf.getFloat32(r + 12, true) * s;
    borderRadiusBottomRightX = buf.getFloat32(r + 16, true) * s;
    borderRadiusBottomRightY = buf.getFloat32(r + 20, true) * s;
    borderRadiusBottomLeftX = buf.getFloat32(r + 24, true) * s;
    borderRadiusBottomLeftY = buf.getFloat32(r + 28, true) * s;
  }
  return {
    size: cmdBoxShadowSize(hasTransform, isInset),
    isInset,
    blurSigma,
    data: [
      x,
      y,
      w,
      h,
      ...color,
      radiusTopLeftX,
      radiusTopRightX,
      radiusBottomRightX,
      radiusBottomLeftX,
      radiusTopLeftY,
      radiusTopRightY,
      radiusBottomRightY,
      radiusBottomLeftY,
      ta,
      tb,
      tc,
      td,
      te,
      tf,
      blurSigma,
      isInset ? 1 : 0,
      borderBoxX,
      borderBoxY,
      borderBoxW,
      borderBoxH,
      borderRadiusTopLeftX,
      borderRadiusTopRightX,
      borderRadiusBottomRightX,
      borderRadiusBottomLeftX,
      borderRadiusTopLeftY,
      borderRadiusTopRightY,
      borderRadiusBottomRightY,
      borderRadiusBottomLeftY,
    ],
  };
}

// Rect instance stride in floats — MUST match the rect pipeline's
// per-instance vertex layout in each backend (44 floats: pos(2) + size(2)
// + fill(4) + border colors(16) + widths(4) + radiiX(4) + radiiY(4) +
// transform(6) + paintMode/borderStyles(2)).
const RECT_INSTANCE_FLOATS = 44;
// Text instance stride in floats — MUST match the text pipeline's
// per-instance vertex layout in each backend (20 floats: pos(2) + size(2)
// + atlas uv(4) + color(4) + pxRange(1) + shadowSoft(1) + transform(6)).
const TEXT_INSTANCE_FLOATS = 20;

// Decode the engine's binary command stream into an ordered batch list.
// This is the single shared command walker: it validates record sizes,
// throws on unknown opcodes, and produces backend-neutral batch objects.
// resources: { atlases, glyphBuffer, svgPathAtlas, images,
// gradientStopPool, deviceScale, renderMode, overlayRects } — all
// optional, same semantics as the former render() options of the same
// names. renderMode (default "standard") selects the HDR boundary
// conversion above. overlayRects appends a final on-top rect batch (see
// the emission at the end of the walk).
export function buildBatches(commandBuffer, commandBytes, resources = {}) {
  const {
    atlases = null,
    glyphBuffer = null,
    svgPathAtlas = null,
    images = null,
    gradientStopPool = null,
    // Raster scale: the command stream carries CSS-pixel coordinates
    // (the engine lays out in CSS pixels); the walker multiplies every
    // length by this scale, so instance data reaches the raster backends
    // in device pixels, exactly as before the raster-scale cutover.
    deviceScale = 1,
    renderMode = "standard",
    overlayRects = null,
    // D2 piece B: Float32Array over the engine's SCROLL_TABLE region
    // ([ref*2] = dx, [ref*2+1] = dy, CSS px). null tolerates callers
    // rendering streams that never emit CMD_SET_SCROLL.
    scrollTable = null,
    // Visible-region rasterization (raster-scale plan, slice 3): the
    // CSS-pixel rectangle of the scene the raster target covers. null
    // covers the full scene. The walker subtracts the origin from every
    // draw's translation (the same slot scroll rides) and culls a draw
    // whose conservative device-pixel bounds miss the target.
    visibleRectangle = null,
  } = resources;
  const s = deviceScale;
  const originX = visibleRectangle ? visibleRectangle.x * s : 0;
  const originY = visibleRectangle ? visibleRectangle.y * s : 0;
  const cullWidth = visibleRectangle ? visibleRectangle.width * s : Infinity;
  const cullHeight = visibleRectangle ? visibleRectangle.height * s : Infinity;
  // Conservative device-pixel bounds test against the raster target AND
  // the current clip state's bounds (clipStateBounds). An
  // identity-or-translate transform gives exact bounds; a rotated or
  // skewed affine transforms the four corners. Bounds are inflated by
  // `inflate` (blur reach, antialiasing padding).
  function culled(x, y, w, h, ta, tb, tc, td, te, tf, inflate = 2) {
    const clipBounds = currentClipState.bounds;
    if (cullWidth === Infinity && clipBounds === null) return false;
    let minX, minY, maxX, maxY;
    if (tb === 0 && tc === 0 && ta === 1 && td === 1) {
      minX = x + te;
      minY = y + tf;
      maxX = minX + w;
      maxY = minY + h;
    } else {
      minX = Infinity;
      minY = Infinity;
      maxX = -Infinity;
      maxY = -Infinity;
      for (
        const [cornerX, cornerY] of [
          [x, y],
          [x + w, y],
          [x, y + h],
          [x + w, y + h],
        ]
      ) {
        const screenX = ta * cornerX + tc * cornerY + te;
        const screenY = tb * cornerX + td * cornerY + tf;
        minX = Math.min(minX, screenX);
        minY = Math.min(minY, screenY);
        maxX = Math.max(maxX, screenX);
        maxY = Math.max(maxY, screenY);
      }
    }
    let left = cullWidth === Infinity ? -Infinity : 0;
    let top = cullWidth === Infinity ? -Infinity : 0;
    let right = cullWidth;
    let bottom = cullHeight;
    if (clipBounds !== null) {
      left = Math.max(left, clipBounds.minX);
      top = Math.max(top, clipBounds.minY);
      right = Math.min(right, clipBounds.maxX);
      bottom = Math.min(bottom, clipBounds.maxY);
    }
    return maxX + inflate < left || maxY + inflate < top ||
      minX - inflate > right || minY - inflate > bottom;
  }
  // Current scroll offset selected by the last CMD_SET_SCROLL record,
  // already in device pixels.
  let scrollX = -originX, scrollY = -originY;
  const INSTANCE_FLOATS = RECT_INSTANCE_FLOATS;
  const convertColor4 = renderMode === "high-dynamic-range"
    ? convertEncodedSrgbColor4ToWorkingRec2020
    : null;
  // --- First pass: scan commands, build batches ---
  const clipStack = [];
  const opacityStack = [];
  // P11: the mask accumulator stack (one per CMD_PUSH_MASK, popped by the
  // flagged CMD_POP_OPACITY) and, within one accumulator, the stack of
  // in-progress layer scratch targets.
  const maskStack = [];
  const maskLayerStack = [];
  // P13: the background stack's own accumulator (one per
  // CMD_PUSH_BACKGROUND) and, within it, the in-progress blended layer's
  // scratch target.
  const backgroundStack = [];
  const blendLayerStack = [];

  // A batch: { type, clipState, instanceData: Float32Array, count, opacityInfo? }
  const batches = [];
  const retainedRecords = resources.commandRetention?.owner != null
    ? new Map()
    : null;
  let currentRectRecords = retainedRecords ? [] : null;
  let pendingOpacityBatch = null;
  let currentRectInstances = [];
  // Parallel to currentRectInstances (P4): one entry per rect INSTANCE in
  // the batch (null when that instance has no gradient) — kept separate
  // from the fixed-width Float32Array above because gradient data doesn't
  // fit the vertex-attribute-limited instance stride (see the shader's own
  // GradientRecord comment); it rides a storage buffer instead, built from
  // this array right before the batch's draw call.
  let currentRectGradients = [];
  let currentClipState = EMPTY_CLIP_STATE;

  function flushRects() {
    if (currentRectInstances.length === 0) return;
    batches.push({
      type: "rect",
      clipState: currentClipState,
      instances: new Float32Array(currentRectInstances),
      count: currentRectInstances.length / INSTANCE_FLOATS,
      gradients: currentRectGradients,
    });
    if (currentRectRecords) {
      const batch = batches[batches.length - 1];
      for (let i = 0; i < currentRectRecords.length; i++) {
        currentRectRecords[i].batch = batch;
        currentRectRecords[i].index = i;
      }
      currentRectRecords = [];
    }
    currentRectInstances = [];
    currentRectGradients = [];
  }

  // box-shadow (P3): its own accumulator, same batching shape as rects
  // (many shadows in one scene should be one draw call) but a DIFFERENT
  // instance stride/pipeline (no border/gradient fields a shadow has no
  // use for) — see readBoxShadow's own comment for why this isn't folded
  // into currentRectInstances.
  let currentShadowInstances = [];

  // P8 / P8b: shared by CMD_PUSH_OPACITY and CMD_PUSH_BACKDROP_FILTER — both
  // carry the identical segment-list wire extension (CMD_PUSH_OPACITY_
  // SEGMENT_*, same KIND enum and per-segment payload layout; backdrop-
  // filter's own command just omits the alpha/blendMode header fields).
  function readFilterSegments(offset, segmentsBase, segmentCount) {
    const filterSegments = [];
    for (let i = 0; i < segmentCount; i++) {
      const segBase = segmentsBase + i * CMD_PUSH_OPACITY_SEGMENT_SIZE;
      const kind = commandBuffer.getUint8(
        segBase + CMD_PUSH_OPACITY_SEGMENT_OFFSET_KIND,
      );
      const payloadOffset = segBase + CMD_PUSH_OPACITY_SEGMENT_OFFSET_PAYLOAD;
      if (kind === CMD_PUSH_OPACITY_SEGMENT_KIND_MATRIX) {
        const matrix = new Float32Array(20);
        for (let j = 0; j < 20; j++) {
          matrix[j] = commandBuffer.getFloat32(payloadOffset + j * 4, true);
        }
        filterSegments.push({ kind: "matrix", matrix });
      } else if (kind === CMD_PUSH_OPACITY_SEGMENT_KIND_BLUR) {
        filterSegments.push({
          kind: "blur",
          sigma: commandBuffer.getFloat32(payloadOffset, true) * s,
        });
      } else if (kind === CMD_PUSH_OPACITY_SEGMENT_KIND_DROP_SHADOW) {
        const dx = commandBuffer.getFloat32(payloadOffset + 0, true) * s;
        const dy = commandBuffer.getFloat32(payloadOffset + 4, true) * s;
        const sigma = commandBuffer.getFloat32(payloadOffset + 8, true) * s;
        // Four 32-bit color floats at payload[3..6] — full precision,
        // the SAME layout writeFilters (scene-renderer.js) stores in
        // FILTER_POOL's own drop-shadow payload.
        const raw = readColor4(
          commandBuffer,
          payloadOffset + 12,
          convertColor4,
        );
        const color = { r: raw[0], g: raw[1], b: raw[2], a: raw[3] };
        filterSegments.push({ kind: "drop-shadow", dx, dy, sigma, color });
      } else {
        throw new Error(
          `filter segment list: unknown kind ${kind} at command-stream offset ${segBase}`,
        );
      }
    }
    return filterSegments;
  }

  function flushShadows() {
    if (currentShadowInstances.length === 0) return;
    batches.push({
      type: "boxShadow",
      clipState: currentClipState,
      instances: new Float32Array(currentShadowInstances),
      count: currentShadowInstances.length / BOX_SHADOW_INSTANCE_FLOATS,
    });
    currentShadowInstances = [];
  }

  // Text: consecutive runs sharing one atlas and one clip state are ONE
  // draw, exactly as rects are. A line of inline spans differs from a
  // line with one text node only in colour, which rides per instance;
  // the batch count follows atlas and clip boundaries, never the number
  // of runs.
  let currentTextInstances = [];
  let currentTextAtlas = null;

  function flushText() {
    if (currentTextInstances.length === 0) return;
    batches.push({
      type: "text",
      clipState: currentClipState,
      instances: new Float32Array(currentTextInstances),
      count: currentTextInstances.length / TEXT_INSTANCE_FLOATS,
      atlas: currentTextAtlas,
    });
    currentTextInstances = [];
    currentTextAtlas = null;
  }

  // Every batch boundary (clip, group, image, path, end of stream) closes
  // all three accumulators; batches execute in push order.
  function flushDraws() {
    flushRects();
    flushShadows();
    flushText();
  }

  let offset = 0;
  let decodedCommandCount = 0;
  while (offset < commandBytes) {
    decodedCommandCount++;
    const opcode = commandBuffer.getUint8(offset);

    if (opcode === CMD_SET_NODE) {
      offset += CMD_SET_NODE_SIZE;
    } else if (opcode === CMD_SET_SCROLL) {
      // D2 piece B: select the current scroll offset. flush* is not
      // required — the offset rides per-instance data, not batch state.
      const scrollRef = commandBuffer.getUint16(
        offset + CMD_SET_SCROLL_OFFSET_REF,
        true,
      );
      if (scrollTable !== null && scrollRef !== 0) {
        scrollX = scrollTable[scrollRef * 2] * s - originX;
        scrollY = scrollTable[scrollRef * 2 + 1] * s - originY;
      } else {
        scrollX = -originX;
        scrollY = -originY;
      }
      offset += CMD_SET_SCROLL_SIZE;
    } else if (opcode === CMD_RECT) {
      // box-shadow (P3): outset shadows are emitted BEFORE this node's own
      // CMD_RECT; flush any accumulated shadow batch first so it doesn't
      // get reordered to draw AFTER a rect that should paint on top of it
      // (batches execute in the order they were pushed — see flushShadows'
      // own comment).
      flushShadows();
      flushText();
      const rect = readRect(
        commandBuffer,
        offset,
        gradientStopPool,
        convertColor4,
        scrollX,
        scrollY,
        s,
      );
      const record = retainedRecords
        ? {
          offset,
          size: rect.size,
          scrollX,
          scrollY,
          data: rect.data,
        }
        : null;
      retainedRecords?.set(offset, record);
      offset += rect.size;
      if (
        culled(
          rect.data[0],
          rect.data[1],
          rect.data[2],
          rect.data[3],
          rect.data[36],
          rect.data[37],
          rect.data[38],
          rect.data[39],
          rect.data[40],
          rect.data[41],
        )
      ) continue;
      currentRectRecords?.push(record);
      currentRectInstances.push(...rect.data);
      currentRectGradients.push(rect.gradient);
    } else if (opcode === CMD_BOX_SHADOW) {
      flushRects();
      flushText();
      const shadow = readBoxShadow(
        commandBuffer,
        offset,
        convertColor4,
        scrollX,
        scrollY,
        s,
      );
      offset += shadow.size;
      if (
        culled(
          shadow.data[0],
          shadow.data[1],
          shadow.data[2],
          shadow.data[3],
          shadow.data[16],
          shadow.data[17],
          shadow.data[18],
          shadow.data[19],
          shadow.data[20],
          shadow.data[21],
          3 * shadow.blurSigma + 2,
        )
      ) continue;
      currentShadowInstances.push(...shadow.data);
    } else if (opcode === CMD_PUSH_CLIP) {
      flushDraws();
      // Oriented-clip redesign: every push carries the COMPLETE clip
      // state (count + entries) and REPLACES the current one — the
      // engine ($clipListAppend) is the single intersection authority,
      // so this stack is pure save/restore, never an intersection engine.
      const entryCount = commandBuffer.getUint8(
        offset + CMD_PUSH_CLIP_OFFSET_COUNT,
      );
      if (entryCount === 0) {
        currentClipState = EMPTY_CLIP_STATE;
      } else {
        const entries = readClipEntries(
          commandBuffer,
          offset,
          entryCount,
          scrollTable,
          s,
          originX,
          originY,
        );
        currentClipState = { entries, bounds: clipStateBounds(entries) };
      }
      clipStack.push(currentClipState);
      if (pendingOpacityBatch) {
        const ancestorMasks = new Set(
          (pendingOpacityBatch.clipState?.entries ?? [])
            .filter((entry) => entry.pathMask)
            .map((entry) =>
              `${entry.pathMask.pathIndex}:${entry.x}:${entry.y}:${entry.w}:${entry.h}`
            ),
        );
        pendingOpacityBatch.pathMask = currentClipState.entries.find((entry) =>
          entry.pathMask &&
          !ancestorMasks.has(
            `${entry.pathMask.pathIndex}:${entry.x}:${entry.y}:${entry.w}:${entry.h}`,
          )
        ) ?? null;
        pendingOpacityBatch = null;
      }
      offset += cmdPushClipSize(entryCount);
    } else if (opcode === CMD_POP_CLIP) {
      flushDraws();
      clipStack.pop();
      currentClipState = clipStack.length > 0
        ? clipStack[clipStack.length - 1]
        : EMPTY_CLIP_STATE;
      offset += CMD_POP_CLIP_SIZE;
    } else if (opcode === CMD_PUSH_OPACITY) {
      flushDraws();
      const opacity = commandBuffer.getFloat32(
        offset + CMD_PUSH_OPACITY_OFFSET_ALPHA,
        true,
      );
      const flags = commandBuffer.getUint8(
        offset + CMD_PUSH_OPACITY_OFFSET_FLAGS,
      );
      const blendMode = (flags & CMD_PUSH_OPACITY_FLAG_BLEND_MASK) >>
        CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT;
      const segmentCount = commandBuffer.getUint16(
        offset + CMD_PUSH_OPACITY_OFFSET_SEGMENT_COUNT,
        true,
      );
      const filterSegments = readFilterSegments(
        offset,
        offset + CMD_PUSH_OPACITY_OFFSET_SEGMENTS,
        segmentCount,
      );
      // P8b: clipState is the ANCESTOR clip active AT PUSH TIME — an
      // ordinary opacity/blend group's own content already respects its
      // own shape internally (painted inside its own CMD_PUSH_CLIP scope
      // right after this push), so nothing further is needed here.
      pendingOpacityBatch = {
        type: "pushOpacity",
        opacity,
        blendMode,
        filterSegments,
        clipState: currentClipState,
        hasMask: (flags & CMD_PUSH_OPACITY_FLAG_MASK) !== 0,
      };
      batches.push(pendingOpacityBatch);
      const size = cmdPushOpacitySize(segmentCount);
      retainedRecords?.set(offset, {
        offset,
        size,
        batch: pendingOpacityBatch,
        bytes: new Uint8Array(
          commandBuffer.buffer,
          commandBuffer.byteOffset + offset,
          size,
        ).slice(),
      });
      offset += cmdPushOpacitySize(segmentCount);
    } else if (opcode === CMD_POP_OPACITY) {
      flushDraws();
      batches.push({ type: "popOpacity" });
      offset += CMD_POP_OPACITY_SIZE;
    } else if (opcode === CMD_PUSH_BACKGROUND) {
      flushDraws();
      batches.push({ type: "pushBackground" });
      offset += CMD_PUSH_BACKGROUND_SIZE;
    } else if (opcode === CMD_POP_BACKGROUND) {
      flushDraws();
      batches.push({ type: "popBackground" });
      offset += CMD_POP_BACKGROUND_SIZE;
    } else if (opcode === CMD_PUSH_BLEND_LAYER) {
      flushDraws();
      batches.push({
        type: "pushBlendLayer",
        blendMode: commandBuffer.getUint8(
          offset + CMD_PUSH_BLEND_LAYER_OFFSET_MODE,
        ),
      });
      offset += CMD_PUSH_BLEND_LAYER_SIZE;
    } else if (opcode === CMD_POP_BLEND_LAYER) {
      flushDraws();
      batches.push({ type: "popBlendLayer" });
      offset += CMD_POP_BLEND_LAYER_SIZE;
    } else if (opcode === CMD_PUSH_MASK) {
      flushDraws();
      batches.push({ type: "pushMask" });
      offset += CMD_PUSH_MASK_SIZE;
    } else if (opcode === CMD_PUSH_MASK_LAYER) {
      flushDraws();
      batches.push({
        type: "pushMaskLayer",
        mode: commandBuffer.getUint8(offset + CMD_PUSH_MASK_LAYER_OFFSET_MODE),
        composite: commandBuffer.getUint8(
          offset + CMD_PUSH_MASK_LAYER_OFFSET_COMPOSITE,
        ),
      });
      offset += CMD_PUSH_MASK_LAYER_SIZE;
    } else if (opcode === CMD_POP_MASK_LAYER) {
      flushDraws();
      batches.push({ type: "popMaskLayer" });
      offset += CMD_POP_MASK_LAYER_SIZE;
    } else if (opcode === CMD_PUSH_BACKDROP_FILTER) {
      flushDraws();
      const segmentCount = commandBuffer.getUint16(
        offset + CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENT_COUNT,
        true,
      );
      const filterSegments = readFilterSegments(
        offset,
        offset + CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENTS,
        segmentCount,
      );
      // P8b: the command's own trailing payload carries exactly ONE
      // CLIP_ENTRY — this element's own border box (+ radii), per spec
      // (filter-effects-2: clipped to the element's own border box,
      // independent of overflow/clip-path). Read directly from the wire,
      // NOT via the ordinary clip stack — that stack's "own resolved clip
      // tier" is empty for a plain node with no overflow:hidden/clip-path
      // of its own, which is correct for an ordinary opacity/blend group
      // (its own content already respects it internally) but WRONG for
      // backdrop-filter's own composite-back, which must clip to the
      // border box unconditionally. See layout.js's own doc comment.
      const ownShapeOffset = offset +
        cmdPushBackdropFilterOwnShapeOffset(segmentCount);
      const ownClipState = {
        entries: readClipEntriesAt(
          commandBuffer,
          ownShapeOffset,
          1,
          scrollTable,
          s,
          originX,
          originY,
        ),
      };
      batches.push({
        type: "pushBackdropFilter",
        filterSegments,
        ownClipState,
      });
      offset += cmdPushBackdropFilterSize(segmentCount);
    } else if (opcode === CMD_POP_BACKDROP_FILTER) {
      // No render-side action — CMD_PUSH_BACKDROP_FILTER already did all
      // the work (snapshot + filter + composite-back) in a single step,
      // unlike CMD_PUSH_OPACITY/CMD_POP_OPACITY's offscreen-target stack.
      // The pop exists purely for wire-format symmetry with the WAT side's
      // emission (see $paintContext's own doc comment).
      offset += CMD_POP_BACKDROP_FILTER_SIZE;
    } else if (opcode === CMD_TEXT) {
      // Parse (and advance past) every text command even when the caller
      // passed no atlases/glyphBuffer — a rect-only caller must still walk
      // THROUGH text commands, or everything after the first one (rects,
      // clip pops, …) would be silently dropped. Only the drawing is
      // conditional on the text resources.
      flushRects();
      flushShadows();
      const flags = commandBuffer.getUint8(offset + CMD_TEXT_OFFSET_FLAGS);
      const hasTransform = (flags & CMD_TEXT_FLAG_TRANSFORM) !== 0;
      const hasTextShadow = (flags & CMD_TEXT_FLAG_TEXT_SHADOW) !== 0;
      const cmdSize = cmdTextSize(hasTransform, hasTextShadow);
      const glyphCount = commandBuffer.getUint16(
        offset + CMD_TEXT_OFFSET_GCOUNT,
        true,
      );
      const glyphOff = commandBuffer.getUint32(
        offset + CMD_TEXT_OFFSET_GOFF,
        true,
      );
      let textX = commandBuffer.getFloat32(offset + CMD_TEXT_OFFSET_X, true) *
        s;
      let textY = commandBuffer.getFloat32(offset + CMD_TEXT_OFFSET_Y, true) *
        s;
      // The command stream carries the CSS-pixel font size; the atlas key
      // wants the CSS optical size and the texel budget wants the
      // device-pixel size (see the glyphInfo call below).
      const fontSizeCss = commandBuffer.getFloat32(
        offset + CMD_TEXT_OFFSET_FSIZE,
        true,
      );
      const fontSize = fontSizeCss * s;
      const baseline = commandBuffer.getFloat32(
        offset + CMD_TEXT_OFFSET_BL,
        true,
      ) * s;
      let cr = commandBuffer.getFloat32(offset + CMD_TEXT_OFFSET_COLOR, true);
      let cg = commandBuffer.getFloat32(
        offset + CMD_TEXT_OFFSET_COLOR + 4,
        true,
      );
      let cb = commandBuffer.getFloat32(
        offset + CMD_TEXT_OFFSET_COLOR + 8,
        true,
      );
      let ca = commandBuffer.getFloat32(
        offset + CMD_TEXT_OFFSET_COLOR + 12,
        true,
      );
      // text-shadow (P6): a shadow-flagged CMD_TEXT is the SAME run drawn
      // in the shadow's color at the shadow's offset (applied in local,
      // pre-transform space — matching Chrome, which offsets the glyph
      // mask before the canvas CTM), with the blur sigma carried to the
      // shader as a ramp-widening parameter per instance.
      let shadowSoft = 0;
      if (hasTextShadow) {
        const ext = offset + cmdTextShadowExtOffset(hasTransform);
        cr = commandBuffer.getFloat32(ext + CMD_TEXT_SHADOW_OFFSET_COLOR, true);
        cg = commandBuffer.getFloat32(
          ext + CMD_TEXT_SHADOW_OFFSET_COLOR + 4,
          true,
        );
        cb = commandBuffer.getFloat32(
          ext + CMD_TEXT_SHADOW_OFFSET_COLOR + 8,
          true,
        );
        ca = commandBuffer.getFloat32(
          ext + CMD_TEXT_SHADOW_OFFSET_COLOR + 12,
          true,
        );
        textX += commandBuffer.getFloat32(
          ext + CMD_TEXT_SHADOW_OFFSET_OFFSET_X,
          true,
        ) * s;
        textY += commandBuffer.getFloat32(
          ext + CMD_TEXT_SHADOW_OFFSET_OFFSET_Y,
          true,
        ) * s;
        shadowSoft = commandBuffer.getFloat32(
          ext + CMD_TEXT_SHADOW_OFFSET_BLUR_SIGMA,
          true,
        ) * s;
      }
      if (convertColor4 !== null) {
        [cr, cg, cb, ca] = convertColor4([cr, cg, cb, ca]);
      }
      const upem = commandBuffer.getUint16(offset + CMD_TEXT_OFFSET_UPEM, true);
      const fontIndex = commandBuffer.getUint16(
        offset + CMD_TEXT_OFFSET_FONT,
        true,
      );
      const fontWeight =
        commandBuffer.getUint8(offset + CMD_TEXT_OFFSET_WEIGHT) * 100;
      const fontStyleItalic =
        commandBuffer.getUint8(offset + CMD_TEXT_OFFSET_STYLE) === 1;
      let ta = 1, tb = 0, tc = 0, td = 1, te = scrollX, tf = scrollY;
      if (hasTransform) {
        ta = commandBuffer.getFloat32(offset + CMD_TEXT_OFFSET_XFORM, true);
        tb = commandBuffer.getFloat32(offset + CMD_TEXT_OFFSET_XFORM + 4, true);
        tc = commandBuffer.getFloat32(offset + CMD_TEXT_OFFSET_XFORM + 8, true);
        td = commandBuffer.getFloat32(
          offset + CMD_TEXT_OFFSET_XFORM + 12,
          true,
        );
        te = commandBuffer.getFloat32(
              offset + CMD_TEXT_OFFSET_XFORM + 16,
              true,
            ) * s + scrollX;
        tf = commandBuffer.getFloat32(
              offset + CMD_TEXT_OFFSET_XFORM + 20,
              true,
            ) * s + scrollY;
      }
      offset += cmdSize;

      const atlasEntry = atlases ? atlases.get(fontIndex) : undefined;
      // Vertical baseline snap: Skia on macOS disables vertical subpixel
      // glyph positioning — a run's glyph origin y lands on a whole
      // DEVICE pixel row (x keeps subpixel positioning). Rendering at the
      // exact fractional baseline instead smeared every glyph row
      // (gradual 124→147→160 onsets where Chrome's rows are instantly
      // solid). Measured A/B on the seven static documents at the
      // 2026-08-25 mask bake: 70.0k structural ink px without the snap,
      // 69.2k with it — a modest corpus win; the stronger argument is
      // behavioral fidelity (crisp whole-row glyph onsets, matching how
      // Chrome's masks land on the device grid). Snap in device space
      // (through the
      // translation the instance will get) and only for an
      // axis-preserving transform: a rotated or skewed run keeps its
      // exact fractional baseline, matching Skia, which snaps in device
      // space only when the CTM maps the baseline to a device row.
      const axisPreserving = !hasTransform ||
        (ta === 1 && tb === 0 && tc === 0 && td === 1);
      const runBaseline = axisPreserving
        ? Math.round(textY + baseline + tf) - tf - textY
        : baseline;
      // Synthetic oblique (italic requested, no real italic face behind
      // this fontIndex — the same condition Blink uses,
      // font_custom_platform_data.cc's `synthetic_italic &&
      // !base_typeface_->isItalic()`): Blink paints it as
      // SkFont::setSkewX(-0.25) — a skew of factor 0.25 about the
      // BASELINE in glyph space, leaning right, advances untouched
      // (font_platform_data.cc:272; identical constant on all three
      // platform files). A CMD_TEXT is one run on ONE baseline
      // (textY + baseline; glyph entries carry only x-offsets), so the
      // skew composes into the per-instance affine UNDER the run's CSS
      // transform (Blink applies setSkewX in glyph space, before the
      // canvas CTM): skew(x,y) = (x − k·(y − y_b), y).
      if (fontStyleItalic && !atlasEntry?.italicFace) {
        const k = 0.25;
        const yB = textY + runBaseline;
        tc = tc - k * ta;
        td = td - k * tb;
        te = te + k * yB * ta;
        tf = tf + k * yB * tb;
      }
      if (atlasEntry && glyphBuffer && glyphCount > 0) {
        const { atlas } = atlasEntry;
        if (currentTextAtlas !== null && currentTextAtlas !== atlas) {
          flushText();
        }
        const fontScale = fontSize / upem;
        const range = 6.0;
        const glyphView = new DataView(
          glyphBuffer.buffer,
          glyphBuffer.byteOffset,
          glyphBuffer.byteLength,
        );
        for (let gi = 0; gi < glyphCount; gi++) {
          const gOff = glyphOff + gi * GLYPH_ENTRY_SIZE;
          const glyphId = glyphView.getUint16(gOff + GLYPH_OFFSET_ID, true);
          if (glyphId === GLYPH_ID_INVISIBLE) continue;
          const xOffset = glyphView.getFloat32(
            gOff + GLYPH_OFFSET_X_OFFSET,
            true,
          );
          // glyphInfo is the single key rule (wasm-side now — atlas.cpp's
          // makeGlyphKey, via GlyphAtlas.glyphInfo). Both the opsz
          // instance and the texel budget key on the CSS-px size: glyph
          // resources are density-invariant (see
          // buildTextRenderResources), so a density change never misses
          // this lookup.
          const info = atlas.glyphInfoFloats(
            glyphId,
            fontWeight,
            fontSizeCss,
            fontSizeCss,
          );
          if (info === null) continue;
          const infoW = info[0], infoH = info[1];
          if (infoW === 0 || infoH === 0) continue;
          const bboxXMin = info[9], bboxYMin = info[10];
          const bboxW = info[11] - bboxXMin;
          const bboxH = info[12] - bboxYMin;
          const maxDim = Math.max(bboxW, bboxH);
          const usableTexels = Math.max(infoW, infoH) - 2 * range;
          const shrinkage = maxDim / usableTexels;
          const quadLeft = bboxXMin - range * shrinkage;
          const quadRight = bboxXMin + (infoW - range) * shrinkage;
          const quadBottom = bboxYMin - range * shrinkage;
          const quadTop = bboxYMin + (infoH - range) * shrinkage;
          const glyphX = textX + xOffset * fontScale;
          const x0 = glyphX + quadLeft * fontScale;
          const x1 = glyphX + quadRight * fontScale;
          const y0 = (textY + runBaseline) - quadTop * fontScale;
          const y1 = (textY + runBaseline) - quadBottom * fontScale;
          const screenSize = Math.max(x1 - x0, y1 - y0);
          const texSize = Math.max(infoW, infoH);
          const pxRange = range * (screenSize / texSize);
          if (
            culled(
              x0,
              y0,
              x1 - x0,
              y1 - y0,
              ta,
              tb,
              tc,
              td,
              te,
              tf,
              shadowSoft * 3 + 2,
            )
          ) continue;
          currentTextAtlas = atlas;
          currentTextInstances.push(
            x0,
            y0,
            x1 - x0,
            y1 - y0,
            info[2],
            info[3],
            info[4],
            info[5],
            cr,
            cg,
            cb,
            ca,
            pxRange,
            shadowSoft,
            ta,
            tb,
            tc,
            td,
            te,
            tf,
          );
        }
      }
    } else if (opcode === CMD_IMAGE) {
      // Same "parse and advance even with no resources" rule as CMD_TEXT
      // above — a caller with no `images` map must still walk THROUGH
      // image commands, or everything after the first one desyncs.
      flushDraws();
      const flags = commandBuffer.getUint8(offset + CMD_IMAGE_OFFSET_FLAGS);
      const hasTransform = (flags & CMD_IMAGE_FLAG_TRANSFORM) !== 0;
      const pixelated = (flags & CMD_IMAGE_FLAG_PIXELATED) !== 0;
      const cmdSize = hasTransform ? CMD_IMAGE_SIZE_XFORM : CMD_IMAGE_SIZE;
      const imageIndex = commandBuffer.getUint16(
        offset + CMD_IMAGE_OFFSET_INDEX,
        true,
      );
      const ix = commandBuffer.getFloat32(offset + CMD_IMAGE_OFFSET_X, true) *
        s;
      const iy = commandBuffer.getFloat32(offset + CMD_IMAGE_OFFSET_Y, true) *
        s;
      const iw = commandBuffer.getFloat32(offset + CMD_IMAGE_OFFSET_W, true) *
        s;
      const ih = commandBuffer.getFloat32(offset + CMD_IMAGE_OFFSET_H, true) *
        s;
      const uvX = commandBuffer.getFloat32(
        offset + CMD_IMAGE_OFFSET_UV_X,
        true,
      );
      const uvY = commandBuffer.getFloat32(
        offset + CMD_IMAGE_OFFSET_UV_Y,
        true,
      );
      const uvW = commandBuffer.getFloat32(
        offset + CMD_IMAGE_OFFSET_UV_W,
        true,
      );
      const uvH = commandBuffer.getFloat32(
        offset + CMD_IMAGE_OFFSET_UV_H,
        true,
      );
      let ia = 1, ib = 0, ic = 0, id = 1, ie = scrollX, ifs = scrollY;
      if (hasTransform) {
        ia = commandBuffer.getFloat32(offset + CMD_IMAGE_OFFSET_XFORM, true);
        ib = commandBuffer.getFloat32(
          offset + CMD_IMAGE_OFFSET_XFORM + 4,
          true,
        );
        ic = commandBuffer.getFloat32(
          offset + CMD_IMAGE_OFFSET_XFORM + 8,
          true,
        );
        id = commandBuffer.getFloat32(
          offset + CMD_IMAGE_OFFSET_XFORM + 12,
          true,
        );
        ie = commandBuffer.getFloat32(
              offset + CMD_IMAGE_OFFSET_XFORM + 16,
              true,
            ) * s + scrollX;
        ifs = commandBuffer.getFloat32(
              offset + CMD_IMAGE_OFFSET_XFORM + 20,
              true,
            ) * s + scrollY;
      }
      offset += cmdSize;

      const imageEntry = images ? images.get(imageIndex) : undefined;
      if (imageEntry) {
        // Pixel snapping. Chrome rounds an element-level image's destination
        // rect to whole DEVICE pixels before painting it, and these
        // coordinates are already device px (this walker multiplied the
        // CSS-px command values by the raster scale above), so this is a
        // plain round of each edge — deriving the size from the two
        // rounded edges rather than rounding the size, which is what
        // keeps two abutting draws sharing a boundary after snapping.
        //
        // Measured against real Chrome, since the filed bug guessed the
        // opposite: a plain <img> at top:20.5px occupies rows 21-40 in Chrome
        // with HARD edges and no partial coverage anywhere, not rows 20-39
        // (what the hardware's pixel-centre fill rule gives an unsnapped
        // quad) and not an antialiased 20-40. Same for a background layer.
        // The snap happens in the draw's own PRE-TRANSFORM space, again
        // because that is where Chrome does it: <img> at top:20.5px under
        // translateY(0.5px) lands on 21.5 in Chrome — round first, translate
        // second — with the resulting half-covered rows antialiased to
        // 127/128 by the shader's edge coverage.
        //
        // CMD_IMAGE_FLAG_NO_PIXEL_SNAP opts a draw out; see its own comment
        // in layout.js for why border-image pieces need that.
        //
        // Same CSS-grid rule as CMD_RECT's snap above: round on the
        // CSS-pixel grid (ix/iy/iw/ih are css × s), then scale — density
        // is raster-only (raster-scale density plan).
        const snap = (flags & CMD_IMAGE_FLAG_NO_PIXEL_SNAP) === 0;
        const dx = snap ? Math.round(ix / s) * s : ix;
        const dy = snap ? Math.round(iy / s) * s : iy;
        const dw = snap
          ? (Math.round((ix + iw) / s) - Math.round(ix / s)) * s
          : iw;
        const dh = snap
          ? (Math.round((iy + ih) / s) - Math.round(iy / s)) * s
          : ih;
        // Per-side ABUT flags as 0/1 floats, left/top/right/bottom — see the
        // constants' own comment in layout.js and the coverageRect snap in
        // IMAGE_SHADER's vertexMain.
        if (culled(dx, dy, dw, dh, ia, ib, ic, id, ie, ifs)) continue;
        batches.push({
          type: "image",
          clipState: currentClipState,
          instances: new Float32Array([
            dx,
            dy,
            dw,
            dh,
            uvX,
            uvY,
            uvW,
            uvH,
            ia,
            ib,
            ic,
            id,
            ie,
            ifs,
            (flags & CMD_IMAGE_FLAG_ABUT_LEFT) ? 1 : 0,
            (flags & CMD_IMAGE_FLAG_ABUT_TOP) ? 1 : 0,
            (flags & CMD_IMAGE_FLAG_ABUT_RIGHT) ? 1 : 0,
            (flags & CMD_IMAGE_FLAG_ABUT_BOTTOM) ? 1 : 0,
          ]),
          count: 1,
          image: imageEntry,
          pixelated,
        });
      }
    } else if (opcode === CMD_SVG_PATH) {
      // Same "parse and advance even with no resources" rule as CMD_TEXT/
      // CMD_IMAGE above. Unlike CMD_IMAGE, the UV rect is resolved HERE at
      // draw time (pathIndex -> atlas.pathCache), not precomputed by the
      // engine — see CMD_SVG_PATH's own doc comment in layout.js for why.
      flushDraws();
      const flags = commandBuffer.getUint8(offset + CMD_SVG_PATH_OFFSET_FLAGS);
      const hasTransform = (flags & CMD_SVG_PATH_FLAG_TRANSFORM) !== 0;
      // Gradient extension (S7 step 2): its presence shifts every
      // subsequent command's offset — must be accounted for in `offset +=
      // cmdSize` below regardless of whether it's actually decoded, same
      // "every walker agrees on size" rule as CMD_RECT's own gradient flag.
      const hasGradient = (flags & CMD_SVG_PATH_FLAG_GRADIENT) !== 0;
      const cmdSize = cmdSvgPathSize(hasTransform, hasGradient);
      const pathIndex = commandBuffer.getUint16(
        offset + CMD_SVG_PATH_OFFSET_INDEX,
        true,
      );
      const px =
        commandBuffer.getFloat32(offset + CMD_SVG_PATH_OFFSET_X, true) * s;
      const py =
        commandBuffer.getFloat32(offset + CMD_SVG_PATH_OFFSET_Y, true) * s;
      const pw =
        commandBuffer.getFloat32(offset + CMD_SVG_PATH_OFFSET_W, true) * s;
      const ph =
        commandBuffer.getFloat32(offset + CMD_SVG_PATH_OFFSET_H, true) * s;
      let [cr, cg, cb, ca] = readColor4(
        commandBuffer,
        offset + CMD_SVG_PATH_OFFSET_COLOR,
        convertColor4,
      );
      let pa = 1, pb = 0, pc = 0, pd = 1, pe = scrollX, pf = scrollY;
      if (hasTransform) {
        pa = commandBuffer.getFloat32(offset + CMD_SVG_PATH_OFFSET_XFORM, true);
        pb = commandBuffer.getFloat32(
          offset + CMD_SVG_PATH_OFFSET_XFORM + 4,
          true,
        );
        pc = commandBuffer.getFloat32(
          offset + CMD_SVG_PATH_OFFSET_XFORM + 8,
          true,
        );
        pd = commandBuffer.getFloat32(
          offset + CMD_SVG_PATH_OFFSET_XFORM + 12,
          true,
        );
        pe = commandBuffer.getFloat32(
              offset + CMD_SVG_PATH_OFFSET_XFORM + 16,
              true,
            ) * s + scrollX;
        pf = commandBuffer.getFloat32(
              offset + CMD_SVG_PATH_OFFSET_XFORM + 20,
              true,
            ) * s + scrollY;
      }
      let gradient = null;
      if (hasGradient) {
        const extOffset = offset + CMD_SVG_PATH_OFFSET_XFORM +
          (hasTransform ? 24 : 0);
        gradient = readGradientExtension(
          commandBuffer,
          extOffset,
          gradientStopPool,
          CMD_SVG_PATH_GRADIENT_OFFSET_KIND,
          CMD_SVG_PATH_GRADIENT_OFFSET_STOP_COUNT,
          CMD_SVG_PATH_GRADIENT_OFFSET_STOP_OFFSET,
          CMD_SVG_PATH_GRADIENT_OFFSET_GEOM,
          convertColor4,
          s,
        );
      }
      offset += cmdSize;

      const pathInfo = svgPathAtlas
        ? svgPathAtlas.getPathByIndex(pathIndex)
        : null;
      if (pathInfo && pathInfo.pixelW > 0 && pathInfo.pixelH > 0) {
        const { range } = svgPathAtlas.getMsdfParams();
        // The atlas texture is PADDED by `range` texels beyond the path's
        // own bbox on every side (see generate_path_msdf_var's own
        // usable = size - 2*range math) — CMD_SVG_PATH's dest rect
        // (px,py,pw,ph) is the UNPADDED bbox, so drawing the full UV span
        // into just that rect visibly SHRINKS the shape (found via a
        // pixel-boundary scan: a 100px-wide path painted only ~74px wide).
        // Expand the dest quad outward by the padding, converted to
        // screen space via the same shrinkage ratio CMD_TEXT's own glyph
        // quad computation uses (see its quadLeft/Right/Top/Bottom).
        const bboxW = pathInfo.bboxXMax - pathInfo.bboxXMin;
        const bboxH = pathInfo.bboxYMax - pathInfo.bboxYMin;
        const userToScreen = Math.max(
          pw / Math.max(bboxW, 1e-6),
          ph / Math.max(bboxH, 1e-6),
        );
        const texelToUser = Math.max(bboxW, bboxH) /
          (Math.max(pathInfo.pixelW, pathInfo.pixelH) - 2 * range);
        const padScreen = range * texelToUser * userToScreen;
        const qx = px - padScreen, qy = py - padScreen;
        const qw = pw + 2 * padScreen, qh = ph + 2 * padScreen;
        const screenSize = Math.max(qw, qh);
        const texSize = Math.max(pathInfo.pixelW, pathInfo.pixelH);
        const pxRange = range * (screenSize / texSize);
        if (culled(qx, qy, qw, qh, pa, pb, pc, pd, pe, pf)) continue;
        batches.push({
          type: "svgPath",
          clipState: currentClipState,
          // gradRectPos/gradRectSize (S7 step 2): the path's own UNPADDED
          // bbox (px,py,pw,ph) — NOT qx,qy,qw,qh (the atlas-padding-
          // expanded quad) — matching the space $writeGradientExtension
          // resolved geom0..3 against in engine.wat.
          instances: new Float32Array([
            qx,
            qy,
            qw,
            qh,
            pathInfo.u,
            pathInfo.v,
            pathInfo.uW,
            pathInfo.vH,
            cr,
            cg,
            cb,
            ca,
            pxRange,
            pa,
            pb,
            pc,
            pd,
            pe,
            pf,
            px,
            py,
            pw,
            ph,
          ]),
          count: 1,
          atlas: svgPathAtlas,
          gradient,
        });
      }
    } else {
      // An opcode this walker has no branch for is a real defect (the byte
      // count is exact, so this is never "end of data") — fail loudly
      // instead of silently dropping everything after it. See
      // commandByteSize's doc in layout.js for the walker-desync history.
      throw new Error(
        `render: unknown opcode 0x${
          opcode.toString(16)
        } at command-stream offset ${offset}`,
      );
    }
  }
  flushDraws();
  // Overlay rectangles (scrollbar tracks and thumbs): a final rect batch
  // painted AFTER every command - same on-top-of-the-frame semantics the
  // old CPU byte compositing had, now through the ordinary rect pipeline,
  // so overlay color stays in the floating-point path and follows the
  // same HDR boundary conversion as every command-stream color.
  if (overlayRects !== null && overlayRects.length > 0) {
    const instances = new Float32Array(
      overlayRects.length * RECT_INSTANCE_FLOATS,
    );
    for (let i = 0; i < overlayRects.length; i++) {
      const rect = overlayRects[i];
      const color = rect.color;
      const fill = convertColor4 === null
        ? [color.r, color.g, color.b, color.a]
        : convertColor4([color.r, color.g, color.b, color.a]);
      const base = i * RECT_INSTANCE_FLOATS;
      instances[base + 0] = rect.x;
      instances[base + 1] = rect.y;
      instances[base + 2] = rect.width;
      instances[base + 3] = rect.height;
      instances[base + 4] = fill[0];
      instances[base + 5] = fill[1];
      instances[base + 6] = fill[2];
      instances[base + 7] = fill[3];
      // Border colors (8-23), widths (24-27), radii (28-35): zero.
      instances[base + 36] = 1; // identity transform a
      instances[base + 39] = 1; // identity transform d
      // paintMode (42) 0 = fill+border; borderStyles (43) 0 = solid.
    }
    batches.push({
      type: "rect",
      clipState: EMPTY_CLIP_STATE,
      instances,
      count: overlayRects.length,
      gradients: new Array(overlayRects.length).fill(null),
    });
  }
  return {
    batches,
    opacityStack,
    maskStack,
    maskLayerStack,
    backgroundStack,
    blendLayerStack,
    retainedRecords,
    decodedCommandCount,
  };
}

// Retention is opt-in: only the publishing renderer can certify that the
// command stream and all out-of-line resources still describe the same scene.
// Failed/incomplete frames are never installed in the context's retained slot.
export function prepareRetainedBatches(
  previous,
  commandBuffer,
  commandBytes,
  options,
  width,
  height,
) {
  const publication = options.commandRetention;
  const rectangle = options.visibleRectangle;
  const background = options.background;
  const gamma = options.textGamma;
  const key = [
    options.deviceScale ?? 1,
    options.renderMode ?? "standard",
    rectangle?.x,
    rectangle?.y,
    rectangle?.width,
    rectangle?.height,
    background?.r ?? 0,
    background?.g ?? 0,
    background?.b ?? 0,
    background?.a ?? 0,
    gamma?.dilateLight ?? 0.45,
    gamma?.dilateDark ?? 0.12,
    gamma?.steepness ?? 1.6,
    width,
    height,
    options.tileSize ?? 64,
  ];
  for (const overlay of options.overlayRects ?? []) {
    key.push(
      overlay.x,
      overlay.y,
      overlay.width,
      overlay.height,
      overlay.color.r,
      overlay.color.g,
      overlay.color.b,
      overlay.color.a,
    );
  }
  const reusable = publication?.owner != null &&
    publication.resourceRevision !== undefined &&
    previous?.publication?.owner === publication.owner &&
    previous.publication.resourceRevision === publication.resourceRevision &&
    previous.buffer === commandBuffer.buffer &&
    previous.byteOffset === commandBuffer.byteOffset &&
    previous.commandBytes === commandBytes &&
    previous.key.length === key.length &&
    previous.key.every((value, i) => value === key[i]) &&
    !previous.liveCanvas;
  let prepared = reusable ? previous.prepared : null;
  let decodedRecords = 0;
  const changedRecords = [];
  if (prepared && previous.publication.revision !== publication.revision) {
    if (
      publication.baseRevision !== previous.publication.revision ||
      !Array.isArray(publication.ranges)
    ) {
      prepared = null;
    } else {
      const patches = [];
      for (const range of publication.ranges) {
        const record = prepared.retainedRecords.get(range.offset);
        if (!record || record.size !== range.byteLength) {
          prepared = null;
          break;
        }
        changedRecords.push(record);
        if (record.data) {
          if (commandBuffer.getUint8(range.offset) !== CMD_RECT) {
            prepared = null;
            break;
          }
          const rect = readRect(
            commandBuffer,
            range.offset,
            options.gradientStopPool ?? null,
            options.renderMode === "high-dynamic-range"
              ? convertEncodedSrgbColor4ToWorkingRec2020
              : null,
            record.scrollX,
            record.scrollY,
            options.deviceScale ?? 1,
          );
          decodedRecords++;
          // Geometry changes need a new spatial index and culling decision.
          // Paint-only publications never take this fallback.
          if (
            rect.size !== record.size || rect.gradient !== null ||
            [0, 1, 2, 3, 36, 37, 38, 39, 40, 41].some((i) =>
              rect.data[i] !== record.data[i]
            )
          ) {
            prepared = null;
            break;
          }
          patches.push(() => {
            record.data = rect.data;
            if (record.batch) {
              record.batch.instances.set(
                rect.data,
                record.index * RECT_INSTANCE_FLOATS,
              );
            }
          });
        } else {
          let compatible = true;
          for (let i = 0; i < record.size; i++) {
            if (
              i >= CMD_PUSH_OPACITY_OFFSET_ALPHA &&
              i < CMD_PUSH_OPACITY_OFFSET_ALPHA + 4
            ) continue;
            if (record.bytes[i] !== commandBuffer.getUint8(range.offset + i)) {
              compatible = false;
              break;
            }
          }
          if (!compatible) {
            prepared = null;
            break;
          }
          const alpha = commandBuffer.getFloat32(
            range.offset + CMD_PUSH_OPACITY_OFFSET_ALPHA,
            true,
          );
          patches.push(() => {
            record.batch.opacity = alpha;
          });
          decodedRecords++;
        }
      }
      if (prepared) { for (const patch of patches) patch(); }
    }
  }
  const rebuilt = prepared === null;
  if (rebuilt) prepared = buildBatches(commandBuffer, commandBytes, options);
  const tileSize = options.tileSize ?? 64;
  // Transient full-target renders cannot reuse this graph. Avoid per-instance
  // tile views and coverage arrays unless publication or explicit damage makes
  // them useful; ordinary one-shot rendering keeps its original batch path.
  const needsIndex = publication?.owner != null || options.dirtyTiles != null;
  const index = rebuilt
    ? (needsIndex
      ? indexDamageBatches(prepared.batches, width, height, tileSize)
      : null)
    : previous.index;
  const state = {
    publication: publication ? { ...publication } : null,
    prepared,
    index,
    key,
    commandBytes,
    buffer: commandBuffer.buffer,
    byteOffset: commandBuffer.byteOffset,
    liveCanvas: rebuilt
      ? prepared.batches.some((batch) => batch.image?.kind === "canvas")
      : previous.liveCanvas,
  };
  // Decoded-command validity and destination validity are distinct. A full
  // publication can replace every batch/resource view while its authoritative
  // dirty map still bounds a local paint change on the same completed target.
  // Never carry damage through a foreign target or either side of an
  // unsupported dependency graph (old filters may have painted beyond it).
  const emptyDamage = options.dirtyTiles != null &&
    !options.dirtyTiles.some((value) => value !== 0);
  const sameTarget = previous && previous.key.length === key.length &&
    previous.key.every((value, i) => value === key[i]);
  const samePublisher = publication?.owner != null
    ? previous?.publication?.owner === publication.owner
    : !previous?.publication;
  const validTarget = sameTarget && samePublisher &&
    !previous.liveCanvas && !state.liveCanvas &&
    previous.index !== null && index !== null;
  let dirtyTiles = validTarget ||
      (reusable && !rebuilt && emptyDamage && decodedRecords === 0)
    ? options.dirtyTiles
    : null;
  if (dirtyTiles != null && rebuilt && validTarget) {
    // A full command publication loses per-command change ranges, not the
    // destination's damage. Expand touched compositing groups on both sides
    // of the publication: their ink can overflow the changed node's box.
    const groups = new Set();
    for (const dependencyIndex of [previous.index, index]) {
      for (let tile = 0; tile < dependencyIndex.tiles.length; tile++) {
        if (!dirtyTiles[tile]) continue;
        for (const unit of dependencyIndex.tiles[tile]) {
          if (unit.batches[0]?.type === "pushOpacity") groups.add(unit);
        }
      }
    }
    if (groups.size) {
      dirtyTiles = dirtyTiles.slice();
      const columns = Math.ceil(width / tileSize);
      const rows = Math.ceil(height / tileSize);
      for (const { bounds } of groups) {
        const x0 = Math.max(0, Math.floor(bounds[0] / tileSize));
        const y0 = Math.max(0, Math.floor(bounds[1] / tileSize));
        const x1 = Math.min(columns - 1, Math.floor(bounds[2] / tileSize));
        const y1 = Math.min(rows - 1, Math.floor(bounds[3] / tileSize));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) dirtyTiles[y * columns + x] = 1;
        }
      }
    }
  }
  if (
    dirtyTiles != null && !rebuilt && changedRecords.length && index !== null
  ) {
    dirtyTiles = dirtyTiles.slice();
    const columns = Math.ceil(width / tileSize);
    const rows = Math.ceil(height / tileSize);
    for (const record of changedRecords) {
      const bounds = record.data
        ? record.batch?.instanceBounds[record.index]
        : record.batch.damageBounds;
      if (!bounds) continue; // A command culled at preparation cannot paint.
      const x0 = Math.max(0, Math.floor(bounds[0] / tileSize));
      const y0 = Math.max(0, Math.floor(bounds[1] / tileSize));
      const x1 = Math.min(columns - 1, Math.floor(bounds[2] / tileSize));
      const y1 = Math.min(rows - 1, Math.floor(bounds[3] / tileSize));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) dirtyTiles[y * columns + x] = 1;
      }
    }
  }
  // A fully damaged destination has nothing to preserve. Replay the original
  // batch list once instead of splitting instances and re-rendering dependency
  // groups. This is exact coverage, not a density heuristic.
  if (
    dirtyTiles != null && index !== null && index.tiles.length > 0 &&
    index.tiles.every((_, tile) => Boolean(dirtyTiles[tile]))
  ) {
    dirtyTiles = null;
  }
  let batches = prepared.batches;
  let replayedInstances = 0;
  if (dirtyTiles != null) {
    // Walk the units in paint order and replay each ONCE, scissored to the
    // dirty tiles it touches. Tiles are disjoint, so for every tile the
    // draws that reach it arrive in the same order as that tile's own
    // subsequence — the same pixels as a per-tile replay. What differs is
    // the cost: a compositing group spanning N dirty tiles used to render
    // its whole source N times, each into a fresh, fully cleared,
    // target-sized texture (the landing page's MOTION section paid ~34
    // such groups a frame for one opacity bar and one lamp,
    // plans/bugs/BUG-motion-frames-wait-on-the-gpu.md). Now it renders
    // once and only its composite draw repeats per scissor rect.
    batches = [];
    const columns = Math.ceil(width / tileSize);
    for (const unit of index.units) {
      let rects = null;
      for (const tile of unit.tiles) {
        if (!dirtyTiles[tile]) continue;
        const x = (tile % columns) * tileSize;
        const y = Math.floor(tile / columns) * tileSize;
        const w = Math.min(tileSize, width - x);
        const last = rects === null ? null : rects[rects.length - 1];
        // Units list their tiles row-major, so a horizontal run of dirty
        // tiles extends the previous rect instead of adding a draw.
        if (last !== null && last.y === y && last.x + last.w === x) {
          last.w += w;
        } else {
          (rects ??= []).push({
            x,
            y,
            w,
            h: Math.min(tileSize, height - y),
          });
        }
      }
      if (rects === null) continue;
      batches.push({ type: "damage", rects });
      for (const batch of unit.batches) {
        batches.push(batch);
        replayedInstances += batch.count ?? 0;
      }
    }
  } else {
    for (const batch of batches) replayedInstances += batch.count ?? 0;
  }
  return {
    state,
    dirtyTiles,
    prepared: { ...prepared, batches },
    statistics: {
      rebuilt,
      decodedRecords: rebuilt ? prepared.decodedCommandCount : decodedRecords,
      replayedInstances,
      replayedBatches: batches.length,
    },
  };
}

// Index paint-order units once. Rects are independently addressable views over
// retained instance storage; a plain opacity group is one dependency unit.
// Filters/backdrops/masks/blends need pixels outside damage and use full replay.
// Returns the units in paint order, each with the tiles it touches
// (row-major), plus the per-tile view of the same units; null when the
// batch list holds something damage replay cannot bound.
function indexDamageBatches(batches, width, height, tileSize) {
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const tiles = Array.from({ length: columns * rows }, () => []);
  const units = [];
  let group = null;
  let depth = 0;
  function add(unit) {
    const [left, top, right, bottom] = unit.bounds;
    const x0 = Math.max(0, Math.floor(left / tileSize));
    const y0 = Math.max(0, Math.floor(top / tileSize));
    const x1 = Math.min(columns - 1, Math.floor(right / tileSize));
    const y1 = Math.min(rows - 1, Math.floor(bottom / tileSize));
    unit.tiles = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const tile = y * columns + x;
        tiles[tile].push(unit);
        unit.tiles.push(tile);
      }
    }
    units.push(unit);
  }
  for (const batch of batches) {
    if (batch.type === "pushOpacity") {
      if (
        batch.blendMode !== BLEND_NORMAL || batch.hasMask ||
        batch.pathMask || batch.filterSegments.length
      ) return null;
      if (depth++ === 0) {
        group = {
          batches: [],
          bounds: [Infinity, Infinity, -Infinity, -Infinity],
        };
      }
      group.batches.push(batch);
      batch.damageBounds = group.bounds;
    } else if (batch.type === "popOpacity") {
      if (!group) return null;
      group.batches.push(batch);
      if (--depth === 0) {
        add(group);
        group = null;
      }
    } else if (
      batch.type === "rect" || batch.type === "text" ||
      batch.type === "image" || batch.type === "svgPath" ||
      batch.type === "boxShadow"
    ) {
      if (batch.image?.kind === "canvas") return null;
      const stride = batch.instances.length / batch.count;
      const transform = batch.type === "rect"
        ? 36
        : batch.type === "text"
        ? 14
        : batch.type === "image"
        ? 8
        : batch.type === "svgPath"
        ? 13
        : 16;
      if (group) group.batches.push(batch);
      batch.instanceBounds = [];
      for (let i = 0; i < batch.count; i++) {
        const data = batch.instances.subarray(i * stride, (i + 1) * stride);
        const inset = batch.type === "boxShadow" && data[23] !== 0;
        const geometry = inset ? 24 : 0;
        const skirt = batch.type === "boxShadow"
          ? Math.max(1.5, data[22] * 3)
          : 1.5;
        let left = Infinity,
          top = Infinity,
          right = -Infinity,
          bottom = -Infinity;
        for (
          const x of [
            data[geometry] - skirt,
            data[geometry] + data[geometry + 2] + skirt,
          ]
        ) {
          for (
            const y of [
              data[geometry + 1] - skirt,
              data[geometry + 1] + data[geometry + 3] + skirt,
            ]
          ) {
            const px = data[transform] * x + data[transform + 2] * y +
              data[transform + 4];
            const py = data[transform + 1] * x + data[transform + 3] * y +
              data[transform + 5];
            left = Math.min(left, px - 2);
            top = Math.min(top, py - 2);
            right = Math.max(right, px + 2);
            bottom = Math.max(bottom, py + 2);
          }
        }
        const clip = batch.clipState.bounds;
        if (clip) {
          left = Math.max(left, clip.minX - 2);
          top = Math.max(top, clip.minY - 2);
          right = Math.min(right, clip.maxX + 2);
          bottom = Math.min(bottom, clip.maxY + 2);
        }
        batch.instanceBounds.push([left, top, right, bottom]);
        if (group) {
          group.bounds[0] = Math.min(group.bounds[0], left);
          group.bounds[1] = Math.min(group.bounds[1], top);
          group.bounds[2] = Math.max(group.bounds[2], right);
          group.bounds[3] = Math.max(group.bounds[3], bottom);
        } else {
          add({
            bounds: [left, top, right, bottom],
            batches: [{
              ...batch,
              instances: data,
              count: 1,
              ...(batch.gradients ? { gradients: [batch.gradients[i]] } : {}),
            }],
          });
        }
      }
    } else {
      return null;
    }
  }
  return depth === 0 ? { tiles, units } : null;
}

export {
  BOX_SHADOW_INSTANCE_FLOATS,
  clipUniformFloats,
  EMPTY_CLIP_STATE,
  GRADIENT_RECORD_STRIDE,
  GRADIENT_STOP_STRIDE,
  MAX_SHADER_CLIP_ENTRIES,
  RECT_INSTANCE_FLOATS,
};
