// Materials and lighting for the shaded pass. Appended to book-geometry.wgsl.

@group(0) @binding(3) var sheet: texture_2d<f32>;
@group(0) @binding(4) var sheetSampler: sampler;
@group(0) @binding(5) var keyShadow: texture_depth_2d;
@group(0) @binding(6) var shadowSampler: sampler_comparison;
@group(0) @binding(7) var skyDepth: texture_depth_2d;
// Pages of an edited document flowed into the book (flow.js), a cell each.
@group(0) @binding(11) var flowSheet: texture_2d<f32>;

fn srgbToLinear(color: vec3f) -> vec3f {
  return select(pow((color + 0.055) / 1.055, vec3f(2.4)), color / 12.92, color <= vec3f(0.04045));
}

// ---------------------------------------------------------------- paper grain

// The current stock baked by paper-grain-bake.wgsl; see page.js.
@group(0) @binding(9) var grain: texture_2d<f32>;
@group(0) @binding(10) var grainSampler: sampler;
override GRAIN_EXTENT: f32 = 216.0;
override GRAIN_SLOPE_RANGE: f32 = 4.0;

struct Grain {
  slope: vec2f,       // mm per mm, averaged over the footprint
  height: f32,        // [0, 1]
  formation: f32,     // [0, 1]
}

// The grain at a sheet position in millimetres; the footprint derivatives
// pick the mip level, so the slope is the surface averaged over the pixel.
fn paperGrain(point: vec2f, footprintX: vec2f, footprintY: vec2f) -> Grain {
  let texel = textureSampleGrad(grain, grainSampler, point / GRAIN_EXTENT,
    footprintX / GRAIN_EXTENT, footprintY / GRAIN_EXTENT);
  return Grain(texel.xy * GRAIN_SLOPE_RANGE, texel.z * 0.5 + 0.5, texel.w * 0.5 + 0.5);
}

// ---------------------------------------------------------------- printed sheet

// Leaf faces: face 2k is leaf k's recto, 2k + 1 its verso. Leaves from
// book.pages.x to book.pages.y carry numbered pages, the first page leaf's
// recto being page 1; the leaves outside them are endpapers or card covers.
fn isEndpaper(leaf: u32) -> bool {
  return book.pages.w > 0.5 && (leaf == 0u || f32(leaf) >= book.stacks.z - 1.0);
}

fn isCard(leaf: u32) -> bool {
  return (leaf == 0u && book.covers.x > 0.5) || (f32(leaf) >= book.stacks.z - 1.0 && book.covers.y > 0.5);
}

fn isNumbered(leaf: u32) -> bool {
  return f32(leaf) >= book.pages.x && f32(leaf) <= book.pages.y;
}

fn pageNumber(face: f32) -> f32 {
  return face + 1.0 - 2.0 * book.pages.x;
}

fn slotFace(slot: i32) -> f32 {
  if (slot < 4) { return book.slots[slot]; }
  return book.slotsMore[slot - 4];
}

// The sheet slot that prints a face: its own slot, else the template for
// numbered pages, else none (−1).
fn sheetSlot(face: f32, leaf: u32, recto: bool) -> i32 {
  for (var slot = 0; slot < 6; slot++) {
    if (slotFace(slot) == face) { return slot; }
  }
  let templateSlot = book.slotsMore.z;
  if (templateSlot >= 0.0 && isNumbered(leaf) && (recto || book.slotsMore.w < 0.5)) { return i32(templateSlot + 0.5); }
  return -1;
}

fn ownSlot(face: f32) -> bool {
  for (var slot = 0; slot < 6; slot++) {
    if (slotFace(slot) == face) { return true; }
  }
  return false;
}

fn sampleSheet(uv: vec2f, gradientX: vec2f, gradientY: vec2f) -> vec3f {
  return srgbToLinear(textureSampleGrad(sheet, sheetSampler, uv, gradientX, gradientY).rgb);
}

fn slotOrigin(slot: i32) -> vec2f {
  let columns = i32(book.sheet.z);
  return vec2f(f32(slot % columns), f32(slot / columns)) * book.sheet.xy;
}

// The printed page as the reader holds it, in millimetres: a side binding
// prints across the leaf from the bound edge, a top binding along it.
fn printedPageSize() -> vec2f {
  if (book.binding.x > 0.5) { return book.page.yx; }
  return book.page.xy;
}

