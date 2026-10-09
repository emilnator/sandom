// Bakes the current paper stock into a grain map, appended to
// paper.wgsl. Texel (i, j) covers the sheet position
// ((i, j) + 0.5) × GRAIN_TEXEL millimetres. Channels, all signed:
//   r, g  grain slope along x and y, divided by GRAIN_SLOPE_RANGE
//   b     paper height × 2 − 1
//   a     formation × 2 − 1
// The shaded pass samples it with the pixel's footprint, so the mip chain
// does the averaging that paperSlope does per pixel.

override GRAIN_TEXEL: f32 = 0.05;
override GRAIN_SLOPE_RANGE: f32 = 4.0;

struct Bake { stock: i32, unused: vec3i }
@group(0) @binding(0) var<uniform> bake: Bake;
@group(0) @binding(1) var grain: texture_storage_2d<rgba8snorm, write>;

@compute @workgroup_size(8, 8)
fn bake_grain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(grain);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let point = (vec2f(id.xy) + 0.5) * GRAIN_TEXEL;
  let step = GRAIN_TEXEL;
  let slope = vec2f(
    paperHeight(point + vec2f(step, 0), bake.stock) - paperHeight(point - vec2f(step, 0), bake.stock),
    paperHeight(point + vec2f(0, step), bake.stock) - paperHeight(point - vec2f(0, step), bake.stock),
  ) * stock(bake.stock).grainHeight / (2.0 * step);
  let height = paperHeight(point, bake.stock);
  textureStore(grain, vec2i(id.xy), vec4f(clamp(slope / GRAIN_SLOPE_RANGE, vec2f(-1), vec2f(1)),
    height * 2.0 - 1.0, formation(point) * 2.0 - 1.0));
}
