// Rasterizer — reads binary command buffer, issues WebGPU draw calls,
// produces raw RGBA pixels.
//
// Handles: rect (with borders, rounded corners), push/pop clip,
// push/pop opacity (offscreen compositing).

import {
  BLEND_NORMAL,
  CMD_BOX_SHADOW,
  CMD_DAMAGE,
  CMD_IMAGE,
  CMD_POP_BACKDROP_FILTER,
  CMD_POP_BACKGROUND,
  CMD_POP_BLEND_LAYER,
  CMD_POP_CLIP,
  CMD_POP_MASK_LAYER,
  CMD_POP_OPACITY,
  CMD_PUSH_BACKDROP_FILTER,
  CMD_PUSH_BACKGROUND,
  CMD_PUSH_BLEND_LAYER,
  CMD_PUSH_CLIP,
  CMD_PUSH_MASK,
  CMD_PUSH_MASK_LAYER,
  CMD_PUSH_OPACITY,
  CMD_RECT,
  CMD_SET_NODE,
  CMD_SET_SCROLL,
  CMD_SVG_PATH,
  CMD_TEXT,
  RASTER_PLAN_PASS_BOX_BLUR_H,
  RASTER_PLAN_PASS_BOX_BLUR_V,
  RASTER_PLAN_PASS_DROP_SHADOW,
  RASTER_PLAN_PASS_MATRIX,
} from "./wasm/layout.js";
import {
  clipUniformFloats,
  createRasterPlanCursor,
  dirtyTileRectangles,
  EMPTY_CLIP_STATE,
  filterPassReaches,
  filterRegionPadding,
  GRADIENT_RECORD_STRIDE,
  GRADIENT_STOP_STRIDE,
  MAX_SHADER_CLIP_ENTRIES,
  openRasterPlan,
  prepareRetainedRasterPlan,
} from "./raster-plan.js";
import {
  createRenderContextWebgl2,
  createWebgl2ColorGlyphCachePage,
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
import { composeShader } from "./shaders/compose.js";

// The gradient record of a solid SVG path fill: kind 0, no stops read.
const ZERO_GRADIENT_RECORD = new Uint8Array(GRADIENT_RECORD_STRIDE);

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

// Reads a direct texture result (`readback: "none"`, the frame a presenter
// receives) back into the same working ImageDescriptor a float32 readback
// produces. The texture is left intact; the caller owns its lifetime.
export async function readbackTextureImage(device, textureImage) {
  const { texture, width, height, format } = textureImage;
  const texelBytes = format === "rgba16float" ? 8 : 4;
  const bytesPerRow = Math.ceil(width * texelBytes / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buffer.mapAsync(GPUMapMode.READ);
  const rawData = new Uint8Array(buffer.getMappedRange());
  const pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    copyReadbackRow(rawData, y * bytesPerRow, pixels, y * width * 4, width, texelBytes);
  }
  buffer.unmap();
  buffer.destroy();
  const renderMode = textureImage.colorEncoding === WORKING_COLOR_ENCODING
    ? "high-dynamic-range"
    : "standard";
  return workingRenderResult(pixels, width, height, renderMode, {
    dirtyRects: [{ x: 0, y: 0, w: width, h: height }],
    readbackByteLength: bytesPerRow * height,
  });
}

// One decoded clip entry as the shaders see it:
//   rect:   local-space minX, minY, maxX, maxY
//   radiiX/radiiY: per-corner elliptical radii, CSS corner order in
//           x/y/z/w = topLeft, topRight, bottomRight, bottomLeft
//   invA:   inverse affine (screen -> local) a, b, c, d
//   invB:   inverse affine e, f; z = mode (0 skip, 1 hard axis-aligned,
//           2 SDF, 3 area axis-aligned — an SVG viewport); w = axis-enable
//           bits for the axis-aligned modes (1 X, 2 Y, 3 both)

// --- Gradient interpolation-space color conversion (wide-color plan,
// package 4). The raster plan prepares stops in the author-selected
// interpolation space, resolves missing components, and fixes hue arcs. The
// shader lerps them premultiplied (hue channel excluded, css-color-4 section
// 12.3) and converts the interpolated result into the rendering mode's working
// encoding: extended sign-mirrored
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
const shaderConstants = {
  MAX_SHADER_CLIP_ENTRIES,
  GRAD_SRGB_TO_XYZ: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.srgbToXyz],
  ),
  GRAD_XYZ_TO_SRGB: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.xyzToSrgb],
  ),
  GRAD_XYZ_TO_REC2020: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.xyzToRec2020],
  ),
  GRAD_ADAPT_D50_TO_D65: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.adaptD50ToD65],
  ),
  GRAD_OKLAB_LAB_TO_LMS: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.oklabLabToLms],
  ),
  GRAD_OKLAB_LMS_TO_XYZ: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.oklabLmsToXyzD65],
  ),
  GRAD_D50_WHITE: XYZ_WHITE_D50.join(", "),
  GRAD_LAB_EPSILON: 216 / 24389,
  GRAD_LAB_KAPPA: 24389 / 27,
};
const RECT_SHADER = composeShader("rect", shaderConstants);
const TILE_CLEAR_SHADER = composeShader("tile-clear", shaderConstants);
const COMPOSITE_SHADER = composeShader("composite", shaderConstants);
const MASK_COMBINE_SHADER = composeShader("mask-combine", shaderConstants);
const BOX_BLUR_SHADER = composeShader("box-blur", shaderConstants);
const DROP_SHADOW_SHADER = composeShader("drop-shadow", shaderConstants);
const FILTER_WINDOW_SHADER = composeShader("filter-window", shaderConstants);
const TEXT_SHADER = composeShader("text", shaderConstants);
const SVG_PATH_SHADER = composeShader("svg-path", shaderConstants);
const IMAGE_SHADER = composeShader("image", shaderConstants);
const BOX_SHADOW_SHADER = composeShader("box-shadow", shaderConstants);
const DOWNSAMPLE_SHADER = composeShader("downsample", shaderConstants);



// Blend-mode enum values — MUST match layout.js's BLEND_* constants
// (Slice 8C). Baked as WGSL consts (not read from the uniform buffer as an
// enum-vs-magic-number pair) purely for readability in the fragment shader
// below.

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
// Every filter pass reads and writes ASSOCIATED (premultiplied) color, the
// encoding of the group texture the chain starts from: box-averaging
// associated color weights each texel by its alpha, so a transparent
// texel contributes exactly zero. Only the color-matrix pass and the final
// composite convert to straight color, and back.

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

// The Rust host receives straight-alpha eight-bit image resources directly.
// Convert them to the renderer's premultiplied float working texture before
// mip generation. The JavaScript host uses sourceConvertShader for the same
// boundary because it also supports additional source formats and color spaces.

// Mip-chain generation (BUG-image-downscale-quality, resolved; see
// activity/reports/REPORT-2026-10-09-resolved-bug-records.md and
// design/paint-coverage.md): WebGPU has no built-in generateMipmap (unlike
// WebGL), so each level is produced by rendering a full-screen quad that
// bilinear-samples the PREVIOUS level at its own half-resolution grid — for
// a standard halving mip chain this is mathematically a 2x2 box filter over
// the previous level, which composes into a true area average of the
// full-resolution source. No instancing, no clip test: this only ever runs
// once per mip level per image texture, straight-line, not part of the
// per-draw batch path the other shaders serve.

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
  const isUnsignedInteger = sourceKind === "uint";
  return composeShader("source-convert", {
    SOURCE_TEXTURE_TYPE: isUnsignedInteger
      ? "texture_2d<u32>"
      : "texture_2d<f32>",
    SOURCE_FETCH: isUnsignedInteger
      ? "vec4f(textureLoad(srcTex, texel, 0)) * uniforms.alphaParams.y"
      : "textureLoad(srcTex, texel, 0)",
  });
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

