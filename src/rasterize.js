// Rasterizer — reads binary command buffer, issues WebGPU draw calls,
// produces raw RGBA pixels.
//
// Handles: rect (with borders, rounded corners), push/pop clip,
// push/pop opacity (offscreen compositing).

import { BLEND_NORMAL } from "./wasm/layout.js";
import {
  BOX_SHADOW_INSTANCE_FLOATS,
  blurBoxWidths,
  buildBatches,
  clipUniformFloats,
  convertEncodedSrgbColor4ToWorkingRec2020,
  EMPTY_CLIP_STATE,
  filterMatrixUniformFloats,
  GRADIENT_RECORD_STRIDE,
  GRADIENT_STOP_STRIDE,
  MAX_SHADER_CLIP_ENTRIES,
  pathMaskUniformFloats,
  prepareRetainedBatches,
} from "./render-commands.js";
import {
  createRenderContextWebgl2,
  releaseSharedWebgl2State,
  renderWebgl2,
} from "./rasterize-webgl2.js";
// The host realm's navigator OBJECT, captured at module load. Component
// environments replace the `globalThis.navigator` binding while ambient
// code runs (and may deliberately withhold GPU from that code), but the
// raster backend always belongs to the host realm, so context creation
// reads `gpu` off this captured object at call time. The `gpu` getter is
// NOT touched at module load: in a permissions:none worker that access
// raises a WebGPU permission request during module evaluation, which can
// never be answered — the worker hangs forever.
const hostNavigator = globalThis.navigator ?? null;
export { releaseSharedWebgl2State };
const hostNavigatorGpu = () => hostNavigator?.gpu ?? null;
import {
  DEFAULT_RENDER_MODE,
  DEFAULT_RENDER_PRECISION,
  KERNEL_MATRICES,
  KERNEL_MATRIX_INDEX,
  STANDARD_WORKING_COLOR_ENCODING,
  validateRenderMode,
  validateRenderPrecision,
  WORKING_COLOR_ENCODING,
  XYZ_WHITE_D50,
} from "./color.js";
import {
  imageUploadRepresentation,
  sourceConversionPlan,
} from "./image-data.js";

// float16 -> float32 conversion table for readback: rgba16float frames
// decode exactly (every binary16 value is representable in binary32).
// This replaced the TEMPORARY float16 -> byte quantization table when the
// public readback contract moved to float32 working descriptors
// (wide-color plan, package 5).
let float16ToFloat32Table = null;
function getFloat16ToFloat32Table() {
  if (float16ToFloat32Table) return float16ToFloat32Table;
  float16ToFloat32Table = new Float32Array(65536);
  for (let bits = 0; bits < 65536; bits++) {
    const sign = bits >> 15 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    let value;
    if (exponent === 0) value = sign * fraction * 2 ** -24;
    else if (exponent === 31) value = fraction ? NaN : sign * Infinity;
    else value = sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
    float16ToFloat32Table[bits] = value;
  }
  return float16ToFloat32Table;
}

// Copies one readback row into the float32 pixel buffer: float16 texels
// decode exactly, eight-bit texels (the rgba8unorm speed precision)
// normalize by 255 - standard mode stores encoded components, so both
// land in the same working encoding.
function copyReadbackRow(
  rawData,
  sourceOffset,
  destination,
  destinationOffset,
  pixelCount,
  texelBytes,
) {
  if (texelBytes === 4) {
    for (let i = 0; i < pixelCount * 4; i++) {
      destination[destinationOffset + i] = rawData[sourceOffset + i] / 255;
    }
    return;
  }
  const table = getFloat16ToFloat32Table();
  for (let i = 0; i < pixelCount * 4; i++) {
    const bits = rawData[sourceOffset + i * 2] |
      (rawData[sourceOffset + i * 2 + 1] << 8);
    destination[destinationOffset + i] = table[bits];
  }
}

// The mode's working encoding for readback descriptors and texture
// results (docs/specifications/color-and-image-data.md).
function workingColorEncoding(renderMode) {
  return renderMode === "high-dynamic-range"
    ? WORKING_COLOR_ENCODING
    : STANDARD_WORKING_COLOR_ENCODING;
}

// A readback result IS a working ImageDescriptor (float32, rgba, tightly
// packed, premultiplied, the mode's working encoding) plus the render
// extras (dirtyRects, readbackByteLength).
function workingRenderResult(pixels, width, height, renderMode, extra) {
  return {
    width,
    height,
    rowStride: width * 16,
    pixels,
    channelLayout: "rgba",
    sampleType: "float32",
    bitsPerSample: 32,
    colorEncoding: workingColorEncoding(renderMode),
    alphaMode: "premultiplied",
    metadata: {},
    ...extra,
  };
}

// One decoded clip entry as the shaders see it:
//   rect:   local-space minX, minY, maxX, maxY
//   radiiX/radiiY: per-corner elliptical radii, CSS corner order in
//           x/y/z/w = topLeft, topRight, bottomRight, bottomLeft
//   invA:   inverse affine (screen -> local) a, b, c, d
//   invB:   inverse affine e, f; z = mode (0 skip, 1 hard axis-aligned,
//           2 SDF); w = axis-enable bits for hard mode (1 X, 2 Y, 3 both)
const CLIP_STRUCT_WGSL = `
struct ClipEntry {
  rect: vec4f,
  radiiX: vec4f,
  radiiY: vec4f,
  invA: vec4f,
  invB: vec4f,
}
`;

// Fragment-shader clip evaluation, interpolated into each draw shader's
// fragmentMain (each shader already defines the SAME roundedRectSDF this
// references). Produces `clipCoverage` and discards fully-clipped
// fragments. All control flow here depends only on uniform-buffer values,
// so the fwidth inside the loop is uniform control flow (same argument
// the pre-redesign per-shader clip blocks documented).
const CLIP_EVAL_WGSL = `
  var clipCoverage = 1.0;
  let clipCount = u32(uniforms.clipCount);
  for (var clipIndex = 0u; clipIndex < ${MAX_SHADER_CLIP_ENTRIES}u; clipIndex++) {
    if (clipIndex >= clipCount) { break; }
    let clipEntry = uniforms.clips[clipIndex];
    let clipMode = clipEntry.invB.z;
    if (clipMode < 0.5) { continue; }
    if (clipMode < 1.5) {
      // Hard axis-aligned screen-space clip — binary, no AA (pixel-exact
      // parity with the pre-redesign axis-aligned clip behavior).
      let clipAxisBits = clipEntry.invB.w;
      if (clipAxisBits == 1.0 || clipAxisBits == 3.0) {
        if (input.pixelPos.x < clipEntry.rect.x || input.pixelPos.x > clipEntry.rect.z) { clipCoverage = 0.0; }
      }
      if (clipAxisBits == 2.0 || clipAxisBits == 3.0) {
        if (input.pixelPos.y < clipEntry.rect.y || input.pixelPos.y > clipEntry.rect.w) { clipCoverage = 0.0; }
      }
    } else {
      // SDF mode: rounded and/or oriented — evaluate in the entry's own
      // local space, antialias over ~1 screen pixel via fwidth.
      let clipLocalP = vec2f(
        clipEntry.invA.x * input.pixelPos.x + clipEntry.invA.z * input.pixelPos.y + clipEntry.invB.x,
        clipEntry.invA.y * input.pixelPos.x + clipEntry.invA.w * input.pixelPos.y + clipEntry.invB.y);
      let clipCenter = (clipEntry.rect.xy + clipEntry.rect.zw) * 0.5;
      let clipHalfSize = (clipEntry.rect.zw - clipEntry.rect.xy) * 0.5;
      let clipD = roundedRectSDF(clipLocalP - clipCenter, clipHalfSize, clipEntry.radiiX, clipEntry.radiiY);
      let clipAa = fwidth(clipD) * 0.5;
      clipCoverage = clipCoverage * (1.0 - smoothstep(-clipAa, clipAa, clipD));
    }
  }
  if (clipCoverage < 0.001) { discard; }
`;

// --- Gradient interpolation-space color conversion (wide-color plan,
// package 4). The walker prepares stops IN the author-selected
// interpolation space (src/gradient-interpolation.js - conversion, missing
// components, hue fixup); the shader lerps them premultiplied (hue channel
// excluded, css-color-4 section 12.3) and converts the interpolated result
// into the rendering mode's working encoding: extended sign-mirrored
// encoded sRGB (standard) or linear Rec. 2020 (high-dynamic-range).
// GradientRecord.hasGradient carries the routing bits: bit 0 has, bit 1
// tiled, bits 8-11 interpolation-space id (GRADIENT_SPACE_NAMES), bit 12
// high-dynamic-range. Matrices mirror src/color.js's KERNEL_MATRICES
// exactly (injected below, column-major for WGSL).
function wgslMat3(matrix) {
  const columns = [0, 1, 2].map((column) =>
    [0, 1, 2].map((row) => matrix[row][column]).join(", ")
  );
  return `mat3x3f(${columns.join(", ")})`;
}
const GRADIENT_COLOR_WGSL = `
const GRAD_SRGB_TO_XYZ = ${
  wgslMat3(KERNEL_MATRICES[KERNEL_MATRIX_INDEX.srgbToXyz])
};
const GRAD_XYZ_TO_SRGB = ${
  wgslMat3(KERNEL_MATRICES[KERNEL_MATRIX_INDEX.xyzToSrgb])
};
const GRAD_XYZ_TO_REC2020 = ${
  wgslMat3(KERNEL_MATRICES[KERNEL_MATRIX_INDEX.xyzToRec2020])
};
const GRAD_ADAPT_D50_TO_D65 = ${
  wgslMat3(KERNEL_MATRICES[KERNEL_MATRIX_INDEX.adaptD50ToD65])
};
const GRAD_OKLAB_LAB_TO_LMS = ${
  wgslMat3(KERNEL_MATRICES[KERNEL_MATRIX_INDEX.oklabLabToLms])
};
const GRAD_OKLAB_LMS_TO_XYZ = ${
  wgslMat3(KERNEL_MATRICES[KERNEL_MATRIX_INDEX.oklabLmsToXyzD65])
};
const GRAD_D50_WHITE = vec3f(${XYZ_WHITE_D50.join(", ")});
const GRAD_LAB_EPSILON: f32 = ${216 / 24389};
const GRAD_LAB_KAPPA: f32 = ${24389 / 27};

// CSS Color 4 sign-mirrored sRGB transfer (src/color.js decodeSrgbTransfer/
// encodeSrgbTransfer) - grad-prefixed: some host shaders define their own.
fn gradDecodeSrgb(value: vec3f) -> vec3f {
  let sign = select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
  let magnitude = abs(value);
  let low = magnitude / 12.92;
  let high = pow((magnitude + 0.055) / 1.055, vec3f(2.4));
  return sign * select(high, low, magnitude <= vec3f(0.04045));
}
fn gradEncodeSrgb(value: vec3f) -> vec3f {
  let sign = select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
  let magnitude = abs(value);
  let low = magnitude * 12.92;
  let high = 1.055 * pow(magnitude, vec3f(1.0 / 2.4)) - 0.055;
  return sign * select(high, low, magnitude <= vec3f(0.0031308));
}

// Lab -> XYZ D50 (mirrors src/color.js convertLabToXyzD50 exactly).
fn gradLabFInverse(f: f32) -> f32 {
  let cubed = f * f * f;
  return select((116.0 * f - 16.0) / GRAD_LAB_KAPPA, cubed, cubed > GRAD_LAB_EPSILON);
}
fn gradLabToXyzD50(lab: vec3f) -> vec3f {
  let fy = (lab.x + 16.0) / 116.0;
  let fx = fy + lab.y / 500.0;
  let fz = fy - lab.z / 200.0;
  let y = select(lab.x / GRAD_LAB_KAPPA, fy * fy * fy, lab.x > GRAD_LAB_KAPPA * GRAD_LAB_EPSILON);
  return vec3f(gradLabFInverse(fx) * GRAD_D50_WHITE.x, y, gradLabFInverse(fz) * GRAD_D50_WHITE.z);
}
fn gradOklabToXyzD65(lab: vec3f) -> vec3f {
  let nonlinear = GRAD_OKLAB_LAB_TO_LMS * lab;
  return GRAD_OKLAB_LMS_TO_XYZ * (nonlinear * nonlinear * nonlinear);
}
fn gradLchToLab(lch: vec3f) -> vec3f {
  let hueRadians = radians(lch.z);
  return vec3f(lch.x, lch.y * cos(hueRadians), lch.y * sin(hueRadians));
}
// HSL/HWB -> encoded sRGB (css-color-4 reference algorithm; s/l/w/b in
// 0..1, h in degrees - kept in lockstep with src/gradient-interpolation.js).
fn gradHslChannel(n: f32, h: f32, s: f32, l: f32) -> f32 {
  let k = (n + h / 30.0) % 12.0;
  let a = s * min(l, 1.0 - l);
  return l - a * max(-1.0, min(min(k - 3.0, 9.0 - k), 1.0));
}
fn gradHslToSrgb(hsl: vec3f) -> vec3f {
  let h = hsl.x - 360.0 * floor(hsl.x / 360.0);
  return vec3f(
    gradHslChannel(0.0, h, hsl.y, hsl.z),
    gradHslChannel(8.0, h, hsl.y, hsl.z),
    gradHslChannel(4.0, h, hsl.y, hsl.z),
  );
}
fn gradHwbToSrgb(hwb: vec3f) -> vec3f {
  let whiteness = hwb.y;
  let blackness = hwb.z;
  if (whiteness + blackness >= 1.0) {
    let gray = whiteness / (whiteness + blackness);
    return vec3f(gray);
  }
  return gradHslToSrgb(vec3f(hwb.x, 1.0, 0.5)) * (1.0 - whiteness - blackness) + vec3f(whiteness);
}

// Hue channel per space id (hsl/hwb: component 0; lch/oklch: component 2;
// rectangular spaces: none). The hue channel never premultiplies.
fn gradientHueChannel(flags: u32) -> i32 {
  let space = (flags >> 8u) & 0xFu;
  if (space == 5u || space == 6u) { return 0; }
  if (space == 7u || space == 8u) { return 2; }
  return -1;
}

// Interpolated interpolation-space color (straight alpha) -> the mode's
// working encoding. The srgb-space standard path returns its input
// untouched so the pre-existing sRGB gradient pixels stay bit-identical.
fn gradientColorToWorking(c: vec4f, flags: u32) -> vec4f {
  let space = (flags >> 8u) & 0xFu;
  let hdr = ((flags >> 12u) & 1u) != 0u;
  if (space == 0u && !hdr) { return c; }
  var encodedSrgb = c.rgb;
  var viaXyz = false;
  var xyz = vec3f(0.0);
  if (space == 1u) {
    if (!hdr) { return vec4f(gradEncodeSrgb(c.rgb), c.a); }
    xyz = GRAD_SRGB_TO_XYZ * c.rgb;
    viaXyz = true;
  } else if (space == 2u) {
    xyz = GRAD_ADAPT_D50_TO_D65 * gradLabToXyzD50(c.rgb);
    viaXyz = true;
  } else if (space == 3u) {
    xyz = gradOklabToXyzD65(c.rgb);
    viaXyz = true;
  } else if (space == 4u) {
    xyz = c.rgb;
    viaXyz = true;
  } else if (space == 5u) {
    encodedSrgb = gradHslToSrgb(c.rgb);
  } else if (space == 6u) {
    encodedSrgb = gradHwbToSrgb(c.rgb);
  } else if (space == 7u) {
    xyz = GRAD_ADAPT_D50_TO_D65 * gradLabToXyzD50(gradLchToLab(c.rgb));
    viaXyz = true;
  } else if (space == 8u) {
    xyz = gradOklabToXyzD65(gradLchToLab(c.rgb));
    viaXyz = true;
  }
  if (hdr) {
    if (!viaXyz) { xyz = GRAD_SRGB_TO_XYZ * gradDecodeSrgb(encodedSrgb); }
    return vec4f(GRAD_XYZ_TO_REC2020 * xyz, c.a);
  }
  if (viaXyz) { return vec4f(gradEncodeSrgb(GRAD_XYZ_TO_SRGB * xyz), c.a); }
  return vec4f(encodedSrgb, c.a);
}
`;

