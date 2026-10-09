// One level of the grain map's mip chain: each texel averages four of the
// level above. Averaging slopes is averaging the surface over the footprint.

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba8snorm, write>;

@compute @workgroup_size(8, 8)
fn reduce_grain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let base = vec2i(id.xy) * 2;
  let sum = textureLoad(source, base, 0) + textureLoad(source, base + vec2i(1, 0), 0) +
    textureLoad(source, base + vec2i(0, 1), 0) + textureLoad(source, base + vec2i(1, 1), 0);
  textureStore(destination, vec2i(id.xy), sum * 0.25);
}