// The flow sheet cell holding a face, or −1.
fn flowCell(face: f32) -> i32 {
  for (var cell = 0; cell < 8; cell++) {
    if (book.flow[cell / 4][cell % 4] == face) { return cell; }
  }
  return -1;
}

// Light transmitted by the ink of a face at a page position in millimetres
// (x from the left edge, y from the top). Blank paper transmits 1. A
// flowed page prints over the face's template.
fn inkTransmittance(face: f32, leaf: u32, recto: bool, position: vec2f, footprintX: vec2f, footprintY: vec2f) -> vec3f {
  let pageSize = printedPageSize();
  let slot = sheetSlot(face, leaf, recto);
  var ink = vec3f(1);
  if (slot >= 0) {
    let scale = book.sheet.xy / pageSize;
    ink = sampleSheet(slotOrigin(slot) + position * scale, footprintX * scale, footprintY * scale);
  }
  let flowed = flowCell(face);
  if (flowed >= 0) {
    let columns = i32(book.flowGrid.z);
    let origin = vec2f(f32(flowed % columns), f32(flowed / columns)) * book.flowGrid.xy;
    let scale = book.flowGrid.xy / pageSize;
    let uv = origin + position * scale;
    ink *= srgbToLinear(textureSampleGrad(flowSheet, sheetSampler, uv, footprintX * scale, footprintY * scale).rgb);
  }
  // Folio: a 16 × 6 mm cell centred 14 mm above the foot, on numbered pages
  // that do not set their own.
  let page = pageNumber(face);
  if (book.pages.z < 0.5 || !isNumbered(leaf) || ownSlot(face) || page < 1.0 || page > book.folio.z * book.folio.w) { return ink; }
  let local = (position - vec2f(0.5 * pageSize.x - 8.0, pageSize.y - 17.0)) / vec2f(16.0, 6.0);
  if (any(local < vec2f(0)) || any(local > vec2f(1))) { return ink; }
  let cell = page - 1.0;
  let cellOrigin = vec2f(cell % book.folio.z, floor(cell / book.folio.z)) * book.folio.xy + vec2f(0.0, book.sheet.w);
  let scale = book.folio.xy / vec2f(16.0, 6.0);
  return ink * sampleSheet(cellOrigin + local * book.folio.xy, footprintX * scale, footprintY * scale);
}

// Distance from a leaf point (arc from the bound edge, position along it)
// to the nearest punched hole's edge; negative inside a hole, and a large
// value for leaves without holes.
fn holeDistance(arc: f32, along: f32) -> f32 {
  if (book.binding.w < 0.5) { return 1e6; }
  let loops = book.holes.w;
  let pitch = book.holes.z;
  let index = clamp(round(along / pitch + 0.5 * (loops - 1.0)), 0.0, loops - 1.0);
  let centre = vec2f(book.holes.x, (index - 0.5 * (loops - 1.0)) * pitch);
  return length(vec2f(arc, along) - centre) - book.holes.y;
}

// ---------------------------------------------------------------- shadows