const RECT_SHADER = `
${CLIP_STRUCT_WGSL}
${GRADIENT_COLOR_WGSL}
struct Uniforms {
  resolution: vec2f,
  clipCount: f32,
  _clipPad: f32,
  clips: array<ClipEntry, ${MAX_SHADER_CLIP_ENTRIES}>,
}

// Gradient plumbing (design/paint-coverage.md P4): the rect pipeline is at
// the default 16-attribute limit already (see INSTANCE_FLOATS's own
// comment at the pipeline setup) — gradient data does NOT ride the vertex
// buffer. Two per-BATCH storage buffers instead, indexed by
// @builtin(instance_index) (see GradientRecord) and by a per-record span
// (see GradientStop). kind: 0=linear (only kind implemented this slice;
// radial/conic reserved).
//
// GradientStop's field order matters: color (vec4f) BEFORE position (f32)
// avoids interior struct padding that a f32-then-vec4f order would need
// (vec4f's 16-byte alignment forces 12 bytes of padding after a leading
// f32) — verified empirically against this project's actual WebGPU/naga
// pipeline (a real compute-shader round-trip test, not just spec reading)
// before choosing this order: the array's actual per-element STRIDE came
// back as 32 bytes either way (WGSL rounds an array's stride up to a
// multiple of its largest member's alignment, a rule distinct from a
// bare struct's own size), so this field order doesn't save memory, but
// keeps the byte layout easier to reason about (no dead bytes in the
// middle of a real value).
// geom0..3 are PER-KIND (mirrors CMD_RECT_GRADIENT_OFFSET_GEOM's own
// per-kind layout in layout.js): linear{dx,dy,length,pad} / radial{cx,cy,
// rx,ry} / conic{cx,cy,fromAngle,pad} — named generically rather than
// after any one kind's own meaning, since all 3 kinds share this one
// 4-float payload.
// hasGradient doubles as a flags word: bit0 = has, bit1 = TILED
// (background-origin — the positioning area differs from the painted
// rect; the dispatch wraps the origin-space sample position modulo
// geom4..7's size). geom4..7 = the ORIGIN RECT {dx, dy, w, h}: the
// positioning area's top-left relative to the painted rect's own
// top-left plus its size — (0, 0, rectW, rectH) whenever the two boxes
// coincide (all SVG draws, borderless CSS boxes).
struct GradientRecord {
  hasGradient: u32,
  kind: u32,
  stopStart: u32,
  stopCount: u32,
  geom0: f32,
  geom1: f32,
  geom2: f32,
  geom3: f32,
  geom4: f32,
  geom5: f32,
  geom6: f32,
  geom7: f32,
}
struct GradientStop {
  color: vec4f,
  position: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) localPos: vec2f,
  @location(1) halfSize: vec2f,
  @location(2) fillColor: vec4f,
  @location(3) borderColorTop: vec4f,
  @location(4) borderColorRight: vec4f,
  @location(5) borderColorBottom: vec4f,
  @location(6) borderColorLeft: vec4f,
  // Border widths per side: x=top, y=right, z=bottom, w=left.
  @location(7) borderWidths: vec4f,
  // Outer corner radii (P10: ELLIPTICAL — rx/ry pairs per corner, a
  // circular corner is just rx==ry), CSS corner order: x=topLeft,
  // y=topRight, z=bottomRight, w=bottomLeft.
  @location(8) radiiX: vec4f,
  @location(9) radiiY: vec4f,
  @location(10) pixelPos: vec2f,
  // 0 = fill+border (default), 1 = fill only, 2 = border only (P5c
  // border-order fix: lets background-image layers paint between
  // background-color and border, matching CSS painting order, by having
  // the caller issue two separate CMD_RECT draws instead of one atomic
  // fill+border draw).
  @location(11) paintMode: f32,
  // Pass-through instance index (P4): fragment shaders can't read
  // @builtin(instance_index) directly, only the vertex stage can — thread
  // it through as an ordinary flat-interpolated location instead (verified
  // this compiles against this project's actual WebGPU pipeline before
  // relying on it).
  @location(12) @interpolate(flat) instanceIndex: u32,
  // isAxisAligned (bug fix, found via S6's own <g>-rotation oracle test,
  // but reproduces on a PLAIN rotated CSS box too — general, pre-existing):
  // the fragment shader's "hard-edged rect, skip AA" fast path below was
  // gating PURELY on radii/border-width being zero, with NO check for
  // whether the rect is actually axis-aligned ON SCREEN. A plain
  // border-radius:0 box rotated at a non-90°-multiple angle (e.g. 15deg)
  // took that fast path anyway, producing a hard, binary, jagged edge
  // with ZERO antialiasing at all — confirmed via a real Chrome-oracle
  // pixel comparison (Chrome blends the same edge over ~2px; sandom did
  // not blend it at all). 1.0 = the transform's own
  // linear part has no off-diagonal (rotation/skew) terms, so a per-pixel
  // hard cutoff still aligns with real pixel boundaries and needs no AA;
  // 0.0 = a genuine rotation/skew is present, so the general SDF+
  // smoothstep path below (which correctly antialiases any angle) must
  // run instead.
  @location(13) @interpolate(flat) isAxisAligned: f32,
  // border styles (P7): the wire's packed 4-bit-per-side u16 —
  // (styles >> (4*side)) & 0xF with side 0=top, 1=right, 2=bottom,
  // 3=left; values are layout.js's BORDER_STYLE_* enum. 0 = all solid.
  @location(14) @interpolate(flat) borderStyles: u32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> gradientRecords: array<GradientRecord>;
@group(0) @binding(2) var<storage, read> gradientStops: array<GradientStop>;

fn applyTransform(p: vec2f, t: mat3x2f) -> vec2f {
  return vec2f(
    t[0][0] * p.x + t[1][0] * p.y + t[2][0],
    t[0][1] * p.x + t[1][1] * p.y + t[2][1]
  );
}

@vertex
fn vertexMain(
  @builtin(instance_index) instanceIndex: u32,
  @location(0) quadVertex: vec2f,
  @location(1) rectPos: vec2f,
  @location(2) rectSize: vec2f,
  @location(3) fillColor: vec4f,
  @location(4) borderColorTop: vec4f,
  @location(5) borderColorRight: vec4f,
  @location(6) borderColorBottom: vec4f,
  @location(7) borderColorLeft: vec4f,
  @location(8) borderWidths: vec4f,
  @location(9) radiiX: vec4f,
  @location(10) radiiY: vec4f,
  @location(11) transformCol0: vec2f,
  @location(12) transformCol1: vec2f,
  @location(13) transformCol2: vec2f,
  @location(14) paintModeAndBorderStyles: vec2f,
) -> VertexOutput {
  // The border ring sits INSIDE the border box (CSS), so the quad only
  // expands past the box for antialiasing headroom, not for the border.
  let expandedPos = rectPos - 1.5;
  let expandedSize = rectSize + 3.0;

  let localPixelPos = expandedPos + quadVertex * expandedSize;

  let transform = mat3x2f(transformCol0, transformCol1, transformCol2);
  let pixelPos = applyTransform(localPixelPos, transform);
  let clipX = (pixelPos.x / uniforms.resolution.x) * 2.0 - 1.0;
  let clipY = 1.0 - (pixelPos.y / uniforms.resolution.y) * 2.0;

  let center = rectPos + rectSize * 0.5;
  let localPos = localPixelPos - center;

  var output: VertexOutput;
  output.position = vec4f(clipX, clipY, 0.0, 1.0);
  output.localPos = localPos;
  output.halfSize = rectSize * 0.5;
  output.fillColor = fillColor;
  output.borderColorTop = borderColorTop;
  output.borderColorRight = borderColorRight;
  output.borderColorBottom = borderColorBottom;
  output.borderColorLeft = borderColorLeft;
  output.borderWidths = borderWidths;
  output.radiiX = radiiX;
  output.radiiY = radiiY;
  output.pixelPos = pixelPos;
  // isAxisAligned: transformCol0.y (b) and transformCol1.x (c) are the
  // affine's own off-diagonal (rotation/skew) terms — see applyTransform's
  // own formula (t[0][0]*x+t[1][0]*y+e, t[0][1]*x+t[1][1]*y+f, i.e. the
  // standard a,b,c,d,e,f order): both must be exactly 0 for the transform
  // to be a pure scale/flip (no rotation, no skew), the only case where a
  // per-pixel hard cutoff still lands on real pixel boundaries.
  output.isAxisAligned = select(0.0, 1.0, transformCol0.y == 0.0 && transformCol1.x == 0.0);
  output.paintMode = paintModeAndBorderStyles.x;
  output.borderStyles = u32(paintModeAndBorderStyles.y);
  output.instanceIndex = instanceIndex;
  return output;
}

// Pick the component of v belonging to p's quadrant. v is packed in CSS
// corner order: x=topLeft, y=topRight, z=bottomRight, w=bottomLeft
// (screen coords, +y down).
fn cornerSelect(p: vec2f, v: vec4f) -> f32 {
  return select(
    select(v.x, v.y, p.x > 0.0),
    select(v.w, v.z, p.x > 0.0),
    p.y > 0.0);
}

// Rounded rect with PER-CORNER, possibly ELLIPTICAL radii (Slice P2).
// Circular corners (rx == ry, including 0) take the classic EXACT rounded-
// rect SDF — so uniform-radius shapes are bit-compatible with the pre-P2
// shader. A genuinely elliptical corner (asymmetric adjacent border widths
// insetting the two axes differently) takes an anisotropically-scaled
// approximation: the ZERO level-set (the contour itself) is exact; only the
// off-contour distance scale is approximate, which fwidth-normalized
// antialiasing absorbs.
fn roundedRectSDF(localP: vec2f, halfSize: vec2f, radiiX: vec4f, radiiY: vec4f) -> f32 {
  let rx = cornerSelect(localP, radiiX);
  let ry = cornerSelect(localP, radiiY);
  let q = abs(localP) - halfSize + vec2f(rx, ry);
  let circD = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rx;
  let cornerD = (length(q / vec2f(max(rx, 1e-6), max(ry, 1e-6))) - 1.0) * min(rx, ry);
  let edgeD = max(q.x - rx, q.y - ry);
  let ellipseD = select(edgeD, cornerD, q.x > 0.0 && q.y > 0.0);
  return select(ellipseD, circD, abs(rx - ry) < 1e-4);
}

// The rounded-rect SDF of the border box inset PER SIDE by the insets
// vector (x=top, y=right, z=bottom, w=left — same order as borderWidths), with
// each corner's radii reduced by the adjacent sides' insets PER AXIS
// (css-backgrounds-3 §5.3's inner-contour construction). insets = the
// border widths gives the padding-box edge (dInner); fractional insets
// give the P7 double-stripe boundaries.
fn insetRectSDF(localPos: vec2f, halfSize: vec2f, radiiX: vec4f, radiiY: vec4f, insets: vec4f) -> f32 {
  let centerOffset = vec2f((insets.w - insets.y) * 0.5, (insets.x - insets.z) * 0.5);
  let half = max(halfSize - vec2f((insets.w + insets.y) * 0.5, (insets.x + insets.z) * 0.5), vec2f(0.0));
  let rX = max(radiiX - vec4f(insets.w, insets.y, insets.y, insets.w), vec4f(0.0));
  let rY = max(radiiY - vec4f(insets.x, insets.x, insets.z, insets.z), vec4f(0.0));
  return roundedRectSDF(localPos - centerOffset, half, rX, rY);
}

// border-style inset/outset/groove/ridge colors (P7 step 2) — Blink's
// exact rules, extracted from color.cc / box_border_painter.cc:
// Dark(): multiply all components by max(0, (v - 0.33) / v) where v =
// max(r,g,b); v == 0 stays black. (White's hardcoded rgb(171,171,171)
// is what the formula produces anyway.)
fn borderColorDark(c: vec3f) -> vec3f {
  let v = max(c.r, max(c.g, c.b));
  if (v == 0.0) { return vec3f(0.0); }
  return c * max(0.0, (v - 0.33) / v);
}
// Light(): multiply by min(1, v + 0.33) / v; black hardcodes to
// rgb(84,84,84) (Blink's kLightenedBlack).
fn borderColorLight(c: vec3f) -> vec3f {
  let v = max(c.r, max(c.g, c.b));
  if (v == 0.0) { return vec3f(84.0 / 255.0); }
  return c * (min(1.0, v + 0.33) / v);
}
// WCAG relative luminance (linearized sRGB), used by Chrome's active
// inset/outset shade rule.
fn relativeLuminance(c: vec3f) -> f32 {
  let linearized = select(
    pow((c + vec3f(0.055)) / 1.055, vec3f(2.4)),
    c / 12.92,
    c <= vec3f(0.04045));
  return dot(linearized, vec3f(0.2126, 0.7152, 0.0722));
}
// CalculateInsetOutsetColor: very dark inputs use Light()/Light().Light()
// so both edges remain visible. Otherwise the darker edge uses Dark() and
// the lighter edge uses Light(), except that very light inputs stay unchanged.
// The thresholds are Blink's exact luminances of rgb(32) and rgb(235).
fn insetOutsetColor(isDarken: bool, c: vec3f) -> vec3f {
  let luminance = relativeLuminance(c);
  if (luminance <= 0.014443844) {
    let light = borderColorLight(c);
    if (isDarken) { return light; }
    return borderColorLight(light);
  }
  if (isDarken) { return borderColorDark(c); }
  if (luminance > 0.83077) { return c; }
  return borderColorLight(c);
}
// Per-side styled border color (P7): inset/outset transform the whole
// band's color (DarkenBoxSide: top/left darken for inset, bottom/right
// for outset); groove/ridge split the band at its midline
// (CenterOutsets) — the OUTER half behaves as inset (groove) / outset
// (ridge), the inner half as the opposite. outerHalfness = 1 in the
// outer half, 0 in the inner, antialiased across the midline contour.
fn styledSideColor(base: vec4f, style: u32, side: u32, outerHalfness: f32) -> vec4f {
  if (style == 4u || style == 5u) {  // BORDER_STYLE_INSET / _OUTSET
    let isDarken = ((side == 0u || side == 3u) == (style == 4u));
    return vec4f(insetOutsetColor(isDarken, base.rgb), base.a);
  }
  if (style == 6u || style == 7u) {  // BORDER_STYLE_GROOVE / _RIDGE
    let outerActsInset = (style == 6u);
    let darkenOuter = ((side == 0u || side == 3u) == outerActsInset);
    let outerColor = insetOutsetColor(darkenOuter, base.rgb);
    let innerColor = insetOutsetColor(!darkenOuter, base.rgb);
    return vec4f(mix(innerColor, outerColor, outerHalfness), base.a);
  }
  return base;
}

// border-style dashed/dotted (P7 step 3) — Blink's dash sizing, extracted
// verbatim from styled_stroke_data.cc:
// - "StrokeIsDashed" = dashed at any width, OR dotted at width <= 3
//   (thin dotted draws square dashes with dash = gap = width, not round
//   dots).
// - dashed: dashLen = w * (w >= 3 ? 2 : 3), gapLen = w * (w >= 3 ? 1 : 2).
//   sideLength <= 2*dashLen -> NO dash effect (solid). sideLength <=
//   2*dashLen + gapLen -> exactly two dashes, intervals scaled
//   proportionally. Else the gap adjusts via SelectBestDashGap so a whole
//   number of dashes fits exactly: over n = floor((L + gapLen) /
//   (dashLen + gapLen)) and n+1 dashes, gap_n = (L - n*dashLen) / (n - 1),
//   pick whichever is closer to gapLen (rejecting a non-positive
//   (n+1)-gap). Phase 0, butt caps -> the pattern starts AND ends with a
//   full dash.
// - dotted w > 3: circles of diameter w (Skia 0-length round-cap dashes)
//   with per-dot period = SelectBestDashGap(L, w, w) + w; the first and
//   last dot centers sit w/2 inside the side's endpoints.
// The pattern parameter is the distance along the side's own run (the
// stroked midline), so everything is a pure function of (sideLength,
// width, s) — no wire fields beyond the style nibbles. All AA widths are
// passed IN (hoisted fwidth) because this runs under a non-uniform
// per-side branch where derivatives are illegal.
fn dashDotInkCoverage(style: u32, w: f32, sideLength: f32, s: f32, across: f32, aa: f32) -> f32 {
  if (style == 3u && w > 3.0) {
    // Round dots. Rendered radius = w/2 - 0.25, measured directly from
    // Chrome (coverage-profile mass through dot centers at widths 6, 8,
    // and 10 gave along-diameters 5.5/7.5/9.5 exactly), with plain
    // LINEAR area coverage at the boundary (clean 0.75/0.5/0.25 edge
    // pixels), not a smoothstep. Chrome's dots are additionally squashed
    // ~0.125px across and jittered per dot by Skia's quarter-pixel dash
    // walk; those sub-eighth-pixel effects were A/B-measured and NOT
    // modeled (they worsen the total diff — see sidePatternCoverage's
    // comment and the bounded oracle test).
    let alongRadius = w * 0.5 - 0.25;
    let acrossRadius = w * 0.5 - 0.25;
    if (sideLength < 2.0 * w) {
      // Not enough room for two dots — a single dot at the start inset.
      let d = length(vec2f((s - w * 0.5) * (acrossRadius / alongRadius), across)) - acrossRadius;
      return clamp(0.5 - d / (2.0 * aa), 0.0, 1.0);
    }
    let minDots = floor((sideLength + w) / (2.0 * w));
    let maxDots = minDots + 1.0;
    let minGap = (sideLength - minDots * w) / (minDots - 1.0);
    let maxGap = (sideLength - maxDots * w) / (maxDots - 1.0);
    var gap = minGap;
    var dotCount = minDots;
    if (maxGap > 0.0 && abs(maxGap - w) < abs(minGap - w)) { gap = maxGap; dotCount = maxDots; }
    let period = gap + w;
    let dotIndex = clamp(round((s - w * 0.5) / period), 0.0, dotCount - 1.0);
    // Deliberately NOT quantized: Chrome's individual dot placements
    // jitter by up to a quarter pixel around the exact fractional
    // centers (Skia's fixed-point dash walk rounds each accumulated
    // position inconsistently — measured spacings 11.75/12.0/12.25/12.5
    // around an exact 12.18 period), which is not reproducible without
    // porting SkDashPathEffect's internals. The exact fractional center
    // is the underlying model both renderers share.
    let center = w * 0.5 + dotIndex * period;
    let d = length(vec2f((s - center) * (acrossRadius / alongRadius), across)) - acrossRadius;
    return clamp(0.5 - d / (2.0 * aa), 0.0, 1.0);
  }
  // Dashed-stroke pattern: dashed at any width, or square-dot thin dotted.
  var dashLength = w;
  var gapLength = w;
  if (style == 2u) {
    dashLength = w * select(3.0, 2.0, w >= 3.0);
    gapLength = w * select(2.0, 1.0, w >= 3.0);
  }
  if (sideLength <= 2.0 * dashLength) { return 1.0; }  // no room: solid
  var gap = gapLength;
  if (sideLength <= 2.0 * dashLength + gapLength) {
    let scale = sideLength / (2.0 * dashLength + gapLength);
    dashLength = dashLength * scale;
    gap = gapLength * scale;
  } else if (style == 2u) {
    // SelectBestDashGap — dashed only (thin dotted keeps gap = width).
    let minDashes = floor((sideLength + gapLength) / (dashLength + gapLength));
    let maxDashes = minDashes + 1.0;
    let minGap = (sideLength - minDashes * dashLength) / (minDashes - 1.0);
    let maxGap = (sideLength - maxDashes * dashLength) / (maxDashes - 1.0);
    gap = minGap;
    if (maxGap > 0.0 && abs(maxGap - gapLength) < abs(minGap - gapLength)) { gap = maxGap; }
  }
  // Thin-dotted end fixups (Blink's EnforceDotsAtEndpoints, ported
  // verbatim): width <= 3 dotted lines get hand-adjusted first/last dots
  // (integer growth/offset per width and sideLength mod 4 / mod 6) so
  // the ends always show a full dot; the periodic pattern then runs
  // between the adjusted line start/end. All quantities here are
  // integer-valued pixels, so the mod arithmetic is exact in f32.
  var lineStart = 0.0;
  var lineEnd = 1e9;
  var startDotEnd = -1.0;   // explicit start dot: ink for s < startDotEnd
  var endDotStart = 1e9;    // explicit end dot: ink for s >= endDotStart
  if (style == 3u && sideLength > 2.0 * dashLength + gapLength) {
    let mod2 = sideLength - 2.0 * floor(sideLength / 2.0);
    let mod4 = sideLength - 4.0 * floor(sideLength / 4.0);
    let mod6 = sideLength - 6.0 * floor(sideLength / 6.0);
    var useStartDot = false;
    var startDotGrowth = 0.0;
    var startLineOffset = 0.0;
    var useEndDot = false;
    var endDotGrowth = 0.0;
    if ((w == 1.0 && mod2 == 0.0) || (w == 3.0 && mod6 == 0.0)) {
      useStartDot = true; startDotGrowth = 1.0; startLineOffset = 1.0;
    }
    if ((w == 2.0 && (mod4 == 0.0 || mod4 == 1.0)) || (w == 3.0 && (mod6 == 1.0 || mod6 == 2.0))) {
      useStartDot = true; startLineOffset = -1.0;
    }
    if ((w == 2.0 && mod4 == 0.0) || (w == 3.0 && mod6 == 1.0)) {
      useEndDot = true;
    }
    if ((w == 2.0 && mod4 == 3.0) || (w == 3.0 && (mod6 == 4.0 || mod6 == 5.0))) {
      useStartDot = true; startLineOffset = 1.0;
    }
    if (w == 3.0 && mod6 == 5.0) {
      useEndDot = true;
    } else if (w == 3.0 && mod6 == 0.0) {
      useEndDot = true; endDotGrowth = 1.0;
    }
    if (useStartDot) {
      startDotEnd = w + startDotGrowth;
      lineStart = 2.0 * w + startLineOffset;
    }
    if (useEndDot) {
      endDotStart = sideLength - w - endDotGrowth;
      lineEnd = sideLength - (w + endDotGrowth + 1.0);
    }
  }
  let period = dashLength + gap;
  let sInLine = s - lineStart;
  // Chrome renders each dash's boundaries QUANTIZED to quarter pixels
  // (measured directly: an underlying 10.307 period rendered dashes at
  // 10.25, 20.5, 31.0, 41.25, 51.5 — each k*period rounded to the
  // nearest 0.25 — with plain linear area coverage at the boundary
  // pixel, e.g. a 10.25 boundary shows exactly 0.75). Evaluate the
  // fragment against its own and the two neighboring dashes' quantized
  // intervals and take the max coverage; the ramp is LINEAR (box-filter
  // area AA), not smoothstep, to match the measured edge values.
  var coverage = 0.0;
  let periodIndex = floor(sInLine / period);
  for (var neighbor = -1; neighbor <= 1; neighbor++) {
    let base = (periodIndex + f32(neighbor)) * period;
    let startQuantized = round(base * 4.0) / 4.0;
    let endQuantized = round((base + dashLength) * 4.0) / 4.0;
    let d = max(startQuantized - sInLine, sInLine - endQuantized);
    coverage = max(coverage, clamp(0.5 - d / (2.0 * aa), 0.0, 1.0));
  }
  if (s < lineStart || s >= lineEnd) { coverage = 0.0; }
  if (s < startDotEnd) { coverage = 1.0; }
  if (s >= endDotStart) { coverage = 1.0; }
  return coverage;
}

// Quarter-arc length of an ellipse with semi-axes (rx, ry) — 8-sample
// midpoint quadrature of ds/dt = sqrt(rx^2 cos^2 t + ry^2 sin^2 t). For
// circular corners the integrand is constant and this is EXACT ((pi/2)r);
// elliptical corners are within ~0.1%. arcPositionAlong uses the SAME
// sampler for positions within an arc, so totals and positions never
// drift apart.
fn quarterArcLength(rx: f32, ry: f32) -> f32 {
  var total = 0.0;
  let step = 1.5707963 / 8.0;
  for (var sample = 0; sample < 8; sample++) {
    let t = (f32(sample) + 0.5) * step;
    total = total + sqrt(rx * rx * cos(t) * cos(t) + ry * ry * sin(t) * sin(t)) * step;
  }
  return total;
}

// Arc length from an arc's start to parametric angle tEnd (same
// quadrature as quarterArcLength).
fn arcLengthTo(rx: f32, ry: f32, tEnd: f32) -> f32 {
  var total = 0.0;
  let step = tEnd / 8.0;
  for (var sample = 0; sample < 8; sample++) {
    let t = (f32(sample) + 0.5) * step;
    total = total + sqrt(rx * rx * cos(t) * cos(t) + ry * ry * sin(t) * sin(t)) * step;
  }
  return total;
}

// Closed centerline-path parameterization for ROUNDED borders (P7):
// Blink strokes the whole closed midline contour (border box inset
// per side by half its width, radii reduced per axis — Blink's
// CenterOutsets contour) with ONE continuous dash walk
// (DrawCurvedDashedDottedBoxSide). Path start: the upper-left corner
// arc's END on the top edge, winding CLOCKWISE
// (PathBuilder::AddRoundedRect — addRRect(..., kCW, start index 0)).
// Returns vec2f(s along the path, total path length). sideFirst
// resolves straight-segment membership for fragments outside every
// corner region.
fn closedCenterlinePosition(localPos: vec2f, halfSize: vec2f, widths: vec4f,
                            radiiX: vec4f, radiiY: vec4f, sideFirst: u32) -> vec2f {
  let mx0 = -halfSize.x + widths.w * 0.5;
  let mx1 = halfSize.x - widths.y * 0.5;
  let my0 = -halfSize.y + widths.x * 0.5;
  let my1 = halfSize.y - widths.z * 0.5;
  let rTLx = max(radiiX.x - widths.w * 0.5, 0.0); let rTLy = max(radiiY.x - widths.x * 0.5, 0.0);
  let rTRx = max(radiiX.y - widths.y * 0.5, 0.0); let rTRy = max(radiiY.y - widths.x * 0.5, 0.0);
  let rBRx = max(radiiX.z - widths.y * 0.5, 0.0); let rBRy = max(radiiY.z - widths.z * 0.5, 0.0);
  let rBLx = max(radiiX.w - widths.w * 0.5, 0.0); let rBLy = max(radiiY.w - widths.z * 0.5, 0.0);
  let arcTR = quarterArcLength(rTRx, rTRy);
  let arcBR = quarterArcLength(rBRx, rBRy);
  let arcBL = quarterArcLength(rBLx, rBLy);
  let arcTL = quarterArcLength(rTLx, rTLy);
  let topLength = (mx1 - rTRx) - (mx0 + rTLx);
  let rightLength = (my1 - rBRy) - (my0 + rTRy);
  let bottomLength = (mx1 - rBRx) - (mx0 + rBLx);
  let leftLength = (my1 - rTLy) - (my0 + rBLy);
  let pathLength = topLength + arcTR + rightLength + arcBR + bottomLength + arcBL + leftLength + arcTL;
  let cTR = vec2f(mx1 - rTRx, my0 + rTRy);
  let cBR = vec2f(mx1 - rBRx, my1 - rBRy);
  let cBL = vec2f(mx0 + rBLx, my1 - rBLy);
  let cTL = vec2f(mx0 + rTLx, my0 + rTLy);
  var s = 0.0;
  if (localPos.x >= cTR.x && localPos.y <= cTR.y && arcTR > 0.0) {
    // TR arc: (rx sin t, -ry cos t) from the top (t=0) clockwise.
    let t = clamp(atan2(max(localPos.x - cTR.x, 0.0) / max(rTRx, 1e-6),
                        max(cTR.y - localPos.y, 0.0) / max(rTRy, 1e-6)), 0.0, 1.5707963);
    s = topLength + arcLengthTo(rTRx, rTRy, t);
  } else if (localPos.x >= cBR.x && localPos.y >= cBR.y && arcBR > 0.0) {
    // BR arc: (rx cos t, ry sin t) from the right (t=0) clockwise.
    let t = clamp(atan2(max(localPos.y - cBR.y, 0.0) / max(rBRy, 1e-6),
                        max(localPos.x - cBR.x, 0.0) / max(rBRx, 1e-6)), 0.0, 1.5707963);
    s = topLength + arcTR + rightLength + arcLengthTo(rBRx, rBRy, t);
  } else if (localPos.x <= cBL.x && localPos.y >= cBL.y && arcBL > 0.0) {
    // BL arc: (-rx sin t, ry cos t) from the bottom (t=0) clockwise.
    let t = clamp(atan2(max(cBL.x - localPos.x, 0.0) / max(rBLx, 1e-6),
                        max(localPos.y - cBL.y, 0.0) / max(rBLy, 1e-6)), 0.0, 1.5707963);
    s = topLength + arcTR + rightLength + arcBR + bottomLength + arcLengthTo(rBLx, rBLy, t);
  } else if (localPos.x <= cTL.x && localPos.y <= cTL.y && arcTL > 0.0) {
    // TL arc: (-rx cos t, -ry sin t) from the left (t=0) clockwise.
    let t = clamp(atan2(max(cTL.y - localPos.y, 0.0) / max(rTLy, 1e-6),
                        max(cTL.x - localPos.x, 0.0) / max(rTLx, 1e-6)), 0.0, 1.5707963);
    s = topLength + arcTR + rightLength + arcBR + bottomLength + arcBL + leftLength + arcLengthTo(rTLx, rTLy, t);
  } else if (sideFirst == 0u) {
    s = clamp(localPos.x - (mx0 + rTLx), 0.0, topLength);
  } else if (sideFirst == 1u) {
    s = topLength + arcTR + clamp(localPos.y - (my0 + rTRy), 0.0, rightLength);
  } else if (sideFirst == 2u) {
    s = topLength + arcTR + rightLength + arcBR + clamp((mx1 - rBRx) - localPos.x, 0.0, bottomLength);
  } else {
    s = topLength + arcTR + rightLength + arcBR + bottomLength + arcBL + clamp((my1 - rBLy) - localPos.y, 0.0, leftLength);
  }
  return vec2f(s, pathLength);
}

// Closed-path dash/dot coverage (P7, rounded borders): the same Blink
// sizing rules as dashDotInkCoverage but with the CLOSED-path variants
// (DashEffectFromStrokeStyle with closed_path = true): the 2-dash
// threshold gains a second gap, SelectBestDashGap uses gap count = dash
// count, dot centers start at phase 0 (the path start — no endpoint
// insets on a closed path), and Blink truncates the measured path
// length to an integer. across = |distance to the midline contour|
// (the dHalfBand SDF magnitude — exact on straights AND arcs).
fn closedDashDotCoverage(style: u32, w: f32, pathLengthExact: f32, s: f32, across: f32, aa: f32) -> f32 {
  let pathLength = floor(pathLengthExact);
  if (style == 3u && w > 3.0) {
    let minDots = floor(pathLength / (2.0 * w));
    if (minDots < 1.0) { return 1.0; }
    let maxDots = minDots + 1.0;
    let minGap = (pathLength - minDots * w) / minDots;
    let maxGap = (pathLength - maxDots * w) / maxDots;
    var gap = minGap;
    if (maxGap > 0.0 && abs(maxGap - w) < abs(minGap - w)) { gap = maxGap; }
    let period = gap + w;
    let center = round(s / period) * period;
    let alongRadius = w * 0.5 - 0.25;
    let d = length(vec2f(s - center, across)) - alongRadius;
    return clamp(0.5 - d / (2.0 * aa), 0.0, 1.0);
  }
  var dashLength = w;
  var gapLength = w;
  if (style == 2u) {
    dashLength = w * select(3.0, 2.0, w >= 3.0);
    gapLength = w * select(2.0, 1.0, w >= 3.0);
  }
  if (pathLength <= 2.0 * dashLength) { return 1.0; }
  var gap = gapLength;
  if (pathLength <= 2.0 * dashLength + 2.0 * gapLength) {
    let scale = pathLength / (2.0 * dashLength + 2.0 * gapLength);
    dashLength = dashLength * scale;
    gap = gapLength * scale;
  } else if (style == 2u) {
    let minDashes = floor(pathLength / (dashLength + gapLength));
    let maxDashes = minDashes + 1.0;
    let minGap = (pathLength - minDashes * dashLength) / minDashes;
    let maxGap = (pathLength - maxDashes * dashLength) / maxDashes;
    gap = minGap;
    if (maxGap > 0.0 && abs(maxGap - gapLength) < abs(minGap - gapLength)) { gap = maxGap; }
  }
  let period = dashLength + gap;
  let periodIndex = floor(s / period);
  var coverage = 0.0;
  // Unlike the straight-side model, boundaries here are NOT quarter-
  // quantized: Skia walks its own numeric measure of the path's conic
  // approximation, whose accumulated positions drift fractions of a
  // pixel from the analytic arc lengths — A/B-measured, quantizing
  // amplifies the mismatch (212 vs 186 structural px on the reference
  // rounded-dashed scene) while plain fractional boundaries track best.
  for (var neighbor = -1; neighbor <= 1; neighbor++) {
    let base = (periodIndex + f32(neighbor)) * period;
    let d = max(base - s, s - (base + dashLength));
    coverage = max(coverage, clamp(0.5 - d / (2.0 * aa), 0.0, 1.0));
  }
  return coverage;
}

// One side's dashed/dotted pattern coverage at this fragment: the pattern
// coordinate runs along the side's own edge (Blink strokes each side
// left-to-right / top-to-bottom), the side length comes from the box
// dimensions, and the across-the-band offset from the side's midline.
fn sidePatternCoverage(side: u32, style: u32, tSide: f32,
                       localPos: vec2f, halfSize: vec2f, widths: vec4f,
                       aaX: f32, aaY: f32) -> f32 {
  var sideLength = 2.0 * halfSize.x;
  var s = localPos.x + halfSize.x;
  var aa = aaX;
  if (side == 1u || side == 3u) {
    sideLength = 2.0 * halfSize.y;
    s = localPos.y + halfSize.y;
    aa = aaY;
  }
  let w = widths[side];
  // Across-the-band offset from the dot-circle center: the band midline.
  // Chrome's rendered dots additionally sit shifted by eighth-pixel,
  // device-axis-dependent amounts and slightly squashed across
  // (extents [lo+0.5, hi-0.25] in y but [lo+0.25, hi-0.5] in x — Skia's
  // cap-raster snapping); modeling those was A/B-measured to WORSEN the
  // total diff because Skia's per-dot quarter-pixel walk jitter
  // dominates — the plain midline model measures best. See the bounded
  // dotted oracle test's signature comment.
  let across = tSide * w - w * 0.5;
  return dashDotInkCoverage(style, w, sideLength, s, across, aa);
}

// Sample a linear gradient at localPos (pixel offset from the rect's
// center — the SAME space every other SDF/coverage calc in this shader
// already operates in). t = 0.5 + dot(localPos, direction) / length:
// localPos=0 (box center) maps to t=0.5, matching css-images-3's own
// gradient-line-centered-on-the-box model (verified numerically — 0,-1
// dir on a 100px box gives t=0 at the top edge — before writing this).
// Non-repeating only this slice (P4 build order step 4 adds repeat via
// fract(t) — see design/paint-coverage.md); t is clamped to [0,1], matching
// how a non-repeating CSS gradient clamps past its first/last stop.
//
// Stop walk: find the FIRST stop whose position exceeds t, then lerp
// between it and its predecessor. A stopCount of 32 as the loop's hard
// cap is generous headroom past the plan's own "e.g. 16" example — no
// real gradient scene approaches it; this is a defensive bound against a
// malformed stopCount runaway, not an expected real limit. SHARED across
// all 3 gradient kinds — only the t computation differs per kind (see
// sampleLinearGradient/sampleRadialGradient/sampleConicGradient below,
// each a thin per-kind t formula delegating here).
const GRADIENT_STOP_WALK_CAP: u32 = 64u;

// Interpolate between two color stops in PREMULTIPLIED space —
// css-images-3's own explicit requirement (confirmed via WebFetch against
// the spec text: "the interpolation taking place in premultiplied RGBA
// space" — straight/non-premultiplied interpolation produces a visibly
// "grayish" fringe when one stop is opaque and the other transparent,
// which the spec calls out by name as the wrong result). Un-premultiplies
// before returning since this shader's other paths (fillColor, border
// blending) all expect STRAIGHT alpha for their own compositing math.
// Stops arrive in the interpolation space; a polar space's hue channel
// (hueChannel >= 0) never premultiplies (css-color-4 section 12.3).
fn mixPremultiplied(a: vec4f, b: vec4f, t: f32, hueChannel: i32) -> vec4f {
  var premultA = vec4f(a.rgb * a.a, a.a);
  var premultB = vec4f(b.rgb * b.a, b.a);
  if (hueChannel >= 0) {
    premultA[hueChannel] = a[hueChannel];
    premultB[hueChannel] = b[hueChannel];
  }
  let premultMixed = mix(premultA, premultB, t);
  if (premultMixed.a < 1e-6) { return vec4f(0.0); }
  var straight = vec4f(premultMixed.rgb / premultMixed.a, premultMixed.a);
  if (hueChannel >= 0) {
    straight[hueChannel] = premultMixed[hueChannel];
  }
  return straight;
}

// Repeating (P4 step 4): css-images-3's own rule (confirmed via WebFetch
// against MDN, both repeating-linear-gradient's and repeating-conic-
// gradient's own pages, since their wording differs slightly but the
// underlying rule is the same): "the length that repeats is the distance
// between the FIRST and LAST color stop" — NOT a fixed [0,1] wrap. A
// gradient whose stops only span e.g. t=0.1..0.35 repeats that 0.25-wide
// SPAN, re-wrapping t back into it — re-verified numerically (including
// a first-stop position that ISN'T 0, which a naive fract(t) would get
// wrong) before implementing. Takes the RAW, un-repeated t (already
// clamped/wrapped into whatever range that KIND's own geometry naturally
// produces — see each sampleXGradient's own comment) and re-derives the
// repeat span from the actual first/last stop positions in the pool.
fn repeatWrapT(t: f32, rec: GradientRecord) -> f32 {
  let firstPos = gradientStops[rec.stopStart].position;
  let lastPos = gradientStops[rec.stopStart + rec.stopCount - 1u].position;
  let span = max(lastPos - firstPos, 1e-6);
  let rel = (t - firstPos) / span;
  return firstPos + fract(rel) * span;
}

fn walkGradientStops(rawT: f32, rec: GradientRecord, isRepeating: bool) -> vec4f {
  if (rec.stopCount == 0u) { return vec4f(0.0); }
  if (rec.stopCount == 1u) { return gradientStops[rec.stopStart].color; }
  let t = select(rawT, repeatWrapT(rawT, rec), isRepeating);
  var prevStop = gradientStops[rec.stopStart];
  let cap = min(rec.stopCount, GRADIENT_STOP_WALK_CAP);
  for (var i: u32 = 1u; i < cap; i = i + 1u) {
    let stop = gradientStops[rec.stopStart + i];
    if (t <= stop.position) {
      // Hard-stop guard (two stops at the same position, a color
      // discontinuity by design — css-images-3's hint/hard-stop
      // syntax): a zero-width span divides by ~0 without this, which
      // would otherwise produce NaN/Inf instead of a clean color jump.
      let span = max(stop.position - prevStop.position, 1e-6);
      let localT = clamp((t - prevStop.position) / span, 0.0, 1.0);
      return mixPremultiplied(prevStop.color, stop.color, localT, gradientHueChannel(rec.hasGradient));
    }
    prevStop = stop;
  }
  return prevStop.color;
}

// isRepeating (P4 step 4): non-repeating clamps rawT to [0,1] (past the
// first/last stop, the gradient holds that stop's own color — CSS's
// ordinary non-repeating behavior). Repeating does NOT clamp here —
// walkGradientStops' own repeatWrapT re-derives the correct repeat span
// from the actual stop positions, which needs the UNCLAMPED value to
// wrap correctly past t=1.
// posO (background-origin): the sample position in ORIGIN-BOX space —
// relative to the positioning area's top-left, already wrapped modulo
// the origin size when the record is TILED (see fragmentMain's gradient
// dispatch). The gradient line is centered on the ORIGIN box (CSS's
// gradient-line-centered-on-the-box model applies to the positioning
// area, not the painted rect), hence the originSize*0.5 recentring.
fn sampleLinearGradient(posO: vec2f, originSize: vec2f, rec: GradientRecord, isRepeating: bool) -> vec4f {
  let rawT = 0.5 + dot(posO - originSize * 0.5, vec2f(rec.geom0, rec.geom1)) / max(rec.geom2, 1e-6);
  let t = select(clamp(rawT, 0.0, 1.0), rawT, isRepeating);
  return walkGradientStops(t, rec, isRepeating);
}

// Radial: geom0/1 = resolved center (cx,cy), geom2/3 = resolved radii
// (rx,ry) — ALL already resolved against the real positioning-area size
// by $resolveRadialGradientGeometry (engine.wat) before reaching this
// shader; t is the normalized elliptical distance from center (0 at
// center, 1 at the ending-shape boundary) — verified numerically
// (t=0 at center, t=1 exactly at rx/ry away along either axis, t=0.5
// halfway along) before implementing. posO and the center (cx,cy) are
// BOTH in origin-box space (relative to the positioning area's
// top-left), so the distance is a plain subtraction.
fn sampleRadialGradient(posO: vec2f, rec: GradientRecord, isRepeating: bool) -> vec4f {
  let centerRelPos = posO - vec2f(rec.geom0, rec.geom1);
  let dx = centerRelPos.x / max(rec.geom2, 1e-6);
  let dy = centerRelPos.y / max(rec.geom3, 1e-6);
  let rawT = sqrt(dx * dx + dy * dy);
  // Non-repeating clamps (past the ending-shape boundary, hold the last
  // stop's color — same "clamp for non-repeating, raw for repeating" rule
  // as linear's own, see that function's comment).
  let t = select(clamp(rawT, 0.0, 1.0), rawT, isRepeating);
  return walkGradientStops(t, rec, isRepeating);
}

// Conic: geom0/1 = resolved center (cx,cy, same top-left-relative space
// as radial's own), geom2 = the from-angle (conic-gradient's "from
// <angle>" clause) in RADIANS (already deg->rad converted in JS — no box
// dependency, unlike linear's own angle). t = ((pointAngle - fromAngle) /
// 2pi) wrapped into [0,1) — same
// css-images convention as linear (0=up, clockwise), verified numerically
// (atan2-to-CSS-angle conversion, fromAngle offset, 360deg wraparound all
// checked against hand-computed values) before implementing. WGSL's
// atan2(y,x) matches the JS Math.atan2(y,x) convention (y first) used to
// derive this formula.
// isRepeating for conic is UNLIKE linear/radial: the angle sweep is
// ALREADY naturally periodic (fract()-ed into [0,1) below) regardless of
// repeating — a plain conic-gradient() with stops spanning less than the
// full circle just HOLDS the last stop's color for the remainder (not a
// clamp on t itself, which stays wrapped; the "hold" behavior comes from
// walkGradientStops' own non-repeating fallthrough — its final
// prevStop.color return after the loop). repeating-conic-gradient() re-wraps
// WITHIN the [firstStop,lastStop] span instead (walkGradientStops' own
// repeatWrapT) — confirmed against MDN's own repeating-conic-gradient
// page (a stop list spanning 0-25% of the circle repeats that quarter 4
// times) and verified numerically (including a first-stop position that
// ISN'T at t=0) before implementing.
fn sampleConicGradient(posO: vec2f, rec: GradientRecord, isRepeating: bool) -> vec4f {
  // posO and the center are both origin-box-space (see radial's comment).
  let centerRelPos = posO - vec2f(rec.geom0, rec.geom1);
  // atan2(dy,dx) + pi/2 converts to the CSS convention (0=up, clockwise) —
  // verified numerically before implementing (0,-1)->0, (1,0)->pi/2 etc.
  let pointAngle = atan2(centerRelPos.y, centerRelPos.x) + 1.5707963267948966;
  let rawT = (pointAngle - rec.geom2) / 6.283185307179586;
  let t = rawT - floor(rawT);
  return walkGradientStops(t, rec, isRepeating);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  // Derivatives FIRST, unconditionally. fwidth is a derivative builtin that
  // WGSL requires to run in uniform control flow. Every discard below is
  // conditioned on non-uniform values (interpolated inputs, per-pixel clip
  // tests), so any derivative placed after them trips Tint's uniformity
  // analysis and fails shader compilation on Chrome (Deno's naga is laxer and
  // silently accepts it, which is why this rendered fine headless but painted
  // white in the browser). Hoisting fwidth above all control flow keeps the
  // whole function uniform-safe.
  //
  // d — the OUTER (border-box) edge, per-corner ELLIPTICAL radii (P10).
  let d = roundedRectSDF(input.localPos, input.halfSize, input.radiiX, input.radiiY);
  // Narrower than a full fwidth(d): a full-width smoothstep band spreads
  // coverage across a 2px-wide zone, visibly softer than Chrome/Skia's own
  // edges (Skia bakes exact per-vertex coverage for straight edges and only
  // uses an fwidth-normalized SDF for arcs — see design/layout-debugging.md's
  // AA notes). This keeps sandom's single shared shader path but tightens
  // the ramp to look closer to Skia's on both straight and curved edges.
  let aa = fwidth(d) * 0.5;
  // Screen pixels per LOCAL unit, per axis — the scale the axis-aligned
  // coverage below needs to size a pixel in the rect's own space. localPos is
  // an affine function of the screen position, so on the axis-aligned path
  // (the only place this is used) dpdx(localPos.x) is exactly 1/a and
  // dpdy(localPos.y) exactly 1/d. Hoisted here with the other derivatives —
  // same uniform-control-flow rule the comment above spells out.
  let localPerScreen = abs(vec2f(dpdx(input.localPos.x), dpdy(input.localPos.y)));
  let screenPerLocal = 1.0 / max(localPerScreen, vec2f(1e-6));

  // dInner — the border's INNER (padding-box) edge (Slice P2): the border
  // box inset per side by that side's own width; each inner corner's radii
  // are the outer radius minus the adjacent side widths PER AXIS
  // (css-backgrounds-3 §5.3 — elliptical whenever the two adjacent widths
  // differ). Replaces the old uniform "d + borderWidth" inset, which was
  // only correct for equal widths on all four sides.
  let widths = input.borderWidths;  // x=top, y=right, z=bottom, w=left
  let dInner = insetRectSDF(input.localPos, input.halfSize, input.radiiX, input.radiiY, widths);
  let aaInner = fwidth(dInner) * 0.5;

  // border-style double (P7, Blink's DrawDoubleBoxSide): per side, stripe
  // thickness third_i = floor((w_i + 1) / 3) — outer stripe [0, third_i)
  // from the outer edge, inner stripe [w_i - third_i, w_i), the middle
  // shows the element's own background (background-clip: border-box).
  // The two stripe boundaries are per-side-inset rounded-rect contours
  // (Blink's DoubleStripeOutsets geometry), same construction as dInner.
  // Computed unconditionally — fwidth needs uniform control flow (same
  // hoisting rule as aa/aaInner above).
  let doubleThirds = floor((widths + vec4f(1.0)) / 3.0);
  let dStripeOuter = insetRectSDF(input.localPos, input.halfSize, input.radiiX, input.radiiY, doubleThirds);
  let aaStripeOuter = fwidth(dStripeOuter) * 0.5;
  let dStripeInner = insetRectSDF(input.localPos, input.halfSize, input.radiiX, input.radiiY, widths - doubleThirds);
  let aaStripeInner = fwidth(dStripeInner) * 0.5;

  // groove/ridge midline contour (P7 step 2, Blink's CenterOutsets): the
  // band's half-width inset; outerHalfness = 1 outside it (the band's
  // OUTER half), 0 inside, antialiased across. Computed unconditionally —
  // fwidth needs uniform control flow.
  let dHalfBand = insetRectSDF(input.localPos, input.halfSize, input.radiiX, input.radiiY, widths * 0.5);
  let outerHalfness = smoothstep(-fwidth(dHalfBand) * 0.5, fwidth(dHalfBand) * 0.5, dHalfBand);

  // Hoisted AA widths for the dashed/dotted pattern (P7 step 3): the
  // pattern coordinate is localPos.x along horizontal sides and
  // localPos.y along vertical ones, and dashDotInkCoverage runs under a
  // NON-uniform per-side branch where derivatives are illegal — so both
  // axes' pixel scales are computed here, unconditionally.
  let dashAaX = fwidth(input.localPos.x) * 0.5;
  let dashAaY = fwidth(input.localPos.y) * 0.5;

  // Which side's border color owns this fragment (Slice P2): the side whose
  // outer edge this fragment is proportionally closest to, measured in
  // multiples of that side's own width. This is exactly Blink's miter — a
  // straight line from the outer corner to the UNADJUSTED inner
  // (padding-box) corner, used unchanged even when the corner is rounded
  // (box_border_painter.cc: miter_line(outer.Outer(),
  // unadjusted_inner_edge)). Sides with zero width never win (their t is
  // infinite: a fragment can't be inside a border that doesn't exist).
  //
  // Computed HERE — above every non-uniform discard/return below — because
  // the seam antialiasing needs a derivative (fwidth), and WGSL requires
  // derivatives in uniform control flow (same hoisting rule as aa/aaInner
  // above; see their comment for the Tint-vs-naga history).
  let tTop = select(1e9, (input.localPos.y + input.halfSize.y) / widths.x, widths.x > 0.0);
  let tRight = select(1e9, (input.halfSize.x - input.localPos.x) / widths.y, widths.y > 0.0);
  let tBottom = select(1e9, (input.halfSize.y - input.localPos.y) / widths.z, widths.z > 0.0);
  let tLeft = select(1e9, (input.localPos.x + input.halfSize.x) / widths.w, widths.w > 0.0);
  var tFirst = tTop;
  var colorFirst = input.borderColorTop;
  // The winning side's index (0=top, 1=right, 2=bottom, 3=left) — P7
  // border styles are per side, keyed by this.
  var sideFirst = 0u;
  var tSecond = 1e9;
  var colorSecond = input.borderColorTop;
  var sideSecond = 0u;
  if (tRight < tFirst) { tSecond = tFirst; colorSecond = colorFirst; sideSecond = sideFirst; tFirst = tRight; colorFirst = input.borderColorRight; sideFirst = 1u; }
  else if (tRight < tSecond) { tSecond = tRight; colorSecond = input.borderColorRight; sideSecond = 1u; }
  if (tBottom < tFirst) { tSecond = tFirst; colorSecond = colorFirst; sideSecond = sideFirst; tFirst = tBottom; colorFirst = input.borderColorBottom; sideFirst = 2u; }
  else if (tBottom < tSecond) { tSecond = tBottom; colorSecond = input.borderColorBottom; sideSecond = 2u; }
  if (tLeft < tFirst) { tSecond = tFirst; colorSecond = colorFirst; sideSecond = sideFirst; tFirst = tLeft; colorFirst = input.borderColorLeft; sideFirst = 3u; }
  else if (tLeft < tSecond) { tSecond = tLeft; colorSecond = input.borderColorLeft; sideSecond = 3u; }
  // Per-side style color transforms (P7 step 2: inset/outset/groove/
  // ridge) apply to EACH side's color BEFORE the miter-seam blend below —
  // Chrome draws each side's transformed color clipped at the miter, so
  // the seam blends the two transformed colors.
  colorFirst = styledSideColor(colorFirst,
    (input.borderStyles >> (4u * sideFirst)) & 0xFu, sideFirst, outerHalfness);
  colorSecond = styledSideColor(colorSecond,
    (input.borderStyles >> (4u * sideSecond)) & 0xFu, sideSecond, outerHalfness);
  // Antialias the miter seam: Blink clips each side's segment with
  // antialiasing on, so the diagonal between two differently-colored sides
  // blends over ~1px instead of hard-switching at pixel centers. Blend the
  // winner with the runner-up across a band around tFirst == tSecond
  // (identical colors reduce to the winner exactly, so uniform borders are
  // unaffected).
  let seamDistance = tSecond - tFirst;
  let seamAa = max(fwidth(seamDistance) * 0.5, 1e-6);
  let seamBlend = clamp(seamDistance / (2.0 * seamAa) + 0.5, 0.5, 1.0);
  let borderColor = mix(colorSecond, colorFirst, seamBlend);

  // Clip coverage: 1.0 = fully inside the clip region, 0.0 = fully
  // outside, fractional at an antialiased (rounded/oriented) boundary —
  // see CLIP_EVAL_WGSL's doc comment for the full model.
${CLIP_EVAL_WGSL}

  // paintMode (P5c border-order fix): 0=fill+border (default, existing
  // behavior below), 1=fill only (extends to the OUTER edge — there's no
  // border ring to sit under, so the fill itself owns the full box), 2=
  // border only (just the ring; the interior is left untouched so a
  // background-image drawn between this and the matching fill-only draw
  // shows through). Split into two draws by the caller (WAT emission) only
  // when a node has both a border AND background-image layers — every
  // other node still gets a single paintMode=0 draw, byte-identical to the
  // pre-existing behavior.
  let isFillOnly = input.paintMode > 0.5 && input.paintMode < 1.5;
  let isBorderOnly = input.paintMode > 1.5;

  // Gradient (P4): substitute the gradient's own computed color for
  // fillColor when this instance carries one — mutually exclusive with
  // the solid NODE_BG_COLOR fill (WAT's $emitNodeRect never sets both;
  // see $hasGradient's own comment there), so a plain read-or-compute is
  // correct, not a blend of the two. localPos is ALREADY the pixel offset
  // from the rect's center (same space the SDF calcs above use) — no
  // extra transform needed for the dot-product against the gradient
  // direction. An if/else (not select()) here — select() would
  // unconditionally evaluate every branch, wastefully sampling all 3
  // kinds' storage-buffer reads even for the (overwhelmingly common)
  // non-gradient case.
  let gradRec = gradientRecords[input.instanceIndex];
  // Mask off the repeating bit (bit 7 — see BG_KIND_REPEATING_BIT's own
  // comment in engine.wat) before comparing kinds; extract it separately
  // (P4 step 4) to pass into each sample function.
  let gradKind = gradRec.kind & 0x7Fu;
  let gradIsRepeating = (gradRec.kind & 0x80u) != 0u;
  var resolvedFillColor = input.fillColor;
  if (gradRec.hasGradient != 0u) {
    // background-origin: map the rect-space position into ORIGIN-BOX
    // space (geom4/5 = origin top-left relative to the rect's own), and
    // when TILED (hasGradient bit1 — the two boxes differ) wrap it
    // modulo the origin size: a gradient is a CSS <image> sized to the
    // positioning area, tiled per background-repeat's default repeat
    // across the painting area (Chrome-probe-verified). floor-division
    // wrap (not %) so negative positions (paint left/above the origin
    // box) wrap positively.
    let gradOriginSize = max(vec2f(gradRec.geom6, gradRec.geom7), vec2f(1e-6));
    var gradPosO = input.localPos + input.halfSize - vec2f(gradRec.geom4, gradRec.geom5);
    if ((gradRec.hasGradient & 2u) != 0u) {
      gradPosO = gradPosO - floor(gradPosO / gradOriginSize) * gradOriginSize;
    }
    if (gradKind == 1u) {
      resolvedFillColor = sampleLinearGradient(gradPosO, gradOriginSize, gradRec, gradIsRepeating);
    } else if (gradKind == 2u) {
      resolvedFillColor = sampleRadialGradient(gradPosO, gradRec, gradIsRepeating);
    } else if (gradKind == 3u) {
      resolvedFillColor = sampleConicGradient(gradPosO, gradRec, gradIsRepeating);
    }
    // Interpolated in the author-selected space; convert into the mode's
    // working encoding before any compositing math (wide-color plan).
    resolvedFillColor = gradientColorToWorking(resolvedFillColor, gradRec.hasGradient);
  }

  // Plain rectangles — no rounded corners, no stroked border, no rotation or
  // skew — take EXACT rectangle-pixel overlap area instead of the SDF's
  // fwidth smoothstep. Two things that both matter come out of one formula:
  //
  //   * an edge on a whole pixel boundary gives exactly 1.0 or 0.0, so the
  //     ordinary integer-positioned box keeps its hard edge with none of the
  //     1-pixel darker fringe a smoothstep leaves against a non-white
  //     backdrop (the reason this path was a binary discard to begin with);
  //   * an edge that genuinely lands mid-pixel — which after readRect's snap
  //     means a TRANSFORMED box, since the snap makes every untransformed
  //     one integral — gets real partial coverage, which the binary discard
  //     could not express at all. Measured against real Chrome: a box under
  //     translate(0, 0.5px) reads 128 on each half-covered row where Chrome
  //     reads 128, and under scale(1, 1.025) reads 191 where Chrome reads
  //     191; the binary version painted both rows solid.
  //
  // It also retires a real off-by-one: the binary test discarded only where
  // the SDF was strictly positive, i.e. it was inclusive at BOTH edges, so a
  // rect whose top and bottom both landed exactly on pixel centres
  // (top:20.5px with a 20px height) painted 21 rows instead of 20,
  // double-counting the boundary row.
  //
  // Only the default fill+border mode or a fill-only draw (whose widths are
  // always zero, since a fill-only draw never carries a border); border-only
  // draws always need the general ring-coverage path below. isAxisAligned is
  // required too (bug fix — see its own doc comment on VertexOutput): a
  // rotated or skewed rect has a genuinely diagonal screen edge, whose
  // coverage is not separable per axis and which the SDF path below handles.
  if (!isBorderOnly && input.isAxisAligned > 0.5 && all(input.radiiX == vec4f(0.0)) && all(input.radiiY == vec4f(0.0)) && all(widths == vec4f(0.0))) {
    let halfPixel = localPerScreen * 0.5;
    let overlap = max(
      min(input.localPos + halfPixel, input.halfSize) - max(input.localPos - halfPixel, -input.halfSize),
      vec2f(0.0));
    let axisCoverage = clamp(overlap * screenPerLocal, vec2f(0.0), vec2f(1.0));
    let coverage = axisCoverage.x * axisCoverage.y;
    if (resolvedFillColor.a * clipCoverage * coverage < 0.001) { discard; }
    return vec4f(resolvedFillColor.rgb, resolvedFillColor.a * clipCoverage * coverage);
  }

  // Coverage layers. The BACKGROUND extends to the border-box edge
  // (background-clip: border-box, Chrome's default — Slice P2 decision 6)
  // with the border ring composited source-over ON TOP of it; for a fully
  // opaque border this reduces exactly to the old fill-inside/border-ring
  // split.
  //
  // paintMode split: fill-only has no ring to sit under, so its fill covers
  // the FULL outer shape (innerAlpha forced to outerAlpha collapses
  // ringCoverage to exactly 0 below). border-only keeps the real ring band
  // but zeroes the interior fill contribution (backgroundA=0) so the
  // caller's later background-image draw shows through underneath it.
  let outerAlpha = 1.0 - smoothstep(-aa, aa, d);
  let innerAlpha = select(1.0 - smoothstep(-aaInner, aaInner, dInner), outerAlpha, isFillOnly);
  let ringCoverage = max(outerAlpha - innerAlpha, 0.0);

  // border-style (P7): the owning side's style reshapes where the border
  // INK paints within the ring band; the remainder of the band (the gap)
  // shows the element's own background, per background-clip: border-box.
  // solid (0) keeps the full band — bit-identical to the pre-P7 math
  // (gapCoverage collapses to exactly 0).
  // Per-side styled ink coverage (P7). The double stripes are whole-box
  // contours, side-independent — computed once here.
  let stripeOuterAlpha = 1.0 - smoothstep(-aaStripeOuter, aaStripeOuter, dStripeOuter);
  let stripeInnerAlpha = 1.0 - smoothstep(-aaStripeInner, aaStripeInner, dStripeInner);
  let doubleInk = max(outerAlpha - stripeOuterAlpha, 0.0) + max(stripeInnerAlpha - innerAlpha, 0.0);

  let sideStyle = (input.borderStyles >> (4u * sideFirst)) & 0xFu;
  let styleOfSecond = (input.borderStyles >> (4u * sideSecond)) & 0xFu;
  // Rounded boxes switch dashed/dotted to Blink's CLOSED-path model: one
  // continuous dash walk around the whole midline contour
  // (DrawCurvedDashedDottedBoxSide) instead of per-side straight lines —
  // the corner arcs carry the pattern THROUGH the corners.
  let boxIsRounded = any(input.radiiX > vec4f(0.0)) || any(input.radiiY > vec4f(0.0));
  var pathPosition = vec2f(0.0, 0.0);
  if (boxIsRounded && (sideStyle == 2u || sideStyle == 3u || styleOfSecond == 2u || styleOfSecond == 3u)) {
    pathPosition = closedCenterlinePosition(
      input.localPos, input.halfSize, widths, input.radiiX, input.radiiY, sideFirst);
  }
  let closedAa = max(dashAaX, dashAaY);
  var inkFirst = ringCoverage;
  if (sideStyle == 1u) { inkFirst = doubleInk; }
  else if (sideStyle == 2u || sideStyle == 3u) {
    if (boxIsRounded) {
      inkFirst = ringCoverage * closedDashDotCoverage(
        sideStyle, widths[sideFirst], pathPosition.y, pathPosition.x, abs(dHalfBand), closedAa);
    } else {
      inkFirst = ringCoverage * sidePatternCoverage(
        sideFirst, sideStyle, tFirst,
        input.localPos, input.halfSize, widths, dashAaX, dashAaY);
    }
  }
  var inkSecond = ringCoverage;
  if (styleOfSecond == 1u) { inkSecond = doubleInk; }
  else if (styleOfSecond == 2u || styleOfSecond == 3u) {
    if (boxIsRounded) {
      inkSecond = ringCoverage * closedDashDotCoverage(
        styleOfSecond, widths[sideSecond], pathPosition.y, pathPosition.x, abs(dHalfBand), closedAa);
    } else {
      inkSecond = ringCoverage * sidePatternCoverage(
        sideSecond, styleOfSecond, tSecond,
        input.localPos, input.halfSize, widths, dashAaX, dashAaY);
    }
  }
  // Corner composition, per Blink's miter rules (ComputeMiter /
  // MitersRequireClipping / BorderStylesRequireMiter):
  // - A dashed/dotted side is UNCLIPPED (its stroked line spans the full
  //   side rect) only when the adjacent side is the SAME style and SAME
  //   color — then the two sides' patterns simply overdraw: union (max).
  // - Every other combination gets a miter; Chrome's soft miters are
  //   drawn with antialiased clip edges, so the two sides' INK blends
  //   across the seam exactly like their colors do (the same seamBlend
  //   factor the color mix below uses). Same-style solid sides make
  //   inkFirst == inkSecond and the blend is a no-op — bit-identical to
  //   the pre-P7 behavior.
  var borderInkCoverage = mix(inkSecond, inkFirst, seamBlend);
  if ((sideStyle == 2u || sideStyle == 3u) && styleOfSecond == sideStyle
      && tSecond <= 1.0 && all(colorSecond == colorFirst) && !boxIsRounded) {
    // Same-style same-color straight-side patterns overdraw at corners
    // (no miter clip) — union. Rounded boxes never need this: the
    // closed-path walk is already continuous through the corners.
    borderInkCoverage = max(inkFirst, inkSecond);
  }
  let gapCoverage = max(ringCoverage - borderInkCoverage, 0.0);

  let backgroundA = select(resolvedFillColor.a, 0.0, isBorderOnly);
  let borderA = borderColor.a;
  let ringA = borderA + backgroundA * (1.0 - borderA);
  let ringRGBWeighted = borderColor.rgb * borderA + resolvedFillColor.rgb * backgroundA * (1.0 - borderA);

  // unclippedAlpha normalizes color (fill/border mix ratio, independent of
  // clipping); clipCoverage is applied only to the final returned alpha, not
  // to the color mix — otherwise a partially-clipped fringe pixel would
  // divide by a smaller number than its weights summed to and come out
  // artificially brighter, not just less opaque.
  let unclippedAlpha = (innerAlpha + gapCoverage) * backgroundA + borderInkCoverage * ringA;
  let totalAlpha = unclippedAlpha * clipCoverage;
  if (totalAlpha < 0.001) { discard; }

  let colorWeighted = resolvedFillColor.rgb * (innerAlpha + gapCoverage) * backgroundA + ringRGBWeighted * borderInkCoverage;
  let color = colorWeighted / unclippedAlpha;

  return vec4f(color, totalAlpha);
}
`;