// A page of the color glyph cache (src/color-glyph-cache.js) for render
// contexts of `context`'s backend, color format and device: a texture the
// entries that a render with readback "none" left in a source context's
// main target are copied into, sampled texel for texel.
export function createColorGlyphCachePage(context, width, height) {
  if (context.kind === "webgl2") {
    return createWebgl2ColorGlyphCachePage(context, width, height);
  }
  const { device, colorFormat } = context;
  const texture = device.createTexture({
    size: { width, height },
    format: colorFormat,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  return {
    texture,
    width,
    height,
    copyFrom(sourceContext, rects) {
      const encoder = device.createCommandEncoder();
      for (const rect of rects) {
        encoder.copyTextureToTexture(
          { texture: sourceContext.mainTexture, origin: { x: rect.x, y: rect.y } },
          { texture, origin: { x: rect.x, y: rect.y } },
          { width: rect.width, height: rect.height },
        );
      }
      device.queue.submit([encoder.finish()]);
    },
    destroy() {
      texture.destroy();
    },
  };
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
    // [other images, color glyph cache pages]: IMAGE_SHADER's
    // GROUP_STRAIGHT_COLOR override.
    const imagePipelines = [null, null];
    return {
      quadBuffer,
      textPipeline,
      getImagePipeline(groupStraightColor = false) {
        return imagePipelines[groupStraightColor ? 1 : 0] ??= device.createRenderPipeline({
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
            constants: { GROUP_STRAIGHT_COLOR: groupStraightColor ? 1 : 0 },
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
          // borderStyles(1, the packed nibble u16 as a float, plus bit 16
          // for CMD_RECT_FLAG_AREA_COVERAGE).
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
  // associated RGBA result (outputPremultiplied = 1) directly into a fresh
  // cleared-transparent texture: the next filter pass and the FINAL
  // composite draw read associated color, and only the final draw blends;
  // and for a group pop with a Porter-Duff operator, whose shader result
  // already holds the backdrop.
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
  // buffer, no instance data" shape — the shader's own associated-color
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

  // Filter-window pipeline (see FILTER_WINDOW_SHADER and
  // applyFilterPasses): the same full-screen overwrite shape, padding a
  // group texture into its filter region and cropping the result back.
  const filterWindowShader = await makeShader(
    "filterWindow",
    FILTER_WINDOW_SHADER,
  );
  let filterWindowPipeline = null;
  function getFilterWindowPipeline() {
    return filterWindowPipeline ??= device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: filterWindowShader,
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
        module: filterWindowShader,
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
    getFilterWindowPipeline,
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

  // Instance buffer: every draw of a frame reads its instances from one
  // upload of the raster plan's payload prefix (see renderFrame). Starts at
  // 4096 instances × 44 floats × 4 bytes = 704 KB and grows on demand.
  const MAX_INSTANCES = 4096;
  const INSTANCE_FLOATS = 44;
  let instanceCapacityBytes = MAX_INSTANCES * INSTANCE_FLOATS * 4;
  let instanceBuffer = device.createBuffer({
    size: instanceCapacityBytes,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  // The single instance every full-target composite, filter, mask and
  // backdrop draw reads: the target rectangle, written once.
  const fullTargetInstanceBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    fullTargetInstanceBuffer,
    0,
    new Float32Array([0, 0, width, height]),
  );
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
  // readback contract returns working float32 descriptors). Allocated on the
  // first pixel readback; texture-only rendering never touches it.
  let persistentPixels = null;
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
  // The ring is allocated on the first pixel readback, so texture-only
  // rendering never creates readback buffers.
  const readbackRing = [];
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
  // Converted image textures (working encoding, render precision, full mip
  // chain) by registered image entry, as the last frame that drew each
  // left them: renderFrame's imageTextureFor converts an image once while
  // it stays in view.
  const retainedImageTextures = new Map();
  // Image samplers by filtering and wrapping; see renderFrame's CMD_IMAGE.
  const imageSamplers = new Map();
  function imageSamplerFor(pixelated, wrap) {
    const key = (pixelated ? 2 : 0) + (wrap ? 1 : 0);
    let sampler = imageSamplers.get(key);
    if (sampler === undefined) {
      const addressMode = wrap ? "repeat" : "clamp-to-edge";
      sampler = pixelated
        ? device.createSampler({
          magFilter: "nearest",
          minFilter: "nearest",
          mipmapFilter: "nearest",
          lodMinClamp: 0,
          lodMaxClamp: 0,
          addressModeU: addressMode,
          addressModeV: addressMode,
        })
        : device.createSampler({
          magFilter: "linear",
          minFilter: "linear",
          mipmapFilter: "linear",
          addressModeU: addressMode,
          addressModeV: addressMode,
        });
      imageSamplers.set(key, sampler);
    }
    return sampler;
  }
  // Scratch textures (opacity groups, filter passes, backdrop copies,
  // background, blend and mask layers), full-target unless a filter region
  // asks for a padded size, kept across frames by usage and size. A frame
  // takes a distinct texture for each use with
  // takeScratchTexture and gives them all back with returnScratchTextures
  // once it is submitted; later frames take the same textures again, which
  // the queue's submission order keeps apart. Every taker clears or copies
  // over the whole texture before it reads it.
  //
  // A texture created for one frame is costly twice over. Its first pass
  // waits about half a millisecond on the GPU (M4, 2200x1600 rgba16float)
  // before it draws, so eight fresh group textures drawn back to back add
  // four milliseconds to the frame. And destroy() frees nothing until the
  // device is polled or the garbage collector drops the texture's views:
  // Deno polls only while a GPU promise is awaited, which a window's frame
  // loop never does, so each frame left 215 MB behind. A texture no frame
  // has taken for SCRATCH_TEXTURE_IDLE_FRAMES frames is destroyed.
  const SCRATCH_TEXTURE_IDLE_FRAMES = 60;
  const scratchTexturePools = new Map();
  function takeScratchTexture(
    usage,
    textureWidth = width,
    textureHeight = height,
  ) {
    // Full-target pools keep the bare usage as their key.
    const key = textureWidth === width && textureHeight === height
      ? usage
      : `${usage}:${textureWidth}x${textureHeight}`;
    return takePooledTexture(key, {
      size: { width: textureWidth, height: textureHeight },
      format: colorFormat,
      usage,
    });
  }
  // A texture of `descriptor` from the pool `key`, kept across frames on
  // the scratch textures' terms: distinct within a frame, given back after
  // submission, destroyed after SCRATCH_TEXTURE_IDLE_FRAMES idle frames.
  function takePooledTexture(key, descriptor) {
    let pool = scratchTexturePools.get(key);
    if (pool === undefined) {
      pool = { textures: [], lastTakenFrames: [], taken: 0 };
      scratchTexturePools.set(key, pool);
    }
    if (pool.taken === pool.textures.length) {
      pool.textures.push(device.createTexture(descriptor));
      pool.lastTakenFrames.push(frameCount);
    }
    // Textures are taken in order, so the least recently taken ones are
    // the last of the pool.
    pool.lastTakenFrames[pool.taken] = frameCount;
    return pool.textures[pool.taken++];
  }
  // A frame's small uniform buffers (image conversions, blur and drop-shadow
  // passes), pooled by byte size and given back with the scratch textures.
  const frameUniformPools = new Map();
  function takeFrameUniformBuffer(size) {
    let pool = frameUniformPools.get(size);
    if (pool === undefined) {
      pool = { buffers: [], taken: 0 };
      frameUniformPools.set(size, pool);
    }
    if (pool.taken === pool.buffers.length) {
      pool.buffers.push(device.createBuffer({
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }));
    }
    return pool.buffers[pool.taken++];
  }
  function returnScratchTextures() {
    for (const pool of frameUniformPools.values()) pool.taken = 0;
    for (const [key, pool] of scratchTexturePools) {
      pool.taken = 0;
      while (
        pool.textures.length > 0 &&
        frameCount - pool.lastTakenFrames.at(-1) > SCRATCH_TEXTURE_IDLE_FRAMES
      ) {
        pool.textures.pop().destroy();
        pool.lastTakenFrames.pop();
      }
      if (pool.textures.length === 0) scratchTexturePools.delete(key);
    }
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
  // clipCount + dilateLight/dilateDark + 12B pad (the ClipEntry needs
  // 16-byte alignment, so the 20-byte prefix pads to 32), then
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
  // Every linear, clamped sampler the context binds: text atlases, path
  // masks, filter and composite sources, SVG path atlases.
  const linearSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  // A pooled uniform buffer keeps its contents across frames: a scroll
  // frame asks most slots for what they already hold, and a queue write is
  // one encoded copy at submit. Every write to a pooled uniform buffer goes
  // through writeUniform, so the remembered contents are the buffer's.
  const uniformContents = new WeakMap();
  function writeUniform(buffer, data) {
    const held = uniformContents.get(buffer);
    if (held !== undefined && held.length === data.length) {
      let index = 0;
      while (index < data.length && Object.is(held[index], data[index])) index++;
      if (index === data.length) return;
    }
    device.queue.writeBuffer(buffer, 0, data);
    uniformContents.set(buffer, data);
  }
  // A text bind group is a function of its pooled uniform buffer and the
  // atlas texture, both of which outlive frames.
  const textBindGroups = new WeakMap();
  function textBindGroupFor(uniformBuffer, atlasTexture) {
    let byTexture = textBindGroups.get(uniformBuffer);
    if (byTexture === undefined) {
      byTexture = new WeakMap();
      textBindGroups.set(uniformBuffer, byTexture);
    }
    let bindGroup = byTexture.get(atlasTexture);
    if (bindGroup === undefined) {
      bindGroup = device.createBindGroup({
        layout: shared.textPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: atlasTexture.createView() },
          { binding: 2, resource: linearSampler },
        ],
      });
      byTexture.set(atlasTexture, bindGroup);
    }
    return bindGroup;
  }
  // A box-shadow bind group is a function of its pooled uniform buffer.
  const boxShadowBindGroups = new WeakMap();
  function boxShadowBindGroupFor(uniformBuffer) {
    let bindGroup = boxShadowBindGroups.get(uniformBuffer);
    if (bindGroup === undefined) {
      bindGroup = device.createBindGroup({
        layout: shared.getBoxShadowPipeline().getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });
      boxShadowBindGroups.set(uniformBuffer, bindGroup);
    }
    return bindGroup;
  }
  // SVG path draws (plans/PLAN-color-glyphs.md slice 3: a page of color
  // glyphs is hundreds of them a frame): one pooled slot per draw of the
  // frame, same discipline as the text pool, holding the 656-byte uniform
  // (resolution, clipCount, pad, 8 × 80B ClipEntry) and the gradient
  // record and stop buffers. A slot's bind group is a function of its
  // buffers and the atlas texture; a stop buffer that grows drops them.
  const svgPathSlotPool = [];
  let svgPathSlotPoolIndex = 0;
  function nextSvgPathSlot() {
    if (svgPathSlotPoolIndex >= svgPathSlotPool.length) {
      svgPathSlotPool.push({
        uniform: device.createBuffer({
          size: 656,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        gradientRecord: device.createBuffer({
          size: GRADIENT_RECORD_STRIDE,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
        gradientStops: device.createBuffer({
          size: GRADIENT_STOP_STRIDE,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
        gradientStopCapacity: GRADIENT_STOP_STRIDE,
        bindGroups: new WeakMap(),
      });
    }
    return svgPathSlotPool[svgPathSlotPoolIndex++];
  }
  function svgPathBindGroupFor(slot, atlasTexture) {
    let bindGroup = slot.bindGroups.get(atlasTexture);
    if (bindGroup === undefined) {
      bindGroup = device.createBindGroup({
        layout: shared.getSvgPathPipeline().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: slot.uniform } },
          { binding: 1, resource: atlasTexture.createView() },
          { binding: 3, resource: { buffer: slot.gradientRecord } },
          { binding: 4, resource: { buffer: slot.gradientStops } },
        ],
      });
      slot.bindGroups.set(atlasTexture, bindGroup);
    }
    return bindGroup;
  }
  // Image draws: a pooled 656-byte uniform per draw; the bind group is a
  // function of the uniform, the image texture and the sampler.
  const imageUniformPool = [];
  let imageUniformPoolIndex = 0;
  function nextImageUniformBuffer() {
    if (imageUniformPoolIndex >= imageUniformPool.length) {
      imageUniformPool.push(device.createBuffer({
        size: 656,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }));
    }
    return imageUniformPool[imageUniformPoolIndex++];
  }
  const imageBindGroups = new WeakMap();
  // A texture is drawn by one pipeline only (a cache page by the group
  // straight-color variant), so the texture key also keys the variant.
  function imageBindGroupFor(uniformBuffer, imageTexture, sampler, groupStraightColor) {
    let byTexture = imageBindGroups.get(uniformBuffer);
    if (byTexture === undefined) {
      byTexture = new WeakMap();
      imageBindGroups.set(uniformBuffer, byTexture);
    }
    let bySampler = byTexture.get(imageTexture);
    if (bySampler === undefined) {
      bySampler = new Map();
      byTexture.set(imageTexture, bySampler);
    }
    let bindGroup = bySampler.get(sampler);
    if (bindGroup === undefined) {
      bindGroup = device.createBindGroup({
        layout: shared.getImagePipeline(groupStraightColor).getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: imageTexture.createView() },
          { binding: 2, resource: sampler },
        ],
      });
      bySampler.set(sampler, bindGroup);
    }
    return bindGroup;
  }

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
    getFilterWindowPipeline: shared.getFilterWindowPipeline,
    getMaskCombinePipelines: shared.getMaskCombinePipelines,
    // The instance buffer, grown to hold `requiredBytes`. The buffer it
    // replaces is destroyed once the work already submitted completes.
    instanceBufferFor(requiredBytes) {
      if (requiredBytes > instanceCapacityBytes) {
        let nextCapacity = instanceCapacityBytes;
        while (nextCapacity < requiredBytes) nextCapacity *= 2;
        const previous = instanceBuffer;
        instanceBuffer = device.createBuffer({
          size: nextCapacity,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        instanceCapacityBytes = nextCapacity;
        void device.queue.onSubmittedWorkDone().then(() => {
          previous.destroy();
        });
      }
      return instanceBuffer;
    },
    fullTargetInstanceBuffer,
    uniformPool,
    imageConversionFor,
    imageConversionUniformFor,
    retainedImageTextures,
    imageSamplerFor,
    takeScratchTexture,
    takePooledTexture,
    takeFrameUniformBuffer,
    returnScratchTextures,
    MAX_INSTANCES,
    width,
    height,
    get persistentPixels() {
      if (persistentPixels === null) {
        persistentPixels = new Float32Array(width * height * 4);
      }
      return persistentPixels;
    },
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
      if (readbackRing.length === 0) {
        for (let i = 0; i < READBACK_RING_SIZE; i++) {
          readbackRing.push({
            buffer: device.createBuffer({
              size: readbackBytesPerRow * height,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            }),
            pixels: new Float32Array(width * height * 4),
          });
        }
      }
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
    resetSvgPathAndImagePools() {
      svgPathSlotPoolIndex = 0;
      imageUniformPoolIndex = 0;
    },
    nextSvgPathSlot,
    svgPathBindGroupFor,
    nextImageUniformBuffer,
    imageBindGroupFor,
    linearSampler,
    writeUniform,
    textBindGroupFor,
    boxShadowBindGroupFor,
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
      fullTargetInstanceBuffer.destroy();
      tileClearInstanceBuffer?.destroy();
      for (const slot of uniformPool) {
        slot.buffer.destroy();
        slot.gradientRecordBuffer.destroy();
        slot.gradientStopBuffer.destroy();
      }
      for (const buffer of compositeUniformPool) buffer.destroy();
      for (const buffer of boxShadowUniformPool) buffer.destroy();
      for (const buffer of textUniformPool) buffer.destroy();
      for (const slot of svgPathSlotPool) {
        slot.uniform.destroy();
        slot.gradientRecord.destroy();
        slot.gradientStops.destroy();
      }
      for (const buffer of imageUniformPool) buffer.destroy();
      for (const buffer of maskCombineUniformPool) buffer.destroy();
      for (const slot of readbackRing) slot.buffer.destroy();
      for (const texture of retainedImageTextures.values()) texture.destroy();
      retainedImageTextures.clear();
      for (const pool of scratchTexturePools.values()) {
        for (const texture of pool.textures) texture.destroy();
      }
      scratchTexturePools.clear();
      shared.liveContextCount--;
    },
  };
}

const retainedRasterFrames = new WeakMap();
const rasterFrameTokens = new WeakMap();

// Keep the publication only after a successful frame. In particular a foreign
// render or a rejected GPU/readback operation must never leave a reusable frame.
export async function render(context, options = {}) {
  if (
    options.rasterPlan?.memory instanceof WebAssembly.Memory !== true ||
    !Number.isInteger(options.rasterPlan.plan) ||
    options.rasterPlan.plan <= 0 ||
    options.rasterPlan.exports == null
  ) {
    throw new TypeError(
      "render: options.rasterPlan with memory, positive plan handle, and exports is required",
    );
  }
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
    rasterPlan: options.rasterPlan?.memory instanceof WebAssembly.Memory
      ? openRasterPlan(options.rasterPlan.memory, options.rasterPlan.plan)
      : options.rasterPlan ?? null,
    rasterPlanDescriptor: options.rasterPlan,
    renderMode: context.renderMode ?? "standard",
    // WebGPU's renderFrame scissors every draw to the dirty tiles; WebGL 2
    // needs the plan's damage selection for that.
    damageSelection: context.kind === "webgl2",
  };
  const frame = prepareRetainedRasterPlan(
    previous,
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
    frame.release();
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
    frame.statistics.replayedBatches = frame.state.planReader.count;
    frame.statistics.replayedInstances = frame.state.planReader.recordTotals(
      () => false,
    ).instances;
  }
  let result;
  try {
    result = await renderFrame(context, {
      ...options,
      dirtyTiles: paintTiles,
      planReader: unchanged || fullReadback
        ? frame.state.planReader
        : frame.planReader,
    });
  } catch (error) {
    frame.release();
    throw error;
  }
  if (!result.deferred) return finish(result);
  return {
    deferred: true,
    collect: async () => {
      try {
        const collected = await result.collect();
        return { finish: () => finish(collected.finish()) };
      } catch (error) {
        frame.release();
        throw error;
      }
    },
  };
}

// Interpret a native raster plan and issue backend draw calls.
async function renderFrame(context, options = {}) {
  // WebGL 2 cannot sample a WebGPU texture. Materialize each live canvas
  // source through its bounded readback path before interpreting the plan.
  if (context.kind === "webgl2") {
    const resolvedImages = options.images ? new Map(options.images) : null;
    if (resolvedImages) {
      for (const [imageIndex, entry] of resolvedImages) {
        if (entry?.kind !== "canvas") continue;
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
    return renderWebgl2(context, {
      ...options,
      images: resolvedImages,
    });
  }
  const {
    background = { r: 0, g: 0, b: 0, a: 0 },
    atlases = null,
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
    dirtyTiles = null,
    tileSize = 64,
    deferReadback = false,
    // Readback contract (wide-color plan, package 5): "float32" returns a
    // working ImageDescriptor; "none" returns a direct textureImage. The
    // pre-cutover boolean contract is rejected loudly below.
    readback = "float32",
    // Optional glyph thickening (design/text-rendering.md, "Platform font
    // smoothing"): each glyph edge moves outward by
    // mix(darkInk, lightInk, textLuma) device pixels, like macOS browser
    // font smoothing. The default draws the exact outline.
    textThickening = { darkInk: 0, lightInk: 0 },
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
    getFilterWindowPipeline,
    getMaskCombinePipelines,
    imageConversionFor,
    imageConversionUniformFor,
    retainedImageTextures,
    imageSamplerFor,
    takeScratchTexture,
    takePooledTexture,
    takeFrameUniformBuffer,
    returnScratchTextures,
    renderMode,
    instanceBufferFor,
    fullTargetInstanceBuffer,
    tileClearPipeline,
    colorFormat,
    colorTexelBytes,
    nextReadbackSlot,
    MAX_INSTANCES,
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
    resetSvgPathAndImagePools,
    nextSvgPathSlot,
    svgPathBindGroupFor,
    nextImageUniformBuffer,
    imageBindGroupFor,
    linearSampler,
    writeUniform,
    textBindGroupFor,
    boxShadowBindGroupFor,
    width,
    height,
  } = context;

  const incremental = dirtyTiles !== null;
  // The caller's clear color bypasses plan preparation, so the plan's native
  // color export converts this one host-authored value.
  let clearColor = background;
  if (renderMode === "high-dynamic-range") {
    const rasterExports = options.rasterPlan?.exports;
    if (rasterExports == null) {
      throw new TypeError(
        "renderFrame: options.rasterPlan.exports is required for HDR clear-color conversion",
      );
    }
    const colorPointer = rasterExports.abi_malloc(32);
    if (colorPointer === 0) {
      throw new Error("raster_convert_color4 could not allocate 32 bytes");
    }
    try {
      const colors = new Float32Array(
        rasterExports.memory.buffer,
        colorPointer,
        8,
      );
      colors.set([background.r, background.g, background.b, background.a]);
      rasterExports.raster_convert_color4(colorPointer, colorPointer + 16);
      clearColor = {
        r: colors[4],
        g: colors[5],
        b: colors[6],
        a: colors[7],
      };
    } finally {
      rasterExports.abi_free(colorPointer);
    }
  }
  const commandEncoder = device.createCommandEncoder();
  // An opacity group whose composite reads nothing under it (normal blend,
  // no backdrop copy, no mask) is drawn on a second encoder, whose command
  // buffer the queue runs first, while the pass it interrupts stays open:
  // the group's content, nested groups and filters need nothing that pass
  // draws, and its composite becomes one more draw in that pass. Ending
  // the pass instead stores the whole target and loads it again, a round
  // trip that costs far more than a small group's own draws. `encoder`
  // records the current pass sequence.
  let detachedEncoder = null;
  let encoder = commandEncoder;
  // Image conversions (see imageTextureFor) read nothing the frame draws;
  // their encoder runs before both.
  let resourceEncoder = null;
  // The image textures this frame draws, by registered image entry; they
  // replace the context's retained ones when the frame is submitted.
  const frameImageTextures = new Map();
  let submitted = false;
  const submitFrame = () => {
    const commandBuffers = [commandEncoder.finish()];
    if (detachedEncoder !== null) commandBuffers.unshift(detachedEncoder.finish());
    if (resourceEncoder !== null) commandBuffers.unshift(resourceEncoder.finish());
    device.queue.submit(commandBuffers);
    submitted = true;
    for (const [image, texture] of retainedImageTextures) {
      if (frameImageTextures.get(image) !== texture) texture.destroy();
    }
    retainedImageTextures.clear();
    for (const [image, texture] of frameImageTextures) {
      retainedImageTextures.set(image, texture);
    }
    context.incrementFrameCount();
    returnScratchTextures();
  };

  // The uniform pools are consumed across every draw in this frame, so
  // reset their cursors once up front. Each batch gets its own uniform
  // buffer from a pool: sharing one would let a later writeBuffer overwrite
  // an earlier batch's data before the GPU runs the submitted pass.
  resetUniformPool();
  resetCompositeUniformPool();
  resetBoxShadowUniformPool();
  resetMaskCombineUniformPool();
  resetTextUniformPool();
  resetSvgPathAndImagePools();

  // --- Incremental: clear dirty tiles ---
  const initialDamageRects = incremental
    ? dirtyTileRectangles(dirtyTiles, width, height, tileSize)
    : [];
  if (incremental) {
    const clearInstances = [];
    for (const { x, y, w, h } of initialDamageRects) {
      clearInstances.push(
        2 * x / width - 1,
        1 - 2 * y / height,
        2 * w / width,
        2 * h / height,
        clearColor.r,
        clearColor.g,
        clearColor.b,
        clearColor.a,
      );
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

  const planReader = options.planReader;
  if (planReader == null) {
    throw new TypeError("renderFrame: options.planReader is required");
  }
  const opacityStack = [];
  const backgroundStack = [];
  const blendLayerStack = [];
  const maskStack = [];
  const maskLayerStack = [];
  const canvasImageLeases = [];
  const resolvedImages = images ? new Map(images) : null;
  const unavailableCanvasImageIndices = new Set();
  const batch = createRasterPlanCursor(planReader, {
    atlases,
    svgPathAtlas,
    images: resolvedImages,
  });
  // Every draw reads its instances from one upload of the plan's payload
  // prefix, at the offset its records hold in the payload region: one
  // queue write per frame instead of one per draw.
  const instanceBuffer = instanceBufferFor(batch.uploadBytes);
  if (batch.uploadBytes > 0) {
    device.queue.writeBuffer(
      instanceBuffer,
      0,
      planReader.payloadRegion(batch.uploadBytes),
    );
  }
  try {
    if (resolvedImages) {
      for (const [imageIndex, image] of resolvedImages) {
        if (image?.kind !== "canvas") continue;
        const capture = image.captureForRender(device);
        canvasImageLeases.push(capture);
        const resolved = await capture.resolve();
        if (resolved === null) {
          resolvedImages.delete(imageIndex);
          unavailableCanvasImageIndices.add(imageIndex);
        } else if (resolved.kind === "gpu-texture") {
          resolvedImages.set(imageIndex, resolved);
        } else {
          resolvedImages.set(imageIndex, {
            width: resolved.width,
            height: resolved.height,
            descriptor: resolved,
            pixels: resolved.pixels,
          });
        }
      }
      batch.setImages(resolvedImages);
    }

    // The composite shader's bind group always needs SOMETHING at bindings
    // 4 and 6, but the overwhelmingly common frame has neither a clip-path
    // mask nor a mask layer. Before this was cached, every frame of every
    // scene created a texture and uploaded the ENTIRE svg path atlas —
    // caught by batching_alloc_test.js's "0 texture allocs in steady state"
    // assertion (BUG-path-mask-atlas-allocated-every-frame, resolved; see
    // activity/reports/REPORT-2026-10-09-resolved-bug-records.md), but the
    // real cost was the per-frame full-atlas upload, not the allocation.
    const pathMaskAtlasTexture = batch.pathMaskInUse
      ? pathAtlasTexture(svgPathAtlas)
      : placeholderTexture();

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
    let currentDamage = incremental ? { rects: initialDamageRects } : null;
    // The scissor rectangle the current pass last set.
    let scissorPass = null;
    let scissorRect = null;
    // Dependency groups render their complete source; only the retained
    // destination is scissored, once per dirty rect the draw reaches: a
    // selected draw (`reach` true) is issued only for the rects its plan
    // bounds overlap (createRasterPlanCursor's `reaches`), and any other
    // draw for every rect. Composite sampling then matches full paint.
    function drawCurrentPass(vertexCount, instanceCount, reach = false) {
      if (currentDamage && currentTarget === mainTexture) {
        for (const rect of currentDamage.rects) {
          if (reach && !batch.reaches(rect.x, rect.y, rect.w, rect.h)) {
            continue;
          }
          if (scissorPass !== currentRenderPass || scissorRect !== rect) {
            currentRenderPass.setScissorRect(rect.x, rect.y, rect.w, rect.h);
            scissorPass = currentRenderPass;
            scissorRect = rect;
          }
          currentRenderPass.draw(vertexCount, instanceCount);
        }
        return;
      }
      currentRenderPass.draw(vertexCount, instanceCount);
    }

    // One instanced draw of the selected entry, reading its instances at
    // their offset in this frame's payload upload. A render pass keeps its
    // pipeline, bind group and vertex buffers between draws, so only what
    // differs from the previous draw in the same pass is set again: the
    // encoder validates and replays every recorded command.
    let boundPass = null;
    let boundPipeline = null;
    let boundGroup = null;
    const drawInstances = (pipeline, bindGroup) => {
      if (boundPass !== currentRenderPass) {
        boundPass = currentRenderPass;
        boundPipeline = null;
        boundGroup = null;
        currentRenderPass.setVertexBuffer(0, quadBuffer);
      }
      if (boundPipeline !== pipeline) {
        currentRenderPass.setPipeline(pipeline);
        boundPipeline = pipeline;
      }
      if (boundGroup !== bindGroup) {
        currentRenderPass.setBindGroup(0, bindGroup);
        boundGroup = bindGroup;
      }
      currentRenderPass.setVertexBuffer(
        1,
        instanceBuffer,
        batch.payloadByteOffset,
        batch.payloadByteLength,
      );
      drawCurrentPass(6, batch.count, true);
    };

    // The blend mode the selected CMD_POP_OPACITY composites its group
    // with: its native composite names one; a pop without one keeps the
    // push's.
    const popBlendMode = (pushBlendMode) =>
      batch.nativeComposite?.[1] ?? pushBlendMode ?? BLEND_NORMAL;
    // Whether the selected pop's composite reads the pixels under the
    // group, through a backdrop copy of the target it composites into.
    const popReadsBackdrop = (blendMode) =>
      batch.needsBackdropCopy || blendMode !== BLEND_NORMAL;
    // popReadsBackdrop for the pop that closes the group pushed at entry
    // `pushEntry`, found ahead in the draw sequence; the push stays
    // selected.
    function groupCompositeReadsBackdrop(pushEntry, pushBlendMode) {
      let depth = 0;
      for (let entry = pushEntry; entry < batch.entryCount; entry++) {
        const kind = planReader.kind(batch.selectEntry(entry));
        if (kind === CMD_PUSH_OPACITY) depth++;
        else if (kind === CMD_POP_OPACITY && --depth === 0) {
          const reads = popReadsBackdrop(popBlendMode(pushBlendMode));
          batch.selectEntry(pushEntry);
          return reads;
        }
      }
      throw new Error(
        `render: the opacity group pushed at draw entry ${pushEntry} has no matching pop`,
      );
    }

    // The image's texture in the working encoding and render precision,
    // with its mip chain. A registered image (`retainable`) keeps the
    // texture an earlier frame converted while every frame draws it, so
    // scrolling it into view converts it once; a live canvas capture
    // converts each frame into a texture of the context's pools (given back
    // after submission, like the scratch textures).
    //
    // Native-precision upload (wide-color plan, package 4 step 1): the
    // registered entry carries the decoder's own ImageDescriptor. Its
    // samples upload untouched into a source texture matching their
    // sample type; the source-to-working conversion pass then writes
    // mip level 0 of the image texture in the selected render
    // precision, converting into the mode's working encoding and
    // premultiplying in float. The eight-bit speed precision clamps
    // extended components at texture write, as the plan specifies. The
    // conversion reads nothing the frame draws, so its passes go on the
    // resource encoder and interrupt no pass of the frame.
    function imageTextureFor(image, retainable) {
      // A color glyph cache page holds rendered entries in this frame's
      // color format and working encoding, premultiplied (src/color-glyph-cache.js).
      if (image.kind === "color-glyph-cache-page") return image.texture;
      if (retainable) {
        const retained = frameImageTextures.get(image) ??
          retainedImageTextures.get(image);
        if (retained !== undefined) {
          frameImageTextures.set(image, retained);
          return retained;
        }
      }
      resourceEncoder ??= device.createCommandEncoder();
      const { width: imgW, height: imgH } = image;
      let sourceTexture;
      let sampleKind;
      let uniformData;
      if (image.kind === "gpu-texture") {
        sourceTexture = image.texture;
        sampleKind = "float";
        uniformData = imageConversionUniformFor(image.descriptor);
      } else {
        const conversion = imageConversionFor(image);
        sampleKind = conversion.upload.sampleKind;
        uniformData = conversion.uniformData;
        // The upload texture is read once, by this conversion: a pooled one
        // of the same size and format serves every frame.
        sourceTexture = takePooledTexture(`image-source:${conversion.upload.format}:${imgW}x${imgH}`, {
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
      }
      const mipLevelCount = 1 + Math.floor(Math.log2(Math.max(imgW, imgH)));
      const imageTextureDescriptor = {
        size: { width: imgW, height: imgH },
        format: colorFormat,
        mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT,
      };
      const imageTexture = retainable
        ? device.createTexture(imageTextureDescriptor)
        : takePooledTexture(`image:${imgW}x${imgH}`, imageTextureDescriptor);
      if (retainable) frameImageTextures.set(image, imageTexture);

      const conversionUniformBuffer = takeFrameUniformBuffer(uniformData.byteLength);
      device.queue.writeBuffer(conversionUniformBuffer, 0, uniformData);
      const conversionPipeline = getSourceConvertPipeline(sampleKind);
      const conversionBindGroup = device.createBindGroup({
        layout: conversionPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sourceTexture.createView() },
          { binding: 1, resource: { buffer: conversionUniformBuffer } },
        ],
      });
      const conversionPass = resourceEncoder.beginRenderPass({
        colorAttachments: [{
          view: imageTexture.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
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
      // scaler; BUG-image-downscale-quality, resolved, in
      // activity/reports/REPORT-2026-10-09-resolved-bug-records.md).
      // clamp-to-edge always:
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
          const downsamplePass = resourceEncoder.beginRenderPass({
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
      return imageTexture;
    }

    // P8 / P8b: filter-segment application, shared by CMD_POP_OPACITY's group
    // filter chain and CMD_PUSH_BACKDROP_FILTER's backdrop snapshot chain —
    // hoisted out of the popOpacity branch (was defined fresh per pop) since
    // both call sites need the identical pass sequence. Each segment is its
    // own full-screen pass reading the CURRENT filtered texture and writing
    // another — matches Blink/Skia's own separation of the SkImageFilter
    // chain from final-layer compositing. Every intermediate texture is a
    // scratch texture of its own for the frame (takeScratchTexture), so no
    // two segments or draws of one submission share one; later frames take
    // it again only after this one is submitted.
    //
    // Every pass writes a texture the size of the one it reads: the frame,
    // or the padded filter region (see applyFilterPasses). `reachX` and
    // `reachY` bound the pass to the part of that region a later pass
    // still reads (setFilterScissor).

    // The scissor of one filter pass: the frame grown by the reach of the
    // passes after it, inside an output texture whose padding is centred
    // on the frame.
    function setFilterScissor(pass, outputTexture, reachX, reachY) {
      const padX = (outputTexture.width - width) / 2;
      const padY = (outputTexture.height - height) / 2;
      const x = Math.max(0, padX - reachX);
      const y = Math.max(0, padY - reachY);
      pass.setScissorRect(
        x,
        y,
        Math.min(outputTexture.width, padX + width + reachX) - x,
        Math.min(outputTexture.height, padY + height + reachY) - y,
      );
    }

    // Copies `sourceTexture` into a fresh texture of the given size,
    // shifted by (shiftX, shiftY) texels with the reads clamped to the
    // source's edge: FILTER_WINDOW_SHADER's pad and crop.
    function applyWindowPass(
      sourceTexture,
      outputWidth,
      outputHeight,
      shiftX,
      shiftY,
    ) {
      const outputTexture = takeScratchTexture(
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        outputWidth,
        outputHeight,
      );
      const windowUniformBuffer = takeFrameUniformBuffer(16);
      device.queue.writeBuffer(
        windowUniformBuffer,
        0,
        new Int32Array([shiftX, shiftY, 0, 0]),
      );
      const windowBindGroup = device.createBindGroup({
        layout: getFilterWindowPipeline().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: windowUniformBuffer } },
          { binding: 1, resource: sourceTexture.createView() },
        ],
      });
      const windowPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: outputTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      windowPass.setPipeline(getFilterWindowPipeline());
      windowPass.setBindGroup(0, windowBindGroup);
      windowPass.setVertexBuffer(0, quadBuffer);
      windowPass.draw(6);
      windowPass.end();
      return outputTexture;
    }

    function applyMatrixPass(sourceTexture, matrixRows, reachX, reachY) {
      const outputTexture = takeScratchTexture(
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        sourceTexture.width,
        sourceTexture.height,
      );
      // The frame-sized resolution and fullTargetInstanceBuffer hold for a
      // padded texture too: the quad still spans clip space, so it covers
      // the whole attachment, and its uv (pixelPos / resolution) still
      // spans [0, 1] of the equally sized source.
      // Reuses COMPOSITE_SHADER's matrix application with the coefficients
      // and constant column already packed by the native raster planner.
      const matrixUniformBuffer = nextCompositeUniformBuffer();
      // clipCount=0 (no clips array entries): a standalone filter-
      // segment pass applies to the WHOLE current texture — clipping
      // to the element's own shape happens only at the FINAL composite
      // draw, same "filter chain is a separate stage from final layer
      // compositing" reasoning as the blur/matrix pass ordering itself.
      writeUniform(
        matrixUniformBuffer,
        new Float32Array([
          width,
          height,
          1,
          BLEND_NORMAL,
          1,
          0,
          1,
          0,
          ...matrixRows,
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
          { binding: 2, resource: linearSampler },
          { binding: 3, resource: sourceTexture.createView() },
          { binding: 4, resource: pathMaskAtlasTexture.createView() },
          { binding: 6, resource: pathMaskAtlasTexture.createView() },
        ],
      });
      const matrixPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: outputTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      matrixPass.setPipeline(getMatrixOverwritePipeline());
      setFilterScissor(matrixPass, outputTexture, reachX, reachY);
      matrixPass.setBindGroup(0, matrixBindGroup);
      matrixPass.setVertexBuffer(0, quadBuffer);
      matrixPass.setVertexBuffer(1, fullTargetInstanceBuffer);
      matrixPass.draw(6, 1);
      matrixPass.end();
      return outputTexture;
    }

    function applyBlurPass(sourceTexture, uniform, reachX, reachY) {
      const passTexture = takeScratchTexture(
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        sourceTexture.width,
        sourceTexture.height,
      );
      const blurUniformBuffer = takeFrameUniformBuffer(32);
      device.queue.writeBuffer(
        blurUniformBuffer,
        0,
        new Float32Array([
          sourceTexture.width,
          sourceTexture.height,
          uniform[1],
          uniform[2],
          uniform[0],
          0,
          0,
          0,
        ]),
      );
      const blurBindGroup = device.createBindGroup({
        layout: getBoxBlurPipeline().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: blurUniformBuffer } },
          { binding: 1, resource: sourceTexture.createView() },
          { binding: 2, resource: linearSampler },
        ],
      });
      const blurPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: passTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      blurPass.setPipeline(getBoxBlurPipeline());
      setFilterScissor(blurPass, passTexture, reachX, reachY);
      blurPass.setBindGroup(0, blurBindGroup);
      blurPass.setVertexBuffer(0, quadBuffer);
      blurPass.draw(6);
      blurPass.end();
      return passTexture;
    }

    function applyDropShadowPass(
      blurredAlphaTexture,
      sourceTexture,
      uniform,
      reachX,
      reachY,
    ) {
      const outputTexture = takeScratchTexture(
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        sourceTexture.width,
        sourceTexture.height,
      );
      const dropShadowUniformBuffer = takeFrameUniformBuffer(32);
      device.queue.writeBuffer(
        dropShadowUniformBuffer,
        0,
        new Float32Array([
          sourceTexture.width,
          sourceTexture.height,
          uniform[0],
          uniform[1],
          uniform[3],
          uniform[4],
          uniform[5],
          uniform[6],
        ]),
      );
      const dropShadowBindGroup = device.createBindGroup({
        layout: getDropShadowPipeline().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: dropShadowUniformBuffer } },
          { binding: 1, resource: blurredAlphaTexture.createView() },
          { binding: 2, resource: sourceTexture.createView() },
          { binding: 3, resource: linearSampler },
        ],
      });
      const dropShadowPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: outputTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      dropShadowPass.setPipeline(getDropShadowPipeline());
      setFilterScissor(dropShadowPass, outputTexture, reachX, reachY);
      dropShadowPass.setBindGroup(0, dropShadowBindGroup);
      dropShadowPass.setVertexBuffer(0, quadBuffer);
      dropShadowPass.draw(6);
      dropShadowPass.end();
      return outputTexture;
    }

    // The filter region (BUG-css-filter-blur-renormalises-at-the-frame-edge,
    // resolved; see activity/reports/REPORT-2026-10-07-resolved-bug-records.md).
    // A blur or drop shadow reads beyond the pixel it writes, and
    // Chrome's filter region is not bounded by the frame: glow one pass
    // spreads past the frame edge is read back by the next. The passes run
    // on a texture padded by the list's whole reach (filterPassReaches,
    // filterRegionPadding) whose padding repeats the frame's edge texels —
    // transparent around content inside the frame, a continuation of
    // content that runs past it — and the frame is cropped out at the end.
    function applyFilterPasses(sourceTexture, passes) {
      const reaches = filterPassReaches(passes);
      const maxExtent = device.limits.maxTextureDimension2D;
      const padX = filterRegionPadding(reaches[0], width, maxExtent);
      const padY = filterRegionPadding(reaches[1], height, maxExtent);
      const padded = padX > 0 || padY > 0;
      let texture = padded
        ? applyWindowPass(
          sourceTexture,
          width + 2 * padX,
          height + 2 * padY,
          -padX,
          -padY,
        )
        : sourceTexture;
      let blurSource = texture;
      let blurPassIndex = 0;
      for (let index = 0; index < passes.length; index++) {
        const pass = passes[index];
        const reachX = reaches[2 * index + 2];
        const reachY = reaches[2 * index + 3];
        if (pass.kind === RASTER_PLAN_PASS_MATRIX) {
          texture = applyMatrixPass(texture, pass.uniform, reachX, reachY);
          blurPassIndex = 0;
        } else if (
          pass.kind === RASTER_PLAN_PASS_BOX_BLUR_H ||
          pass.kind === RASTER_PLAN_PASS_BOX_BLUR_V
        ) {
          if (blurPassIndex === 0) blurSource = texture;
          texture = applyBlurPass(texture, pass.uniform, reachX, reachY);
          blurPassIndex = (blurPassIndex + 1) % 6;
        } else if (pass.kind === RASTER_PLAN_PASS_DROP_SHADOW) {
          texture = applyDropShadowPass(
            texture,
            blurSource,
            pass.uniform,
            reachX,
            reachY,
          );
          blurPassIndex = 0;
        } else {
          throw new Error(`render: unknown native filter pass ${pass.kind}`);
        }
      }
      return padded
        ? applyWindowPass(texture, width, height, padX, padY)
        : texture;
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
      writeUniform(
        uniformBuffer,
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
      const bindGroup = device.createBindGroup({
        layout: getCompositePipeline().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: sourceTexture.createView() },
          { binding: 2, resource: linearSampler },
          // A normal-blend draw never samples the backdrop; bind the source
          // as the dummy, exactly as popOpacity does.
          {
            binding: 3,
            resource: (backdropTexture ?? sourceTexture).createView(),
          },
          { binding: 4, resource: pathMaskAtlasTexture.createView() },
          { binding: 6, resource: pathMaskAtlasTexture.createView() },
        ],
      });
      currentRenderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: currentTarget.createView(),
          loadOp: "load",
          storeOp: "store",
        }],
      });
      currentRenderPass.setPipeline(getCompositePipeline());
      currentRenderPass.setBindGroup(0, bindGroup);
      currentRenderPass.setVertexBuffer(0, quadBuffer);
      currentRenderPass.setVertexBuffer(1, fullTargetInstanceBuffer);
      drawCurrentPass(6, 1);
    }

    let lastRectSlot = null;
    let lastText = null;
    let lastShadow = null;
    // Native GradientRecord and GradientStop bytes come from the raster plan.
    // Batching only rebases the record's stopStart into the batch-wide flat
    // stop span; color conversion, missing-component resolution, hue fixup,
    // geometry scaling, and both backend color copies are already packed.
    // A span is gradient-free by construction, so only a single-record
    // selection carries a gradient, as its first record.
    const writeRectGradients = (slot, gradient, count) => {
      if (count > MAX_INSTANCES) {
        throw new Error(
          `instance buffer overflow: a rect batch of ${count} instances exceeds the ${MAX_INSTANCES} gradient records a slot holds`,
        );
      }
      // `zeroRecords` counts the leading gradient records a slot is known
      // to hold zeroed; a gradient-free batch of that many instances needs
      // no write, in this frame or a later one.
      if (gradient === null) {
        if ((slot.zeroRecords ?? 0) >= count) return;
        writeUniform(
          slot.gradientRecordBuffer,
          new Uint8Array(count * GRADIENT_RECORD_STRIDE),
        );
        slot.zeroRecords = count;
        return;
      }
      const recordBytes = new Uint8Array(count * GRADIENT_RECORD_STRIDE);
      recordBytes.set(gradient.record, 0);
      new DataView(recordBytes.buffer).setUint32(8, 0, true);
      writeUniform(slot.gradientRecordBuffer, recordBytes);
      slot.zeroRecords = 0;
      slot.ensureStopCapacity(gradient.stopCount);
      if (gradient.stopCount > 0) {
        writeUniform(slot.gradientStopBuffer, gradient.stops.slice());
      }
    };
    for (let entryIndex = 0; entryIndex < batch.entryCount; entryIndex++) {
      // One draw per SPAN of mergeable records, not one per record. The
      // native plan writes a record per source command because its record
      // directory is also the source-coverage map, so consecutive rects,
      // shadows and text runs under one clip and resource arrive as many
      // one-instance records; drawing each separately is what
      // BUG-raster-plan-draws-one-record-per-command (resolved; see
      // activity/reports/REPORT-2026-10-07-resolved-bug-records.md) measured as 717
      // draw calls where 132 suffice. The cursor's draw sequence names
      // the spans and leaves out the records that paint nothing.
      const recordIndex = batch.selectEntry(entryIndex);
      switch (planReader.kind(recordIndex)) {
        case CMD_DAMAGE:
          currentDamage = { rects: batch.rects };
          continue;
        case CMD_RECT: {
        if (batch.payloadByteLength === 0) break;
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
        const gradient = batch.gradient;
        const hasGradient = gradient !== null;
        let slot = lastRectSlot;
        if (
          slot === null || slot.clipIndex !== clip.clipIndex || hasGradient ||
          slot.zeroRecords < batch.count
        ) {
          slot = nextUniform();
          slot.clipIndex = clip.clipIndex;
          writeUniform(
            slot.buffer,
            new Float32Array([
              width,
              height,
              clip.entries.length,
              0,
              ...clipUniformFloats(clip),
            ]),
          );
          writeRectGradients(slot, gradient, batch.count);
          lastRectSlot = hasGradient ? null : slot;
        }
        drawInstances(rectPipeline, slot.bindGroup);
        break;
      }
      case CMD_BOX_SHADOW: {
        if (batch.payloadByteLength === 0) break;
        // Simple pooled uniform buffer (no gradient/texture bind-group
        // coupling — a shadow draw needs only clip state) — see
        // boxShadowUniformPool's own comment for why this doesn't reuse
        // nextUniform()'s rect-specific pool. Same reuse rule as the rect
        // slot: consecutive shadow batches under one clip state (every
        // rect flushes the shadow accumulator, so a page of shadowed boxes
        // is many one-instance batches) draw with the previous uniform.
        const clip = batch.clipState;
        const clipIndex = clip.clipIndex ?? -1;
        let boxShadowBindGroup;
        if (lastShadow !== null && lastShadow.clipIndex === clipIndex) {
          boxShadowBindGroup = lastShadow.bindGroup;
        } else {
          const boxShadowUniform = nextBoxShadowUniformBuffer();
          writeUniform(
            boxShadowUniform,
            new Float32Array([
              width,
              height,
              clip.entries.length,
              0,
              ...clipUniformFloats(clip),
            ]),
          );
          boxShadowBindGroup = boxShadowBindGroupFor(boxShadowUniform);
          lastShadow = { clipIndex, bindGroup: boxShadowBindGroup };
        }

        drawInstances(getBoxShadowPipeline(), boxShadowBindGroup);
        break;
      }
      case CMD_TEXT: {
        if (batch.payloadByteLength === 0) break;
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
          lastText !== null &&
          lastText.clipIndex === clip.clipIndex &&
          lastText.resourceIndex === batch.resourceIndex &&
          lastText.resourceGeneration === batch.resourceGeneration
        ) {
          textBindGroup = lastText.bindGroup;
        } else {
          const textUniform = nextTextUniformBuffer();
          writeUniform(
            textUniform,
            new Float32Array([
              width,
              height,
              clip.entries.length,
              textThickening.lightInk,
              textThickening.darkInk,
              0,
              0,
              0,
              ...clipUniformFloats(clip),
            ]),
          );
          textBindGroup = textBindGroupFor(textUniform, atlasTexture);
          lastText = {
            clipIndex: clip.clipIndex,
            resourceIndex: batch.resourceIndex,
            resourceGeneration: batch.resourceGeneration,
            bindGroup: textBindGroup,
          };
        }

        drawInstances(textPipeline, textBindGroup);
        break;
      }
      case CMD_SVG_PATH: {
        if (batch.payloadByteLength === 0) break;
        // Same atlas-texture rule as the text batch above, minus the gamma
        // uniform (SVG_PATH_SHADER has no mask-gamma remap — see its own
        // top comment).
        const clip = batch.clipState;
        const atlasTexture = batch.atlas.deviceTexture(device);

        // A pooled slot per draw (see svgPathSlotPool): the uniform is
        // resolution + clipCount + pad (16B, exactly the ClipEntry array's
        // 16-byte alignment) + 8 × 80B ClipEntry, then the gradient record
        // and stops of this single-instance draw (one CMD_SVG_PATH = one
        // draw call), written only when the slot holds other contents. A
        // solid fill's record is zero and the shader reads no stop.
        const slot = nextSvgPathSlot();
        writeUniform(
          slot.uniform,
          new Float32Array([
            width,
            height,
            clip.entries.length,
            0,
            ...clipUniformFloats(clip),
          ]),
        );
        const svgGradient = batch.gradient;
        if (svgGradient !== null) {
          const stopBytes = svgGradient.stops.byteLength;
          if (stopBytes > slot.gradientStopCapacity) {
            slot.gradientStops.destroy();
            slot.gradientStopCapacity = Math.max(stopBytes, slot.gradientStopCapacity * 2);
            slot.gradientStops = device.createBuffer({
              size: slot.gradientStopCapacity,
              usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            slot.bindGroups = new WeakMap();
          }
          // Copies: the gradient bytes are views the plan rewrites, and
          // writeUniform keeps what it wrote to compare the next write.
          writeUniform(slot.gradientStops, svgGradient.stops.slice());
        }
        writeUniform(
          slot.gradientRecord,
          svgGradient === null ? ZERO_GRADIENT_RECORD : svgGradient.record.slice(),
        );

        drawInstances(getSvgPathPipeline(), svgPathBindGroupFor(slot, atlasTexture));
        break;
      }
      case CMD_IMAGE: {
        if (batch.payloadByteLength === 0) break;
        if (unavailableCanvasImageIndices.has(batch.resourceIndex)) break;
        const clip = batch.clipState;
        // A registered image is the entry the caller's map holds; a live
        // canvas draws this frame's capture, which the frame converts and
        // drops.
        const imageTexture = imageTextureFor(
          batch.image,
          images?.get(batch.resourceIndex) === batch.image,
        );

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
        const sampler = imageSamplerFor(batch.pixelated, needsWrap);
        // 656 bytes — resolution + clipCount + opacity (16B) +
        // 8 × 80B ClipEntry. An earlier version of this buffer got the WGSL
        // size math wrong once already (64B vs 80B, caught by an uncaptured
        // device validation error). If this shader's struct changes again,
        // recompute the real WGSL size rather than assuming. Pooled per
        // draw (see imageUniformPool).
        const imageUniform = nextImageUniformBuffer();
        writeUniform(
          imageUniform,
          new Float32Array([
            width,
            height,
            clip.entries.length,
            1,
            ...clipUniformFloats(clip),
          ]),
        );

        const groupStraightColor = batch.image.kind === "color-glyph-cache-page";
        drawInstances(
          getImagePipeline(groupStraightColor),
          imageBindGroupFor(imageUniform, imageTexture, sampler, groupStraightColor),
        );
        break;
      }
      case CMD_PUSH_OPACITY: {
        const entry = {
          texture: null,
          opacity: batch.opacity,
          blendMode: batch.blendMode,
          filterPasses: batch.filterPasses,
          clipState: batch.clipState,
          hasMask: batch.hasMask,
          previousTarget: currentTarget,
          // The pass this group interrupts, kept open for its composite
          // when the group is drawn on the detached encoder.
          suspendedPass: null,
        };
        // A group inside a detached one is drawn where its parent is. A
        // mask accumulator may be cleared on this encoder before the push,
        // so a masked group stays in order here.
        if (
          encoder === commandEncoder && !entry.hasMask &&
          !groupCompositeReadsBackdrop(entryIndex, entry.blendMode)
        ) {
          detachedEncoder ??= device.createCommandEncoder();
          encoder = detachedEncoder;
          entry.suspendedPass = currentRenderPass;
        } else {
          currentRenderPass.end();
        }
        // COPY_SRC: a blended group NESTED inside this one (Slice 8C) needs
        // to snapshot ITS previousTarget — which may be this texture — as
        // its backdrop at pop time.
        entry.texture = takeScratchTexture(
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
        );
        opacityStack.push(entry);
        currentTarget = entry.texture;
        currentRenderPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        break;
      }
      case CMD_POP_OPACITY: {
        currentRenderPass.end();
        const entry = opacityStack.pop();
        currentTarget = entry.previousTarget;

        // P8: apply the group's own filter-segment list, in order, BEFORE
        // the opacity/blend-mode composite below — matches Blink/Skia's
        // own architecture (the SkImageFilter chain is a separate stage
        // from the final layer's alpha/blend-mode compositing, not folded
        // together). Each segment is its own full-screen pass reading the
        // CURRENT filtered texture and writing another scratch texture of
        // the frame, so this is NOT the shared-buffer hazard documented at
        // the rect uniform pool above (search "THE SHARED-BUFFER HAZARD") —
        // that hazard is about UNIFORM BUFFERS reused across multiple draws
        // before submit(); no two segments of a frame share a texture.
        entry.texture = applyFilterPasses(
          entry.texture,
          entry.filterPasses,
        );
        // A detached group's content and filters are recorded; its
        // composite belongs to the pass it interrupted.
        if (entry.suspendedPass !== null) encoder = commandEncoder;

        const blendMode = popBlendMode(entry.blendMode);
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
        const pathMaskUniforms = entry.pathMaskUniforms ??
          new Array(24).fill(0);
        const maskTexture = entry.hasMask ? maskStack.pop() : null;
        if (entry.hasMask && !maskTexture) {
          throw new Error(
            "render: CMD_PUSH_OPACITY carried the mask flag but no mask accumulator was pushed",
          );
        }
        if (batch.nativeComposite) {
          // The native pop payload follows the resolution.
          const compositeUniform = new Float32Array(
            2 + batch.nativeComposite.length,
          );
          compositeUniform[0] = width;
          compositeUniform[1] = height;
          compositeUniform.set(batch.nativeComposite, 2);
          writeUniform(compositeUniformBuffer, compositeUniform);
        } else {
          writeUniform(
            compositeUniformBuffer,
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
        }

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
        if (popReadsBackdrop(blendMode)) {
          backdropTexture = takeScratchTexture(
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          );
          encoder.copyTextureToTexture(
            { texture: currentTarget },
            { texture: backdropTexture },
            { width, height },
          );
        }

        // A Porter-Duff operator (composite uniform float 7) writes its
        // result over the backdrop copy itself: no blend state.
        const compositePipelineForPop = batch.nativeComposite?.[5]
          ? getMatrixOverwritePipeline()
          : getCompositePipeline();
        const compositeBindGroup = device.createBindGroup({
          layout: compositePipelineForPop.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: compositeUniformBuffer } },
            { binding: 1, resource: entry.texture.createView() },
            { binding: 2, resource: linearSampler },
            { binding: 3, resource: backdropTexture.createView() },
            { binding: 4, resource: pathMaskAtlasTexture.createView() },
            {
              binding: 6,
              resource: (maskTexture ?? pathMaskAtlasTexture).createView(),
            },
          ],
        });
        currentRenderPass = entry.suspendedPass ?? encoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
        currentRenderPass.setPipeline(compositePipelineForPop);
        currentRenderPass.setBindGroup(0, compositeBindGroup);
        currentRenderPass.setVertexBuffer(0, quadBuffer);
        currentRenderPass.setVertexBuffer(1, fullTargetInstanceBuffer);
        drawCurrentPass(6, 1);
        // The resumed pass no longer holds the pipeline, bind group and
        // quad buffer its last instanced draw set.
        boundPass = null;
        break;
      }
      case CMD_PUSH_BACKGROUND: {
        // P13: the background stack gets its own accumulator so a blending
        // layer sees the layers below it and NOT the page behind the
        // element (css-compositing-1 §5.2). Emitted only when some layer
        // actually blends, so an ordinary background never pays for this.
        currentRenderPass.end();
        // COPY_SRC: popBlendLayer snapshots this as the blend backdrop.
        const accumulator = takeScratchTexture(
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
        );
        backgroundStack.push({
          texture: accumulator,
          previousTarget: currentTarget,
        });
        currentTarget = accumulator;
        currentRenderPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        break;
      }
      case CMD_POP_BACKGROUND: {
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
        break;
      }
      case CMD_PUSH_BLEND_LAYER: {
        currentRenderPass.end();
        const scratch = takeScratchTexture(
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        );
        blendLayerStack.push({
          texture: scratch,
          previousTarget: currentTarget,
          blendMode: batch.blendMode,
        });
        currentTarget = scratch;
        currentRenderPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        break;
      }
      case CMD_POP_BLEND_LAYER: {
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
        const backdropTexture = takeScratchTexture(
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        );
        encoder.copyTextureToTexture(
          { texture: currentTarget },
          { texture: backdropTexture },
          { width, height },
        );
        compositeTexture(layer.texture, layer.blendMode, backdropTexture);
        break;
      }
      case CMD_PUSH_MASK: {
        // P11: a zero-cleared canvas-sized coverage accumulator. It
        // is never the target of ordinary draws — only the MASK_COMBINE
        // pass at each popMaskLayer writes into it — so it gets its own
        // clear pass here rather than riding some other pass's loadOp.
        currentRenderPass.end();
        const accumulator = takeScratchTexture(
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        );
        encoder.beginRenderPass({
          colorAttachments: [{
            view: accumulator.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        }).end();
        maskStack.push(accumulator);
        currentRenderPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
        break;
      }
      case CMD_PUSH_MASK_LAYER: {
        // One layer rasterizes WHOLE into its own scratch before it can be
        // combined: subtract/intersect/exclude must change the accumulator
        // where the layer does NOT paint, which per-draw blend state on the
        // layer's own quad cannot express.
        currentRenderPass.end();
        const scratch = takeScratchTexture(
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        );
        maskLayerStack.push({
          texture: scratch,
          previousTarget: currentTarget,
          mode: batch.mode,
          composite: batch.composite,
        });
        currentTarget = scratch;
        currentRenderPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        break;
      }
      case CMD_POP_MASK_LAYER: {
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
            { binding: 2, resource: linearSampler },
          ],
        });
        const combinePass = encoder.beginRenderPass({
          colorAttachments: [{
            view: accumulator.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
        combinePass.setPipeline(pipeline);
        combinePass.setBindGroup(0, maskBindGroup);
        combinePass.setVertexBuffer(0, quadBuffer);
        combinePass.setVertexBuffer(1, fullTargetInstanceBuffer);
        combinePass.draw(6, 1);
        combinePass.end();
        currentRenderPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
        break;
      }
      case CMD_PUSH_BACKDROP_FILTER: {
        // P8b: backdrop-filter, unlike pushOpacity/popOpacity, is a single-
        // step operation with no offscreen-target stack — it filters
        // whatever is ALREADY painted into currentTarget (the content BEHIND
        // this element, per spec) and composites the filtered result back
        // into that SAME target, clipped to this element's own shape. The
        // element's own content then continues painting into currentTarget
        // normally in the very next batches — no push/pop of currentTarget
        // itself, unlike an opacity group.
        currentRenderPass.end();

        const snapshotTexture = takeScratchTexture(
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        );
        encoder.copyTextureToTexture(
          { texture: currentTarget },
          { texture: snapshotTexture },
          { width, height },
        );

        const filteredTexture = applyFilterPasses(
          snapshotTexture,
          batch.filterPasses,
        );

        const backdropUniformBuffer = nextCompositeUniformBuffer();
        // ownClipState (read directly from the command's own trailing
        // CLIP_ENTRY payload — see the parse site's own comment) is this
        // element's own border-box shape, per spec. opacity=1/blendMode=
        // normal: backdrop-filter has neither of its own — it's a pure
        // "replace what's behind me, inside my own border box, with the
        // filtered version" operation.
        const clipCount = batch.ownClipState?.entryCount ??
          batch.ownClipState?.entries.length ?? 0;
        writeUniform(
          backdropUniformBuffer,
          new Float32Array([
            width,
            height,
            1,
            BLEND_NORMAL,
            0,
            clipCount,
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
            ...(batch.ownClipState?.packedFloats ??
              clipUniformFloats(batch.ownClipState ?? EMPTY_CLIP_STATE)),
          ]),
        );

        const backdropBindGroup = device.createBindGroup({
          layout: getCompositePipeline().getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: backdropUniformBuffer } },
            { binding: 1, resource: filteredTexture.createView() },
            { binding: 2, resource: linearSampler },
            { binding: 3, resource: filteredTexture.createView() },
            { binding: 4, resource: pathMaskAtlasTexture.createView() },
            { binding: 6, resource: pathMaskAtlasTexture.createView() },
          ],
        });
        currentRenderPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: currentTarget.createView(),
            loadOp: "load",
            storeOp: "store",
          }],
        });
        currentRenderPass.setPipeline(getCompositePipeline());
        currentRenderPass.setBindGroup(0, backdropBindGroup);
        currentRenderPass.setVertexBuffer(0, quadBuffer);
        currentRenderPass.setVertexBuffer(1, fullTargetInstanceBuffer);
        drawCurrentPass(6, 1);
        // currentRenderPass stays open (load-mode) — the element's own
        // content (background/border/children) continues painting into this
        // SAME target in subsequent batches, same as if no backdrop-filter
        // had been emitted at all.
      }
        break;
      case CMD_PUSH_CLIP:
      case CMD_POP_CLIP:
      case CMD_POP_BACKDROP_FILTER:
      case CMD_SET_NODE:
      case CMD_SET_SCROLL:
        break;
      default:
        throw new Error(
          `render: unknown raster-plan record kind 0x${
            planReader.kind(recordIndex).toString(16)
          } at index ${recordIndex}`,
        );
    }
    }

    currentRenderPass.end();

    if (readback === "none") {
      submitFrame();
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
    const persistentPixels = context.persistentPixels;
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
        submitFrame();
        await device.queue.onSubmittedWorkDone();
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const rawData = new Uint8Array(readbackBuffer.getMappedRange());
        const pixelRegions = [];
        bufferOffset = 0;
        for (const region of readbackRegions) {
          const regionPixels = new Float32Array(region.w * region.h * 4);
          for (let row = 0; row < region.h; row++) {
            copyReadbackRow(
              rawData,
              bufferOffset + row * region.bytesPerRow,
              regionPixels,
              row * region.w * 4,
              region.w,
              colorTexelBytes,
            );
            persistentPixels.set(
              regionPixels.subarray(row * region.w * 4, (row + 1) * region.w * 4),
              ((region.y + row) * width + region.x) * 4,
            );
          }
          pixelRegions.push({
            x: region.x,
            y: region.y,
            width: region.w,
            height: region.h,
            pixels: regionPixels,
          });
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
            pixelRegions,
            readbackByteLength: bufferOffset,
          },
        );
      }
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
      submitFrame();

      const collect = async () => {
        await device.queue.onSubmittedWorkDone();
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const finish = () => {
          const rawData = new Uint8Array(readbackBuffer.getMappedRange());
          const pixelRegions = [];
          slotPixels.set(persistentPixels);
          let regionOffset = 0;
          for (const region of readbackRegions) {
            const regionPixels = new Float32Array(region.w * region.h * 4);
            for (let row = 0; row < region.h; row++) {
              copyReadbackRow(
                rawData,
                regionOffset + row * region.bytesPerRow,
                regionPixels,
                row * region.w * 4,
                region.w,
                colorTexelBytes,
              );
              const source = regionPixels.subarray(
                row * region.w * 4,
                (row + 1) * region.w * 4,
              );
              const destinationOffset = ((region.y + row) * width + region.x) * 4;
              slotPixels.set(source, destinationOffset);
              persistentPixels.set(source, destinationOffset);
            }
            pixelRegions.push({
              x: region.x,
              y: region.y,
              width: region.w,
              height: region.h,
              pixels: regionPixels,
            });
            regionOffset += region.bytesPerRow * region.h;
          }
          readbackBuffer.unmap();
          return workingRenderResult(slotPixels, width, height, renderMode, {
            dirtyRects,
            pixelRegions,
            readbackByteLength: bufferOffset,
          });
        };
        return { finish };
      };
      return { deferred: true, collect };
    } else {
      const { buffer: readbackBuffer, pixels: slotPixels } = nextReadbackSlot();
      commandEncoder.copyTextureToBuffer(
        { texture: mainTexture },
        { buffer: readbackBuffer, bytesPerRow },
        { width, height },
      );
      submitFrame();

      const collect = async () => {
        await device.queue.onSubmittedWorkDone();
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
    // A frame that failed before its submission keeps the textures earlier
    // frames retained and drops the ones it converted. Its scratch textures
    // were never submitted, so the next frame may take them.
    if (!submitted) {
      for (const [image, texture] of frameImageTextures) {
        if (retainedImageTextures.get(image) !== texture) texture.destroy();
      }
      returnScratchTextures();
    }
  }
}