fn keyShadowFactor(world: vec3f, normal: vec3f) -> f32 {
  let lightDirection = scene.keyLight.xyz;
  let facing = select(-normal, normal, dot(normal, lightDirection) >= 0.0);
  let offset = world + facing * 0.15 + lightDirection * 0.1;
  let clip = scene.keyLightViewProjection * vec4f(offset, 1.0);
  let uv = vec2f(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
  if (any(uv < vec2f(0)) || any(uv > vec2f(1))) { return 1.0; }
  let receiver = clip.z;
  let texels = scene.keyMap.z;
  let millimetresPerTexel = 2.0 * scene.keyMap.x / texels;
  // Blocker search, then a penumbra that widens with the distance from the
  // occluder: the key light is a large soft box.
  var blockerSum = 0.0;
  var blockers = 0.0;
  let searchRadius = 10.0;
  for (var index = 0; index < 16; index++) {
    let angle = f32(index) * 2.39996;
    let radius = sqrt((f32(index) + 0.5) / 16.0) * searchRadius;
    let texel = vec2i(uv * texels + radius * vec2f(cos(angle), sin(angle)));
    let depth = textureLoad(keyShadow, clamp(texel, vec2i(0), vec2i(i32(texels) - 1)), 0);
    if (depth < receiver - 0.0005) {
      blockerSum += depth;
      blockers += 1.0;
    }
  }
  if (blockers == 0.0) { return 1.0; }
  let separation = (receiver - blockerSum / blockers) * scene.keyMap.y;
  let penumbra = clamp(separation * scene.keyMap.w / millimetresPerTexel, 1.0, 24.0);
  var lit = 0.0;
  let rotation = hash(world.xy * 7.3) * 6.2832;
  for (var index = 0; index < 16; index++) {
    let angle = f32(index) * 2.39996 + rotation;
    let radius = sqrt((f32(index) + 0.5) / 16.0) * penumbra;
    let sampleUv = uv + radius * vec2f(cos(angle), sin(angle)) / texels;
    lit += textureSampleCompareLevel(keyShadow, shadowSampler, sampleUv, receiver - 0.0003);
  }
  return lit / 16.0;
}

// Ambient occlusion from the top-down height map: nearby surfaces higher
// than this point hide part of the sky.
fn skyOcclusion(world: vec3f, normal: vec3f) -> f32 {
  let texels = vec2f(textureDimensions(skyDepth));
  let halfExtent = scene.sky.z;
  var occlusion = 0.0;
  let rotation = hash(world.xy * 3.1) * 6.2832;
  for (var index = 0; index < 12; index++) {
    let angle = f32(index) * 2.39996 + rotation;
    let radius = 1.5 + sqrt((f32(index) + 0.5) / 12.0) * 16.0;
    let point = world.xy + radius * vec2f(cos(angle), sin(angle));
    let uv = vec2f(point.x / halfExtent * 0.5 + 0.5, 0.5 - point.y / halfExtent * 0.5);
    let depth = textureLoad(skyDepth, clamp(vec2i(uv * texels), vec2i(0), vec2i(texels) - 1), 0);
    let height = scene.sky.x - depth * scene.sky.y;
    let rise = height - world.z - 0.2;
    occlusion += clamp(rise / (rise + radius), 0.0, 1.0);
  }
  let upness = clamp(normal.z * 0.5 + 0.5, 0.0, 1.0);
  return 1.0 - 0.85 * upness * occlusion / 12.0;
}

// ---------------------------------------------------------------- lighting

// A room lit from above by a warm soft box; dim walls; a dark table below.
fn environment(direction: vec3f, roughness: f32) -> vec3f {
  let softness = mix(0.05, 0.7, roughness);
  let ceiling = smoothstep(0.55 - softness, 0.95, direction.z) * vec3f(1.25, 1.18, 1.08);
  let window = smoothstep(0.75 - softness, 0.95, dot(direction, normalize(vec3f(-0.8, 0.4, 0.45)))) * vec3f(0.9, 1.0, 1.15);
  let walls = vec3f(0.11, 0.1, 0.095) * smoothstep(-0.4, 0.3, direction.z);
  let table = vec3f(0.025, 0.022, 0.02);
  let sharp = table + walls + ceiling + window;
  return mix(sharp, vec3f(0.3, 0.29, 0.28), roughness * roughness * 0.6);
}

fn ggx(normalDotHalf: f32, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alphaSquared = alpha * alpha;
  let denominator = normalDotHalf * normalDotHalf * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / (PI * denominator * denominator);
}

struct Material {
  albedo: vec3f,
  roughness: f32,
  metalness: f32,
  sheen: f32,
}

fn shade(material: Material, normal: vec3f, view: vec3f, shadow: f32, occlusion: f32) -> vec3f {
  let lightDirection = scene.keyLight.xyz;
  let halfVector = normalize(view + lightDirection);
  let normalDotLight = max(dot(normal, lightDirection), 0.0);
  let normalDotView = max(dot(normal, view), 1e-3);
  let normalDotHalf = max(dot(normal, halfVector), 0.0);
  let specularColor = mix(vec3f(0.04), material.albedo, material.metalness);
  let fresnel = specularColor + (1.0 - specularColor) * pow(1.0 - max(dot(halfVector, view), 0.0), 5.0);
  let k = (material.roughness + 1.0) * (material.roughness + 1.0) / 8.0;
  let visibility = 1.0 / ((normalDotLight * (1.0 - k) + k) * (normalDotView * (1.0 - k) + k));
  let specular = fresnel * ggx(normalDotHalf, material.roughness) * visibility * 0.25;
  let diffuse = material.albedo * (1.0 - material.metalness) / PI;
  let sheenTerm = vec3f(material.sheen * pow(1.0 - normalDotView, 4.0) * 0.2);
  var color = (diffuse + specular + sheenTerm) * normalDotLight * scene.keyLight.w * shadow;
  let reflected = reflect(-view, normal);
  let environmentFresnel = specularColor + (max(vec3f(1.0 - material.roughness), specularColor) - specularColor)
    * pow(1.0 - normalDotView, 5.0);
  color += environment(reflected, material.roughness) * environmentFresnel * occlusion;
  color += material.albedo * (1.0 - material.metalness) * environment(normal, 1.0) * occlusion;
  return color;
}

// ---------------------------------------------------------------- surfaces

// Perturbs `normal` by the slope of a height field given in millimetres
// along `tangent` (coordinate x) and `bitangent` (coordinate y).
fn perturb(normal: vec3f, tangent: vec3f, bitangent: vec3f, slope: vec2f) -> vec3f {
  let t = normalize(tangent - normal * dot(tangent, normal));
  let b = normalize(bitangent - normal * dot(bitangent, normal) - t * dot(bitangent, t));
  return normalize(normal - t * slope.x - b * slope.y);
}

fn toneMap(color: vec3f) -> vec3f {
  let mapped = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  return clamp(mapped, vec3f(0), vec3f(1));
}

const ENDPAPER = vec3f(0.12, 0.2, 0.19);

@fragment
fn fs_main(input: Surface) -> @location(0) vec4f {
  // Screen-space footprints, taken while control flow is still uniform.
  let footprintX = dpdx(input.coordinate);
  let footprintY = dpdy(input.coordinate);
  let footprint = max(length(footprintX), length(footprintY));
  let material = input.identity.x;
  let view = normalize(scene.eye.xyz - input.world);
  let geometric = normalize(input.normal);
  let facing = dot(geometric, view) >= 0.0;

  if (material == MATERIAL_LEAF || material == MATERIAL_RESTING_LEAF) {
    let leaf = input.identity.y;
    let arc = input.coordinate.x;
    let along = input.coordinate.y;
    // A punched hole: through a turning leaf the scene behind shows; in the
    // top leaf of a stack it looks down into the holes of the leaves below.
    let hole = holeDistance(arc, along);
    if (hole < 0.0 && material == MATERIAL_LEAF) { discard; }
    // The parametric normal points out of the recto.
    let recto = facing;
    let normal = select(-geometric, geometric, recto);
    let flip = select(-1.0, 1.0, recto);
    let face = f32(2u * leaf) + select(1.0, 0.0, recto);
    let reverseFace = f32(2u * leaf) + select(0.0, 1.0, recto);
    let top = book.binding.x > 0.5;
    let across = book.page.x;
    let leafLength = book.page.y;
    var position: vec2f;
    var reversePosition: vec2f;
    var pageTangentX: vec3f;
    var pageTangentY: vec3f;
    if (top) {
      // Bound along the head: the recto reads from the bound edge down, and
      // the verso is printed head to foot, so it reads the right way up once
      // turned over the top.
      let pageX = along + 0.5 * leafLength;
      position = vec2f(pageX, select(across - arc, arc, recto));
      reversePosition = vec2f(pageX, across - position.y);
      pageTangentX = vec3f(1, 0, 0);
      pageTangentY = input.tangent * flip;
    } else {
      let pageX = select(across - arc, arc, recto);
      position = vec2f(pageX, 0.5 * leafLength - along);
      reversePosition = vec2f(across - pageX, position.y);
      pageTangentX = input.tangent * flip;
      pageTangentY = vec3f(0, -1, 0);
    }
    let endpaper = isEndpaper(leaf);
    let card = isCard(leaf);

    let stockIndex = i32(book.cloth.w + 0.5);
    let paperStock = stock(stockIndex);
    let sample = paperGrain(position, footprintX, footprintY);
    let cloud = sample.formation;
    let height = sample.height;
    let fibreTone = 0.97 + 0.06 * height;
    var base = srgbToLinear(book.paper.rgb);
    if (endpaper) { base = srgbToLinear(ENDPAPER); }
    if (card) { base = srgbToLinear(book.cloth.rgb); }
    let paperColor = base * (0.96 + 0.07 * cloud) * fibreTone;
    var ink = vec3f(1);
    var reverseInk = vec3f(1);
    if (!endpaper) {
      ink = inkTransmittance(face, leaf, recto, position, footprintX, footprintY);
      reverseInk = inkTransmittance(reverseFace, leaf, !recto, reversePosition, footprintX, footprintY);
    }
    let inkCover = 1.0 - dot(ink, vec3f(0.333));
    // Ink partly fills the valleys between fibres.
    let slope = sample.slope * (1.0 - 0.4 * inkCover);
    let bitangentY = pageTangentY - normal * dot(pageTangentY, normal);
    let shadingNormal = perturb(normal, pageTangentX, bitangentY, slope);
    var printed = paperColor * ink;
    // Down a hole the edges of the leaves below, in their own shadow.
    let recess = 1.0 - smoothstep(-0.25, 0.0, hole);
    printed = mix(printed, srgbToLinear(book.paper.rgb) * 0.18, recess);
    let roughness = mix(paperStock.roughness.x, paperStock.roughness.y, height);
    var surfaceMaterial = Material(printed, mix(roughness, 0.55, inkCover), 0.0, paperStock.sheen * (1.0 - inkCover));
    let shadow = keyShadowFactor(input.world, normal);
    let occlusion = skyOcclusion(input.world, normal);
    var color = shade(surfaceMaterial, shadingNormal, view, shadow, occlusion);

    // Light that enters the far side comes through the sheet, coloured by
    // both sides' ink and by the paper's cloudy formation.
    let translucency = select(book.paper.w, book.covers.z, card) * (0.8 + 0.4 * cloud) * (1.0 - recess);
    let through = paperColor * ink * reverseInk * translucency;
    let behind = max(-dot(normal, scene.keyLight.xyz), 0.0);
    color += through * behind * scene.keyLight.w * shadow / PI;
    color += through * environment(-normal, 1.0) * 0.5;
    return vec4f(toneMap(color), 1.0);
  }

  if (material == MATERIAL_PAGE_EDGE) {
    let normal = select(-geometric, geometric, facing);
    // One fine line where each leaf meets the next, fading into an even tone
    // once a pixel spans several leaves.
    let layer = input.coordinate.y;
    let layerFootprint = max(abs(footprintX.y), abs(footprintY.y));
    let line = 1.0 - smoothstep(0.0, 0.25, abs(fract(layer) - 0.5) * 2.0 - 0.5);
    let lineWeight = (1.0 - smoothstep(0.3, 1.0, layerFootprint)) * 0.12;
    let along = select(input.coordinate.y, input.coordinate.x, input.identity.y == 1u);
    let mottle = 0.96 + 0.05 * fbm(vec2f(along * 0.4, layer * 0.3), 3);
    let albedo = srgbToLinear(book.paper.rgb) * 0.9 * mottle * (1.0 - lineWeight * line);
    let shadow = keyShadowFactor(input.world, normal);
    let color = shade(Material(albedo, 0.9, 0.0, 0.1), normal, view, shadow, skyOcclusion(input.world, normal));
    return vec4f(toneMap(color), 1.0);
  }

  if (material == MATERIAL_TABLE) {
    let point = input.coordinate;
    let weave = 0.92 + 0.08 * fbm(point * 1.7, 3) * (1.0 - smoothstep(0.2, 0.8, footprint));
    let tone = 0.9 + 0.1 * fbm(point * 0.01, 3);
    let albedo = srgbToLinear(vec3f(0.23, 0.2, 0.17)) * weave * tone;
    let shadow = keyShadowFactor(input.world, geometric);
    let color = shade(Material(albedo, 0.92, 0.0, 0.3), geometric, view, shadow, skyOcclusion(input.world, geometric));
    let fade = exp(-length(point) / 900.0);
    return vec4f(toneMap(color) * fade, 1.0);
  }

  if (material == MATERIAL_WIRE) {
    let normal = select(-geometric, geometric, facing);
    let shadow = keyShadowFactor(input.world, normal);
    let color = shade(Material(srgbToLinear(vec3f(0.78, 0.78, 0.8)), 0.32, 1.0, 0.0), normal, view, shadow, skyOcclusion(input.world, normal));
    return vec4f(toneMap(color), 1.0);
  }

  // Card of a soft cover where it is not a leaf: its spine strip, and the
  // backing board it is wrapped round.
  if (material == MATERIAL_CARD) {
    let normal = select(-geometric, geometric, facing);
    let point = input.coordinate;
    let sample = paperGrain(point + vec2f(0.0, 0.5 * GRAIN_EXTENT), footprintX, footprintY);
    let albedo = srgbToLinear(book.cloth.rgb) * (0.96 + 0.07 * sample.formation) * (0.97 + 0.06 * sample.height);
    let textured = perturb(normal, input.tangent, cross(normal, input.tangent), sample.slope * 0.8);
    let color = shade(Material(albedo, 0.8, 0.0, 0.2), textured, view, keyShadowFactor(input.world, normal), skyOcclusion(input.world, normal));
    return vec4f(toneMap(color), 1.0);
  }

  // Boards and spine: bookcloth outside, endpaper inside.
  let normal = select(-geometric, geometric, facing);
  let point = input.coordinate;
  let shadow = keyShadowFactor(input.world, normal);
  let occlusion = skyOcclusion(input.world, normal);
  if (material == MATERIAL_BOARD_INSIDE) {
    let sample = paperGrain(point + vec2f(0.0, 0.5 * GRAIN_EXTENT), footprintX, footprintY);
    let albedo = srgbToLinear(ENDPAPER) * (0.97 + 0.05 * sample.formation) * (0.97 + 0.06 * sample.height);
    let pasted = perturb(normal, input.tangent, cross(normal, input.tangent), sample.slope * 0.6);
    let color = shade(Material(albedo, 0.85, 0.0, 0.2), pasted, view, shadow, occlusion);
    return vec4f(toneMap(color), 1.0);
  }

  // Plain-weave cloth: warp and weft threads at 2.4 per millimetre.
  let threadDetail = 1.0 - smoothstep(0.08, 0.3, footprint);
  let warp = sin(point.x * 2.4 * 2.0 * PI);
  let weft = sin(point.y * 2.4 * 2.0 * PI);
  let weave = vec2f(warp, weft) * threadDetail;
  var clothNormal = perturb(normal, input.tangent, cross(normal, input.tangent), weave * 0.12);
  var albedo = srgbToLinear(book.cloth.rgb) * (0.93 + 0.07 * fbm(point * 0.8, 3)) * (1.0 + 0.04 * weave.x * weave.y);
  var roughness = 0.72;
  var metalness = 0.0;

  // Foil stamped into the front board from the sheet's cover slot.
  if (material == MATERIAL_BOARD_OUTSIDE && input.identity.y == 0u && book.slots.x == -2.0) {
    let width = book.page.x + book.board.y;
    let halfHeight = 0.5 * book.page.y + book.board.y;
    let scale = book.sheet.xy / vec2f(width, 2.0 * halfHeight);
    let local = vec2f(point.x, halfHeight - point.y);
    let gradientX = footprintX * vec2f(1, -1) * scale;
    let gradientY = footprintY * vec2f(1, -1) * scale;
    let coverage = 1.0 - dot(sampleSheet(local * scale, gradientX, gradientY), vec3f(0.333));
    let reach = 0.12;
    let coverageX = 1.0 - dot(sampleSheet((local + vec2f(reach, 0)) * scale, gradientX, gradientY), vec3f(0.333));
    let coverageY = 1.0 - dot(sampleSheet((local + vec2f(0, reach)) * scale, gradientX, gradientY), vec3f(0.333));
    // The die presses the foil 0.1 mm into the cloth.
    let pressed = vec2f(coverageX - coverage, -(coverageY - coverage)) * -0.1 / reach;
    let foilNormal = perturb(normal, input.tangent, cross(normal, input.tangent), pressed);
    clothNormal = normalize(mix(clothNormal, foilNormal, max(coverage, length(pressed) * 2.0)));
    albedo = mix(albedo, srgbToLinear(vec3f(0.93, 0.76, 0.43)), coverage);
    roughness = mix(roughness, 0.28, coverage);
    metalness = coverage;
  }
  let color = shade(Material(albedo, roughness, metalness, 0.5 * (1.0 - metalness)), clothNormal, view, shadow, occlusion);
  return vec4f(toneMap(color), 1.0);
}