const TILE_CLEAR_SHADER = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}
@vertex fn vertexMain(
  @location(0) quadPosition: vec2f,
  @location(1) normalizedPosition: vec2f,
  @location(2) normalizedSize: vec2f,
  @location(3) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(
    normalizedPosition.x + quadPosition.x * normalizedSize.x,
    normalizedPosition.y - quadPosition.y * normalizedSize.y,
    0.0,
    1.0,
  );
  output.color = color;
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return input.color;
}
`;

// Blend-mode enum values — MUST match layout.js's BLEND_* constants
// (Slice 8C). Baked as WGSL consts (not read from the uniform buffer as an
// enum-vs-magic-number pair) purely for readability in the fragment shader
// below.
const COMPOSITE_SHADER = `
const BLEND_NORMAL: f32 = 0.0;
const BLEND_MULTIPLY: f32 = 1.0;
const BLEND_SCREEN: f32 = 2.0;
const BLEND_OVERLAY: f32 = 3.0;
const BLEND_DARKEN: f32 = 4.0;
const BLEND_LIGHTEN: f32 = 5.0;
const BLEND_COLOR_DODGE: f32 = 6.0;
const BLEND_COLOR_BURN: f32 = 7.0;
const BLEND_HARD_LIGHT: f32 = 8.0;
const BLEND_SOFT_LIGHT: f32 = 9.0;
const BLEND_DIFFERENCE: f32 = 10.0;
const BLEND_EXCLUSION: f32 = 11.0;
const BLEND_HUE: f32 = 12.0;
const BLEND_SATURATION: f32 = 13.0;
const BLEND_COLOR: f32 = 14.0;
const BLEND_LUMINOSITY: f32 = 15.0;

${CLIP_STRUCT_WGSL}
struct Uniforms {
  resolution: vec2f,
  opacity: f32,
  blendMode: f32,
  hasMatrix: f32,
  clipCount: f32,
  _matrixPad0: f32,
  _matrixPad1: f32,
  // P8: color-matrix filter, row-major 4x5 (out R/G/B/A = row . [in
  // R,G,B,A] + matrixConst[row]) — applied to the group's own straight-
  // alpha color BEFORE opacity/blend-mode (filter runs first per the CSS
  // stacking/compositing order).
  matrixR: vec4f,
  matrixG: vec4f,
  matrixB: vec4f,
  matrixA: vec4f,
  matrixConst: vec4f,
  // P8b: real oriented/rounded clip evaluation (CLIP_EVAL_WGSL, the SAME
  // shared mechanism every other shader uses) — REPLACES this struct's
  // former private clipMin/clipMax/clipRadius/clipEnabled fields, which
  // were dead code (every writer set clipEnabled=0; nothing had ever
  // wired this shader's own clip up to the rasterizer's real clip
  pathMaskInfo: vec4f,
  pathMaskRect: vec4f,
  pathMaskBbox: vec4f,
  pathMaskUv: vec4f,
  pathMaskInvA: vec4f,
  pathMaskInvB: vec4f,
  // P11: x = 1 when this group is masked. The mask accumulator is
  // canvas-sized, exactly like the group texture, so it samples at the
  // composite quad's own uv with no mapping.
  maskInfo: vec4f,
  // stack). See design/paint-coverage.md's P8b design note.
  clips: array<ClipEntry, ${MAX_SHADER_CLIP_ENTRIES}>,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) pixelPos: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;
@group(0) @binding(4) var pathMaskTex: texture_2d<f32>;
@group(0) @binding(5) var pathMaskSampler: sampler;
@group(0) @binding(6) var maskTex: texture_2d<f32>;
@group(0) @binding(3) var backdropTex: texture_2d<f32>;

@vertex
fn vertexMain(
  @location(0) quadVertex: vec2f,
  @location(1) rectPos: vec2f,
  @location(2) rectSize: vec2f,
) -> VertexOutput {
  let pixelPos = rectPos + quadVertex * rectSize;
  let clipX = (pixelPos.x / uniforms.resolution.x) * 2.0 - 1.0;
  let clipY = 1.0 - (pixelPos.y / uniforms.resolution.y) * 2.0;

  var output: VertexOutput;
  output.position = vec4f(clipX, clipY, 0.0, 1.0);
  output.uv = pixelPos / uniforms.resolution;
  output.pixelPos = pixelPos;
  return output;
}

// P8b: real oriented/rounded clip evaluation — same shared cornerSelect/
// roundedRectSDF(localP, halfSize, radiiX, radiiY) every other shader
// defines (each shader carries its own copy rather than a shared WGSL
// module, matching this codebase's own established per-shader-copy
// convention for CLIP_EVAL_WGSL's own dependencies).
fn cornerSelect(p: vec2f, v: vec4f) -> f32 {
  return select(
    select(v.x, v.y, p.x > 0.0),
    select(v.w, v.z, p.x > 0.0),
    p.y > 0.0);
}

fn roundedRectSDF(localP: vec2f, halfSize: vec2f, radiiX: vec4f, radiiY: vec4f) -> f32 {
  let rx = cornerSelect(localP, radiiX);
  let ry = cornerSelect(localP, radiiY);
  let q = abs(localP) - halfSize + vec2f(rx, ry);
  let circD = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rx;
  let cornerD = (length(q / vec2f(max(rx, 1e-6), max(ry, 1e-6))) - 1.0) * min(rx, ry);
  let edgeD = max(q.x - rx, q.y - ry);
  let ellipseD = select(edgeD, cornerD, q.x > 0.0 && q.y > 0.0);
  return select(ellipseD, circD, abs(rx - ry) < 1e-4);
}

// --- CSS Compositing and Blending Level 1 — per-channel separable formulas.
// Each takes the backdrop (Cb) and source (Cs) channel value in [0,1].
fn blendMultiply(cb: f32, cs: f32) -> f32 { return cb * cs; }
fn blendScreen(cb: f32, cs: f32) -> f32 { return cb + cs - cb * cs; }
fn blendDarken(cb: f32, cs: f32) -> f32 { return min(cb, cs); }
fn blendLighten(cb: f32, cs: f32) -> f32 { return max(cb, cs); }
fn blendHardLight(cb: f32, cs: f32) -> f32 {
  if (cs <= 0.5) { return blendMultiply(cb, 2.0 * cs); }
  return blendScreen(cb, 2.0 * cs - 1.0);
}
fn blendOverlay(cb: f32, cs: f32) -> f32 { return blendHardLight(cs, cb); }
fn blendColorDodge(cb: f32, cs: f32) -> f32 {
  if (cb <= 0.0) { return 0.0; }
  if (cs >= 1.0) { return 1.0; }
  return min(1.0, cb / (1.0 - cs));
}
fn blendColorBurn(cb: f32, cs: f32) -> f32 {
  if (cb >= 1.0) { return 1.0; }
  if (cs <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - cb) / cs);
}
fn blendSoftLight(cb: f32, cs: f32) -> f32 {
  if (cs <= 0.5) { return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }
  var d: f32;
  if (cb <= 0.25) { d = ((16.0 * cb - 12.0) * cb + 4.0) * cb; }
  else { d = sqrt(cb); }
  return cb + (2.0 * cs - 1.0) * (d - cb);
}
fn blendDifference(cb: f32, cs: f32) -> f32 { return abs(cb - cs); }
fn blendExclusion(cb: f32, cs: f32) -> f32 { return cb + cs - 2.0 * cb * cs; }

fn blendSeparable(mode: f32, cb: vec3f, cs: vec3f) -> vec3f {
  if (mode == BLEND_MULTIPLY) {
    return vec3f(blendMultiply(cb.r, cs.r), blendMultiply(cb.g, cs.g), blendMultiply(cb.b, cs.b));
  }
  if (mode == BLEND_SCREEN) {
    return vec3f(blendScreen(cb.r, cs.r), blendScreen(cb.g, cs.g), blendScreen(cb.b, cs.b));
  }
  if (mode == BLEND_OVERLAY) {
    return vec3f(blendOverlay(cb.r, cs.r), blendOverlay(cb.g, cs.g), blendOverlay(cb.b, cs.b));
  }
  if (mode == BLEND_DARKEN) {
    return vec3f(blendDarken(cb.r, cs.r), blendDarken(cb.g, cs.g), blendDarken(cb.b, cs.b));
  }
  if (mode == BLEND_LIGHTEN) {
    return vec3f(blendLighten(cb.r, cs.r), blendLighten(cb.g, cs.g), blendLighten(cb.b, cs.b));
  }
  if (mode == BLEND_COLOR_DODGE) {
    return vec3f(blendColorDodge(cb.r, cs.r), blendColorDodge(cb.g, cs.g), blendColorDodge(cb.b, cs.b));
  }
  if (mode == BLEND_COLOR_BURN) {
    return vec3f(blendColorBurn(cb.r, cs.r), blendColorBurn(cb.g, cs.g), blendColorBurn(cb.b, cs.b));
  }
  if (mode == BLEND_HARD_LIGHT) {
    return vec3f(blendHardLight(cb.r, cs.r), blendHardLight(cb.g, cs.g), blendHardLight(cb.b, cs.b));
  }
  if (mode == BLEND_SOFT_LIGHT) {
    return vec3f(blendSoftLight(cb.r, cs.r), blendSoftLight(cb.g, cs.g), blendSoftLight(cb.b, cs.b));
  }
  if (mode == BLEND_DIFFERENCE) {
    return vec3f(blendDifference(cb.r, cs.r), blendDifference(cb.g, cs.g), blendDifference(cb.b, cs.b));
  }
  // BLEND_EXCLUSION
  return vec3f(blendExclusion(cb.r, cs.r), blendExclusion(cb.g, cs.g), blendExclusion(cb.b, cs.b));
}

// --- Non-separable modes (hue/saturation/color/luminosity) — CSS
// Compositing spec §3.2 SetLum/SetSat/Lum/Sat helpers, straight port.
fn lum(c: vec3f) -> f32 { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }

fn clipColor(c: vec3f) -> vec3f {
  let l = lum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  var result = c;
  if (n < 0.0) {
    result = l + (result - l) * (l / (l - n));
  }
  if (x > 1.0) {
    result = l + (result - l) * ((1.0 - l) / (x - l));
  }
  return result;
}

fn setLum(c: vec3f, l: f32) -> vec3f {
  let d = l - lum(c);
  return clipColor(c + vec3f(d, d, d));
}

fn sat(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

// setSat: scale the mid/max channels so the result has saturation s,
// preserving which channel is min/mid/max. WGSL has no dynamic swizzle
// assignment, so this compares all three orderings explicitly (a direct,
// unrolled port of the spec's sort-based pseudocode).
fn setSat(c: vec3f, s: f32) -> vec3f {
  let cmin = min(c.r, min(c.g, c.b));
  let cmax = max(c.r, max(c.g, c.b));
  if (cmax <= cmin) { return vec3f(0.0, 0.0, 0.0); }
  let cmid = c.r + c.g + c.b - cmin - cmax;
  let newMid = (cmid - cmin) * s / (cmax - cmin);
  if (c.r == cmax) {
    if (c.g == cmin) { return vec3f(s, 0.0, newMid); }
    return vec3f(s, newMid, 0.0);
  }
  if (c.g == cmax) {
    if (c.r == cmin) { return vec3f(0.0, s, newMid); }
    return vec3f(newMid, s, 0.0);
  }
  // c.b == cmax
  if (c.r == cmin) { return vec3f(0.0, newMid, s); }
  return vec3f(newMid, 0.0, s);
}

fn blendNonSeparable(mode: f32, cb: vec3f, cs: vec3f) -> vec3f {
  if (mode == BLEND_HUE) { return setLum(setSat(cs, sat(cb)), lum(cb)); }
  if (mode == BLEND_SATURATION) { return setLum(setSat(cb, sat(cs)), lum(cb)); }
  if (mode == BLEND_COLOR) { return setLum(cs, lum(cb)); }
  // BLEND_LUMINOSITY
  return setLum(cb, lum(cs));
}

fn median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  // Clip-list coverage — shared CLIP_EVAL_WGSL (P8b: replaces this
  // shader's former private, dead clipMin/clipMax/clipRadius/clipEnabled
  // fields — see design/paint-coverage.md's P8b design note).
${CLIP_EVAL_WGSL}

  var src = textureSample(srcTex, srcSampler, input.uv);
  if (src.a < 0.001) { discard; }
  if (uniforms.pathMaskInfo.x > 0.5) {
    let localPos = vec2f(
      uniforms.pathMaskInvA.x * input.pixelPos.x + uniforms.pathMaskInvA.z * input.pixelPos.y + uniforms.pathMaskInvB.x,
      uniforms.pathMaskInvA.y * input.pixelPos.x + uniforms.pathMaskInvA.w * input.pixelPos.y + uniforms.pathMaskInvB.y);
    let pathPos = (localPos - uniforms.pathMaskRect.xy) / uniforms.pathMaskInfo.y;
    let bboxSize = uniforms.pathMaskBbox.zw - uniforms.pathMaskBbox.xy;
    let normalized = (pathPos - uniforms.pathMaskBbox.xy) / bboxSize;
    let insidePathBounds = all(normalized >= vec2f(0.0)) && all(normalized <= vec2f(1.0));
    let atlasUv = uniforms.pathMaskUv.xy
      + clamp(normalized, vec2f(0.0), vec2f(1.0)) * uniforms.pathMaskUv.zw;
    let msdf = textureSampleLevel(pathMaskTex, pathMaskSampler, atlasUv, 0.0);
    let screenPxDistance = (median(msdf.r, msdf.g, msdf.b) - 0.5) * uniforms.pathMaskInfo.z;
    let fw = max(fwidth(screenPxDistance), 1e-4);
    let sampledCoverage = clamp(screenPxDistance / fw + 0.5, 0.0, 1.0);
    let pathCoverage = select(0.0, sampledCoverage, insidePathBounds);
    src.a = src.a * pathCoverage;
    if (src.a < 0.001) { discard; }
  }
  // P11: the mask accumulator carries coverage in ALPHA (see the
  // MASK_COMBINE pass, which converts each layer to a coverage value and
  // composites the layers there). Multiplying it into the group's alpha
  // here is the whole of masking's effect on the element.
  if (uniforms.maskInfo.x > 0.5) {
    src.a = src.a * textureSampleLevel(maskTex, srcSampler, input.uv, 0.0).a;
    if (src.a < 0.001) { discard; }
  }

  // P8: color-matrix filters apply to the group's own straight-alpha
  // color BEFORE blend-mode/opacity (filter -> blend -> opacity is the
  // CSS stacking-context paint order — filter-effects-1 / the
  // Appendix E paint order this codebase already follows elsewhere).
  if (uniforms.hasMatrix > 0.5) {
    let rgba = vec4f(src.r, src.g, src.b, src.a);
    let filtered = vec4f(
      dot(uniforms.matrixR, rgba) + uniforms.matrixConst.r,
      dot(uniforms.matrixG, rgba) + uniforms.matrixConst.g,
      dot(uniforms.matrixB, rgba) + uniforms.matrixConst.b,
      dot(uniforms.matrixA, rgba) + uniforms.matrixConst.a);
    src = vec4f(clamp(filtered.rgb, vec3f(0.0), vec3f(1.0)), clamp(filtered.a, 0.0, 1.0));
  }

  var color = src;
  if (uniforms.blendMode != BLEND_NORMAL) {
    // CSS Compositing §3.1: Cs = (1 - ab)×Cs + ab×B(Cb, Cs) — the blended
    // color is itself mixed with the source color by the backdrop's alpha
    // (a fully-transparent backdrop leaves the source untouched), THEN
    // the normal src-over-backdrop alpha compositing (the pipeline's fixed-
    // function blend state below) combines it with the backdrop using the
    // element's own alpha. Backdrop is read UNASSOCIATED (straight) alpha,
    // matching srcTex's own convention (this compositor never premultiplies).
    let backdrop = textureSampleLevel(backdropTex, srcSampler, input.uv, 0.0);
    var blended: vec3f;
    if (uniforms.blendMode <= BLEND_EXCLUSION) {
      blended = blendSeparable(uniforms.blendMode, backdrop.rgb, src.rgb);
    } else {
      blended = blendNonSeparable(uniforms.blendMode, backdrop.rgb, src.rgb);
    }
    let mixed = mix(src.rgb, blended, backdrop.a);
    color = vec4f(mixed, src.a);
  }
  return vec4f(color.rgb, color.a * uniforms.opacity * clipCoverage);
}
`;

// P11: one mask LAYER's scratch texture -> a coverage value composited
// into the mask accumulator. Coverage rides in ALPHA (RGB is written as
// zero and never read), which is what lets each mask-composite operator
// be an ordinary alpha blend state on this pipeline instead of shader
// math — see MASK_COMPOSITE_BLEND.
//
// mask-mode: `alpha` takes the layer's own alpha; `luminance` weights the
// sRGB-ENCODED channels by the Rec.709 coefficients and multiplies by
// alpha (CSS masks default to the sRGB color space — an SVG <mask>
// element's linearRGB default is a different thing and needs the DOM
// layer). `match-source` resolves to alpha: every source sandom can have
// is an image or a gradient.
const MASK_COMBINE_SHADER = `
struct Uniforms {
  resolution: vec2f,
  mode: f32,
  _pad: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var layerTex: texture_2d<f32>;
@group(0) @binding(2) var layerSampler: sampler;

@vertex
fn vertexMain(
  @location(0) quadVertex: vec2f,
  @location(1) rectPos: vec2f,
  @location(2) rectSize: vec2f,
) -> VertexOutput {
  let pixelPos = rectPos + quadVertex * rectSize;
  var output: VertexOutput;
  output.position = vec4f(
    (pixelPos.x / uniforms.resolution.x) * 2.0 - 1.0,
    1.0 - (pixelPos.y / uniforms.resolution.y) * 2.0,
    0.0, 1.0);
  output.uv = quadVertex;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let layer = textureSample(layerTex, layerSampler, input.uv);
  var coverage = layer.a;
  if (uniforms.mode > 1.5) {
    coverage = (0.2126 * layer.r + 0.7152 * layer.g + 0.0722 * layer.b) * layer.a;
  }
  return vec4f(0.0, 0.0, 0.0, coverage);
}
`;

// mask-composite as blend factors on MASK_COMBINE's own draw, indexed by
// layout.js's MASK_COMPOSITE_* enum. Coverage is in alpha, so each entry
// is the Porter-Duff operator css-masking-1 §5.7 names, expressed
// directly: add = source-over, subtract = source-out, intersect =
// source-in, exclude = xor. The color channels carry no information and
// use the same factors purely so the two channels never disagree.
const MASK_COMPOSITE_BLEND = [
  { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  { srcFactor: "one-minus-dst-alpha", dstFactor: "zero" },
  { srcFactor: "dst-alpha", dstFactor: "zero" },
  { srcFactor: "one-minus-dst-alpha", dstFactor: "one-minus-src-alpha" },
];

// filter: blur() (P8, blur sub-step) — ONE box-blur pass along a single
// axis (horizontal XOR vertical). filter-effects-1 §9.14: every major
// implementation (Chrome/Skia included) approximates Gaussian blur with
// THREE box-blur passes per axis, not a true per-pixel Gaussian kernel
// — see design/paint-coverage.md's P8 blur design note for the box-width
// derivation (d = floor(sigma*3*sqrt(2*PI)/4 + 0.5), odd/even handling).
// This shader runs that ONE pass; the JS driver calls it 3x per axis
// with the box widths the odd/even correction picks.
//
// Blurs in PREMULTIPLIED space (box-averaging straight-alpha RGB
// directly would bleed a fully-transparent texel's arbitrary/garbage
// RGB into its semi-transparent neighbors — premultiplying first makes
// a transparent texel's contribution exactly zero, the physically
// correct behavior) and un-premultiplies on output, matching the
// group's own straight-alpha convention everywhere else in this file.
const BOX_BLUR_SHADER = `
struct Uniforms {
  resolution: vec2f,
  direction: vec2f,   // (1,0) horizontal or (0,1) vertical, texel units
  boxWidth: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;

@vertex
fn vertexMain(@location(0) quadVertex: vec2f) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(quadVertex.x * 2.0 - 1.0, 1.0 - quadVertex.y * 2.0, 0.0, 1.0);
  output.uv = quadVertex;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let texelSize = uniforms.direction / uniforms.resolution;
  let radius = floor(uniforms.boxWidth / 2.0);
  var sum = vec4f(0.0);
  var count = 0.0;
  for (var i = -radius; i <= radius; i = i + 1.0) {
    let sampleUv = input.uv + texelSize * i;
    if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
      continue;
    }
    let c = textureSampleLevel(srcTex, srcSampler, sampleUv, 0.0);
    sum = sum + vec4f(c.rgb * c.a, c.a);
    count = count + 1.0;
  }
  let premult = sum / max(count, 1.0);
  if (premult.a < 0.0001) {
    return vec4f(0.0);
  }
  return vec4f(premult.rgb / premult.a, premult.a);
}
`;

// filter: drop-shadow() (P8 step 3) — the final "flood + offset + mask +
// composite-under" pass, reading the group's blurred-alpha texture
// (already produced by BOX_BLUR_SHADER's own six passes, reused as-is —
// its RGB output is simply ignored here, its alpha channel is exactly
// SourceAlpha's own blur) and the group's CURRENT (unblurred) texture.
// Spec-verified via the markup-equivalent SVG filter chain
// (drafts.csswg.org/filter-effects-1 sec 13.1.10):
//   feOffset(blurredAlpha, dx, dy)                    -> offsetblur
//   feFlood(color) composited "in" offsetblur's alpha  -> shadow
//   feMerge: [shadow, SourceGraphic] (paint order = shadow UNDER)
// "in" is the standard Porter-Duff operator: result.rgb = src.rgb,
// result.a = src.a * dst.a — with a fully-opaque flood (src.a=1), this
// reduces to result = (color.rgb, offsetblur.a), i.e. a flat color flood
// masked by the offset alpha shape.
const DROP_SHADOW_SHADER = `
struct Uniforms {
  resolution: vec2f,
  offset: vec2f,     // (dx, dy) in pixels
  color: vec4f,       // straight RGBA, [0,1]
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var blurredAlphaTex: texture_2d<f32>;
@group(0) @binding(2) var currentTex: texture_2d<f32>;
@group(0) @binding(3) var srcSampler: sampler;

@vertex
fn vertexMain(@location(0) quadVertex: vec2f) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(quadVertex.x * 2.0 - 1.0, 1.0 - quadVertex.y * 2.0, 0.0, 1.0);
  output.uv = quadVertex;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let offsetUv = input.uv - uniforms.offset / uniforms.resolution;
  var shadowAlpha = 0.0;
  if (offsetUv.x >= 0.0 && offsetUv.x <= 1.0 && offsetUv.y >= 0.0 && offsetUv.y <= 1.0) {
    shadowAlpha = textureSampleLevel(blurredAlphaTex, srcSampler, offsetUv, 0.0).a;
  }
  let shadow = vec4f(uniforms.color.rgb, uniforms.color.a * shadowAlpha);
  let current = textureSample(currentTex, srcSampler, input.uv);
  // Straight-alpha src-over: current ON TOP of shadow (shadow is UNDER,
  // per the spec's own feMerge order).
  let outAlpha = current.a + shadow.a * (1.0 - current.a);
  if (outAlpha < 0.0001) {
    return vec4f(0.0);
  }
  let outRgb = (current.rgb * current.a + shadow.rgb * shadow.a * (1.0 - current.a)) / outAlpha;
  return vec4f(outRgb, outAlpha);
}
`;

const TEXT_SHADER = `
${CLIP_STRUCT_WGSL}
struct Uniforms {
  resolution: vec2f,
  clipCount: f32,
  // Chrome-on-macOS text mask model (see fragmentMain): per-polarity
  // iso-contour dilation in screen pixels for fully-light text (luma 1)
  // and fully-dark text (luma 0), interpolated by the text color's
  // luminance. 0/0 = no dilation.
  dilateLight: f32,
  dilateDark: f32,
  // Schlick steepness gain for the coverage S-curve (see fragmentMain) —
  // 1.0 is the identity.
  steepness: f32,
  _clipPad1: f32,
  _clipPad2: f32,
  clips: array<ClipEntry, ${MAX_SHADER_CLIP_ENTRIES}>,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) pxRange: f32,
  @location(3) pixelPos: vec2f,
  // text-shadow (P6): blur sigma in screen px; 0 = ink pass.
  @location(4) shadowSoft: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;

fn applyTransform(p: vec2f, t: mat3x2f) -> vec2f {
  return vec2f(
    t[0][0] * p.x + t[1][0] * p.y + t[2][0],
    t[0][1] * p.x + t[1][1] * p.y + t[2][1]
  );
}

@vertex
fn vertexMain(
  @location(0) quadVertex: vec2f,
  @location(1) glyphPos: vec2f,
  @location(2) glyphSize: vec2f,
  @location(3) uvPos: vec2f,
  @location(4) uvSize: vec2f,
  @location(5) color: vec4f,
  @location(6) params: vec2f,
  @location(7) transformCol0: vec2f,
  @location(8) transformCol1: vec2f,
  @location(9) transformCol2: vec2f,
) -> VertexOutput {
  let localPixelPos = glyphPos + quadVertex * glyphSize;
  let transform = mat3x2f(transformCol0, transformCol1, transformCol2);
  let pixelPos = applyTransform(localPixelPos, transform);
  let clipX = (pixelPos.x / uniforms.resolution.x) * 2.0 - 1.0;
  let clipY = 1.0 - (pixelPos.y / uniforms.resolution.y) * 2.0;

  var output: VertexOutput;
  output.position = vec4f(clipX, clipY, 0.0, 1.0);
  output.uv = uvPos + quadVertex * uvSize;
  output.color = color;
  output.pxRange = params.x;
  output.pixelPos = pixelPos;
  output.shadowSoft = params.y;
  return output;
}

fn median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

// Same per-corner elliptical rounded-rect SDF as the rect shader (each
// shader string is self-contained — keep the two in sync).
fn cornerSelect(p: vec2f, v: vec4f) -> f32 {
  return select(
    select(v.x, v.y, p.x > 0.0),
    select(v.w, v.z, p.x > 0.0),
    p.y > 0.0);
}

fn roundedRectSDF(localP: vec2f, halfSize: vec2f, radiiX: vec4f, radiiY: vec4f) -> f32 {
  let rx = cornerSelect(localP, radiiX);
  let ry = cornerSelect(localP, radiiY);
  let q = abs(localP) - halfSize + vec2f(rx, ry);
  let circD = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rx;
  let cornerD = (length(q / vec2f(max(rx, 1e-6), max(ry, 1e-6))) - 1.0) * min(rx, ry);
  let edgeD = max(q.x - rx, q.y - ry);
  let ellipseD = select(edgeD, cornerD, q.x > 0.0 && q.y > 0.0);
  return select(ellipseD, circD, abs(rx - ry) < 1e-4);
}

// Rotated-grid supersampling offsets (RGSS), in pixel-footprint units.
const RGSS_OFFSETS = array<vec2f, 4>(
  vec2f(0.125, 0.375), vec2f(0.375, -0.125),
  vec2f(-0.125, -0.375), vec2f(-0.375, 0.125));

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  // Clip-list coverage — shared CLIP_EVAL_WGSL (was a per-shader copy of
  // the rect shader's clip block; glyphs crossing a rounded/oriented clip
  // boundary blend via the same fwidth band, Slice T3's behavior kept).
${CLIP_EVAL_WGSL}

  let msdf = textureSample(atlasTex, atlasSampler, input.uv);
  let sd = median(msdf.r, msdf.g, msdf.b);
  let screenPxDistance = (sd - 0.5) * input.pxRange;
  // Isotropic gradient magnitude, NOT fwidth: fwidth = |ddx|+|ddy|
  // overestimates the gradient by up to sqrt(2) on diagonals, widening
  // the coverage ramp exactly where glyphs curve — measured on the
  // coverage-profile corpus as soft/fat AA skirts on curved-heavy faces
  // (a heavy-weight display face measured 1.24-1.44x Chrome's faint ink;
  // dropped to ~1.04 with the isotropic form). See design/text-rendering.md.
  let fw = max(length(vec2f(dpdx(screenPxDistance), dpdy(screenPxDistance))), 1e-4);
  // text-shadow blur pass (P6): a Gaussian-blurred glyph edge
  // approximated by WIDENING the distance ramp — smoothstep over ±2σ
  // tracks the normal-CDF falloff of a true Gaussian of std σ, floored
  // at the AA band so tiny sigmas stay antialiased. No Skia mask-gamma
  // remap here: that models the glyph rasterizer's coverage curve, and
  // a blur falloff is not glyph coverage (zero-blur shadows never take
  // this branch — they run the exact ink path below in the shadow's
  // color, keeping the "pure offset copy" requirement bit-faithful).
  // Ceiling: the falloff saturates at the quad edge, whose usable
  // outward range is ~pxRange/2 screen px — large blurs truncate there
  // (documented in design/paint-coverage.md P6; typical small text-shadow
  // blurs sit well inside it).
  let uvdx = dpdx(input.uv);
  let uvdy = dpdy(input.uv);
  if (input.shadowSoft > 0.0) {
    let h = max(2.0 * input.shadowSoft, 0.5 * fw);
    let softAlpha = smoothstep(-h, h, screenPxDistance) * input.color.a * clipCoverage;
    if (softAlpha < 0.001) { discard; }
    return vec4f(input.color.rgb, softAlpha);
  }
  // Coverage: BOX-FILTER emulation via 4 rotated-grid sub-pixel taps of
  // the linear ramp, averaged. A single center sample MISSES sub-pixel
  // features that fall between pixel centers — Inter wght-100 hairline
  // stems at 24px rendered as broken/absent runs (the specimen
  // weight-ramp rows' stray pixels: whole 2px stem columns with zero
  // sandom ink) while Chrome's true box coverage keeps every stem
  // visibly continuous. Four taps give a piecewise approximation of the
  // pixel-footprint integral; a stem between pixel centers still lands
  // on 1-2 taps. (The earlier single-sample linear ramp replaced a
  // smoothstep for the same thin-stroke reasons — this keeps the linear
  // per-tap ramp.)
  // Chrome-on-macOS text mask model, two mechanisms (recalibrated
  // 2026-08-25 at density 2 on the static-document corpus, verified at
  // density 1 on the React parity pins):
  //
  //   DILATION — macOS font smoothing (CoreGraphics stem darkening, kept
  //   by Chrome's Skia/CoreText raster path) DILATES glyph outlines,
  //   strongly for light-on-dark text, slightly for dark-on-light. This
  //   creates real coverage OUTSIDE the true outline — an alpha remap
  //   cannot reproduce it (there is nothing to remap where coverage is
  //   zero; the retired pow(alpha, 0.4) model faked it by amplifying
  //   4%-coverage noise to 28% alpha, which is exactly the softness the
  //   sharpness ruling retired). Modeled as a per-polarity ISO-CONTOUR
  //   shift: each tap's signed distance moves outward by
  //   mix(dilateDark, dilateLight, textLuma) screen pixels.
  //
  //   GAIN — Skia's kFakeGammaAndBoostContrast contrast curve, modeled
  //   as a Schlick S-curve around 0.5 (steepness 1 = identity). This
  //   narrows the coverage ramp toward Chrome's measured 0.65-0.82
  //   device-px stem transitions (raw 4-tap box coverage is a fixed
  //   ~1 px linear ramp; no pointwise remap of a single sample can
  //   narrow it, only the tap-domain shift plus this S-curve).
  //
  // Constants live in render()'s textGamma default; calibrate with
  // tools/calibrate-text-gamma.js (objective: minimum summed structural
  // ink across the document corpus, ramp width as the overfit guard).
  let luma = dot(input.color.rgb, vec3f(0.299, 0.587, 0.114));
  let dilate = mix(uniforms.dilateDark, uniforms.dilateLight, luma);
  var cov = 0.0;
  for (var i = 0; i < 4; i++) {
    let o = RGSS_OFFSETS[i];
    let m = textureSampleLevel(atlasTex, atlasSampler, input.uv + uvdx * o.x + uvdy * o.y, 0.0);
    let d = (median(m.r, m.g, m.b) - 0.5) * input.pxRange + dilate;
    cov += clamp(d / fw + 0.5, 0.0, 1.0);
  }
  var alpha = cov * 0.25;
  let sp = max(uniforms.steepness, 1e-3);
  let ap = pow(alpha, sp);
  alpha = ap / max(ap + pow(1.0 - alpha, sp), 1e-6);

  if (alpha < 0.001) { discard; }
  // Clip coverage multiplies AFTER mask gamma: gamma models the glyph
  // rasterizer's coverage remap, clip coverage is plain geometry.
  return vec4f(input.color.rgb, input.color.a * alpha * clipCoverage);
}
`;

// SVG path fill (design/svg-rendering.md, Tier B): same MSDF median/coverage math as
// TEXT_SHADER (both sample a 3-channel distance-field atlas), but WITHOUT
// the Skia glyph-mask gamma remap — that's a text-rasterizer-specific
// convention (SkMaskGamma preblend, calibrated against Chrome's own glyph
// hinting), not something SVG path fills do; Chrome renders vector path
// fills with plain linear coverage. Also no border-color/miter machinery
// (a filled path has no border concept at Tier A's RECT-shader sense —
// S5 stroke-to-fill produces a SEPARATE filled outline shape, drawn as its
// own ordinary fill, not a border ring). Self-contained shader string per
// this file's existing convention (kept in sync with TEXT_SHADER manually).
//
// Gradient fill (Tier B SVG gradients): the sample*Gradient/walkGradient
// Stops/mixPremultiplied/repeatWrapT functions below are a VERBATIM copy
// of RECT_SHADER's own — gradient math is a pure function of (localPos,
// halfSize, GradientRecord), independent of the rounded-rect SDF geometry
// RECT_SHADER also happens to compute, so nothing rect-specific needed
// porting. localPos here is relative to the FILL PATH'S OWN unpadded
// bbox center (gradRectPos/gradRectSize, a SEPARATE pair of vertex
// attributes from destPos/destSize) — NOT the atlas-padded quad's own
// center (destPos/destSize is expanded by the atlas's msdfgen `range`
// padding purely for correct MSDF sampling, see vertexMain's own comment;
// the gradient must resolve against the shape's REAL geometry, matching
// what $writeGradientExtension resolved it against in engine.wat).
const SVG_PATH_SHADER = `
${CLIP_STRUCT_WGSL}
${GRADIENT_COLOR_WGSL}
struct Uniforms {
  resolution: vec2f,
  clipCount: f32,
  _clipPad: f32,
  clips: array<ClipEntry, ${MAX_SHADER_CLIP_ENTRIES}>,
}

// hasGradient doubles as a flags word: bit0 = has, bit1 = TILED
// (background-origin — the positioning area differs from the painted
// rect; the dispatch wraps the origin-space sample position modulo
// geom4..7's size). geom4..7 = the ORIGIN RECT {dx, dy, w, h}: the
// positioning area's top-left relative to the painted rect's own
// top-left plus its size — (0, 0, rectW, rectH) whenever the two boxes
// coincide (all SVG draws, borderless CSS boxes).
struct GradientRecord {
  hasGradient: u32,
  kind: u32,
  stopStart: u32,
  stopCount: u32,
  geom0: f32,
  geom1: f32,
  geom2: f32,
  geom3: f32,
  geom4: f32,
  geom5: f32,
  geom6: f32,
  geom7: f32,
}
struct GradientStop {
  color: vec4f,
  position: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) pxRange: f32,
  @location(3) pixelPos: vec2f,
  @location(4) gradLocalPos: vec2f,
  @location(5) gradHalfSize: vec2f,
  // Pass-through instance index (S7 step 2): fragment shaders can't read
  // @builtin(instance_index) directly, only the vertex stage can (same
  // constraint RECT_SHADER's own GradientRecord lookup already works
  // around) — thread it through as an ordinary flat-interpolated location.
  @location(6) @interpolate(flat) instanceIndex: u32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;
@group(0) @binding(3) var<storage, read> gradientRecords: array<GradientRecord>;
@group(0) @binding(4) var<storage, read> gradientStops: array<GradientStop>;

fn applyTransform(p: vec2f, t: mat3x2f) -> vec2f {
  return vec2f(
    t[0][0] * p.x + t[1][0] * p.y + t[2][0],
    t[0][1] * p.x + t[1][1] * p.y + t[2][1]
  );
}

@vertex
fn vertexMain(
  @builtin(instance_index) instanceIndex: u32,
  @location(0) quadVertex: vec2f,
  @location(1) destPos: vec2f,
  @location(2) destSize: vec2f,
  @location(3) uvPos: vec2f,
  @location(4) uvSize: vec2f,
  @location(5) color: vec4f,
  @location(6) pxRange: f32,
  @location(7) transformCol0: vec2f,
  @location(8) transformCol1: vec2f,
  @location(9) transformCol2: vec2f,
  @location(10) gradRectPos: vec2f,
  @location(11) gradRectSize: vec2f,
) -> VertexOutput {
  let localPixelPos = destPos + quadVertex * destSize;
  let transform = mat3x2f(transformCol0, transformCol1, transformCol2);
  let pixelPos = applyTransform(localPixelPos, transform);
  let clipX = (pixelPos.x / uniforms.resolution.x) * 2.0 - 1.0;
  let clipY = 1.0 - (pixelPos.y / uniforms.resolution.y) * 2.0;

  var output: VertexOutput;
  output.position = vec4f(clipX, clipY, 0.0, 1.0);
  output.uv = uvPos + quadVertex * uvSize;
  output.color = color;
  output.pxRange = pxRange;
  output.pixelPos = pixelPos;
  // Gradient local position — relative to the FILL PATH'S OWN unpadded
  // bbox center (same space $writeGradientExtension resolved geom0..3
  // against), computed the same way from localPixelPos as the padded
  // destPos/destSize pair is, just against gradRectPos/gradRectSize
  // instead.
  output.gradLocalPos = localPixelPos - (gradRectPos + gradRectSize * 0.5);
  output.gradHalfSize = gradRectSize * 0.5;
  output.instanceIndex = instanceIndex;
  return output;
}

fn median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

fn cornerSelect(p: vec2f, v: vec4f) -> f32 {
  return select(
    select(v.x, v.y, p.x > 0.0),
    select(v.w, v.z, p.x > 0.0),
    p.y > 0.0);
}

fn roundedRectSDF(localP: vec2f, halfSize: vec2f, radiiX: vec4f, radiiY: vec4f) -> f32 {
  let rx = cornerSelect(localP, radiiX);
  let ry = cornerSelect(localP, radiiY);
  let q = abs(localP) - halfSize + vec2f(rx, ry);
  let circD = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rx;
  let cornerD = (length(q / vec2f(max(rx, 1e-6), max(ry, 1e-6))) - 1.0) * min(rx, ry);
  let edgeD = max(q.x - rx, q.y - ry);
  let ellipseD = select(edgeD, cornerD, q.x > 0.0 && q.y > 0.0);
  return select(ellipseD, circD, abs(rx - ry) < 1e-4);
}

// --- Gradient sampling (S7 step 2) — verbatim from RECT_SHADER, see this
// file's copy for the full derivation/verification comments on each. ---
const GRADIENT_STOP_WALK_CAP: u32 = 64u;

// Hue-channel-aware premultiplied mix, verbatim from RECT_SHADER.
fn mixPremultiplied(a: vec4f, b: vec4f, t: f32, hueChannel: i32) -> vec4f {
  var premultA = vec4f(a.rgb * a.a, a.a);
  var premultB = vec4f(b.rgb * b.a, b.a);
  if (hueChannel >= 0) {
    premultA[hueChannel] = a[hueChannel];
    premultB[hueChannel] = b[hueChannel];
  }
  let premultMixed = mix(premultA, premultB, t);
  if (premultMixed.a < 1e-6) { return vec4f(0.0); }
  var straight = vec4f(premultMixed.rgb / premultMixed.a, premultMixed.a);
  if (hueChannel >= 0) {
    straight[hueChannel] = premultMixed[hueChannel];
  }
  return straight;
}

fn repeatWrapT(t: f32, rec: GradientRecord) -> f32 {
  let firstPos = gradientStops[rec.stopStart].position;
  let lastPos = gradientStops[rec.stopStart + rec.stopCount - 1u].position;
  let span = max(lastPos - firstPos, 1e-6);
  let rel = (t - firstPos) / span;
  return firstPos + fract(rel) * span;
}

fn walkGradientStops(rawT: f32, rec: GradientRecord, isRepeating: bool) -> vec4f {
  if (rec.stopCount == 0u) { return vec4f(0.0); }
  if (rec.stopCount == 1u) { return gradientStops[rec.stopStart].color; }
  let t = select(rawT, repeatWrapT(rawT, rec), isRepeating);
  var prevStop = gradientStops[rec.stopStart];
  let cap = min(rec.stopCount, GRADIENT_STOP_WALK_CAP);
  for (var i: u32 = 1u; i < cap; i = i + 1u) {
    let stop = gradientStops[rec.stopStart + i];
    if (t <= stop.position) {
      let span = max(stop.position - prevStop.position, 1e-6);
      let localT = clamp((t - prevStop.position) / span, 0.0, 1.0);
      return mixPremultiplied(prevStop.color, stop.color, localT, gradientHueChannel(rec.hasGradient));
    }
    prevStop = stop;
  }
  return prevStop.color;
}

// geom3: the linear center-shift term (background-origin) — always 0 for
// SVG paths (identity origin), kept in lockstep with the rect shader's
// own sampleLinearGradient (see its comment above).
// Origin-box-space samplers, kept in lockstep with the rect shader's own
// copies (see their comments there). For SVG the origin box is always
// the painted rect itself (geom4/5 = 0, geom6/7 = rect size, TILED never
// set), so these reduce exactly to the pre-origin formulas.
fn sampleLinearGradient(posO: vec2f, originSize: vec2f, rec: GradientRecord, isRepeating: bool) -> vec4f {
  let rawT = 0.5 + dot(posO - originSize * 0.5, vec2f(rec.geom0, rec.geom1)) / max(rec.geom2, 1e-6);
  let t = select(clamp(rawT, 0.0, 1.0), rawT, isRepeating);
  return walkGradientStops(t, rec, isRepeating);
}

fn sampleRadialGradient(posO: vec2f, rec: GradientRecord, isRepeating: bool) -> vec4f {
  let centerRelPos = posO - vec2f(rec.geom0, rec.geom1);
  let dx = centerRelPos.x / max(rec.geom2, 1e-6);
  let dy = centerRelPos.y / max(rec.geom3, 1e-6);
  let rawT = sqrt(dx * dx + dy * dy);
  let t = select(clamp(rawT, 0.0, 1.0), rawT, isRepeating);
  return walkGradientStops(t, rec, isRepeating);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  // Clip-list coverage — shared CLIP_EVAL_WGSL.
${CLIP_EVAL_WGSL}

  let msdf = textureSample(atlasTex, atlasSampler, input.uv);
  let sd = median(msdf.r, msdf.g, msdf.b);
  let screenPxDistance = (sd - 0.5) * input.pxRange;
  let fw = max(fwidth(screenPxDistance), 1e-4);
  // Plain linear box-filter coverage ramp — no gamma remap (see this
  // shader's own top comment for why not).
  let alpha = clamp(screenPxDistance / fw + 0.5, 0.0, 1.0);

  if (alpha < 0.001) { discard; }

  // Gradient (S7 step 2): substitute the gradient's own computed color
  // for the plain fill color when this instance carries one — same
  // mutually-exclusive read-or-compute as RECT_SHADER's own (WAT never
  // sets both a solid fill AND a gradient flag on the same draw).
  let gradRec = gradientRecords[input.instanceIndex];
  let gradKind = gradRec.kind & 0x7Fu;
  let gradIsRepeating = (gradRec.kind & 0x80u) != 0u;
  var resolvedColor = input.color;
  if (gradRec.hasGradient != 0u) {
    // Same origin-space mapping as the rect shader's dispatch (identity
    // for SVG — geom4/5 are 0 and TILED is never set, but the shared
    // formula keeps the two shaders in lockstep).
    let gradOriginSize = max(vec2f(gradRec.geom6, gradRec.geom7), vec2f(1e-6));
    var gradPosO = input.gradLocalPos + input.gradHalfSize - vec2f(gradRec.geom4, gradRec.geom5);
    if ((gradRec.hasGradient & 2u) != 0u) {
      gradPosO = gradPosO - floor(gradPosO / gradOriginSize) * gradOriginSize;
    }
    if (gradKind == 1u) {
      resolvedColor = sampleLinearGradient(gradPosO, gradOriginSize, gradRec, gradIsRepeating);
    } else if (gradKind == 2u) {
      resolvedColor = sampleRadialGradient(gradPosO, gradRec, gradIsRepeating);
    }
    // Same working-encoding conversion as the rect shader's dispatch.
    resolvedColor = gradientColorToWorking(resolvedColor, gradRec.hasGradient);
    // Conic (kind==3u) never reaches here — writeGradientStops (render-
    // scene.js) throws for a conic svgFillGradient before emission, per
    // this project's own "reject outright, not silently ignore" S7 ruling.
  }

  return vec4f(resolvedColor.rgb, resolvedColor.a * alpha * clipCoverage);
}
`;

// Plain textured quad (Slice P5a): a straightforward RGBA8 sample, no MSDF
// median/coverage math (that's specific to the text shader's distance-field
// atlas) — same vertex-stage shape and clip-coverage fragment logic as
// TEXT_SHADER (kept in sync manually, self-contained shader strings per this
// file's existing convention), because both are "textured quad with a
// per-draw texture + clip test."
//
// EDGE COVERAGE. The quad is expanded outward by the same 1.5px AA headroom
// RECT_SHADER's vertex stage uses, and the fragment stage weights the sample
// by the dest rect's own coverage of the pixel, so a fractional destination
// edge blends instead of snapping to whichever side of the pixel centre the
// hardware's binary fill rule happened to land on. Two coverage functions,
// picked by the same isAxisAligned test RECT_SHADER already makes:
//
//   * axis-aligned (no rotation/skew) -> EXACT rectangle-pixel overlap area.
//     This is not an approximation and needs no fast-path bypass: an edge
//     that lands on a whole pixel boundary comes out at exactly 1.0/0.0, so
//     the ordinary integer-positioned image keeps its hard edge with no
//     smoothstep fringe (the reason RECT_SHADER needs a separate hard path
//     is that its SDF+smoothstep can't represent an exact edge; this can).
//     It is also what Skia does for straight edges — see RECT_SHADER's own
//     `aa` comment.
//   * rotated/skewed -> the shared roundedRectSDF (zero radii = a plain box
//     SDF) with the same fwidth-normalised smoothstep RECT_SHADER uses, the
//     only workable answer for a diagonal edge.
//
// Verified against real Chrome, per case: an untransformed <img> whose dest
// rect the rasterizer pixel-snapped (see the CMD_IMAGE batching in render())
// stays hard-edged; translate(0, 0.5px) gives 127/128 on the two half-covered
// rows, matching Chrome exactly; scale(1, 1.025) gives 191 where Chrome reads
// 191; a border-image `space` tile seam at y=52.5 reads 0.50 on both sides.
const IMAGE_SHADER = `
${CLIP_STRUCT_WGSL}
struct Uniforms {
  resolution: vec2f,
  clipCount: f32,
  opacity: f32,
  clips: array<ClipEntry, ${MAX_SHADER_CLIP_ENTRIES}>,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) pixelPos: vec2f,
  // The UNEXPANDED dest rect, in the two forms the coverage math needs:
  // localPos/halfSize are the fragment's offset from its centre and its
  // half-extent (SDF path); coverageRect is the same rect mapped to screen
  // space as minX/minY/maxX/maxY (exact-area path), with any side flagged
  // ABUT already snapped to the pixel grid — see vertexMain.
  @location(2) localPos: vec2f,
  @location(3) halfSize: vec2f,
  @location(4) @interpolate(flat) coverageRect: vec4f,
  @location(5) @interpolate(flat) isAxisAligned: f32,
  // This draw's OWN source rect as minU/minV/maxU/maxV. The bilinear fetch
  // is clamped to it — see fragmentMain.
  @location(6) @interpolate(flat) uvRect: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var imageTex: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;

fn applyTransform(p: vec2f, t: mat3x2f) -> vec2f {
  return vec2f(
    t[0][0] * p.x + t[1][0] * p.y + t[2][0],
    t[0][1] * p.x + t[1][1] * p.y + t[2][1]
  );
}

@vertex
fn vertexMain(
  @location(0) quadVertex: vec2f,
  @location(1) destPos: vec2f,
  @location(2) destSize: vec2f,
  @location(3) uvPos: vec2f,
  @location(4) uvSize: vec2f,
  @location(5) transformCol0: vec2f,
  @location(6) transformCol1: vec2f,
  @location(7) transformCol2: vec2f,
  // Per-side ABUT flags as 0/1, in this draw's own pre-transform order:
  // x = left, y = top, z = right, w = bottom.
  @location(8) abutSides: vec4f,
) -> VertexOutput {
  // Antialiasing headroom, same 1.5px outward expansion RECT_SHADER's own
  // vertex stage takes: a pixel whose CENTRE falls outside the dest rect can
  // still be partially covered by it, and the hardware would never generate
  // a fragment for it without this.
  let expandedPos = destPos - 1.5;
  let expandedSize = destSize + 3.0;
  let localPixelPos = expandedPos + quadVertex * expandedSize;
  let transform = mat3x2f(transformCol0, transformCol1, transformCol2);
  let pixelPos = applyTransform(localPixelPos, transform);
  let clipX = (pixelPos.x / uniforms.resolution.x) * 2.0 - 1.0;
  let clipY = 1.0 - (pixelPos.y / uniforms.resolution.y) * 2.0;

  // UV follows the UNEXPANDED mapping, so the interior sample positions are
  // bit-identical to what they were before the expansion existed; only the
  // headroom band runs off the ends, and the fragment stage clamps that back.
  let uvUnit = (localPixelPos - destPos) / max(destSize, vec2f(1e-6));
  let destMin = applyTransform(destPos, transform);
  let destMax = applyTransform(destPos + destSize, transform);

  var output: VertexOutput;
  output.position = vec4f(clipX, clipY, 0.0, 1.0);
  output.uv = uvPos + uvUnit * uvSize;
  output.pixelPos = pixelPos;
  output.localPos = localPixelPos - (destPos + destSize * 0.5);
  output.halfSize = destSize * 0.5;
  // An ABUT side is shared with a neighbouring draw, so it is not a
  // silhouette and must not be antialiased: two abutting draws that each
  // blend their shared edge composite to less than full coverage there and
  // leave a seam. Snapping that bound to ceil(b - 0.5) reproduces EXACTLY
  // the hardware's own pixel-centre ownership rule — the pixel straddling
  // the boundary goes wholly to whichever draw contains its centre — so the
  // two draws partition it with no gap and no double-composite, while every
  // unmarked side keeps real partial coverage. The flags are in the draw's
  // own axis order, so a mirroring transform (destMax < destMin) has to swap
  // each axis's pair along with the bounds themselves.
  let rawMin = min(destMin, destMax);
  let rawMax = max(destMin, destMax);
  let flipped = destMax < destMin;
  let abutMin = select(abutSides.xy, abutSides.zw, flipped);
  let abutMax = select(abutSides.zw, abutSides.xy, flipped);
  output.coverageRect = vec4f(
    mix(rawMin, ceil(rawMin - 0.5), abutMin),
    mix(rawMax, ceil(rawMax - 0.5), abutMax));
  // Same test (and same reasoning) as RECT_SHADER's isAxisAligned: both
  // off-diagonal terms zero means no rotation or skew, so the dest quad is
  // still a screen-space rectangle and its pixel coverage is exact.
  output.isAxisAligned = select(0.0, 1.0, transformCol0.y == 0.0 && transformCol1.x == 0.0);
  output.uvRect = vec4f(min(uvPos, uvPos + uvSize), max(uvPos, uvPos + uvSize));
  return output;
}

// Same per-corner elliptical rounded-rect SDF as the rect/text shaders
// (each shader string is self-contained — keep the three in sync).
fn cornerSelect(p: vec2f, v: vec4f) -> f32 {
  return select(
    select(v.x, v.y, p.x > 0.0),
    select(v.w, v.z, p.x > 0.0),
    p.y > 0.0);
}

fn roundedRectSDF(localP: vec2f, halfSize: vec2f, radiiX: vec4f, radiiY: vec4f) -> f32 {
  let rx = cornerSelect(localP, radiiX);
  let ry = cornerSelect(localP, radiiY);
  let q = abs(localP) - halfSize + vec2f(rx, ry);
  let circD = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rx;
  let cornerD = (length(q / vec2f(max(rx, 1e-6), max(ry, 1e-6))) - 1.0) * min(rx, ry);
  let edgeD = max(q.x - rx, q.y - ry);
  let ellipseD = select(edgeD, cornerD, q.x > 0.0 && q.y > 0.0);
  return select(ellipseD, circD, abs(rx - ry) < 1e-4);
}

// Exact area of the unit pixel square centred on p that falls inside the
// screen-space rect r (minX, minY, maxX, maxY). Separable because both are
// axis-aligned, and exactly 1.0 / 0.0 whenever the rect's edges sit on whole
// pixel boundaries — which is what lets this run unconditionally instead of
// behind a hard-edge fast path.
fn boxCoverage(p: vec2f, r: vec4f) -> f32 {
  let span = clamp(min(r.zw, p + 0.5) - max(r.xy, p - 0.5), vec2f(0.0), vec2f(1.0));
  return span.x * span.y;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  // Derivatives FIRST, unconditionally — the same WGSL uniformity rule
  // RECT_SHADER's fragmentMain documents at length (a derivative below a
  // discard or an interpolated-value branch is not uniform control flow).
  let d = roundedRectSDF(input.localPos, input.halfSize, vec4f(0.0), vec4f(0.0));
  let aa = fwidth(d) * 0.5;
  // Chrome/Skia chooses the mip level from the LESS-minified principal
  // axis. A one-axis squash therefore stays on level 0 (ordinary bilinear
  // sampling), while minification on both axes enters the mip chain. WebGPU's
  // implicit LOD instead uses the MORE-minified axis, and hardware anisotropy
  // applies extra taps along it; both disagree sharply with Chrome. Compute
  // the smaller singular value of the screen-to-texel Jacobian explicitly.
  // Do this before the sub-rect UV clamp: clamping must constrain fetches,
  // never alter the mapping derivatives used for LOD selection.
  let textureSize = vec2f(textureDimensions(imageTex, 0));
  let uvDxTexels = dpdx(input.uv) * textureSize;
  let uvDyTexels = dpdy(input.uv) * textureSize;
  let jacobianXX = dot(uvDxTexels, uvDxTexels);
  let jacobianXY = dot(uvDxTexels, uvDyTexels);
  let jacobianYY = dot(uvDyTexels, uvDyTexels);
  let discriminant = sqrt(max(
    (jacobianXX - jacobianYY) * (jacobianXX - jacobianYY) +
      4.0 * jacobianXY * jacobianXY,
    0.0));
  let minimumScaleSquared = max(
    0.5 * (jacobianXX + jacobianYY - discriminant),
    1.0);
  let imageLod = 0.5 * log2(minimumScaleSquared);

  // Clip-list coverage — shared CLIP_EVAL_WGSL.
${CLIP_EVAL_WGSL}

  let edgeCoverage = select(
    1.0 - smoothstep(-aa, aa, d),
    boxCoverage(input.pixelPos, input.coverageRect),
    input.isAxisAligned > 0.5);

  // Clamp the bilinear FETCH to this draw's own source rect. A bilinear tap
  // reads half a texel past its sample position, so without this a draw that
  // owns only a SUB-RECT of a shared texture pulls in whatever is next door:
  // border-image's nine pieces all slice one image, and every internal seam
  // came out as a blend of the two slices where Chrome has a hard line. The
  // half-texel inset is applied HERE and not to the emitted UV rect on
  // purpose — insetting the rect itself rescales the whole span and shifts
  // every interior sample by half a texel (invisible on flat artwork, plainly
  // wrong on anything with detail), whereas clamping only alters samples that
  // would have read outside the rect at all, leaving the interior mapping
  // untouched. Effectively clamp-to-edge, scoped to the sub-rect. lo/hi are
  // re-ordered before use so a sub-texel-thin rect degenerates to sampling
  // its own centre rather than to an inverted clamp.
  let halfTexel = 0.5 / vec2f(textureDimensions(imageTex, 0));
  let lo = input.uvRect.xy + halfTexel;
  let hi = input.uvRect.zw - halfTexel;
  let uv = clamp(input.uv, min(lo, hi), max(lo, hi));

  // EMPIRICAL BIAS, not a described filter — Chrome's reconstruction lands
  // about a quarter mip level sharper than the nominal Jacobian footprint,
  // and -0.25 is FITTED to one measurement rather than derived. Measured on
  // the 360x540 photo cropped and minified to 100x144: the unbiased level
  // produced 158 structural pixels (max delta 141); -0.25 produces 77 (max
  // delta 122), while +0.25 worsens it to 238. The existing one-axis and
  // pixelated oracle cases pin the surrounding LOD-selection contract.
  //
  // This is the ONLY thing holding image-object-fit-photo under
  // IMAGE_STRUCT_FLOOR (77 against 100), so the sweep's whole image
  // tolerance rides on this constant — see design/paint-coverage.md's open
  // item 3. Bisected 2026-07-26: the divergence is NOT a regression (162
  // structural at e75cb59^, before that day's image-sampling commits).
  let premultipliedColor = textureSampleLevel(imageTex, imageSampler, uv, imageLod - 0.25);
  let sampledAlpha = premultipliedColor.a;
  if (sampledAlpha < 0.001) { discard; }
  let straightColor = premultipliedColor.rgb / sampledAlpha;
  let alpha = sampledAlpha * uniforms.opacity * clipCoverage * edgeCoverage;
  if (alpha < 0.001) { discard; }
  return vec4f(straightColor, alpha);
}
`;

// Box-shadow (design/paint-coverage.md P3). blur=0 draws a plain colored
// rounded rect (roundedRectSDF coverage, same as RECT_SHADER's own
// outerAlpha); blur>0 (step 3) switches to the analytic Evan Wallace
// technique (https://madebyevan.com/shaders/fast-rounded-rectangle-
// shadows/, CC0) — a closed-form (erf-based) Gaussian blur along X,
// numerically integrated (4-sample Gauss-weighted quadrature) along Y to
// account for the rounded corners, which have no closed form. Extended
// here to sandom's per-corner ELLIPTICAL radii (Wallace's original takes
// one shared scalar `corner` for all 4 corners) — verified to reduce
// EXACTLY to Wallace's own formula when all 4 corners share one radius
// (max diff 0.0 across a full 2D sweep) before trusting the extension,
// and to behave correctly in a genuinely asymmetric per-corner case
// (checked geometrically: a MORE rounded corner shows LOWER shadow mass
// at a symmetric probe point than a SHARPER corner, as expected — a
// rounded corner recedes the box's silhouette inward). blurSigma =
// blur-radius/2, resolved in engine.wat ($emitBoxShadows) — see its own
// comment for how that mapping was verified (empirically against real
// Chrome, not from an uncited spec claim).
const BOX_SHADOW_SHADER = `
${CLIP_STRUCT_WGSL}
struct Uniforms {
  resolution: vec2f,
  clipCount: f32,
  _clipPad: f32,
  clips: array<ClipEntry, ${MAX_SHADER_CLIP_ENTRIES}>,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) localPos: vec2f,
  @location(1) halfSize: vec2f,
  @location(2) color: vec4f,
  @location(3) radiiX: vec4f,
  @location(4) radiiY: vec4f,
  @location(5) pixelPos: vec2f,
  @location(6) blurSigma: f32,
  @location(7) isInset: f32,
  // Inset-only (P3 step 4): the node's own UNSPREAD border box, in the
  // SAME local space as localPos (relative to the MAIN rect's own
  // center — see the vertex shader's own comment on why, not the border
  // box's own center) — the outer clip boundary for inset shadows. For
  // outset, these mirror halfSize/radiiX/radiiY exactly (unused by the
  // fragment shader's own isInset-gated branch).
  @location(8) borderBoxLocalCenter: vec2f,
  @location(9) borderBoxHalfSize: vec2f,
  @location(10) borderBoxRadiiX: vec4f,
  @location(11) borderBoxRadiiY: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

fn applyTransform(p: vec2f, t: mat3x2f) -> vec2f {
  return vec2f(
    t[0][0] * p.x + t[1][0] * p.y + t[2][0],
    t[0][1] * p.x + t[1][1] * p.y + t[2][1]
  );
}

@vertex
fn vertexMain(
  @location(0) quadVertex: vec2f,
  @location(1) rectPos: vec2f,
  @location(2) rectSize: vec2f,
  @location(3) color: vec4f,
  @location(4) radiiX: vec4f,
  @location(5) radiiY: vec4f,
  @location(6) transformCol0: vec2f,
  @location(7) transformCol1: vec2f,
  @location(8) transformCol2: vec2f,
  @location(9) blurSigma: f32,
  @location(10) isInset: f32,
  @location(11) borderBoxPos: vec2f,
  @location(12) borderBoxSize: vec2f,
  @location(13) borderBoxRadiiX: vec4f,
  @location(14) borderBoxRadiiY: vec4f,
) -> VertexOutput {
  // The quad itself must cover the RIGHT rect for each case: outset's
  // visible paint region is its own (spread-adjusted) rect plus the
  // blur skirt; inset's visible paint region is the ENTIRE border box
  // (the dark ring can reach all the way to the box's own edge) plus
  // the blur skirt, NOT the smaller deflated "hole" rect (rectPos/
  // rectSize for inset holds the hole, not the paintable area).
  let quadPos = select(rectPos, borderBoxPos, isInset > 0.5);
  let quadSize = select(rectSize, borderBoxSize, isInset > 0.5);

  // AA-headroom for blur=0 stays the same tight +/-1.5px skirt (byte-
  // identical to step 2's already-oracle-verified output); a real blur
  // needs a MUCH bigger skirt to contain its own falloff — 3 sigma each
  // side is where the Gaussian's own tails become negligible (matches
  // this plan's own "Rasterizer" section spec, and is the same bound
  // roundedBoxShadow's own Y-integration window uses below).
  let skirt = max(1.5, 3.0 * blurSigma);
  let expandedPos = quadPos - skirt;
  let expandedSize = quadSize + skirt * 2.0;
  let localPixelPos = expandedPos + quadVertex * expandedSize;

  let transform = mat3x2f(transformCol0, transformCol1, transformCol2);
  let pixelPos = applyTransform(localPixelPos, transform);
  let clipX = (pixelPos.x / uniforms.resolution.x) * 2.0 - 1.0;
  let clipY = 1.0 - (pixelPos.y / uniforms.resolution.y) * 2.0;

  // localPos is relative to the MAIN rect's own center (the hole rect
  // for inset, the shadow rect for outset) — this is the space
  // roundedRectSDF/roundedBoxShadow both already expect for their own
  // coverage/inversion boundary. The border box's own center is a
  // DIFFERENT point (the hole is generally off-center from the box only
  // when offsetX/offsetY != 0, but even at offset=0 the two centers
  // coincide only when spread symmetrically deflates every side the
  // same amount, which spread always does — so in practice these ARE
  // the same center; kept as a distinct computed value rather than an
  // assumption, since a future asymmetric-inset-offset scene should
  // still be geometrically correct without needing this comment revised).
  let center = rectPos + rectSize * 0.5;
  let localPos = localPixelPos - center;
  let borderBoxCenter = borderBoxPos + borderBoxSize * 0.5;
  let borderBoxLocalCenter = borderBoxCenter - center;

  var output: VertexOutput;
  output.position = vec4f(clipX, clipY, 0.0, 1.0);
  output.localPos = localPos;
  output.halfSize = rectSize * 0.5;
  output.color = color;
  output.radiiX = radiiX;
  output.radiiY = radiiY;
  output.pixelPos = pixelPos;
  output.blurSigma = blurSigma;
  output.isInset = isInset;
  output.borderBoxLocalCenter = borderBoxLocalCenter;
  output.borderBoxHalfSize = borderBoxSize * 0.5;
  output.borderBoxRadiiX = borderBoxRadiiX;
  output.borderBoxRadiiY = borderBoxRadiiY;
  return output;
}

// Same per-corner elliptical rounded-rect SDF as the rect/text/image
// shaders (each shader string is self-contained — keep them in sync).
fn cornerSelect(p: vec2f, v: vec4f) -> f32 {
  return select(
    select(v.x, v.y, p.x > 0.0),
    select(v.w, v.z, p.x > 0.0),
    p.y > 0.0);
}

fn roundedRectSDF(localP: vec2f, halfSize: vec2f, radiiX: vec4f, radiiY: vec4f) -> f32 {
  let rx = cornerSelect(localP, radiiX);
  let ry = cornerSelect(localP, radiiY);
  let q = abs(localP) - halfSize + vec2f(rx, ry);
  let circD = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rx;
  let cornerD = (length(q / vec2f(max(rx, 1e-6), max(ry, 1e-6))) - 1.0) * min(rx, ry);
  let edgeD = max(q.x - rx, q.y - ry);
  let ellipseD = select(edgeD, cornerD, q.x > 0.0 && q.y > 0.0);
  return select(ellipseD, circD, abs(rx - ry) < 1e-4);
}

// Evan Wallace's own polynomial erf() approximation (CC0), used verbatim
// so the engine-side blurSigma=blurRadius/2 mapping (verified against
// THIS approximation, not the true erf) stays consistent with what
// actually runs here.
fn erf(x: vec4f) -> vec4f {
  let s = sign(x);
  let a = abs(x);
  var t = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  t *= t;
  t *= t;
  return s - s / t;
}

fn gaussian(x: f32, sigma: f32) -> f32 {
  let pi = 3.141592653589793;
  return exp(-(x * x) / (2.0 * sigma * sigma)) / (sqrt(2.0 * pi) * sigma);
}

// How far the box's boundary on ONE side extends in X at a given Y,
// generalizing Wallace's own circular-corner "curved" formula to an
// ellipse (rx, ry independent) — reduces EXACTLY to his formula when
// rx==ry (verified numerically before writing this). rx/ry here are
// ALREADY the correct corner's own radii (the caller selects which
// corner based on which side of the box this call is evaluating).
fn curvedExtent(halfSizeX: f32, halfSizeY: f32, rx: f32, ry: f32, y: f32) -> f32 {
  let delta = min(halfSizeY - ry - abs(y), 0.0);
  let ryClamped = max(ry, 1e-6);
  let t = max(0.0, 1.0 - (delta / ryClamped) * (delta / ryClamped));
  let dx = rx * sqrt(t);
  return halfSizeX - rx + dx;
}

// Wallace's own roundedBoxShadowX, generalized to distinct LEFT/RIGHT
// corner radii (his original assumes one shared "corner" so left/right
// are trivially symmetric at a given y — sandom's per-corner radii can
// differ left vs right, so curvedExtent is computed separately for each
// side using whichever corner is active for y's sign).
fn roundedBoxShadowXPerCorner(x: f32, y: f32, sigma: f32, halfSize: vec2f, radiiX: vec4f, radiiY: vec4f) -> f32 {
  let isBottom = y > 0.0;
  // radiiX/Y order: (topLeft, topRight, bottomRight, bottomLeft).
  let leftRx = select(radiiX.x, radiiX.w, isBottom);
  let leftRy = select(radiiY.x, radiiY.w, isBottom);
  let rightRx = select(radiiX.y, radiiX.z, isBottom);
  let rightRy = select(radiiY.y, radiiY.z, isBottom);

  let curvedLeft = curvedExtent(halfSize.x, halfSize.y, leftRx, leftRy, y);
  let curvedRight = curvedExtent(halfSize.x, halfSize.y, rightRx, rightRy, y);

  let scale = sqrt(0.5) / sigma;
  let lo = 0.5 + 0.5 * erf(vec4f((x + curvedLeft) * scale, 0.0, 0.0, 0.0)).x;
  let hi = 0.5 + 0.5 * erf(vec4f((x - curvedRight) * scale, 0.0, 0.0, 0.0)).x;
  return lo - hi;
}

// Wallace's own roundedBoxShadow: numerically integrate the X-blur
// (closed-form via erf) over Y using a 4-sample Gaussian-weighted
// quadrature, windowed to [-3 sigma, 3 sigma] clamped to the box's own
// Y span (matching his own start/end/step derivation exactly).
fn roundedBoxShadow(halfSize: vec2f, point: vec2f, sigma: f32, radiiX: vec4f, radiiY: vec4f) -> f32 {
  let low = point.y - halfSize.y;
  let high = point.y + halfSize.y;
  let start = clamp(-3.0 * sigma, low, high);
  let end = clamp(3.0 * sigma, low, high);
  let step = (end - start) / 4.0;
  var y = start + step * 0.5;
  var value = 0.0;
  for (var i = 0; i < 4; i++) {
    value += roundedBoxShadowXPerCorner(point.x, point.y - y, sigma, halfSize, radiiX, radiiY) * gaussian(y, sigma) * step;
    y += step;
  }
  return value;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  // Clip-list coverage — shared CLIP_EVAL_WGSL.
${CLIP_EVAL_WGSL}

  let isInset = input.isInset > 0.5;

  // Inset (P3 step 4): a SECOND clip, to the node's own border box —
  // CSS's own model (an inset shadow's dark ring never paints outside
  // the box's own outer edge, only the ancestor-overflow clip above
  // isn't enough on its own since an ancestor's clip can be LARGER than
  // this node's own box). No-op for outset (borderBoxHalfSize equals
  // the main rect's own halfSize there, and the coverage math below
  // never reaches this branch for outset anyway).
  let bd = roundedRectSDF(input.localPos - input.borderBoxLocalCenter, input.borderBoxHalfSize, input.borderBoxRadiiX, input.borderBoxRadiiY);
  let bAa = fwidth(bd) * 0.5;
  var borderBoxCoverage = 1.0;
  if (isInset) {
    if (bd > bAa) { discard; }
    borderBoxCoverage = 1.0 - smoothstep(-bAa, bAa, bd);
  }

  let d = roundedRectSDF(input.localPos, input.halfSize, input.radiiX, input.radiiY);
  let aa = fwidth(d) * 0.5;
  var coverage: f32;
  if (input.blurSigma <= 0.0) {
    // blur=0: exact same SDF-based coverage step 2 already oracle-
    // verified — kept as its own path rather than routing through the
    // erf machinery at sigma->0 (which is numerically degenerate, a
    // divide-by-near-zero in curvedExtent/roundedBoxShadowXPerCorner's
    // own scale term).
    coverage = 1.0 - smoothstep(-aa, aa, d);
  } else {
    coverage = clamp(roundedBoxShadow(input.halfSize, input.localPos, input.blurSigma, input.radiiX, input.radiiY), 0.0, 1.0);
  }
  // Inset inverts coverage relative to the (main rect's own) hole
  // boundary — dark OUTSIDE the hole (near the box edge), transparent
  // INSIDE it (the box's true interior shows through) — then clipped to
  // the border box above so it never bleeds past the box's own edge.
  let finalCoverage = select(coverage, 1.0 - coverage, isInset) * borderBoxCoverage;
  let alpha = input.color.a * finalCoverage * clipCoverage;
  if (alpha < 0.001) { discard; }
  return vec4f(input.color.rgb, alpha);
}
`;

// The Rust host receives straight-alpha eight-bit image resources directly.
// Convert them to the renderer's premultiplied float working texture before
// mip generation. The JavaScript host uses sourceConvertShader for the same
// boundary because it also supports additional source formats and color spaces.
const SOURCE_PREMULTIPLY_SHADER = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@vertex
fn vertexMain(@location(0) quadVertex: vec2f) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(quadVertex.x * 2.0 - 1.0, 1.0 - quadVertex.y * 2.0, 0.0, 1.0);
  output.uv = quadVertex;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let sample = textureSample(srcTex, srcSampler, input.uv);
  return vec4f(sample.rgb * sample.a, sample.a);
}
`;

// Mip-chain generation (see BUG-image-downscale-quality.md /
// PLAN-image-mipmap.md): WebGPU has no built-in generateMipmap (unlike
// WebGL), so each level is produced by rendering a full-screen quad that
// bilinear-samples the PREVIOUS level at its own half-resolution grid — for
// a standard halving mip chain this is mathematically a 2x2 box filter over
// the previous level, which composes into a true area average of the
// full-resolution source. No instancing, no clip test: this only ever runs
// once per mip level per image texture, straight-line, not part of the
// per-draw batch path the other shaders serve.
const DOWNSAMPLE_SHADER = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@vertex
fn vertexMain(@location(0) quadVertex: vec2f) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(quadVertex.x * 2.0 - 1.0, 1.0 - quadVertex.y * 2.0, 0.0, 1.0);
  output.uv = quadVertex;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(srcTex, srcSampler, input.uv);
}
`;

// Source-to-working image conversion (wide-color plan, package 4 step 1).
// One full-screen pass per uploaded image: reads the source texture texel
// for texel (textureLoad, no filtering), converts the sample into the
// selected rendering mode's working encoding, premultiplies in float, and
// writes mip level 0 of the image texture in the selected render
// precision. The transfer curves mirror src/color.js exactly (the CSS
// Color 4 sign-mirrored extensions included); transfer identifiers are the
// CONVERSION_TRANSFER_IDS contract in src/image-data.js.
//
// Two variants share this body: the FLOAT variant binds unorm and float
// source formats as texture_2d<f32>; the UINT variant binds sixteen-bit
// integer sources as texture_2d<u32> and normalizes by alphaParams.y.
function sourceConvertShader(sourceKind) {
  const textureType = sourceKind === "uint"
    ? "texture_2d<u32>"
    : "texture_2d<f32>";
  const fetch = sourceKind === "uint"
    ? "vec4f(textureLoad(srcTex, texel, 0)) * uniforms.alphaParams.y"
    : "textureLoad(srcTex, texel, 0)";
  return `
struct ConversionUniforms {
  matrixRow0: vec4f,
  matrixRow1: vec4f,
  matrixRow2: vec4f,
  // x: transferId, y: gammaExponent, z: linearScale, w: encodeSrgbOutput
  transferParams: vec4f,
  // x: alphaSourceMode, y: sourceScale, z: standard canvas tone mapping
  alphaParams: vec4f,
}

@group(0) @binding(0) var srcTex: ${textureType};
@group(0) @binding(1) var<uniform> uniforms: ConversionUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
}

@vertex
fn vertexMain(@location(0) quadVertex: vec2f) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(quadVertex.x * 2.0 - 1.0, 1.0 - quadVertex.y * 2.0, 0.0, 1.0);
  return output;
}

// CSS Color 4 sign-mirrored sRGB curve (src/color.js decodeSrgbTransfer /
// encodeSrgbTransfer).
fn decodeSrgb(value: vec3f) -> vec3f {
  let sign = select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
  let magnitude = abs(value);
  let low = magnitude / 12.92;
  let high = pow((magnitude + vec3f(0.055)) / 1.055, vec3f(2.4));
  return sign * select(high, low, magnitude <= vec3f(0.04045));
}

fn encodeSrgb(value: vec3f) -> vec3f {
  let sign = select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
  let magnitude = abs(value);
  let low = magnitude * 12.92;
  let high = 1.055 * pow(magnitude, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return sign * select(high, low, magnitude <= vec3f(0.0031308));
}

// Rec. ITU-R BT.2020 piecewise curve (src/color.js decodeRec2020Transfer).
fn decodeRec2020(value: vec3f) -> vec3f {
  let sign = select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
  let magnitude = abs(value);
  let alpha = 1.09929682680944;
  let beta = 0.018053968510807;
  let low = magnitude / 4.5;
  let high = pow((magnitude + vec3f(alpha - 1.0)) / alpha, vec3f(1.0 / 0.45));
  return sign * select(high, low, magnitude < vec3f(beta * 4.5));
}

// ROMM curve with the 1/512 linear segment (src/color.js
// decodeProphotoTransfer).
fn decodeProphoto(value: vec3f) -> vec3f {
  let sign = select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
  let magnitude = abs(value);
  let low = magnitude / 16.0;
  let high = pow(magnitude, vec3f(1.8));
  return sign * select(high, low, magnitude <= vec3f(16.0 / 512.0));
}

// Perceptual quantizer, Rec. ITU-R BT.2100, into the working scale where
// 1 equals the 203-candela reference white (src/color.js
// pqSignalToLuminance / decodePqToWorkingScale).
fn decodePqToWorkingScale(value: vec3f) -> vec3f {
  let m1 = 1305.0 / 8192.0;
  let m2 = 2523.0 / 32.0;
  let c1 = 107.0 / 128.0;
  let c2 = 2413.0 / 128.0;
  let c3 = 2392.0 / 128.0;
  let power = pow(max(value, vec3f(0.0)), vec3f(1.0 / m2));
  let numerator = max(power - vec3f(c1), vec3f(0.0));
  let denominator = vec3f(c2) - c3 * power;
  return 10000.0 * pow(numerator / denominator, vec3f(1.0 / m1)) / 203.0;
}

// Hybrid log-gamma, Rec. ITU-R BT.2100, with the nominal 1000-candela
// reference display and system gamma 1.2 (src/color.js
// decodeHlgRgbToWorkingScale).
fn decodeHlgToWorkingScale(value: vec3f) -> vec3f {
  let a = 0.17883277;
  let b = 1.0 - 4.0 * a;
  let c = 0.5 - a * log(4.0 * a);
  let clamped = max(value, vec3f(0.0));
  let low = clamped * clamped / 3.0;
  let high = (exp((clamped - vec3f(c)) / a) + vec3f(b)) / 12.0;
  let scene = select(high, low, clamped <= vec3f(0.5));
  let sceneLuminance = dot(scene, vec3f(0.2627, 0.678, 0.0593));
  if (sceneLuminance <= 0.0) { return vec3f(0.0); }
  let gain = 1000.0 * pow(sceneLuminance, 1.2 - 1.0) / 203.0;
  return scene * gain;
}

fn decodeGamma(value: vec3f, exponent: f32) -> vec3f {
  let sign = select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
  return sign * pow(abs(value), vec3f(exponent));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let texel = vec2i(input.position.xy);
  var sample = ${fetch};
  let alphaSourceMode = uniforms.alphaParams.x;
  var alpha = sample.a;
  if (alphaSourceMode == 1.0) { alpha = 1.0; }
  var color = sample.rgb;
  if (alphaSourceMode == 2.0 && alpha > 0.0) { color = color / alpha; }

  // Standard canvas tone mapping clamps the float16 canvas VALUES to
  // [0, 1] in the canvas's OWN color space, before any conversion - the
  // compositor contract a toneMapping:"standard" float canvas presents
  // under. Clamping after the primary matrix instead would destroy
  // legitimate wide-gamut chroma: a display-p3 color inside [0, 1] on a
  // p3 canvas maps to out-of-[0, 1] linear sRGB working components that
  // the extended working encoding exists to carry.
  if (uniforms.alphaParams.z == 1.0) {
    color = clamp(color, vec3f(0.0), vec3f(1.0));
    alpha = clamp(alpha, 0.0, 1.0);
  }

  let transferId = uniforms.transferParams.x;
  if (transferId == 1.0) {
    color = decodeSrgb(color);
  } else if (transferId == 2.0) {
    color = decodeGamma(color, uniforms.transferParams.y);
  } else if (transferId == 3.0) {
    color = decodePqToWorkingScale(color);
  } else if (transferId == 4.0) {
    color = decodeHlgToWorkingScale(color);
  } else if (transferId == 5.0) {
    color = decodeRec2020(color);
  } else if (transferId == 6.0) {
    color = decodeProphoto(color);
  }
  color = color * uniforms.transferParams.z;

  color = vec3f(
    dot(uniforms.matrixRow0.xyz, color),
    dot(uniforms.matrixRow1.xyz, color),
    dot(uniforms.matrixRow2.xyz, color),
  );

  if (uniforms.transferParams.w == 1.0) {
    color = encodeSrgb(color);
  }
  return vec4f(color * alpha, alpha);
}
`;
}

const QUAD_VERTICES = new Float32Array([
  0,
  0,
  1,
  0,
  0,
  1,
  0,
  1,
  1,
  0,
  1,
  1,
]);

// Backend selection (PLAN-webgl-2-degraded-backend.md): `graphicsBackend`
// is a closed option — "webgpu", "webgl2", or "auto" (the default).
// `auto` requests WebGPU first; when WebGPU is absent or cannot supply a
// device, it probes WebGL 2; when both fail, it throws one error carrying
// both failures. The selection happens ONCE at context creation — there
// is no fallback after rendering starts.
export async function createRenderContext(options) {
  const graphicsBackend = options.graphicsBackend ?? "auto";
  if (graphicsBackend === "webgpu") return createRenderContextWebgpu(options);
  if (graphicsBackend === "webgl2") return createRenderContextWebgl2(options);
  if (graphicsBackend !== "auto") {
    throw new Error(
      `createRenderContext: unknown graphicsBackend "${graphicsBackend}" (expected "webgpu", "webgl2", or "auto")`,
    );
  }
  let webgpuFailure;
  // The HOST's WebGPU capability, read at call time from the real global
  // unless a component environment has shadowed `navigator` — ambient
  // component code may deliberately see no GPU, but the raster backend
  // always belongs to the host realm.
  if (hostNavigatorGpu()) {
    try {
      return await createRenderContextWebgpu(options);
    } catch (error) {
      webgpuFailure = error;
    }
  } else {
    webgpuFailure = new Error("navigator.gpu is absent");
  }
  try {
    return await createRenderContextWebgl2(options);
  } catch (webglFailure) {
    throw new Error(
      `createRenderContext: no raster backend available.\n` +
        `  WebGPU: ${webgpuFailure.message}\n` +
        `  WebGL 2: ${webglFailure.message}`,
    );
  }
}

const GPU_COMPOSITION_BLEND = Object.freeze({
  color: Object.freeze({
    srcFactor: "src-alpha",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  }),
  alpha: Object.freeze({
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  }),
});

async function createTextureAndTextGpuCompositionOperations({
  device,
  colorFormat,
  compileShader,
}) {
  const quadBuffer = device.createBuffer({
    size: QUAD_VERTICES.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(quadBuffer, 0, QUAD_VERTICES);
  try {
    const textShader = await compileShader("text", TEXT_SHADER);
    const textPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: textShader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: "vertex",
            attributes: [{
              shaderLocation: 0,
              offset: 0,
              format: "float32x2",
            }],
          },
          {
            arrayStride: 20 * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x2" },
              { shaderLocation: 2, offset: 2 * 4, format: "float32x2" },
              { shaderLocation: 3, offset: 4 * 4, format: "float32x2" },
              { shaderLocation: 4, offset: 6 * 4, format: "float32x2" },
              { shaderLocation: 5, offset: 8 * 4, format: "float32x4" },
              { shaderLocation: 6, offset: 12 * 4, format: "float32x2" },
              { shaderLocation: 7, offset: 14 * 4, format: "float32x2" },
              { shaderLocation: 8, offset: 16 * 4, format: "float32x2" },
              { shaderLocation: 9, offset: 18 * 4, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: {
        module: textShader,
        entryPoint: "fragmentMain",
        targets: [{ format: colorFormat, blend: GPU_COMPOSITION_BLEND }],
      },
      primitive: { topology: "triangle-list" },
    });

    const imageShader = await compileShader("image", IMAGE_SHADER);
    let imagePipeline = null;
    return {
      quadBuffer,
      textPipeline,
      getImagePipeline() {
        return imagePipeline ??= device.createRenderPipeline({
          layout: "auto",
          vertex: {
            module: imageShader,
            entryPoint: "vertexMain",
            buffers: [
              {
                arrayStride: 2 * 4,
                stepMode: "vertex",
                attributes: [{
                  shaderLocation: 0,
                  offset: 0,
                  format: "float32x2",
                }],
              },
              {
                arrayStride: 18 * 4,
                stepMode: "instance",
                attributes: [
                  { shaderLocation: 1, offset: 0, format: "float32x2" },
                  { shaderLocation: 2, offset: 2 * 4, format: "float32x2" },
                  { shaderLocation: 3, offset: 4 * 4, format: "float32x2" },
                  { shaderLocation: 4, offset: 6 * 4, format: "float32x2" },
                  { shaderLocation: 5, offset: 8 * 4, format: "float32x2" },
                  { shaderLocation: 6, offset: 10 * 4, format: "float32x2" },
                  { shaderLocation: 7, offset: 12 * 4, format: "float32x2" },
                  { shaderLocation: 8, offset: 14 * 4, format: "float32x4" },
                ],
              },
            ],
          },
          fragment: {
            module: imageShader,
            entryPoint: "fragmentMain",
            targets: [{ format: colorFormat, blend: GPU_COMPOSITION_BLEND }],
          },
          primitive: { topology: "triangle-list" },
        });
      },
      dispose() {
        quadBuffer.destroy();
      },
    };
  } catch (error) {
    quadBuffer.destroy();
    throw error;
  }
}

export async function createGpuCompositionOperations({
  colorFormat = "rgba16float",
  device,
} = {}) {
  if (
    !device || typeof device.createBuffer !== "function" ||
    typeof device.createShaderModule !== "function" ||
    typeof device.queue?.writeBuffer !== "function"
  ) {
    throw new TypeError("GPU composition operations require a GPUDevice");
  }
  async function compileShader(name, code) {
    const module = device.createShaderModule({ code });
    const information = await module.getCompilationInfo();
    const errors = information.messages.filter((message) =>
      message.type === "error"
    );
    if (errors.length > 0) {
      throw new Error(
        `WGSL compilation failed for ${name}: ` +
          errors.map((message) =>
            `${message.lineNum}:${message.linePos} ${message.message}`
          ).join("; "),
      );
    }
    return module;
  }
  return await createTextureAndTextGpuCompositionOperations({
    device,
    colorFormat,
    compileShader,
  });
}

// One WebGPU adapter, device, and compiled shader/pipeline set per shared
// state owner and color format — the WebGPU analogue of the WebGL 2
// backend's one shared GL context (rasterize-webgl2.js). Devices, shader
// modules, and pipelines are immutable and safe to share across render
// contexts; every mutable per-frame resource (instance buffer, uniform
// pools, readback ring, render target) stays per-context. The state owner
// is the caller's sharedStateOwner (the scene-renderer runtime's
// graphicsStateOwner), so a module realm — e.g. one worker — owns exactly
// one device per format and releaseSharedWebgpuStates() releases it
// deliberately once every context is destroyed.
const defaultWebgpuStateOwner = {};

async function createSharedWebgpuState(
  colorFormat,
  suppliedDevice = null,
) {
  let adapter = null;
  let device = suppliedDevice;
  const ownsDevice = device === null;
  if (ownsDevice) {
    adapter = await hostNavigatorGpu().requestAdapter();
    if (!adapter) throw new Error("WebGPU not available: no adapter found");
    device = await adapter.requestDevice();
  }
  if (
    typeof device?.createBuffer !== "function" ||
    typeof device?.createTexture !== "function" ||
    typeof device?.queue?.submit !== "function"
  ) {
    throw new TypeError("Supplied WebGPU device is invalid");
  }

  // Compile a shader module and surface compilation errors instead of letting
  // them pass silently. createShaderModule never throws on a bad shader — the
  // module is created "invalid", createRenderPipeline accepts it, and every
  // draw with that pipeline is a silent no-op (the canvas keeps its cleared
  // background). That's exactly how a Tint uniformity rejection painted the
  // whole scene white while Deno's laxer naga compiled the same source fine.
  // getCompilationInfo() is the only way to see the diagnostics, so check it
  // and throw with the message + location so a shader bug is loud, not white.
  async function makeShader(name, code) {
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length > 0) {
      const sourceLines = code.split("\n");
      const detail = errors
        .map((message) => {
          const sourceLine = sourceLines[message.lineNum - 1]?.trim() ??
            "<source unavailable>";
          return `  ${name} line ${message.lineNum}:${message.linePos} — ${message.message}\n    ${sourceLine}`;
        })
        .join("\n");
      throw new Error(`WGSL compilation failed:\n${detail}`);
    }
    return module;
  }

  const focusedOperations = await createTextureAndTextGpuCompositionOperations({
    device,
    colorFormat,
    compileShader: makeShader,
  });
  const {
    quadBuffer,
    textPipeline,
    getImagePipeline,
  } = focusedOperations;
  let placeholder = null;
  let disposed = false;

  // One shared 1x1 opaque-white texture for every bind-group slot a frame
  // must fill but never samples (the composite shader's path-mask and
  // mask slots when neither feature is active).
  function placeholderTexture() {
    if (!placeholder) {
      placeholder = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: placeholder },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );
    }
    return placeholder;
  }

  // Rect pipeline.
  const rectShader = await makeShader("rect", RECT_SHADER);
  const rectPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: rectShader,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 2 * 4,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
        {
          // 44 floats per rect (Slice P2 + P5c border-order fix + P10
          // elliptical radii + P7 border styles): pos(2) + size(2) +
          // fill(4) + borderColor top/right/bottom/left (16) + widths(4)
          // + radiiX(4) + radiiY(4) + transform(6) + paintMode(1) +
          // borderStyles(1, the packed nibble u16 as a float).
          arrayStride: 44 * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x2" }, // rectPos
            { shaderLocation: 2, offset: 2 * 4, format: "float32x2" }, // rectSize
            { shaderLocation: 3, offset: 4 * 4, format: "float32x4" }, // fillColor
            { shaderLocation: 4, offset: 8 * 4, format: "float32x4" }, // borderColorTop
            { shaderLocation: 5, offset: 12 * 4, format: "float32x4" }, // borderColorRight
            { shaderLocation: 6, offset: 16 * 4, format: "float32x4" }, // borderColorBottom
            { shaderLocation: 7, offset: 20 * 4, format: "float32x4" }, // borderColorLeft
            { shaderLocation: 8, offset: 24 * 4, format: "float32x4" }, // borderWidths (t,r,b,l)
            { shaderLocation: 9, offset: 28 * 4, format: "float32x4" }, // radiiX (tl,tr,br,bl)
            { shaderLocation: 10, offset: 32 * 4, format: "float32x4" }, // radiiY (tl,tr,br,bl)
            { shaderLocation: 11, offset: 36 * 4, format: "float32x2" }, // transform col0
            { shaderLocation: 12, offset: 38 * 4, format: "float32x2" }, // transform col1
            { shaderLocation: 13, offset: 40 * 4, format: "float32x2" }, // transform col2
            { shaderLocation: 14, offset: 42 * 4, format: "float32x2" }, // paintMode, borderStyles
          ],
        },
      ],
    },
    fragment: {
      module: rectShader,
      entryPoint: "fragmentMain",
      targets: [{
        format: colorFormat,
        blend: {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });

  // Dirty tiles need overwrite semantics. The authored rectangle pipeline
  // uses source-over blending and discards zero-alpha fragments, so it cannot
  // clear a retained pixel to transparent.
  const tileClearShader = await makeShader("tile-clear", TILE_CLEAR_SHADER);
  const tileClearPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: tileClearShader,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 2 * 4,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
        {
          arrayStride: 8 * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x2" },
            { shaderLocation: 2, offset: 2 * 4, format: "float32x2" },
            { shaderLocation: 3, offset: 4 * 4, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module: tileClearShader,
      entryPoint: "fragmentMain",
      targets: [{ format: colorFormat }],
    },
    primitive: { topology: "triangle-list" },
  });

  // Composite pipeline (for opacity groups).
  const compositeShader = await makeShader("composite", COMPOSITE_SHADER);
  let compositePipeline = null;
  function getCompositePipeline() {
    return compositePipeline ??= device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: compositeShader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
          {
            arrayStride: 4 * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x2" },
              { shaderLocation: 2, offset: 2 * 4, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: {
        module: compositeShader,
        entryPoint: "fragmentMain",
        targets: [{
          format: colorFormat,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  // Same shader as compositePipeline, but a pure OVERWRITE (no blend) —
  // for P8's standalone matrix-segment passes, which write a filter's
  // straight-alpha RGBA result directly into a fresh cleared-transparent
  // texture and must NOT go through src-over blending (compositePipeline's
  // own blend state multiplies output RGB by its own alpha even against a
  // fully-transparent destination, silently double-applying alpha when
  // the matrix segment itself changes alpha — e.g. opacity() — since the
  // FINAL composite draw blends again).
  let matrixOverwritePipeline = null;
  function getMatrixOverwritePipeline() {
    return matrixOverwritePipeline ??= device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: compositeShader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
          {
            arrayStride: 4 * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x2" },
              { shaderLocation: 2, offset: 2 * 4, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: {
        module: compositeShader,
        entryPoint: "fragmentMain",
        targets: [{ format: colorFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  // P11: one MASK_COMBINE pipeline per mask-composite operator (blend
  // state is baked into a pipeline, and a layer's operator is per-layer),
  // all four sharing the one shader module.
  const maskCombineShader = await makeShader(
    "maskCombine",
    MASK_COMBINE_SHADER,
  );
  let maskCombinePipelines = null;
  function getMaskCombinePipelines() {
    return maskCombinePipelines ??= MASK_COMPOSITE_BLEND.map((factors) =>
      device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: maskCombineShader,
          entryPoint: "vertexMain",
          buffers: [
            {
              arrayStride: 2 * 4,
              stepMode: "vertex",
              attributes: [{
                shaderLocation: 0,
                offset: 0,
                format: "float32x2",
              }],
            },
            {
              arrayStride: 4 * 4,
              stepMode: "instance",
              attributes: [
                { shaderLocation: 1, offset: 0, format: "float32x2" },
                { shaderLocation: 2, offset: 2 * 4, format: "float32x2" },
              ],
            },
          ],
        },
        fragment: {
          module: maskCombineShader,
          entryPoint: "fragmentMain",
          targets: [{
            format: colorFormat,
            blend: {
              color: {
                srcFactor: factors.srcFactor,
                dstFactor: factors.dstFactor,
                operation: "add",
              },
              alpha: {
                srcFactor: factors.srcFactor,
                dstFactor: factors.dstFactor,
                operation: "add",
              },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
      })
    );
  }

  const svgPathShader = await makeShader("svgPath", SVG_PATH_SHADER);
  let svgPathPipeline = null;
  function getSvgPathPipeline() {
    return svgPathPipeline ??= device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: svgPathShader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
          {
            // 23 floats per path: destPos(2) + destSize(2) + uv(2) + uvSize(2) +
            // color(4) + pxRange(1) + transform(6) + gradRectPos(2) +
            // gradRectSize(2) — the last 4 (S7 step 2) are the FILL PATH'S OWN
            // unpadded bbox, a separate pair from destPos/destSize (which is
            // the atlas-padding-EXPANDED quad — see SVG_PATH_SHADER's own
            // vertexMain comment for why the two must stay distinct).
            arrayStride: 23 * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x2" }, // destPos
              { shaderLocation: 2, offset: 2 * 4, format: "float32x2" }, // destSize
              { shaderLocation: 3, offset: 4 * 4, format: "float32x2" }, // uvPos
              { shaderLocation: 4, offset: 6 * 4, format: "float32x2" }, // uvSize
              { shaderLocation: 5, offset: 8 * 4, format: "float32x4" }, // color
              { shaderLocation: 6, offset: 12 * 4, format: "float32" }, // pxRange
              { shaderLocation: 7, offset: 13 * 4, format: "float32x2" }, // transform col0
              { shaderLocation: 8, offset: 15 * 4, format: "float32x2" }, // transform col1
              { shaderLocation: 9, offset: 17 * 4, format: "float32x2" }, // transform col2
              { shaderLocation: 10, offset: 19 * 4, format: "float32x2" }, // gradRectPos
              { shaderLocation: 11, offset: 21 * 4, format: "float32x2" }, // gradRectSize
            ],
          },
        ],
      },
      fragment: {
        module: svgPathShader,
        entryPoint: "fragmentMain",
        targets: [{
          format: colorFormat,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  // box-shadow (P3, blur=0/no-spread step): plain colored rounded rect,
  // batches like rect draws do (many shadows in one scene should be one
  // draw call) rather than one-draw-per-command like image (no per-draw
  // texture to worry about — every shadow instance is pure geometry+color).
  const boxShadowShader = await makeShader("boxShadow", BOX_SHADOW_SHADER);
  let boxShadowPipeline = null;
  function getBoxShadowPipeline() {
    return boxShadowPipeline ??= device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: boxShadowShader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
          {
            // 36 floats per shadow: rectPos(2) + rectSize(2) + color(4) +
            // radiiX(4) + radiiY(4) + transform(6) + blurSigma(1) (P3 step
            // 3) + isInset(1) + borderBoxPos(2) + borderBoxSize(2) +
            // borderBoxRadiiX(4) + borderBoxRadiiY(4) (P3 step 4 — the
            // node's own UNSPREAD rect+radii, for inset's outer clip; for
            // outset, these mirror rectPos/rectSize/radiiX/radiiY exactly,
            // a no-op in the shader's own isInset-gated branch).
            arrayStride: 36 * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x2" }, // rectPos
              { shaderLocation: 2, offset: 2 * 4, format: "float32x2" }, // rectSize
              { shaderLocation: 3, offset: 4 * 4, format: "float32x4" }, // color
              { shaderLocation: 4, offset: 8 * 4, format: "float32x4" }, // radiiX
              { shaderLocation: 5, offset: 12 * 4, format: "float32x4" }, // radiiY
              { shaderLocation: 6, offset: 16 * 4, format: "float32x2" }, // transform col0
              { shaderLocation: 7, offset: 18 * 4, format: "float32x2" }, // transform col1
              { shaderLocation: 8, offset: 20 * 4, format: "float32x2" }, // transform col2
              { shaderLocation: 9, offset: 22 * 4, format: "float32" }, // blurSigma
              { shaderLocation: 10, offset: 23 * 4, format: "float32" }, // isInset
              { shaderLocation: 11, offset: 24 * 4, format: "float32x2" }, // borderBoxPos
              { shaderLocation: 12, offset: 26 * 4, format: "float32x2" }, // borderBoxSize
              { shaderLocation: 13, offset: 28 * 4, format: "float32x4" }, // borderBoxRadiiX
              { shaderLocation: 14, offset: 32 * 4, format: "float32x4" }, // borderBoxRadiiY
            ],
          },
        ],
      },
      fragment: {
        module: boxShadowShader,
        entryPoint: "fragmentMain",
        targets: [{
          format: colorFormat,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  // Downsample pipeline (mip-chain generation, see DOWNSAMPLE_SHADER's own
  // comment). No blending — each level is a fresh, fully-opaque-or-not copy
  // of the previous level, never composited against anything already in the
  // target. Just one vertex buffer (the same QUAD_VERTICES every other
  // pipeline uses): no per-draw instance data, since this never batches.
  // Targets the selected render precision: image mips live in the same
  // working-encoded format as every other color texture (wide-color plan,
  // package 4 step 1).
  const downsampleShader = await makeShader("downsample", DOWNSAMPLE_SHADER);
  let downsamplePipeline = null;
  function getDownsamplePipeline() {
    return downsamplePipeline ??= device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: downsampleShader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
        ],
      },
      fragment: {
        module: downsampleShader,
        entryPoint: "fragmentMain",
        targets: [{ format: colorFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  // Source-to-working conversion pipelines (see sourceConvertShader's own
  // comment). Two variants selected by the upload representation's
  // sampleKind; both write the image texture's mip level 0 in the selected
  // render precision. Same "no blending, one vertex buffer" shape as the
  // downsample pipeline.
  const sourceConvertShaderFloat = await makeShader(
    "sourceConvertFloat",
    sourceConvertShader("float"),
  );
  const sourceConvertShaderUint = await makeShader(
    "sourceConvertUint",
    sourceConvertShader("uint"),
  );
  const sourceConvertPipelines = {};
  function getSourceConvertPipeline(sampleKind) {
    return sourceConvertPipelines[sampleKind] ??= device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: sampleKind === "uint"
          ? sourceConvertShaderUint
          : sourceConvertShaderFloat,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
        ],
      },
      fragment: {
        module: sampleKind === "uint"
          ? sourceConvertShaderUint
          : sourceConvertShaderFloat,
        entryPoint: "fragmentMain",
        targets: [{ format: colorFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  // Box-blur pipeline (P8, filter: blur() — see BOX_BLUR_SHADER's own
  // comment). Same "no blending, one vertex buffer, no instance data"
  // shape as downsamplePipeline — each pass is a fresh full-screen
  // overwrite of a scratch texture, never composited against anything.
  const boxBlurShader = await makeShader("boxBlur", BOX_BLUR_SHADER);
  let boxBlurPipeline = null;
  function getBoxBlurPipeline() {
    return boxBlurPipeline ??= device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: boxBlurShader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
        ],
      },
      fragment: {
        module: boxBlurShader,
        entryPoint: "fragmentMain",
        targets: [{ format: colorFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  // Drop-shadow pipeline (P8 step 3, filter: drop-shadow() — see
  // DROP_SHADOW_SHADER's own comment). Same "no blend, one vertex
  // buffer, no instance data" shape — the shader's own straight-alpha
  // src-over math handles compositing the shadow under the current
  // texture directly, so no GPU fixed-function blend state is needed.
  const dropShadowShader = await makeShader("dropShadow", DROP_SHADOW_SHADER);
  let dropShadowPipeline = null;
  function getDropShadowPipeline() {
    return dropShadowPipeline ??= device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: dropShadowShader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
        ],
      },
      fragment: {
        module: dropShadowShader,
        entryPoint: "fragmentMain",
        targets: [{ format: colorFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  return {
    adapter,
    device,
    ownsDevice,
    quadBuffer,
    rectPipeline,
    tileClearPipeline,
    textPipeline,
    getCompositePipeline,
    getImagePipeline,
    getSvgPathPipeline,
    getDownsamplePipeline,
    getSourceConvertPipeline,
    getBoxShadowPipeline,
    getBoxBlurPipeline,
    getMatrixOverwritePipeline,
    getDropShadowPipeline,
    getMaskCombinePipelines,
    placeholderTexture,
    liveContextCount: 0,
    dispose() {
      if (disposed) return;
      disposed = true;
      focusedOperations.dispose();
      placeholder?.destroy();
    },
  };
}

// Deliberate device release for a long-lived embedder: destroys the shared
// device of every state whose contexts have all been destroyed. States with
// live contexts are left untouched.
export async function releaseSharedWebgpuStates(
  stateOwner = defaultWebgpuStateOwner,
) {
  const sharedStates = stateOwner.webgpu;
  if (!sharedStates) return;
  for (const [key, sharedPromise] of [...sharedStates]) {
    const shared = await sharedPromise;
    if (shared.liveContextCount > 0) continue;
    sharedStates.delete(key);
    await shared.device.queue.onSubmittedWorkDone();
    shared.dispose?.();
    if (shared.ownsDevice) shared.device.destroy();
  }
}

async function createRenderContextWebgpu(options) {
  // Native texture extents truncate fractional requests. Resolve that once
  // here so textures, readback buffers, row strides, and metadata agree.
  const width = Math.trunc(options.width);
  const height = Math.trunc(options.height);
  // Rendering mode and render precision (docs/specifications/
  // color-and-image-data.md, "Rendering modes and render precisions").
  // Standard mode stores encoded sRGB components, so every existing
  // shader and blend state is already correct; the precision selects
  // only texture width. The eight-bit precision exists only inside
  // standard mode.
  const renderMode = validateRenderMode(
    options.renderMode ?? DEFAULT_RENDER_MODE,
  );
  const renderPrecision = validateRenderPrecision(
    options.renderPrecision ?? DEFAULT_RENDER_PRECISION,
  );
  if (renderMode === "high-dynamic-range" && renderPrecision === "rgba8unorm") {
    throw new Error(
      "createRenderContext: the rgba8unorm speed precision exists only in standard mode",
    );
  }
  const colorFormat = renderPrecision;
  const colorTexelBytes = colorFormat === "rgba16float" ? 8 : 4;
  const stateOwner = options.sharedStateOwner ?? defaultWebgpuStateOwner;
  const sharedStates = stateOwner.webgpu ??= new Map();
  let sharedPromise = sharedStates.get(colorFormat);
  if (!sharedPromise) {
    sharedPromise = createSharedWebgpuState(
      colorFormat,
      stateOwner.webgpuDevice ?? null,
    );
    sharedStates.set(colorFormat, sharedPromise);
    sharedPromise.catch(() => {
      // A failed boot must not stick to the owner; the next caller retries.
      // The awaiting caller below still observes the rejection itself.
      if (sharedStates.get(colorFormat) === sharedPromise) {
        sharedStates.delete(colorFormat);
      }
    });
  }
  const shared = await sharedPromise;
  const { device } = shared;
  let contextDestroyed = false;

  // Pre-allocated buffers for batched rendering.
  // Instance buffer: 4096 instances × 44 floats × 4 bytes = 704 KB.
  const MAX_INSTANCES = 4096;
  const INSTANCE_FLOATS = 44;
  const instanceBuffer = device.createBuffer({
    size: MAX_INSTANCES * INSTANCE_FLOATS * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  let tileClearInstanceBuffer = null;
  let tileClearInstanceCapacityBytes = 0;

  // Gradient storage buffers (P4): one GradientRecord per rect INSTANCE in
  // a batch (indexed by @builtin(instance_index), see the shader's own
  // comment), sized for a full MAX_INSTANCES-sized batch by default — 32 B
  // (GRADIENT_RECORD_STRIDE, module-level) × MAX_INSTANCES. Stops are
  // sized more modestly (most rects carry none; a real scene rarely needs
  // more than a few gradients' worth of stops per batch) and GROW ON
  // DEMAND, same discipline as the uniform pool below.
  const INITIAL_GRADIENT_STOP_CAPACITY = 256;

  // Uniform buffer pool — one per batch. Avoids per-draw createBuffer.
  // 64 bytes: resolution(2) + clipMin(2) + clipMax(2) + enabled(2) +
  // clipRadiiX(4) + clipRadiiY(4) floats — see the rect shader's Uniforms.
  // Each slot ALSO carries its own gradient storage buffers (P4) — a
  // batch's gradient data is exactly as per-batch as its clip state, same
  // "one shared buffer would race across sibling/nested batches in one
  // render() call" hazard the uniform buffer itself exists to avoid.
  //
  // THE SHARED-BUFFER HAZARD (recurring bug class, fixed twice — read this
  // before adding any new per-draw GPU uniform/storage buffer): render()
  // records every writeBuffer + draw call into one command encoder and
  // only executes them at device.queue.submit() time. If two draws in a
  // frame write to the SAME GPU buffer before that submit, the GPU sees
  // only the LAST write — every draw reads the final buffer contents, not
  // its own. Original instance (fixed 2026-06-16, recovered WIP `8c3fcc5`):
  // multiple rect batches sharing one uniform buffer all drew with the
  // last batch's clip region. Recurrence #2 (2026-07-06, Slice 8C
  // mix-blend-mode, `09ebb89`): the composite pass's uniform buffer
  // (`compositeUniformBuffer`, below) was still a single shared buffer,
  // unpooled, even though this rect pool had already been fixed — two
  // `popOpacity` calls in one render() (siblings OR nested) raced on it
  // exactly the same way. Undetected until then because the one
  // pre-existing nested-opacity test happened to use the SAME alpha at
  // both nesting levels — a clobbered-then-reread shared buffer still
  // reads correctly when every write contains an identical value, so
  // identical-value tests are structurally blind to this bug; confirmed
  // via two SIBLING opacity groups at DIFFERENT alphas (0.2 vs 0.8) both
  // incorrectly rendering at 0.8. LESSON: if this codebase ever adds
  // ANOTHER per-draw GPU uniform/storage buffer, check whether it's pooled
  // BEFORE assuming a single shared buffer is fine — and any test
  // asserting two instances of the same effect in one frame should default
  // to DIFFERENT parameter values, not the same ones, specifically to
  // catch this class of bug.
  const UNIFORM_POOL_SIZE = 64;
  function makeRectBindGroupSlot() {
    // 656 bytes — resolution + clipCount + pad (16B) + 8 × 80B ClipEntry
    // (see CLIP_STRUCT_WGSL).
    const buf = device.createBuffer({
      size: 656,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const gradientRecordBuffer = device.createBuffer({
      size: MAX_INSTANCES * GRADIENT_RECORD_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    let gradientStopBuffer = device.createBuffer({
      size: INITIAL_GRADIENT_STOP_CAPACITY * GRADIENT_STOP_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    let gradientStopCapacity = INITIAL_GRADIENT_STOP_CAPACITY;
    function makeBindGroup() {
      return device.createBindGroup({
        layout: shared.rectPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: { buffer: gradientRecordBuffer } },
          { binding: 2, resource: { buffer: gradientStopBuffer } },
        ],
      });
    }
    const slot = {
      buffer: buf,
      gradientRecordBuffer,
      bindGroup: makeBindGroup(),
    };
    // Grow the stop buffer on demand (same "compare against the pool's
    // OWN current capacity, not the initial constant" discipline the
    // outer pools use) — most batches need far fewer than
    // INITIAL_GRADIENT_STOP_CAPACITY stops; a batch that legitimately
    // needs more grows this ONE slot's stop buffer, and the bind group is
    // rebuilt to point at the new buffer (bind groups are immutable once
    // created — the buffer reference itself can't be swapped in place).
    slot.ensureStopCapacity = (neededStops) => {
      if (neededStops <= gradientStopCapacity) return;
      gradientStopCapacity = Math.max(neededStops, gradientStopCapacity * 2);
      gradientStopBuffer = device.createBuffer({
        size: gradientStopCapacity * GRADIENT_STOP_STRIDE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      slot.gradientStopBuffer = gradientStopBuffer;
      slot.bindGroup = makeBindGroup();
    };
    slot.gradientStopBuffer = gradientStopBuffer;
    return slot;
  }
  const uniformPool = [];
  for (let i = 0; i < UNIFORM_POOL_SIZE; i++) {
    uniformPool.push(makeRectBindGroupSlot());
  }
  let uniformPoolIndex = 0;
  const mainTexture = device.createTexture({
    size: { width, height },
    format: colorFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING,
  });

  // Persistent float32 pixel buffer for incremental rendering (the
  // readback contract returns working float32 descriptors).
  const persistentPixels = new Float32Array(width * height * 4);
  let frameCount = 0;

  // GPU→CPU readback buffer RING, each sized for a full frame. Deno/wgpu
  // resolves mapAsync on a fixed ~13ms poll cadence regardless of size, so
  // awaiting a readback serially per frame caps throughput at ~1 frame per poll
  // cycle (~66fps). Keeping several readbacks in flight lets them resolve
  // together on a poll tick (~2ms amortized). A single shared buffer can't be
  // in flight more than once, so we round-robin a small ring; depth bounds how
  // many frames can overlap (and thus memory + latency).
  const readbackBytesPerRow = Math.ceil(width * colorTexelBytes / 256) * 256;
  const READBACK_RING_SIZE = 4;
  // Each ring slot pairs a GPU readback buffer with its OWN CPU pixel buffer, so
  // up to READBACK_RING_SIZE frames can be in flight and delivered without any
  // sharing — the GPU buffer can't be remapped until its collect unmaps it, and
  // the CPU buffer is the delivered frame's pixels (no cross-frame overwrite).
  const readbackRing = [];
  for (let i = 0; i < READBACK_RING_SIZE; i++) {
    readbackRing.push({
      buffer: device.createBuffer({
        size: readbackBytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      pixels: new Float32Array(width * height * 4),
    });
  }
  let readbackRingIndex = 0;
  const maskCombineUniformPool = [];
  let maskCombineUniformPoolIndex = 0;
  function nextMaskCombineUniformBuffer() {
    if (maskCombineUniformPoolIndex >= maskCombineUniformPool.length) {
      maskCombineUniformPool.push(device.createBuffer({
        size: 16, // resolution vec2f + mode f32 + pad
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }));
    }
    return maskCombineUniformPool[maskCombineUniformPoolIndex++];
  }

  // Cross-frame GPU texture cache (see placeholderTexture below), owned by
  // the context and outliving any one render() call, unlike every per-frame
  // texture, which render() destroys. Atlas textures are owned by their
  // atlas instead (WasmAtlas.deviceTexture).
  // Per-image upload representation and conversion parameters, derived
  // once per registered descriptor per context (the conversion plan
  // depends on this context's rendering mode). Replaces the pre-cutover
  // CPU premultiply cache: premultiplication now happens in the
  // conversion shader.
  const imageConversionCache = new WeakMap();
  const imageConversionUniformCache = new WeakMap();
  function imageConversionUniformFor(descriptor) {
    let uniformData = imageConversionUniformCache.get(descriptor);
    if (!uniformData) {
      const plan = sourceConversionPlan(descriptor, renderMode);
      uniformData = new Float32Array(20);
      uniformData.set(plan.matrix, 0);
      uniformData[12] = plan.transferId;
      uniformData[13] = plan.gammaExponent;
      uniformData[14] = plan.linearScale;
      uniformData[15] = plan.encodeSrgbOutput;
      uniformData[16] = plan.alphaSourceMode;
      uniformData[17] = plan.sourceScale;
      uniformData[18] = descriptor.sampleType === "float16" &&
          descriptor.canvasToneMapping === "standard"
        ? 1
        : 0;
      imageConversionUniformCache.set(descriptor, uniformData);
    }
    return uniformData;
  }
  function imageConversionFor(entry) {
    let cached = imageConversionCache.get(entry.descriptor);
    if (!cached) {
      cached = {
        upload: imageUploadRepresentation(entry.descriptor),
        uniformData: imageConversionUniformFor(entry.descriptor),
      };
      imageConversionCache.set(entry.descriptor, cached);
    }
    return cached;
  }
  // Composite uniform buffer POOL — one per CMD_POP_OPACITY draw, not a
  // single shared buffer. This is the same shared-buffer hazard documented
  // at the rect uniform pool below (search "THE SHARED-BUFFER HAZARD") —
  // this buffer was the bug's second recurrence (Slice 8C, `09ebb89`).
  // Grows on demand past the initial size, same discipline as the rect
  // pool (compare against .length, not the constant, or a >N-pop frame
  // reallocates every pop on every subsequent frame too).
  const COMPOSITE_UNIFORM_POOL_SIZE = 16;
  const compositeUniformPool = [];
  for (let i = 0; i < COMPOSITE_UNIFORM_POOL_SIZE; i++) {
    compositeUniformPool.push(device.createBuffer({
      // 864 B: the 848-byte path-mask-era block plus P11's one vec4f
      // maskInfo (16 B), followed by the clip-entry array.
      size: 864,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
  }
  let compositeUniformPoolIndex = 0;

  // The svg path atlas as a GPU texture, or the placeholder when the scene
  // has none. The atlas uploads once per (device, revision)
  // (WasmAtlas.deviceTexture) and outlives the frame.
  function pathAtlasTexture(svgPathAtlas) {
    const hasAtlas = svgPathAtlas && svgPathAtlas.atlasWidth > 0 &&
      svgPathAtlas.atlasHeight > 0;
    if (!hasAtlas) return shared.placeholderTexture();
    return svgPathAtlas.deviceTexture(device);
  }
  // box-shadow uniform pool (P3): same simple "plain pooled uniform
  // buffer, no bind-group coupling" shape as the composite pool above —
  // a shadow draw has no gradient/texture bind-group entries the rect/
  // image pools' own pooling exists to manage, so a bind group is built
  // fresh per batch in render() (cheap: one buffer entry, no texture).
  // 80 bytes: SAME struct shape as IMAGE_SHADER's own Uniforms
  // (resolution + clipCount + pad = 16B, exactly the ClipEntry array's
  // 16-byte alignment, then 8 × 80B ClipEntry = 656B total — see the
  // image uniform's own comment for the WGSL size-math warning).
  const BOX_SHADOW_UNIFORM_POOL_SIZE = 16;
  const boxShadowUniformPool = [];
  for (let i = 0; i < BOX_SHADOW_UNIFORM_POOL_SIZE; i++) {
    boxShadowUniformPool.push(device.createBuffer({
      size: 656,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
  }
  let boxShadowUniformPoolIndex = 0;
  // text uniform pool: same plain pooled shape as the box-shadow pool.
  // 672 bytes — the text shader's Uniforms struct: resolution +
  // clipCount + dilateLight/dilateDark/steepness + 8B pad (the ClipEntry
  // needs 16-byte alignment, so the 20-byte prefix pads to 32), then
  // 8 × 80B ClipEntry. The atlas sampler is immutable, so one serves
  // every text draw of the context.
  const TEXT_UNIFORM_POOL_SIZE = 16;
  const textUniformPool = [];
  for (let i = 0; i < TEXT_UNIFORM_POOL_SIZE; i++) {
    textUniformPool.push(device.createBuffer({
      size: 672,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
  }
  let textUniformPoolIndex = 0;
  const textSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  shared.liveContextCount++;
  return {
    kind: "webgpu",
    backendInfo: Object.freeze({
      host: "webgpu",
      implementation: "WebGPU",
    }),
    shared,
    device,
    mainTexture,
    quadBuffer: shared.quadBuffer,
    renderMode,
    renderPrecision,
    colorFormat,
    colorTexelBytes,
    rectPipeline: shared.rectPipeline,
    tileClearPipeline: shared.tileClearPipeline,
    textPipeline: shared.textPipeline,
    getCompositePipeline: shared.getCompositePipeline,
    getImagePipeline: shared.getImagePipeline,
    getSvgPathPipeline: shared.getSvgPathPipeline,
    getDownsamplePipeline: shared.getDownsamplePipeline,
    getSourceConvertPipeline: shared.getSourceConvertPipeline,
    getBoxShadowPipeline: shared.getBoxShadowPipeline,
    getBoxBlurPipeline: shared.getBoxBlurPipeline,
    getMatrixOverwritePipeline: shared.getMatrixOverwritePipeline,
    getDropShadowPipeline: shared.getDropShadowPipeline,
    getMaskCombinePipelines: shared.getMaskCombinePipelines,
    instanceBuffer,
    uniformPool,
    imageConversionFor,
    imageConversionUniformFor,
    MAX_INSTANCES,
    INSTANCE_FLOATS,
    width,
    height,
    persistentPixels,
    get frameCount() {
      return frameCount;
    },
    incrementFrameCount() {
      frameCount++;
    },
    tileClearInstanceBuffer(requiredBytes) {
      if (requiredBytes > tileClearInstanceCapacityBytes) {
        let nextCapacity = Math.max(
          MAX_INSTANCES * INSTANCE_FLOATS * 4,
          tileClearInstanceCapacityBytes,
        );
        while (nextCapacity < requiredBytes) nextCapacity *= 2;
        const previous = tileClearInstanceBuffer;
        tileClearInstanceBuffer = device.createBuffer({
          size: nextCapacity,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        tileClearInstanceCapacityBytes = nextCapacity;
        if (previous !== null) {
          void device.queue.onSubmittedWorkDone().then(() => {
            previous.destroy();
          });
        }
      }
      return tileClearInstanceBuffer;
    },
    // Round-robin the readback ring. Caller must finish (unmap) a slot before it
    // comes around again; with depth 4 and same-order collection that holds.
    nextReadbackSlot() {
      const slot = readbackRing[readbackRingIndex];
      readbackRingIndex = (readbackRingIndex + 1) % READBACK_RING_SIZE;
      return slot;
    },
    get readbackRingSize() {
      return READBACK_RING_SIZE;
    },
    resetUniformPool() {
      uniformPoolIndex = 0;
    },
    nextUniform() {
      // Grow only when the cursor has passed everything the pool currently
      // holds — NOT when it passes the initial UNIFORM_POOL_SIZE. Comparing
      // against the constant would re-allocate every batch past 64 on every
      // frame (and leak the pool unboundedly), since grown entries would never
      // be reused. Against pool.length, a frame that needs >64 batches grows
      // the pool once; later frames reuse the grown entries and allocate zero.
      if (uniformPoolIndex >= uniformPool.length) {
        uniformPool.push(makeRectBindGroupSlot());
      }
      return uniformPool[uniformPoolIndex++];
    },
    resetCompositeUniformPool() {
      compositeUniformPoolIndex = 0;
    },
    resetMaskCombineUniformPool() {
      maskCombineUniformPoolIndex = 0;
    },
    pathAtlasTexture,
    placeholderTexture: shared.placeholderTexture,
    nextMaskCombineUniformBuffer,
    // Same pooling discipline as nextUniform() above, and for the identical
    // reason: two CMD_POP_OPACITY draws in one render() call (sibling or
    // nested groups) must never share a GPU buffer, or the GPU sees only
    // the LAST writeBuffer's values for every composite draw in the frame
    // (see this pool's header comment for the full hazard).
    nextCompositeUniformBuffer() {
      if (compositeUniformPoolIndex >= compositeUniformPool.length) {
        compositeUniformPool.push(device.createBuffer({
          // 864 B — see the pool's initial-seed comment above.
          size: 864,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }));
      }
      return compositeUniformPool[compositeUniformPoolIndex++];
    },
    resetBoxShadowUniformPool() {
      boxShadowUniformPoolIndex = 0;
    },
    nextBoxShadowUniformBuffer() {
      if (boxShadowUniformPoolIndex >= boxShadowUniformPool.length) {
        boxShadowUniformPool.push(device.createBuffer({
          size: 656,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }));
      }
      return boxShadowUniformPool[boxShadowUniformPoolIndex++];
    },
    resetTextUniformPool() {
      textUniformPoolIndex = 0;
    },
    nextTextUniformBuffer() {
      if (textUniformPoolIndex >= textUniformPool.length) {
        textUniformPool.push(device.createBuffer({
          size: 672,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }));
      }
      return textUniformPool[textUniformPoolIndex++];
    },
    textSampler,
    // Release every per-context GPU resource. The shared device, shader
    // modules, and pipelines stay with the state owner; see
    // releaseSharedWebgpuStates for the deliberate device release.
    async destroy() {
      if (contextDestroyed) return;
      contextDestroyed = true;
      this._releaseRasterRetention?.();
      await device.queue.onSubmittedWorkDone();
      mainTexture.destroy();
      instanceBuffer.destroy();
      tileClearInstanceBuffer?.destroy();
      for (const slot of uniformPool) {
        slot.buffer.destroy();
        slot.gradientRecordBuffer.destroy();
        slot.gradientStopBuffer.destroy();
      }
      for (const buffer of compositeUniformPool) buffer.destroy();
      for (const buffer of boxShadowUniformPool) buffer.destroy();
      for (const buffer of textUniformPool) buffer.destroy();
      for (const buffer of maskCombineUniformPool) buffer.destroy();
      for (const slot of readbackRing) slot.buffer.destroy();
      shared.liveContextCount--;
    },
  };
}

const retainedRasterFrames = new WeakMap();
const rasterFrameTokens = new WeakMap();

// Keep the publication only after a successful frame. In particular a foreign
// render or a rejected GPU/readback operation must never leave a reusable frame.
export async function render(
  context,
  commandBuffer,
  commandBytes,
  options = {},
) {
  const previous = retainedRasterFrames.get(context);
  retainedRasterFrames.delete(context);
  const token = {};
  rasterFrameTokens.set(context, token);
  const retain = options.commandRetention?.owner != null ||
    options.dirtyTiles != null;
  if (retain && !context._releaseRasterRetention) {
    context._releaseRasterRetention = () => {
      retainedRasterFrames.delete(context);
      rasterFrameTokens.delete(context);
      delete context._releaseRasterRetention;
    };
  }
  if (context.contextLost) {
    throw new Error(
      "render: the WebGL 2 context was lost; create a new render context",
    );
  }
  const resources = {
    ...options,
    renderMode: context.renderMode ?? "standard",
  };
  const frame = prepareRetainedBatches(
    previous,
    commandBuffer,
    commandBytes,
    resources,
    context.width,
    context.height,
  );
  const readback = options.readback ?? "float32";
  const unchanged = frame.dirtyTiles != null &&
    !frame.dirtyTiles.some((value) => value !== 0);
  const fullReadback = readback === "float32" &&
    previous?.readback !== "float32";
  const paintTiles = unchanged || fullReadback ? null : frame.dirtyTiles;
  const paintedRects = [];
  if (paintTiles != null) {
    const tileSize = options.tileSize ?? 64;
    const columns = Math.ceil(context.width / tileSize);
    for (let i = 0; i < paintTiles.length; i++) {
      if (!paintTiles[i]) continue;
      const x = (i % columns) * tileSize;
      const y = Math.floor(i / columns) * tileSize;
      paintedRects.push({
        x,
        y,
        w: Math.min(tileSize, context.width - x),
        h: Math.min(tileSize, context.height - y),
      });
    }
  }
  const finish = (result) => {
    if (paintTiles != null) result.dirtyRects = paintedRects;
    result.rasterPreparation = frame.statistics;
    if (!retain) {
      if (rasterFrameTokens.get(context) === token) {
        rasterFrameTokens.delete(context);
      }
      return result;
    }
    const state = frame.state;
    // Store a private CPU snapshot: returned pixels belong to the caller.
    state.result = unchanged && previous?.readback === readback
      ? previous.result
      : {
        ...result,
        ...(result.pixels ? { pixels: result.pixels.slice() } : {}),
        ...(result.textureImage
          ? { textureImage: { ...result.textureImage } }
          : {}),
      };
    state.readback = readback;
    if (rasterFrameTokens.get(context) === token) {
      retainedRasterFrames.set(context, state);
    }
    return result;
  };
  if (unchanged && previous?.result && previous.readback === readback) {
    const result = {
      ...previous.result,
      ...(previous.result.pixels
        ? { pixels: previous.result.pixels.slice() }
        : {}),
      ...(previous.result.textureImage
        ? { textureImage: { ...previous.result.textureImage } }
        : {}),
      dirtyRects: [],
      readbackByteLength: 0,
    };
    finish(result);
    if (options.deferReadback && readback === "float32") {
      return {
        deferred: true,
        collect: async () => ({ finish: () => result }),
      };
    }
    return result;
  }
  // Partial readback merges into persistentPixels. A previous texture-only
  // frame has no complete CPU baseline, so initialize it with a full frame.
  if ((unchanged || fullReadback) && frame.dirtyTiles != null) {
    frame.statistics.replayedBatches = frame.state.prepared.batches.length;
    frame.statistics.replayedInstances = 0;
    for (const batch of frame.state.prepared.batches) {
      frame.statistics.replayedInstances += batch.count ?? 0;
    }
  }
  const result = await renderFrame(context, commandBuffer, commandBytes, {
    ...options,
    dirtyTiles: paintTiles,
    _preparedBatches: unchanged || fullReadback
      ? frame.state.prepared
      : frame.prepared,
  });
  if (!result.deferred) return finish(result);
  return {
    deferred: true,
    collect: async () => {
      const collected = await result.collect();
      return { finish: () => finish(collected.finish()) };
    },
  };
}

// Render the command buffer with batched draw calls and pre-allocated buffers.
async function renderFrame(
  context,
  commandBuffer,
  commandBytes,
  options = {},
) {
  // WebGL 2 cannot sample a WebGPU texture. Materialize each live canvas
  // source through its bounded readback path before the shared command walker.
  if (context.kind === "webgl2") {
    const resolvedImages = options.images ? new Map(options.images) : null;
    let materializedCanvas = false;
    if (resolvedImages) {
      for (const [imageIndex, entry] of resolvedImages) {
        if (entry?.kind !== "canvas") continue;
        materializedCanvas = true;
        const capture = entry.captureForRender(null);
        let descriptor;
        try {
          descriptor = await capture.resolve();
        } finally {
          capture.release();
        }
        if (descriptor === null) {
          resolvedImages.delete(imageIndex);
          continue;
        }
        resolvedImages.set(imageIndex, {
          width: descriptor.width,
          height: descriptor.height,
          descriptor,
          pixels: descriptor.pixels,
        });
      }
    }
    return renderWebgl2(context, commandBuffer, commandBytes, {
      ...options,
      images: resolvedImages,
      _preparedBatches: materializedCanvas
        ? undefined
        : options._preparedBatches,
    });
  }
  const {
    background = { r: 0, g: 0, b: 0, a: 0 },
    atlases = null,
    glyphBuffer = null,
    // Tier B: a single SvgPathAtlas shared across every svg-path/
    // svg-polygon/svg-polyline node in the scene (paths aren't scoped to a
    // font the way glyphs are, so unlike `atlases` there's no per-index
    // map — one atlas instance, looked up by pathIndex -> atlas.pathCache
    // at draw time, same pattern as CMD_TEXT's glyphId lookup).
    svgPathAtlas = null,
    // Slice P5a: imageIndex -> { width, height, pixels } (RGBA8), the decoded
    // pixel cache the engine itself never sees (IMAGE_TABLE only carries
    // width/height for layout) — see examples/render-scene.js's
    // imagePixelsFor.
    images = null,
    // P4: a DataView over GRADIENT_STOP_POOL's live WASM bytes (see
    // readRect's own comment for why this arrives as an option rather
    // than being reached directly — this module never touches engine
    // memory except through what its caller explicitly resolves and
    // passes down). null when the caller never touches gradients at all
    // (readRect only dereferences it for a CMD_RECT that actually sets
    // CMD_RECT_FLAG_GRADIENT).
    gradientStopPool = null,
    dirtyTiles = null,
    // Overlay rectangles (wide-color plan, package 4): plain solid rects
    // drawn ON TOP of the whole frame through the ordinary rect pipeline
    // (scrollbar tracks and thumbs - src/dom/render-surface.js). Each is
    // { x, y, width, height, color: {r,g,b,a} } in PHYSICAL pixels with
    // authored extended encoded sRGB color; the walker applies the same
    // HDR boundary conversion every command-stream color gets.
    overlayRects = null,
    // D2 piece B: Float32Array over the engine's SCROLL_TABLE region
    // (see render-commands.js buildBatches).
    scrollTable = null,
    tileSize = 64,
    deferReadback = false,
    // Readback contract (wide-color plan, package 5): "float32" returns a
    // working ImageDescriptor; "none" returns a direct textureImage. The
    // pre-cutover boolean contract is rejected loudly below.
    readback = "float32",
    // Chrome-on-macOS text mask model (see the text fragment shader):
    // per-tap SDF DILATION mix(dilateDark, dilateLight, textLuma) in
    // screen px models macOS font-smoothing stem darkening (strong for
    // light-on-dark text) → 4-tap box coverage → Schlick GAIN
    // (steepness; 1 = identity) sharpens the mid-ramp.
    // Recalibrated 2026-08-25 at density 2 against the static-document
    // corpus (tools/calibrate-text-gamma.js): objective is ZERO
    // systematic edge dilation on both text polarities plus Chrome-matched
    // stem ramp width. The 2026-07-16 mass-ratio plateau (contrast lift
    // model) and the older pow-only calibration are both superseded.
    textGamma = { dilateLight: 0.45, dilateDark: 0.12, steepness: 1.6 },
    // Raster scale: the command stream carries CSS-pixel coordinates;
    // buildBatches multiplies every length by this scale while it
    // decodes, so instance data reaches the pipelines in device pixels.
    deviceScale = 1,
    // Visible-region rasterization: CSS-px rectangle the target covers
    // (see buildBatches); null covers the full scene.
    visibleRectangle = null,
    glyphPerformance = null,
  } = options;
  if (readback !== "float32" && readback !== "none") {
    throw new Error(
      `render: readback must be "float32" or "none", got ${
        JSON.stringify(readback)
      } - the pre-cutover boolean contract was removed (wide-color plan, package 5)`,
    );
  }
  const {
    device,
    mainTexture,
    quadBuffer,
    rectPipeline,
    textPipeline,
    getCompositePipeline,
    getImagePipeline,
    getSvgPathPipeline,
    getDownsamplePipeline,
    getSourceConvertPipeline,
    getBoxShadowPipeline,
    getBoxBlurPipeline,
    getMatrixOverwritePipeline,
    getDropShadowPipeline,
    getMaskCombinePipelines,
    uniformPool,
    imageConversionFor,
    imageConversionUniformFor,
    renderMode,
    instanceBuffer: preAllocInstanceBuffer,
    tileClearPipeline,
    persistentPixels,
    colorFormat,
    colorTexelBytes,
    nextReadbackSlot,
    MAX_INSTANCES,
    INSTANCE_FLOATS,
    tileClearInstanceBuffer,
    resetUniformPool,
    nextUniform,
    resetCompositeUniformPool,
    nextCompositeUniformBuffer,
    resetMaskCombineUniformPool,
    nextMaskCombineUniformBuffer,
    pathAtlasTexture,
    placeholderTexture,
    resetBoxShadowUniformPool,
    nextBoxShadowUniformBuffer,
    resetTextUniformPool,
    nextTextUniformBuffer,
    textSampler,
    width,
    height,
  } = context;

  const incremental = dirtyTiles !== null;
  // HDR boundary conversion for the caller's clear color: `background`
  // arrives in extended encoded sRGB like every authored color; the
  // walker converts command-stream colors (see buildBatches), and this
  // is the one authored color that bypasses the command stream.
  const clearColor = renderMode === "high-dynamic-range"
    ? (() => {
      const [r, g, b, a] = convertEncodedSrgbColor4ToWorkingRec2020([
        background.r,
        background.g,
        background.b,
        background.a,
      ]);
      return { r, g, b, a };
    })()
    : background;
  const commandEncoder = device.createCommandEncoder();
  const texturesToDestroy = [];

  // Both the uniform pool and the single pre-allocated instance buffer are
  // consumed across every draw in this frame, so reset their cursors once up
  // front. Each batch gets its own uniform buffer (from the pool) and its own
  // slice of the instance buffer (via a running byte offset) — sharing either
  // would let a later writeBuffer overwrite an earlier batch's data before the
  // GPU runs the submitted pass.
  resetUniformPool();
  resetCompositeUniformPool();
  resetBoxShadowUniformPool();
  resetMaskCombineUniformPool();
  resetTextUniformPool();
  // Hand out a fresh slice of the single pre-allocated instance buffer per
  // draw. byteOffset must be 4-byte aligned; every float write satisfies that.
  // Capacity is the rect/text stride (20 floats) × MAX_INSTANCES; composite
  // draws use a 4-float stride but write into the same byte budget.
  const instanceCapacityBytes = MAX_INSTANCES * INSTANCE_FLOATS * 4;
  let instanceOffsetBytes = 0;
  function writeInstances(data) {
    if (instanceOffsetBytes + data.byteLength > instanceCapacityBytes) {
      throw new Error(
        `instance buffer overflow: frame needs more than ${instanceCapacityBytes} bytes ` +
          `(at ${instanceOffsetBytes}, adding ${data.byteLength})`,
      );
    }
    const byteOffset = instanceOffsetBytes;
    device.queue.writeBuffer(preAllocInstanceBuffer, byteOffset, data);
    instanceOffsetBytes += data.byteLength;
    return byteOffset;
  }

  // --- Incremental: clear dirty tiles ---
  if (incremental) {
    const columns = Math.ceil(width / tileSize);
    const rows = Math.ceil(height / tileSize);
    const clearInstances = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        if (!dirtyTiles[row * columns + col]) continue;
        const x = col * tileSize;
        const y = row * tileSize;
        const tileWidth = Math.min(tileSize, width - x);
        const tileHeight = Math.min(tileSize, height - y);
        clearInstances.push(
          2 * x / width - 1,
          1 - 2 * y / height,
          2 * tileWidth / width,
          2 * tileHeight / height,
          clearColor.r,
          clearColor.g,
          clearColor.b,
          clearColor.a,
        );
      }
    }
    if (clearInstances.length > 0) {
      const clearData = new Float32Array(clearInstances);
      const clearInstanceBuffer = tileClearInstanceBuffer(
        clearData.byteLength,
      );
      device.queue.writeBuffer(clearInstanceBuffer, 0, clearData);
      const pass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: mainTexture.createView(),
          loadOp: "load",
          storeOp: "store",
        }],
      });
      pass.setPipeline(tileClearPipeline);
      pass.setVertexBuffer(0, quadBuffer);
      pass.setVertexBuffer(
        1,
        clearInstanceBuffer,
        0,
        clearData.byteLength,
      );
      pass.draw(6, clearData.length / 8);
      pass.end();
    }
  }

  // --- First pass (shared walker): decode commands into batches ---
  const {
    batches,
    opacityStack,
    maskStack,
    maskLayerStack,
    backgroundStack,
    blendLayerStack,
  } = options._preparedBatches ?? buildBatches(commandBuffer, commandBytes, {
    atlases,
    glyphBuffer,
    svgPathAtlas,
    images,
    gradientStopPool,
    deviceScale,
    renderMode,
    overlayRects,
    scrollTable,
    visibleRectangle,
  });
  const canvasImageLeases = [];
  try {
    const resolvedCanvasSources = new Map();
    for (const batch of batches) {
      if (batch.type !== "image" || batch.image?.kind !== "canvas") continue;
      let resolved = resolvedCanvasSources.get(batch.image);
      if (resolved === undefined) {
        const capture = batch.image.captureForRender(device);
        canvasImageLeases.push(capture);
        resolved = await capture.resolve();
        resolvedCanvasSources.set(batch.image, resolved ?? null);
      }
      if (resolved === null) {
        batch.skip = true;
      } else if (resolved.kind === "gpu-texture") {
        batch.image = resolved;
      } else {
        batch.image = {
          width: resolved.width,
          height: resolved.height,
          descriptor: resolved,
          pixels: resolved.pixels,
        };
      }
    }

    // The composite shader's bind group always needs SOMETHING at bindings
    // 4 and 6, but the overwhelmingly common frame has neither a clip-path
    // mask nor a mask layer. Before this was cached, every frame of every
    // scene created a texture and uploaded the ENTIRE svg path atlas —
    // caught by batching_alloc_test.js's "0 texture allocs in steady state"
    // assertion (see BUG-path-mask-atlas-allocated-every-frame.md), but the
    // real cost was the per-frame full-atlas upload, not the allocation.
    //
    // A frame needs the real atlas only if some group actually carries a
    // path mask; batches are fully built by this point, so that is a plain
    // predicate rather than a guess. Everything else binds the context's
    // one shared 1x1 placeholder.
    const needsPathAtlas = batches.some((batch) => batch.pathMask);
    const pathMaskAtlasTexture = needsPathAtlas
      ? pathAtlasTexture(svgPathAtlas)
      : placeholderTexture();
    const pathMaskSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    // --- Second pass: execute batches ---
    let currentTarget = mainTexture;
    let currentRenderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: currentTarget.createView(),
        clearValue: clearColor,
        loadOp: incremental ? "load" : "clear",
        storeOp: "store",
      }],
    });
    let currentDamage = null;
    function drawCurrentPass(...args) {
      // Dependency groups render their complete source; only the retained
      // destination is scissored, once per dirty rect the unit touches.
      // Composite sampling then matches full paint.
      if (currentDamage && currentTarget === mainTexture) {
        for (const rect of currentDamage.rects) {
          currentRenderPass.setScissorRect(rect.x, rect.y, rect.w, rect.h);
          currentRenderPass.draw(...args);
        }
        return;
      }
      currentRenderPass.draw(...args);
    }

    // P8 / P8b: filter-segment application, shared by CMD_POP_OPACITY's group
    // filter chain and CMD_PUSH_BACKDROP_FILTER's backdrop snapshot chain —
    // hoisted out of the popOpacity branch (was defined fresh per pop) since
    // both call sites need the identical pass sequence. Each segment is its
    // own full-screen pass reading the CURRENT filtered texture and writing a
    // fresh one — matches Blink/Skia's own separation of the SkImageFilter
    // chain from final-layer compositing. Every intermediate texture is
    // freshly created per segment/pass and destroyed at end of render() —
    // never pooled/reused across draws, so this is NOT the [[rasterizer-
    // shared-buffer-bug]] hazard (that bug is about UNIFORM BUFFERS reused
    // across multiple draws before submit(); a texture created fresh per
    // segment and read exactly once has no such reuse).
    const filterSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    function applyMatrixSegment(sourceTexture, matrix) {
      const outputTexture = device.createTexture({
        size: { width, height },
        format: colorFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING,
      });
      texturesToDestroy.push(outputTexture);
      // Reuses COMPOSITE_SHADER's own matrix application, with
      // opacity=1/blendMode=normal (a pure matrix pass, not a
      // composite), with the shared coefficient-row/constant-column packing.
      const matrixWgsl = filterMatrixUniformFloats(matrix);
      const matrixUniformBuffer = nextCompositeUniformBuffer();
      // clipCount=0 (no clips array entries): a standalone filter-
      // segment pass applies to the WHOLE current texture — clipping
      // to the element's own shape happens only at the FINAL composite
      // draw, same "filter chain is a separate stage from final layer
      // compositing" reasoning as the blur/matrix pass ordering itself.
      device.queue.writeBuffer(
        matrixUniformBuffer,
        0,
        new Float32Array([
          width,
          height,
          1,
          BLEND_NORMAL,
          1,
          0,
          0,
          0,
          ...matrixWgsl,
          ...new Array(24).fill(0),
          0,
          0,
          0,
          0,
        ]),
      );
      const matrixBindGroup = device.createBindGroup({
        layout: getMatrixOverwritePipeline().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: matrixUniformBuffer } },
          { binding: 1, resource: sourceTexture.createView() },
          { binding: 2, resource: filterSampler },
          { binding: 3, resource: sourceTexture.createView() },
          { binding: 4, resource: pathMaskAtlasTexture.createView() },
          { binding: 5, resource: pathMaskSampler },
          { binding: 6, resource: pathMaskAtlasTexture.createView() },
        ],
      });
      const matrixInstances = new Float32Array([0, 0, width, height]);
      const matrixByteOffset = writeInstances(matrixInstances);
      const matrixPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: outputTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      matrixPass.setPipeline(getMatrixOverwritePipeline());
      matrixPass.setBindGroup(0, matrixBindGroup);
      matrixPass.setVertexBuffer(0, quadBuffer);
      matrixPass.setVertexBuffer(
        1,
        preAllocInstanceBuffer,
        matrixByteOffset,
        matrixInstances.byteLength,
      );
      matrixPass.draw(6, 1);
      matrixPass.end();
      return outputTexture;
    }

    // Six-pass box blur (3 horizontal + 3 vertical — see BOX_BLUR_SHADER's
    // own comment for why box blur, not a true Gaussian). d = floor(sigma
    // * 3*sqrt(2*PI)/4 + 0.5): if d is odd, three passes of width d
    // (centered, no offset needed — a symmetric odd-width box is already
    // centered on its own output texel); if d is even, two passes of
    // width d plus one of width d+1 (the standard box-blur-approximates-
    // Gaussian construction — see filter-effects-1 §9.14 / the SVG-spec-
    // codified Kutskir/Getreuer formulation). Order (which pass uses d
    // vs d+1, H-then-V vs interleaved) doesn't matter — box blur is
    // separable and every pass commutes with every other.
    function applyBlurSegment(sourceTexture, sigma) {
      const widths = blurBoxWidths(sigma);
      let current = sourceTexture;
      for (const boxWidth of widths) {
        for (const direction of [[1, 0], [0, 1]]) {
          const passTexture = device.createTexture({
            size: { width, height },
            format: colorFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT |
              GPUTextureUsage.TEXTURE_BINDING,
          });
          texturesToDestroy.push(passTexture);
          const blurUniformBuffer = device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(
            blurUniformBuffer,
            0,
            new Float32Array([
              width,
              height,
              direction[0],
              direction[1],
              boxWidth,
              0,
              0,
              0,
            ]),
          );
          const blurBindGroup = device.createBindGroup({
            layout: getBoxBlurPipeline().getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: blurUniformBuffer } },
              { binding: 1, resource: current.createView() },
              { binding: 2, resource: filterSampler },
            ],
          });
          const blurPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
              view: passTexture.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            }],
          });
          blurPass.setPipeline(getBoxBlurPipeline());
          blurPass.setBindGroup(0, blurBindGroup);
          blurPass.setVertexBuffer(0, quadBuffer);
          blurPass.draw(6);
          blurPass.end();
          current = passTexture;
        }
      }
      return current;
    }

    // filter: drop-shadow(dx, dy, sigma, color) (P8 step 3) — blur the
    // CURRENT texture's alpha (reusing applyBlurSegment's own six-pass
    // box blur as-is; its RGB output is simply never read, only
    // DROP_SHADOW_SHADER's own .a sample matters, matching the spec's
    // own "feGaussianBlur in=SourceAlpha" — blurring the FULL rgba
    // texture and discarding RGB gives the identical alpha channel a
    // blur-alpha-only shader would, since box blur is a per-channel
    // independent operation), then offset+flood+mask+composite-under
    // in DROP_SHADOW_SHADER (see its own comment for the exact
    // feOffset/feFlood/feComposite/feMerge derivation).
    function applyDropShadowSegment(sourceTexture, dx, dy, sigma, color) {
      const blurredAlphaTexture = applyBlurSegment(sourceTexture, sigma);
      const outputTexture = device.createTexture({
        size: { width, height },
        format: colorFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING,
      });
      texturesToDestroy.push(outputTexture);
      const dropShadowUniformBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(
        dropShadowUniformBuffer,
        0,
        new Float32Array([
          width,
          height,
          dx,
          dy,
          color.r,
          color.g,
          color.b,
          color.a,
        ]),
      );
      const dropShadowBindGroup = device.createBindGroup({
        layout: getDropShadowPipeline().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: dropShadowUniformBuffer } },
          { binding: 1, resource: blurredAlphaTexture.createView() },
          { binding: 2, resource: sourceTexture.createView() },
          { binding: 3, resource: filterSampler },
        ],
      });
      const dropShadowPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: outputTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      dropShadowPass.setPipeline(getDropShadowPipeline());
      dropShadowPass.setBindGroup(0, dropShadowBindGroup);
      dropShadowPass.setVertexBuffer(0, quadBuffer);
      dropShadowPass.draw(6);
      dropShadowPass.end();
      return outputTexture;
    }

    function applyFilterSegments(sourceTexture, filterSegments) {
      let texture = sourceTexture;
      for (const segment of filterSegments ?? []) {
        if (segment.kind === "matrix") {
          texture = applyMatrixSegment(texture, segment.matrix);
        } else if (segment.kind === "blur") {
          texture = applyBlurSegment(texture, segment.sigma);
        } else if (segment.kind === "drop-shadow") {
          texture = applyDropShadowSegment(
            texture,
            segment.dx,
            segment.dy,
            segment.sigma,
            segment.color,
          );
        }
      }
      return texture;
    }

    // P13: draw one full-canvas texture into currentTarget through the
    // composite pipeline, optionally blending it against a backdrop
    // snapshot, and leave a fresh load-mode pass open on currentTarget.
    // The background group's pop (plain src-over) and each blended
    // background layer's pop (a real blend mode) are the same draw with
    // different arguments; popOpacity keeps its own copy because it also
    // carries opacity, filters, clip entries and the mask accumulator.
    function compositeTexture(sourceTexture, blendMode, backdropTexture) {
      const uniformBuffer = nextCompositeUniformBuffer();
      device.queue.writeBuffer(
        uniformBuffer,
        0,
        new Float32Array([
          width,
          height,
          1,
          blendMode,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          ...new Array(24).fill(0),
          0,
          0,
          0,
          0,
          ...clipUniformFloats(EMPTY_CLIP_STATE),
        ]),
      );
      const sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
      });
      const bindGroup = device.createBindGroup({
        layout: getCompositePipeline().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: sourceTexture.createView() },
          { binding: 2, resource: sampler },
          // A normal-blend draw never samples the backdrop; bind the source
          // as the dummy, exactly as popOpacity does.
          {
            binding: 3,
            resource: (backdropTexture ?? sourceTexture).createView(),
          },
          { binding: 4, resource: pathMaskAtlasTexture.createView() },
          { binding: 5, resource: pathMaskSampler },
          { binding: 6, resource: pathMaskAtlasTexture.createView() },
        ],
      });
      const instances = new Float32Array([0, 0, width, height]);
      const byteOffset = writeInstances(instances);
      currentRenderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: currentTarget.createView(),
          loadOp: "load",
          storeOp: "store",
        }],
      });
      currentRenderPass.setPipeline(getCompositePipeline());
      currentRenderPass.setBindGroup(0, bindGroup);
      currentRenderPass.setVertexBuffer(0, quadBuffer);
      currentRenderPass.setVertexBuffer(
        1,
        preAllocInstanceBuffer,
        byteOffset,
        instances.byteLength,
      );
      drawCurrentPass(6, 1);
    }

    let lastRectSlot = null;
    let lastText = null;
    let lastShadow = null;
    // Gradient records + stops (P4): one GradientRecord per instance
    // (matching this batch's own instance_index order exactly — see
    // GradientRecord's own comment on why this can't ride the vertex
    // buffer), plus every gradient's stops concatenated into one flat
    // array, each record's stopStart pointing at its own span within
    // it. hasGradient=0 records are left fully zeroed — the shader
    // never reads dx/dy/length/stopStart for those.
    const writeRectGradients = (slot, batch, hasGradient) => {
      const { gradientRecordBuffer } = slot;
      const recordBytes = new ArrayBuffer(
        batch.count * GRADIENT_RECORD_STRIDE,
      );
      const recordU32 = new Uint32Array(recordBytes);
      const recordF32 = new Float32Array(recordBytes);
      const allStops = [];
      for (let i = 0; i < batch.count; i++) {
        const g = batch.gradients[i];
        const base = i * (GRADIENT_RECORD_STRIDE / 4);
        if (g) {
          // hasGradient flags: bit0 has, bit1 tiled, bits 8-11
          // interpolation-space id, bit 12 high-dynamic-range (see
          // GRADIENT_COLOR_WGSL's own comment).
          recordU32[base + 0] = 1 | (g.tiled ? 2 : 0) | (g.spaceId << 8) |
            (g.hdr ? 1 << 12 : 0);
          recordU32[base + 1] = g.kind; // kind
          recordU32[base + 2] = allStops.length; // stopStart
          recordU32[base + 3] = g.stops.length; // stopCount
          recordF32[base + 4] = g.geom0;
          recordF32[base + 5] = g.geom1;
          recordF32[base + 6] = g.geom2;
          recordF32[base + 7] = g.geom3;
          recordF32[base + 8] = g.geom4;
          recordF32[base + 9] = g.geom5;
          recordF32[base + 10] = g.geom6;
          recordF32[base + 11] = g.geom7;
          allStops.push(...g.stops);
        }
      }
      device.queue.writeBuffer(gradientRecordBuffer, 0, recordU32);
      // Records [0, count) are now zero when no gradient was written;
      // records past a longer earlier run were zero already.
      slot.zeroRecords = hasGradient
        ? 0
        : Math.max(slot.zeroRecords ?? 0, batch.count);
      slot.ensureStopCapacity(allStops.length);
      if (allStops.length > 0) {
        const stopBytes = new ArrayBuffer(
          allStops.length * GRADIENT_STOP_STRIDE,
        );
        const stopF32 = new Float32Array(stopBytes);
        for (let i = 0; i < allStops.length; i++) {
          const base = i * (GRADIENT_STOP_STRIDE / 4);
          // readColor4 returns a plain [r,g,b,a] array, not an {r,g,b,a} object.
          stopF32[base + 0] = allStops[i].color[0];
          stopF32[base + 1] = allStops[i].color[1];
          stopF32[base + 2] = allStops[i].color[2];
          stopF32[base + 3] = allStops[i].color[3];
          stopF32[base + 4] = allStops[i].position;
        }
        device.queue.writeBuffer(slot.gradientStopBuffer, 0, stopF32);
      }
      // ensureStopCapacity may have rebuilt the bind group against a new
      // stop buffer — callers read slot.bindGroup AFTER this, never before.
    };
    for (const batch of batches) {
      if (batch.type === "damage") {
        currentDamage = batch;
        continue;
      }
      if (batch.skip) continue;
      if (batch.type === "rect") {
        const clip = batch.clipState;
        // A slot's contents are a function of (clip state, gradient records,
        // stops). Two draws may share one slot when both would write the
        // SAME contents — the shared-buffer hazard (see the rect pool's
        // comment) is about DIFFERING contents before one submit. Text runs
        // interleave with rects in document order, so a page is hundreds of
        // small rect batches under one clip state with no gradient; those
        // reuse the previous slot as-is, paying one instance write and one
        // draw instead of three writes (plans/dom/PLAN-raster-frame-costs.md,
        // item 2). `zeroRecords` counts the leading gradient records a slot
        // is known to hold zeroed — a gradient-free batch of that many
        // instances reads nothing else.
        const hasGradient = batch.gradients.some((g) => g !== null);
        let slot = lastRectSlot;
        if (
          slot === null || slot.clip !== clip || hasGradient ||
          slot.zeroRecords < batch.count
        ) {
          slot = nextUniform();
          slot.clip = clip;
          device.queue.writeBuffer(
            slot.buffer,
            0,
            new Float32Array([
              width,
              height,
              clip.entries.length,
              0,
              ...clipUniformFloats(clip),
            ]),
          );
          writeRectGradients(slot, batch, hasGradient);
          lastRectSlot = hasGradient ? null : slot;
        }
        const { bindGroup } = slot;

        const byteOffset = writeInstances(batch.instances);

        currentRenderPass.setPipeline(rectPipeline);
        currentRenderPass.setBindGroup(0, bindGroup);
        currentRenderPass.setVertexBuffer(0, quadBuffer);
        currentRenderPass.setVertexBuffer(
          1,
          preAllocInstanceBuffer,
          byteOffset,
          batch.instances.byteLength,
        );
        drawCurrentPass(6, batch.count);
      } else if (batch.type === "boxShadow") {
        // Simple pooled uniform buffer (no gradient/texture bind-group
        // coupling — a shadow draw needs only clip state) — see
        // boxShadowUniformPool's own comment for why this doesn't reuse
        // nextUniform()'s rect-specific pool. Same reuse rule as the rect
        // slot: consecutive shadow batches under one clip state (every
        // rect flushes the shadow accumulator, so a page of shadowed boxes
        // is many one-instance batches) draw with the previous uniform.
        const clip = batch.clipState;
        let boxShadowBindGroup;
        if (lastShadow !== null && lastShadow.clip === clip) {
          boxShadowBindGroup = lastShadow.bindGroup;
        } else {
          const boxShadowUniform = nextBoxShadowUniformBuffer();
          device.queue.writeBuffer(
            boxShadowUniform,
            0,
            new Float32Array([
              width,
              height,
              clip.entries.length,
              0,
              ...clipUniformFloats(clip),
            ]),
          );
          boxShadowBindGroup = device.createBindGroup({
            layout: getBoxShadowPipeline().getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: boxShadowUniform } }],
          });
          lastShadow = { clip, bindGroup: boxShadowBindGroup };
        }

        const shadowByteOffset = writeInstances(batch.instances);
        currentRenderPass.setPipeline(getBoxShadowPipeline());
        currentRenderPass.setBindGroup(0, boxShadowBindGroup);
        currentRenderPass.setVertexBuffer(0, quadBuffer);
        currentRenderPass.setVertexBuffer(
          1,
          preAllocInstanceBuffer,
          shadowByteOffset,
          batch.instances.byteLength,
        );
        drawCurrentPass(6, batch.count);
      } else if (batch.type === "text") {
        const clip = batch.clipState;
        const atlas = batch.atlas;
        // Atlas-owned, uploaded once per (device, revision); never a
        // per-draw texture (see WasmAtlas.deviceTexture).
        const glyphUploadStartedAt = glyphPerformance ? performance.now() : 0;
        const atlasTexture = atlas.deviceTexture(device);
        if (glyphPerformance) {
          glyphPerformance.phaseMilliseconds.gpuUploadMilliseconds +=
            performance.now() - glyphUploadStartedAt;
        }

        // Pooled per draw (see textUniformPool's own comment and the
        // shared-buffer hazard above makeRectBindGroupSlot). Same reuse
        // rule as the rect slot: a batch under the clip state and atlas of
        // the previous text batch would write identical contents, so it
        // draws with the previous uniform and bind group.
        let textBindGroup;
        if (
          lastText !== null && lastText.clip === clip &&
          lastText.atlasTexture === atlasTexture
        ) {
          textBindGroup = lastText.bindGroup;
        } else {
          const textUniform = nextTextUniformBuffer();
          device.queue.writeBuffer(
            textUniform,
            0,
            new Float32Array([
              width,
              height,
              clip.entries.length,
              textGamma.dilateLight,
              textGamma.dilateDark,
              textGamma.steepness ?? 1,
              0,
              0,
              ...clipUniformFloats(clip),
            ]),
          );
          textBindGroup = device.createBindGroup({
            layout: textPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: textUniform } },
              { binding: 1, resource: atlasTexture.createView() },
              { binding: 2, resource: textSampler },
            ],
          });
          lastText = { clip, atlasTexture, bindGroup: textBindGroup };
        }

        const textByteOffset = writeInstances(batch.instances);
        currentRenderPass.setPipeline(textPipeline);
        currentRenderPass.setBindGroup(0, textBindGroup);
        currentRenderPass.setVertexBuffer(0, quadBuffer);
        currentRenderPass.setVertexBuffer(
          1,
          preAllocInstanceBuffer,
          textByteOffset,
          batch.instances.byteLength,
        );
        drawCurrentPass(6, batch.count);
      } else if (batch.type === "svgPath") {
        // Same atlas-texture rule as the text batch above, minus the gamma
        // uniform (SVG_PATH_SHADER has no mask-gamma remap — see its own
        // top comment).
        const clip = batch.clipState;
        const atlasTexture = batch.atlas.deviceTexture(device);

        const sampler = device.createSampler({
          magFilter: "linear",
          minFilter: "linear",
        });
        // 656 bytes — resolution + clipCount + pad (16B, exactly the
        // ClipEntry array's 16-byte alignment) + 8 × 80B ClipEntry. If this
        // shader's struct ever changes, recompute the real WGSL size by
        // hand rather than assuming (this file got that wrong once already
        // — see the image uniform's own comment).
        const svgPathUniform = device.createBuffer({
          size: 656,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(
          svgPathUniform,
          0,
          new Float32Array([
            width,
            height,
            clip.entries.length,
            0,
            ...clipUniformFloats(clip),
          ]),
        );

        // Gradient record + stops (S7 step 2): this batch is always a
        // single-instance draw (one CMD_SVG_PATH = one draw call, unlike
        // the rect pipeline's own multi-instance batching), so a single
        // GradientRecord suffices — no per-instance array needed. A
        // fresh small buffer per draw, matching this block's own
        // "create/upload/destroy per draw" convention for buffers rather
        // than reaching for the rect pipeline's own pooled-slot machinery,
        // which exists specifically to amortize cost across MANY same-frame
        // rect instances.
        const svgGradient = batch.gradient;
        const svgGradientRecordBuffer = device.createBuffer({
          size: GRADIENT_RECORD_STRIDE,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const svgGradientRecordBytes = new ArrayBuffer(GRADIENT_RECORD_STRIDE);
        const svgGradientRecordU32 = new Uint32Array(svgGradientRecordBytes);
        const svgGradientRecordF32 = new Float32Array(svgGradientRecordBytes);
        let svgGradientStopBuffer;
        if (svgGradient) {
          // Same flag packing as the rect record loop above (space id +
          // high-dynamic-range bits route gradientColorToWorking).
          svgGradientRecordU32[0] = 1 | (svgGradient.tiled ? 2 : 0) |
            (svgGradient.spaceId << 8) | (svgGradient.hdr ? 1 << 12 : 0);
          svgGradientRecordU32[1] = svgGradient.kind; // kind
          svgGradientRecordU32[2] = 0; // stopStart (this draw's own private stop buffer, always starts at 0)
          svgGradientRecordU32[3] = svgGradient.stops.length; // stopCount
          svgGradientRecordF32[4] = svgGradient.geom0;
          svgGradientRecordF32[5] = svgGradient.geom1;
          svgGradientRecordF32[6] = svgGradient.geom2;
          svgGradientRecordF32[7] = svgGradient.geom3;
          svgGradientRecordF32[8] = svgGradient.geom4;
          svgGradientRecordF32[9] = svgGradient.geom5;
          svgGradientRecordF32[10] = svgGradient.geom6;
          svgGradientRecordF32[11] = svgGradient.geom7;
          const stopBytes = new ArrayBuffer(
            Math.max(svgGradient.stops.length, 1) * GRADIENT_STOP_STRIDE,
          );
          const stopF32 = new Float32Array(stopBytes);
          for (let i = 0; i < svgGradient.stops.length; i++) {
            const base = i * (GRADIENT_STOP_STRIDE / 4);
            stopF32[base + 0] = svgGradient.stops[i].color[0];
            stopF32[base + 1] = svgGradient.stops[i].color[1];
            stopF32[base + 2] = svgGradient.stops[i].color[2];
            stopF32[base + 3] = svgGradient.stops[i].color[3];
            stopF32[base + 4] = svgGradient.stops[i].position;
          }
          svgGradientStopBuffer = device.createBuffer({
            size: stopBytes.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(svgGradientStopBuffer, 0, stopF32);
        } else {
          // hasGradient=0 record; the shader never reads kind/geom/stops for
          // it, but the bind group still needs A buffer bound (WebGPU has no
          // "optional" storage binding) — a minimal 1-stop-sized dummy.
          svgGradientStopBuffer = device.createBuffer({
            size: GRADIENT_STOP_STRIDE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
        }
        device.queue.writeBuffer(
          svgGradientRecordBuffer,
          0,
          svgGradientRecordU32,
        );

        const svgPathBindGroup = device.createBindGroup({
          layout: getSvgPathPipeline().getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: svgPathUniform } },
            { binding: 1, resource: atlasTexture.createView() },
            { binding: 2, resource: sampler },
            { binding: 3, resource: { buffer: svgGradientRecordBuffer } },
            { binding: 4, resource: { buffer: svgGradientStopBuffer } },
          ],
        });

        const svgPathByteOffset = writeInstances(batch.instances);
        currentRenderPass.setPipeline(getSvgPathPipeline());
        currentRenderPass.setBindGroup(0, svgPathBindGroup);
        currentRenderPass.setVertexBuffer(0, quadBuffer);
        currentRenderPass.setVertexBuffer(
          1,
          preAllocInstanceBuffer,
          svgPathByteOffset,
          batch.instances.byteLength,
        );
        drawCurrentPass(6, batch.count);
      } else if (batch.type === "image") {
        // Per-draw texture (Slice P5a): created + uploaded fresh per draw,
        // destroyed at frame end (bind-group churn is fine at sandom's
        // command counts; this avoids ever needing a persistent GPU-side
        // image cache keyed by imageIndex).
        //
        // Native-precision upload (wide-color plan, package 4 step 1): the
        // registered entry carries the decoder's own ImageDescriptor. Its
        // samples upload untouched into a source texture matching their
        // sample type; the source-to-working conversion pass then writes
        // mip level 0 of the image texture in the selected render
        // precision, converting into the mode's working encoding and
        // premultiplying in float. The eight-bit speed precision clamps
        // extended components at texture write, as the plan specifies.
        const clip = batch.clipState;
        const { width: imgW, height: imgH } = batch.image;
        let sourceTexture;
        let sampleKind;
        let uniformData;
        if (batch.image.kind === "gpu-texture") {
          sourceTexture = batch.image.texture;
          sampleKind = "float";
          uniformData = imageConversionUniformFor(batch.image.descriptor);
        } else {
          const conversion = imageConversionFor(batch.image);
          sampleKind = conversion.upload.sampleKind;
          uniformData = conversion.uniformData;
          sourceTexture = device.createTexture({
            size: { width: imgW, height: imgH },
            format: conversion.upload.format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          device.queue.writeTexture(
            { texture: sourceTexture },
            conversion.upload.data,
            { bytesPerRow: conversion.upload.bytesPerRow },
            { width: imgW, height: imgH },
          );
          texturesToDestroy.push(sourceTexture);
        }
        const mipLevelCount = 1 +
          Math.floor(Math.log2(Math.max(imgW, imgH)));

        const imageTexture = device.createTexture({
          size: { width: imgW, height: imgH },
          format: colorFormat,
          mipLevelCount,
          usage: GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
        texturesToDestroy.push(imageTexture);

        const conversionUniformBuffer = device.createBuffer({
          size: uniformData.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(conversionUniformBuffer, 0, uniformData);
        const conversionPipeline = getSourceConvertPipeline(sampleKind);
        const conversionBindGroup = device.createBindGroup({
          layout: conversionPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sourceTexture.createView() },
            { binding: 1, resource: { buffer: conversionUniformBuffer } },
          ],
        });

        // A WebGPU command encoder allows only ONE open render pass at a
        // time, and currentRenderPass (the shared rect/text/image draw pass)
        // is open across this whole batch loop — same constraint
        // pushOpacity/popOpacity already navigate below by ending and
        // reopening it. End it here, run the conversion pass and the mip
        // passes, then reopen onto the SAME currentTarget with loadOp:'load'
        // so nothing already painted this frame is lost.
        currentRenderPass.end();
        const conversionPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: imageTexture.createView({
              baseMipLevel: 0,
              mipLevelCount: 1,
            }),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        conversionPass.setPipeline(conversionPipeline);
        conversionPass.setBindGroup(0, conversionBindGroup);
        conversionPass.setVertexBuffer(0, quadBuffer);
        conversionPass.draw(6);
        conversionPass.end();

        // Populate levels 1..N by rendering a full-screen quad that bilinear-
        // samples the PREVIOUS level at half resolution (see DOWNSAMPLE_SHADER's
        // own comment: this is a 2x2 box filter per output texel, composing
        // into a true area average of the source — confirmed by direct
        // measurement against a real Chrome oracle to match Chrome's own
        // scaler, see BUG-image-downscale-quality.md). clamp-to-edge always:
        // this samples strictly WITHIN the source texture regardless of
        // whether the eventual DRAW wants repeat tiling, so it must never wrap.
        if (mipLevelCount > 1) {
          const downsampleSampler = device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
          });
          for (let level = 1; level < mipLevelCount; level++) {
            const downsampleBindGroup = device.createBindGroup({
              layout: getDownsamplePipeline().getBindGroupLayout(0),
              entries: [
                {
                  binding: 0,
                  resource: imageTexture.createView({
                    baseMipLevel: level - 1,
                    mipLevelCount: 1,
                  }),
                },
                { binding: 1, resource: downsampleSampler },
              ],
            });
            const downsamplePass = commandEncoder.beginRenderPass({
              colorAttachments: [{
                view: imageTexture.createView({
                  baseMipLevel: level,
                  mipLevelCount: 1,
                }),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: "clear",
                storeOp: "store",
              }],
            });
            downsamplePass.setPipeline(getDownsamplePipeline());
            downsamplePass.setBindGroup(0, downsampleBindGroup);
            downsamplePass.setVertexBuffer(0, quadBuffer);
            downsamplePass.draw(6);
            downsamplePass.end();
          }
        }
        currentRenderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            clearValue: clearColor,
            loadOp: "load",
            storeOp: "store",
          }],
        });

        // addressMode 'repeat' (Slice P5c): background-image tiling emits
        // UV rects that extend PAST 0..1 (uvW/uvH can be N tiles wide) and
        // relies on the sampler wrapping them, rather than the engine
        // emitting N separate tile quads. MUST be per-draw, not shared with
        // <img>/object-fit's own CMD_IMAGE draws: bilinear filtering samples
        // half a texel PAST the UV edge even for a rect that never exceeds
        // [0,1] itself, so 'repeat' blends in the texture's OPPOSITE edge
        // right at UV=0/1 seams — a real, measured regression (found by
        // image_test.js's own object-fit corner-color assertions, which
        // this project treats as load-bearing, not cosmetic: a marker
        // image's exact corner pixel bled from pure blue toward purple
        // once every CMD_IMAGE draw shared one 'repeat' sampler). Detect
        // real tiling by whether this draw's own UV rect extends past 1.0.
        const uvW = batch.instances[6], uvH = batch.instances[7];
        const needsWrap = uvW > 1 || uvH > 1;
        // The image shader selects an explicit Chrome/Skia-compatible mip LOD
        // from the less-minified principal axis. The linear sampler interpolates
        // between the two levels around that LOD; hardware anisotropy must stay
        // off because it adds major-axis taps Chrome does not use. The
        // anisotropic oracle cases in image_test.js defend this selection.
        //
        // image-rendering: pixelated (P10): nearest-neighbor of the BASE level
        // in both scale directions. lodMaxClamp 0 remains an extra invariant
        // beside the shader's explicit level, and nearest filters preserve
        // Chrome-faithful decimation.
        const sampler = batch.pixelated
          ? device.createSampler({
            magFilter: "nearest",
            minFilter: "nearest",
            mipmapFilter: "nearest",
            lodMinClamp: 0,
            lodMaxClamp: 0,
            addressModeU: needsWrap ? "repeat" : "clamp-to-edge",
            addressModeV: needsWrap ? "repeat" : "clamp-to-edge",
          })
          : device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
            addressModeU: needsWrap ? "repeat" : "clamp-to-edge",
            addressModeV: needsWrap ? "repeat" : "clamp-to-edge",
          });
        // 656 bytes — resolution + clipCount + opacity (16B) +
        // 8 × 80B ClipEntry. An earlier version of this buffer got the WGSL
        // size math wrong once already (64B vs 80B, caught by an uncaptured
        // device validation error). If this shader's struct changes again,
        // recompute the real WGSL size rather than assuming.
        const imageUniform = device.createBuffer({
          size: 656,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(
          imageUniform,
          0,
          new Float32Array([
            width,
            height,
            clip.entries.length,
            1,
            ...clipUniformFloats(clip),
          ]),
        );

        const imageBindGroup = device.createBindGroup({
          layout: getImagePipeline().getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: imageUniform } },
            { binding: 1, resource: imageTexture.createView() },
            { binding: 2, resource: sampler },
          ],
        });

        const imageByteOffset = writeInstances(batch.instances);
        currentRenderPass.setPipeline(getImagePipeline());
        currentRenderPass.setBindGroup(0, imageBindGroup);
        currentRenderPass.setVertexBuffer(0, quadBuffer);
        currentRenderPass.setVertexBuffer(
          1,
          preAllocInstanceBuffer,
          imageByteOffset,
          batch.instances.byteLength,
        );
        drawCurrentPass(6, batch.count);
      } else if (batch.type === "pushOpacity") {
        currentRenderPass.end();
        const offscreenTexture = device.createTexture({
          size: { width, height },
          format: colorFormat,
          // COPY_SRC: a blended group NESTED inside this one (Slice 8C) needs
          // to snapshot ITS previousTarget — which may be this texture — as
          // its backdrop at pop time.
          usage: GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        opacityStack.push({
          texture: offscreenTexture,
          ...batch,
          previousTarget: currentTarget,
        });
        currentTarget = offscreenTexture;
        currentRenderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
      } else if (batch.type === "popOpacity") {
        currentRenderPass.end();
        const entry = opacityStack.pop();
        currentTarget = entry.previousTarget;
        texturesToDestroy.push(entry.texture);

        // P8: apply the group's own filter-segment list, in order, BEFORE
        // the opacity/blend-mode composite below — matches Blink/Skia's
        // own architecture (the SkImageFilter chain is a separate stage
        // from the final layer's alpha/blend-mode compositing, not folded
        // together). Each segment is its own full-screen pass reading the
        // CURRENT filtered texture and writing a fresh one. Every
        // intermediate texture is freshly created per segment/pass and
        // destroyed at end of render() — never pooled/reused across draws,
        // so this is NOT the shared-buffer hazard documented at the rect
        // uniform pool above (search "THE SHARED-BUFFER HAZARD") — that
        // hazard is about UNIFORM BUFFERS reused across multiple draws
        // before submit(); a texture created fresh per segment and read
        // exactly once has no such reuse.
        entry.texture = applyFilterSegments(
          entry.texture,
          entry.filterSegments,
        );

        const sampler = device.createSampler({
          magFilter: "linear",
          minFilter: "linear",
        });
        const blendMode = entry.blendMode || BLEND_NORMAL;
        // Pooled, not the single buffer this used to be — see
        // nextCompositeUniformBuffer's header comment: two pops (sibling or
        // nested) in one render() call must never share a buffer, or the GPU
        // sees only the last writeBuffer's opacity/blendMode for every
        // composite draw in the frame (a real, previously-uncaught bug this
        // slice's nested-isolation test exposed — see design/layout-engine.md's
        // stacking-context notes).
        const compositeUniformBuffer = nextCompositeUniformBuffer();
        // P8: the filter-segment loop above already applied every matrix/
        // blur segment as its own pass — this final composite draw ONLY
        // handles opacity/blend-mode now (hasMatrix always 0), matching
        // Blink/Skia's own separation of the filter chain from final layer
        // compositing.
        // P8b: entry.clipState is the clip that was ACTIVE WHEN THIS GROUP
        // WAS PUSHED — i.e. the ancestor clip tier, NOT the element's own
        // border-radius clip (that gets applied INSIDE the offscreen
        // texture's own render pass, via an ordinary CMD_PUSH_CLIP the WAT
        // side emits right after CMD_PUSH_OPACITY — $paintContext's own
        // emission order). Clipping the FINAL composite draw to this same
        // ancestor state is therefore redundant with what the group's own
        // content already respects for an ORDINARY opacity/blend group —
        // included here anyway (not just left at 0) because it's cheap and
        // correct either way, and backdrop-filter's own composite (a
        // DIFFERENT case, added in a later step) genuinely needs the
        // element's own shape clip at this exact draw stage.
        const clipEntries = entry.clipState?.entries ?? [];
        const pathMaskUniforms = entry.pathMask
          ? pathMaskUniformFloats(entry.pathMask, svgPathAtlas)
          : new Array(24).fill(0);
        // P11: pop the accumulator the mask layer records built just before
        // this group was pushed, and multiply its coverage into the group's
        // alpha in the composite shader.
        const maskTexture = entry.hasMask ? maskStack.pop() : null;
        if (entry.hasMask && !maskTexture) {
          throw new Error(
            "render: CMD_PUSH_OPACITY carried the mask flag but no mask accumulator was pushed",
          );
        }
        device.queue.writeBuffer(
          compositeUniformBuffer,
          0,
          new Float32Array([
            width,
            height,
            entry.opacity,
            blendMode,
            0,
            clipEntries.length,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            ...pathMaskUniforms,
            maskTexture ? 1 : 0,
            0,
            0,
            0,
            ...clipUniformFloats(entry.clipState ?? EMPTY_CLIP_STATE),
          ]),
        );

        // Non-normal blend modes (Slice 8C) need the backdrop's CURRENT pixels
        // (whatever's already been painted into currentTarget within the
        // enclosing stacking context — see design/layout-engine.md's blend-mode
        // notes for why this snapshot already gives the correct CSS isolation
        // scope for free). copyTextureToTexture requires a same-size,
        // same-format, COPY_SRC-capable source — both mainTexture and every
        // offscreen group texture satisfy that. A normal-mode pop (every
        // existing opacity-only group) skips this entirely: same texture
        // (srcTex, reused as a dummy binding) and same single-texture shader
        // path as before this slice, zero extra GPU work.
        let backdropTexture = entry.texture;
        if (blendMode !== BLEND_NORMAL) {
          backdropTexture = device.createTexture({
            size: { width, height },
            format: colorFormat,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          commandEncoder.copyTextureToTexture(
            { texture: currentTarget },
            { texture: backdropTexture },
            { width, height },
          );
          texturesToDestroy.push(backdropTexture);
        }

        const compositeBindGroup = device.createBindGroup({
          layout: getCompositePipeline().getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: compositeUniformBuffer } },
            { binding: 1, resource: entry.texture.createView() },
            { binding: 2, resource: sampler },
            { binding: 3, resource: backdropTexture.createView() },
            { binding: 4, resource: pathMaskAtlasTexture.createView() },
            { binding: 5, resource: pathMaskSampler },
            {
              binding: 6,
              resource: (maskTexture ?? pathMaskAtlasTexture).createView(),
            },
          ],
        });
        const compositeInstances = new Float32Array([0, 0, width, height]);
        const compositeByteOffset = writeInstances(compositeInstances);

        currentRenderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
        currentRenderPass.setPipeline(getCompositePipeline());
        currentRenderPass.setBindGroup(0, compositeBindGroup);
        currentRenderPass.setVertexBuffer(0, quadBuffer);
        currentRenderPass.setVertexBuffer(
          1,
          preAllocInstanceBuffer,
          compositeByteOffset,
          compositeInstances.byteLength,
        );
        drawCurrentPass(6, 1);
      } else if (batch.type === "pushBackground") {
        // P13: the background stack gets its own accumulator so a blending
        // layer sees the layers below it and NOT the page behind the
        // element (css-compositing-1 §5.2). Emitted only when some layer
        // actually blends, so an ordinary background never pays for this.
        currentRenderPass.end();
        const accumulator = device.createTexture({
          size: { width, height },
          format: colorFormat,
          // COPY_SRC: popBlendLayer snapshots this as the blend backdrop.
          usage: GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        texturesToDestroy.push(accumulator);
        backgroundStack.push({
          texture: accumulator,
          previousTarget: currentTarget,
        });
        currentTarget = accumulator;
        currentRenderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
      } else if (batch.type === "popBackground") {
        currentRenderPass.end();
        const entry = backgroundStack.pop();
        if (!entry) {
          throw new Error("render: CMD_POP_BACKGROUND with no matching push");
        }
        currentTarget = entry.previousTarget;
        // Plain src-over: the blending happened INSIDE the accumulator; the
        // finished stack meets the page normally. Content is already
        // clipped (the layer loop pushed the background-clip box), so this
        // draw carries no clip of its own.
        compositeTexture(entry.texture, BLEND_NORMAL, null);
      } else if (batch.type === "pushBlendLayer") {
        currentRenderPass.end();
        const scratch = device.createTexture({
          size: { width, height },
          format: colorFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING,
        });
        texturesToDestroy.push(scratch);
        blendLayerStack.push({
          texture: scratch,
          previousTarget: currentTarget,
          blendMode: batch.blendMode,
        });
        currentTarget = scratch;
        currentRenderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
      } else if (batch.type === "popBlendLayer") {
        currentRenderPass.end();
        const layer = blendLayerStack.pop();
        if (!layer) {
          throw new Error("render: CMD_POP_BLEND_LAYER with no matching push");
        }
        currentTarget = layer.previousTarget;
        // Snapshot the accumulator as the blend backdrop, then draw the
        // layer over it — popOpacity's own non-normal-blend path, and the
        // reason this slice needed no new blend math: the composite shader
        // already carries all 16 formulas plus css-compositing-1 §3.1's
        // mix(src, blended, backdrop.a) rule.
        const backdropTexture = device.createTexture({
          size: { width, height },
          format: colorFormat,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        commandEncoder.copyTextureToTexture(
          { texture: currentTarget },
          { texture: backdropTexture },
          { width, height },
        );
        texturesToDestroy.push(backdropTexture);
        compositeTexture(layer.texture, layer.blendMode, backdropTexture);
      } else if (batch.type === "pushMask") {
        // P11: a fresh, zero-cleared canvas-sized coverage accumulator. It
        // is never the target of ordinary draws — only the MASK_COMBINE
        // pass at each popMaskLayer writes into it — so it gets its own
        // clear pass here rather than riding some other pass's loadOp.
        currentRenderPass.end();
        const accumulator = device.createTexture({
          size: { width, height },
          format: colorFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING,
        });
        texturesToDestroy.push(accumulator);
        commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: accumulator.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        }).end();
        maskStack.push(accumulator);
        currentRenderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
      } else if (batch.type === "pushMaskLayer") {
        // One layer rasterizes WHOLE into its own scratch before it can be
        // combined: subtract/intersect/exclude must change the accumulator
        // where the layer does NOT paint, which per-draw blend state on the
        // layer's own quad cannot express.
        currentRenderPass.end();
        const scratch = device.createTexture({
          size: { width, height },
          format: colorFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING,
        });
        texturesToDestroy.push(scratch);
        maskLayerStack.push({
          texture: scratch,
          previousTarget: currentTarget,
          mode: batch.mode,
          composite: batch.composite,
        });
        currentTarget = scratch;
        currentRenderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
      } else if (batch.type === "popMaskLayer") {
        currentRenderPass.end();
        const layer = maskLayerStack.pop();
        currentTarget = layer.previousTarget;
        const accumulator = maskStack[maskStack.length - 1];
        const maskUniformBuffer = nextMaskCombineUniformBuffer();
        device.queue.writeBuffer(
          maskUniformBuffer,
          0,
          new Float32Array([width, height, layer.mode, 0]),
        );
        const maskSampler = device.createSampler({
          magFilter: "linear",
          minFilter: "linear",
        });
        const pipeline = getMaskCombinePipelines()[layer.composite];
        if (!pipeline) {
          throw new Error(
            `render: unknown mask-composite operator ${layer.composite}`,
          );
        }
        const maskBindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: maskUniformBuffer } },
            { binding: 1, resource: layer.texture.createView() },
            { binding: 2, resource: maskSampler },
          ],
        });
        const maskInstances = new Float32Array([0, 0, width, height]);
        const maskByteOffset = writeInstances(maskInstances);
        const combinePass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: accumulator.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
        combinePass.setPipeline(pipeline);
        combinePass.setBindGroup(0, maskBindGroup);
        combinePass.setVertexBuffer(0, quadBuffer);
        combinePass.setVertexBuffer(
          1,
          preAllocInstanceBuffer,
          maskByteOffset,
          maskInstances.byteLength,
        );
        combinePass.draw(6, 1);
        combinePass.end();
        currentRenderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
      } else if (batch.type === "pushBackdropFilter") {
        // P8b: backdrop-filter, unlike pushOpacity/popOpacity, is a single-
        // step operation with no offscreen-target stack — it filters
        // whatever is ALREADY painted into currentTarget (the content BEHIND
        // this element, per spec) and composites the filtered result back
        // into that SAME target, clipped to this element's own shape. The
        // element's own content then continues painting into currentTarget
        // normally in the very next batches — no push/pop of currentTarget
        // itself, unlike an opacity group.
        currentRenderPass.end();

        const snapshotTexture = device.createTexture({
          size: { width, height },
          format: colorFormat,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        texturesToDestroy.push(snapshotTexture);
        commandEncoder.copyTextureToTexture(
          { texture: currentTarget },
          { texture: snapshotTexture },
          { width, height },
        );

        const filteredTexture = applyFilterSegments(
          snapshotTexture,
          batch.filterSegments,
        );

        const backdropSampler = device.createSampler({
          magFilter: "linear",
          minFilter: "linear",
        });
        const backdropUniformBuffer = nextCompositeUniformBuffer();
        // ownClipState (read directly from the command's own trailing
        // CLIP_ENTRY payload — see the parse site's own comment) is this
        // element's own border-box shape, per spec. opacity=1/blendMode=
        // normal: backdrop-filter has neither of its own — it's a pure
        // "replace what's behind me, inside my own border box, with the
        // filtered version" operation.
        const clipEntries = batch.ownClipState?.entries ?? [];
        device.queue.writeBuffer(
          backdropUniformBuffer,
          0,
          new Float32Array([
            width,
            height,
            1,
            BLEND_NORMAL,
            0,
            clipEntries.length,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            ...new Array(24).fill(0),
            0,
            0,
            0,
            0,
            ...clipUniformFloats(batch.ownClipState ?? EMPTY_CLIP_STATE),
          ]),
        );

        const backdropBindGroup = device.createBindGroup({
          layout: getCompositePipeline().getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: backdropUniformBuffer } },
            { binding: 1, resource: filteredTexture.createView() },
            { binding: 2, resource: backdropSampler },
            { binding: 3, resource: filteredTexture.createView() },
            { binding: 4, resource: pathMaskAtlasTexture.createView() },
            { binding: 5, resource: pathMaskSampler },
            { binding: 6, resource: pathMaskAtlasTexture.createView() },
          ],
        });
        const backdropInstances = new Float32Array([0, 0, width, height]);
        const backdropByteOffset = writeInstances(backdropInstances);

        currentRenderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
        currentRenderPass.setPipeline(getCompositePipeline());
        currentRenderPass.setBindGroup(0, backdropBindGroup);
        currentRenderPass.setVertexBuffer(0, quadBuffer);
        currentRenderPass.setVertexBuffer(
          1,
          preAllocInstanceBuffer,
          backdropByteOffset,
          backdropInstances.byteLength,
        );
        drawCurrentPass(6, 1);
        // currentRenderPass stays open (load-mode) — the element's own
        // content (background/border/children) continues painting into this
        // SAME target in subsequent batches, same as if no backdrop-filter
        // had been emitted at all.
      }
    }

    currentRenderPass.end();

    if (readback === "none") {
      device.queue.submit([commandEncoder.finish()]);
      for (const texture of texturesToDestroy) texture.destroy();
      context.incrementFrameCount();
      return {
        backend: "webgpu",
        device,
        // Direct texture result (docs/specifications/color-and-image-data.md,
        // "Render results"): the live main texture in the selected render
        // precision, encoded in the mode's working encoding.
        textureImage: {
          texture: mainTexture,
          width,
          height,
          format: colorFormat,
          colorEncoding: workingColorEncoding(renderMode),
          alphaMode: "premultiplied",
        },
        width,
        height,
        dirtyRects: [{ x: 0, y: 0, w: width, h: height }],
      };
    }
    const bytesPerRow = Math.ceil(width * colorTexelBytes / 256) * 256;
    if (incremental) {
      const columns = Math.ceil(width / tileSize);
      const rows = Math.ceil(height / tileSize);

      // The per-tile dirty rects reported to callers (used for the overlay and
      // to tell the encoder what changed).
      const dirtyRects = [];
      // Read back contiguous dirty tile spans instead of widening every dirty
      // tile row to the full framebuffer width. Each span has its own padded
      // row stride: WebGPU requires bytesPerRow to be 256-byte aligned, but the
      // texture-copy origin and width can still follow the actual dirty region.
      const readbackRegions = [];
      for (let row = 0; row < rows; row++) {
        let firstDirtyColumn = -1;
        for (let col = 0; col <= columns; col++) {
          const isDirty = col < columns &&
            dirtyTiles[row * columns + col];
          if (isDirty) {
            const x = col * tileSize;
            const y = row * tileSize;
            dirtyRects.push({
              x,
              y,
              w: Math.min(tileSize, width - x),
              h: Math.min(tileSize, height - y),
            });
            if (firstDirtyColumn < 0) firstDirtyColumn = col;
          } else if (firstDirtyColumn >= 0) {
            const x = firstDirtyColumn * tileSize;
            const right = Math.min(col * tileSize, width);
            const regionWidth = right - x;
            readbackRegions.push({
              x,
              y: row * tileSize,
              w: regionWidth,
              h: Math.min(tileSize, height - row * tileSize),
              bytesPerRow: Math.ceil(regionWidth * colorTexelBytes / 256) * 256,
            });
            firstDirtyColumn = -1;
          }
        }
      }

      // A synchronous incremental render merges dirty regions into the
      // context-owned complete frame. Deferred renders still need independent
      // full snapshots because several GPU frames can be in flight at once.
      const { buffer: readbackBuffer, pixels: slotPixels } = nextReadbackSlot();
      if (!deferReadback) {
        let bufferOffset = 0;
        for (const region of readbackRegions) {
          commandEncoder.copyTextureToBuffer(
            { texture: mainTexture, origin: { x: region.x, y: region.y } },
            {
              buffer: readbackBuffer,
              offset: bufferOffset,
              bytesPerRow: region.bytesPerRow,
            },
            { width: region.w, height: region.h },
          );
          bufferOffset += region.bytesPerRow * region.h;
        }
        device.queue.submit([commandEncoder.finish()]);
        for (const texture of texturesToDestroy) texture.destroy();
        context.incrementFrameCount();
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const rawData = new Uint8Array(readbackBuffer.getMappedRange());
        bufferOffset = 0;
        for (const region of readbackRegions) {
          for (let row = 0; row < region.h; row++) {
            copyReadbackRow(
              rawData,
              bufferOffset + row * region.bytesPerRow,
              persistentPixels,
              ((region.y + row) * width + region.x) * 4,
              region.w,
              colorTexelBytes,
            );
          }
          bufferOffset += region.bytesPerRow * region.h;
        }
        readbackBuffer.unmap();
        return workingRenderResult(
          persistentPixels,
          width,
          height,
          renderMode,
          {
            dirtyRects,
            readbackByteLength: bufferOffset,
          },
        );
      }
      commandEncoder.copyTextureToBuffer(
        { texture: mainTexture },
        { buffer: readbackBuffer, bytesPerRow },
        { width, height },
      );
      device.queue.submit([commandEncoder.finish()]);
      for (const tex of texturesToDestroy) tex.destroy();
      context.incrementFrameCount();

      // Two-step: collect() does the poll-bound mapAsync wait (overlap many across
      // frames); finish() copies the snapshot into this slot's OWN cpu buffer and
      // returns it, so deliveries never share or overwrite each other's pixels.
      const collect = async () => {
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const finish = () => {
          const rawData = new Uint8Array(readbackBuffer.getMappedRange());
          for (let y = 0; y < height; y++) {
            copyReadbackRow(
              rawData,
              y * bytesPerRow,
              slotPixels,
              y * width * 4,
              width,
              colorTexelBytes,
            );
          }
          persistentPixels.set(slotPixels);
          readbackBuffer.unmap();
          return workingRenderResult(slotPixels, width, height, renderMode, {
            dirtyRects,
            readbackByteLength: bytesPerRow * height,
          });
        };
        return { finish };
      };
      if (!deferReadback) return (await collect()).finish();
      return { deferred: true, collect };
    } else {
      const { buffer: readbackBuffer, pixels: slotPixels } = nextReadbackSlot();
      commandEncoder.copyTextureToBuffer(
        { texture: mainTexture },
        { buffer: readbackBuffer, bytesPerRow },
        { width, height },
      );
      device.queue.submit([commandEncoder.finish()]);
      for (const tex of texturesToDestroy) tex.destroy();
      context.incrementFrameCount();

      const collect = async () => {
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const finish = () => {
          const rawData = new Uint8Array(readbackBuffer.getMappedRange());
          for (let y = 0; y < height; y++) {
            copyReadbackRow(
              rawData,
              y * bytesPerRow,
              slotPixels,
              y * width * 4,
              width,
              colorTexelBytes,
            );
          }
          persistentPixels.set(slotPixels);
          readbackBuffer.unmap();
          return workingRenderResult(slotPixels, width, height, renderMode, {
            dirtyRects: [{ x: 0, y: 0, w: width, h: height }],
            readbackByteLength: bytesPerRow * height,
          });
        };
        return { finish };
      };
      if (!deferReadback) return (await collect()).finish();
      return { deferred: true, collect };
    }
  } finally {
    for (const lease of canvasImageLeases) lease.release();
  }
}
