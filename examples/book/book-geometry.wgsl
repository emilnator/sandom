// Book geometry, shared by the shaded pass and the two occlusion passes.
// Positions are built in the binding's frame of book-model.js (millimetres;
// x across the binding with the bound edge at x ≈ 0, y along it, z up) and
// turned into the world by toWorld: a top-bound pad lies a quarter turn
// round, its bound edge across the head.
//
// Every resting surface is drawn from the rest curves of leaf-curves.js in
// `curves`, so the stack tops, fore edges, head and tail faces and the
// spine meet exactly where their leaves do.

struct Scene {
  viewProjection: mat4x4f,
  keyLightViewProjection: mat4x4f,
  skyViewProjection: mat4x4f,
  eye: vec4f,
  keyLight: vec4f,     // direction toward the light, intensity
  sky: vec4f,          // sky map: top height, depth range, half extent, unused
  keyMap: vec4f,       // key light map: half extent, depth range, texels, light size
}

struct Book {
  page: vec4f,         // leaf across the binding, leaf along it, page caliper, shell point count
  board: vec4f,        // board thickness, square, hinge height, half block thickness
  stacks: vec4f,       // left count, right start, leaf count, front board angle
  grid: vec4f,         // columns, rows, turning count, unused
  turning: array<vec4f, 2>,  // leaf index in each turning slot
  sheet: vec4f,        // slot width, slot height (uv), slot columns, folio strip top (v)
  folio: vec4f,        // folio cell width, height (uv), folio columns, folio rows
  slots: vec4f,        // leaf face printed by sheet slots 0 … 3 (−1 none, −2 the front board's foil die)
  slotsMore: vec4f,    // faces of slots 4 and 5, template slot (−1 none), template on rectos only (1) or every page (0)
  pages: vec4f,        // first and last page leaf, folios (1) or not (0), endpapers (1) or not (0)
  paper: vec4f,        // paper colour (sRGB), translucency
  cloth: vec4f,        // cover colour (sRGB), paper stock index
  binding: vec4f,      // orientation (0 side, 1 top), cover (0 none, 1 soft, 2 hard), back board thickness, rings (1) or not (0)
  rings: vec4f,        // ring centre x, z, radius, wire radius
  holes: vec4f,        // hole centre's arc from the bound edge, hole radius, loop pitch, loop count
  covers: vec4f,       // front leaf is card (1), back leaf is card (1), card translucency, staples (1) or not (0)
  staple: vec4f,       // staple point x, z; outward direction x, z
  flow: array<vec4f, 2>,  // leaf face held by each flow sheet cell (−1 none)
  flowGrid: vec4f,     // flow cell width, height (uv), cell columns, unused
}

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> book: Book;
@group(0) @binding(2) var<storage, read> particles: array<vec4f>;
// Per leaf: a header (caliper, side, pivot arc, level) and CURVE_SAMPLES
// points (x, z, upper normal x, z); then the shell's (inner x, z, outer x, z).
@group(0) @binding(8) var<storage, read> curves: array<vec4f>;

// 0 camera, 1 key light, 2 sky (top-down occlusion).
override VIEW: u32 = 0u;
// Samples per rest curve, from leaf-curves.js.
override CURVE_SAMPLES: u32 = 65u;

const PI = 3.14159265;
const MATERIAL_LEAF = 0u;
const MATERIAL_PAGE_EDGE = 1u;
const MATERIAL_BOARD_OUTSIDE = 2u;
const MATERIAL_BOARD_INSIDE = 3u;
const MATERIAL_BOARD_EDGE = 4u;
const MATERIAL_SPINE = 5u;
const MATERIAL_TABLE = 6u;
// The top leaf of a stack: a leaf whose punched holes look into the stack.
const MATERIAL_RESTING_LEAF = 7u;
const MATERIAL_CARD = 8u;
const MATERIAL_WIRE = 9u;

struct Surface {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  // Leaf: arc length from the bound edge and position along it. Other
  // materials: their own surface coordinates in millimetres.
  @location(2) coordinate: vec2f,
  // Direction of increasing coordinate.x on the surface.
  @location(3) tangent: vec3f,
  // Material, leaf index (or front/back board).
  @location(4) @interpolate(flat) identity: vec2u,
}

fn project(world: vec3f) -> vec4f {
  switch VIEW {
    case 1u: { return scene.keyLightViewProjection * vec4f(world, 1.0); }
    case 2u: { return scene.skyViewProjection * vec4f(world, 1.0); }
    default: { return scene.viewProjection * vec4f(world, 1.0); }
  }
}

// The binding's frame to the world: a top binding turns a quarter turn
// about z, so the bound edge runs along x at the head.
fn toWorld(point: vec3f) -> vec3f {
  if (book.binding.x > 0.5) { return vec3f(point.y, -point.x, point.z); }
  return point;
}

fn surface(position: vec3f, normal: vec3f, coordinate: vec2f, tangent: vec3f, material: u32, leaf: u32) -> Surface {
  var output: Surface;
  let world = toWorld(position);
  output.clip = project(world);
  output.world = world;
  output.normal = toWorld(normal);
  output.coordinate = coordinate;
  output.tangent = toWorld(tangent);
  output.identity = vec2u(material, leaf);
  return output;
}

fn hidden() -> Surface {
  var output: Surface;
  output.clip = vec4f(2.0, 2.0, 2.0, 1.0);
  return output;
}

// Corner of quad `quad` in a grid `columns` quads wide, for six vertices per quad.
fn gridCorner(vertex: u32, columns: u32) -> vec2f {
  let quad = vertex / 6u;
  var corners = array<vec2u, 6>(vec2u(0, 0), vec2u(1, 0), vec2u(1, 1), vec2u(0, 0), vec2u(1, 1), vec2u(0, 1));
  let corner = corners[vertex % 6u];
  return vec2f(f32(quad % columns + corner.x), f32(quad / columns + corner.y));
}

fn leafCount() -> u32 { return u32(book.stacks.z + 0.5); }
fn leftCount() -> u32 { return u32(book.stacks.x + 0.5); }
fn rightStart() -> u32 { return u32(book.stacks.y + 0.5); }

// ---------------------------------------------------------------- rest curves

fn curveStride() -> u32 { return CURVE_SAMPLES + 1u; }
fn curveHeader(leaf: u32) -> vec4f { return curves[leaf * curveStride()]; }
fn curvePoint(leaf: u32, sample: u32) -> vec4f { return curves[leaf * curveStride() + 1u + sample]; }

// Arc length of a sample from the bound edge, as in leaf-curves.js.
fn sampleArc(sample: f32) -> f32 {
  return book.page.x * pow(sample / f32(CURVE_SAMPLES - 1u), 1.4);
}

// Leaves of a stack from the bottom: the right stack's bottom leaf is the
// last leaf, the left stack's the first.
fn stackCount(right: bool) -> u32 { return select(leftCount(), leafCount() - rightStart(), right); }
fn stackLeaf(right: bool, layer: u32) -> u32 { return select(layer, leafCount() - 1u - layer, right); }

// Cross-section point of a stack row: row 0 is the bottom leaf's lower
// face, rows 1 … count the leaves' mid-surfaces, row count + 1 the top
// leaf's upper face. xy position, zw upper normal.
fn stackRow(right: bool, row: u32, sample: u32) -> vec4f {
  let count = stackCount(right);
  let layer = clamp(row, 1u, count) - 1u;
  let leaf = stackLeaf(right, layer);
  let point = curvePoint(leaf, sample);
  var offset = 0.0;
  if (row == 0u) { offset = -0.5 * curveHeader(leaf).x; }
  if (row == count + 1u) { offset = 0.5 * curveHeader(leaf).x; }
  return vec4f(point.xy + offset * point.zw, point.zw);
}

// ---------------------------------------------------------------- turning leaves

fn gridParticle(slot: u32, column: i32, row: i32) -> vec3f {
  let columns = i32(book.grid.x);
  let index = u32(row * columns + column) + slot * u32(columns * i32(book.grid.y));
  return particles[index].xyz;
}

// Columns beyond the edges extrapolate linearly, so the spline keeps the
// edge tangent.
fn rowParticle(slot: u32, column: i32, row: i32) -> vec3f {
  let last = i32(book.grid.x) - 1;
  if (column < 0) { return 2.0 * gridParticle(slot, 0, row) - gridParticle(slot, 1, row); }
  if (column > last) { return 2.0 * gridParticle(slot, last, row) - gridParticle(slot, last - 1, row); }
  return gridParticle(slot, column, row);
}

fn leafParticle(slot: u32, column: i32, row: i32) -> vec3f {
  let last = i32(book.grid.y) - 1;
  if (row < 0) { return 2.0 * rowParticle(slot, column, 0) - rowParticle(slot, column, 1); }
  if (row > last) { return 2.0 * rowParticle(slot, column, last) - rowParticle(slot, column, last - 1); }
  return rowParticle(slot, column, row);
}

fn catmullRom(t: f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return 0.5 * vec4f(-t3 + 2.0 * t2 - t, 3.0 * t3 - 5.0 * t2 + 2.0, -3.0 * t3 + 4.0 * t2 + t, t3 - t2);
}

fn catmullRomDerivative(t: f32) -> vec4f {
  let t2 = t * t;
  return 0.5 * vec4f(-3.0 * t2 + 4.0 * t - 1.0, 9.0 * t2 - 10.0 * t, -9.0 * t2 + 8.0 * t + 1.0, 3.0 * t2 - 2.0 * t);
}

const LEAF_QUADS_ACROSS = 88u;
const LEAF_QUADS_ALONG = 56u;

fn leafVertex(vertex: u32, instance: u32) -> Surface {
  if (f32(instance) >= book.grid.z) { return hidden(); }
  let columns = book.grid.x;
  let rows = book.grid.y;
  let corner = gridCorner(vertex, LEAF_QUADS_ACROSS) / vec2f(f32(LEAF_QUADS_ACROSS), f32(LEAF_QUADS_ALONG));
  let parameter = corner * vec2f(columns - 1.0, rows - 1.0);
  let baseColumn = min(floor(parameter.x), columns - 2.0);
  let baseRow = min(floor(parameter.y), rows - 2.0);
  let weightsAcross = catmullRom(parameter.x - baseColumn);
  let weightsAlong = catmullRom(parameter.y - baseRow);
  let slopesAcross = catmullRomDerivative(parameter.x - baseColumn);
  let slopesAlong = catmullRomDerivative(parameter.y - baseRow);
  var position = vec3f(0);
  var alongColumns = vec3f(0);
  var alongRows = vec3f(0);
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let point = leafParticle(instance, i32(baseColumn) + i - 1, i32(baseRow) + j - 1);
      position += weightsAcross[i] * weightsAlong[j] * point;
      alongColumns += slopesAcross[i] * weightsAlong[j] * point;
      alongRows += weightsAcross[i] * slopesAlong[j] * point;
    }
  }
  let normal = normalize(cross(alongColumns, alongRows));
  let columnSpacing = book.page.x / (columns - 1.0);
  let rowSpacing = book.page.y / (rows - 1.0);
  let coordinate = vec2f(parameter.x * columnSpacing, -0.5 * book.page.y + parameter.y * rowSpacing);
  let leaf = u32(book.turning[instance / 4u][instance % 4u]);
  return surface(position, normal, coordinate, normalize(alongColumns), MATERIAL_LEAF, leaf);
}

@vertex
fn vs_leaf(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Surface {
  return leafVertex(vertex, instance);
}

// ---------------------------------------------------------------- resting stacks

const STACK_QUADS_ALONG = 8u;

// Instance: side (0 left, 1 right) × part (0 top leaf, 1 fore edge, 2 bound edge).
fn stackVertex(vertex: u32, instance: u32) -> Surface {
  let right = instance >= 3u;
  let part = instance % 3u;
  let count = stackCount(right);
  if (count == 0u) { return hidden(); }
  let sign = select(-1.0, 1.0, right);
  let halfLength = 0.5 * book.page.y;

  if (part == 0u) {
    // The top leaf's upper face.
    let quads = CURVE_SAMPLES - 1u;
    if (vertex >= quads * STACK_QUADS_ALONG * 6u) { return hidden(); }
    let corner = gridCorner(vertex, quads);
    let sample = u32(corner.x);
    let row = stackRow(right, count + 1u, sample);
    let y = -halfLength + corner.y / f32(STACK_QUADS_ALONG) * book.page.y;
    // The recto faces the upper normal on the right stack and away from it on the left.
    let normal = sign * row.zw;
    let tangent = sign * vec2f(row.w, -row.z);
    let leaf = stackLeaf(right, count - 1u);
    return surface(vec3f(row.x, y, row.y), vec3f(normal.x, 0.0, normal.y), vec2f(sampleArc(f32(sample)), y),
      vec3f(tangent.x, 0.0, tangent.y), MATERIAL_RESTING_LEAF, leaf);
  }
  // Fore edge: the leaves' ends from the bottom face to the top face. The
  // bound edge is the same at the binding's end of the leaves, where no
  // spine or spine strip covers it: a padded head, a fold, or the margins
  // inside a ring.
  let fore = part == 1u;
  if (!fore && book.page.w > 0.5) { return hidden(); }
  let quads = count + 1u;
  if (vertex >= quads * 4u * 6u) { return hidden(); }
  let corner = gridCorner(vertex, quads);
  let row = u32(corner.x);
  let sample = select(0u, CURVE_SAMPLES - 1u, fore);
  let point = stackRow(right, row, sample).xy;
  let below = stackRow(right, max(row, 1u) - 1u, sample).xy;
  let above = stackRow(right, min(row + 1u, count + 1u), sample).xy;
  let rising = normalize(above - below + vec2f(0.0, 1e-6));
  let outward = sign * select(-1.0, 1.0, fore);
  let normal = outward * vec2f(rising.y, -rising.x);
  let y = -halfLength + corner.y / 4.0 * book.page.y;
  let layer = clamp(f32(row) - 0.5, 0.0, f32(count));
  return surface(vec3f(point.x, y, point.y), vec3f(normal.x, 0.0, normal.y), vec2f(y, layer),
    vec3f(0, 1, 0), MATERIAL_PAGE_EDGE, 0u);
}

@vertex
fn vs_stack(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Surface {
  return stackVertex(vertex, instance);
}

// Head and tail of the stacks: strips between neighbouring rows of the
// rest curves. Instance: side (0 left, 1 right) × end (0 head, 1 tail).
fn stackEndVertex(vertex: u32, instance: u32) -> Surface {
  let right = instance >= 2u;
  let head = instance % 2u == 0u;
  let count = stackCount(right);
  let quads = CURVE_SAMPLES - 1u;
  if (count == 0u || vertex >= (count + 1u) * quads * 6u) { return hidden(); }
  let corner = gridCorner(vertex, quads);
  let sample = u32(corner.x);
  let row = u32(corner.y);
  let point = stackRow(right, row, sample).xy;
  let y = select(-0.5, 0.5, head) * book.page.y;
  let layer = clamp(f32(row) - 0.5, 0.0, f32(count));
  let sign = select(-1.0, 1.0, right);
  return surface(vec3f(point.x, y, point.y), vec3f(0.0, select(-1.0, 1.0, head), 0.0),
    vec2f(sampleArc(f32(sample)), layer), vec3f(sign, 0.0, 0.0), MATERIAL_PAGE_EDGE, 1u);
}

@vertex
fn vs_stack_ends(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Surface {
  return stackEndVertex(vertex, instance);
}

// ---------------------------------------------------------------- boards and spine

// Board frame: along the board away from the hinge, and its outward normal.
fn boardAxes(angle: f32) -> mat2x2f {
  return mat2x2f(vec2f(cos(angle), sin(angle)), vec2f(-sin(angle), cos(angle)));
}

fn shellPoint(index: u32) -> vec4f {
  return curves[leafCount() * curveStride() + index];
}

// The spine of a hardcover or the spine strip of a soft cover: between the
// block's outline next to the binding (its inner surface) and that outline
// moved out by the cover's thickness. Parts: 0 outside, 1 inside, 2 head,
// 3 tail.
fn shellVertex(vertex: u32) -> Surface {
  let points = u32(book.page.w + 0.5);
  if (points < 2u) { return hidden(); }
  let segments = points - 1u;
  let part = vertex / (segments * 6u);
  if (part >= 4u) { return hidden(); }
  let corner = gridCorner(vertex % (segments * 6u), segments);
  let index = u32(corner.x);
  let point = shellPoint(index);
  let hard = book.binding.y > 1.5;
  let halfLength = 0.5 * book.page.y + select(0.0, book.board.y, hard);
  // Along the outline, from the neighbouring points.
  let before = shellPoint(max(index, 1u) - 1u);
  let after = shellPoint(min(index + 1u, segments));
  let outerDirection = normalize(after.zw - before.zw + vec2f(1e-6, 0.0));
  let innerDirection = normalize(after.xy - before.xy + vec2f(1e-6, 0.0));
  // The outline runs from the front of the block to the back, so its
  // outward side is to its right.
  let outerNormal = vec2f(outerDirection.y, -outerDirection.x);
  let innerNormal = vec2f(-innerDirection.y, innerDirection.x);
  let outsideMaterial = select(MATERIAL_CARD, MATERIAL_SPINE, hard);
  let edgeMaterial = select(MATERIAL_CARD, MATERIAL_BOARD_EDGE, hard);
  var distance = 0.0;
  for (var step = 1u; step <= index; step++) { distance += length(shellPoint(step).zw - shellPoint(step - 1u).zw); }
  if (part < 2u) {
    let outside = part == 0u;
    let y = (corner.y * 2.0 - 1.0) * halfLength;
    let xz = select(point.xy, point.zw, outside);
    let normal = select(innerNormal, outerNormal, outside);
    let direction = select(innerDirection, outerDirection, outside);
    return surface(vec3f(xz.x, y, xz.y), vec3f(normal.x, 0.0, normal.y), vec2f(distance, y),
      vec3f(direction.x, 0.0, direction.y), outsideMaterial, 2u);
  }
  let head = part == 2u;
  let y = select(-halfLength, halfLength, head);
  let xz = mix(point.xy, point.zw, corner.y);
  return surface(vec3f(xz.x, y, xz.y), vec3f(0.0, select(-1.0, 1.0, head), 0.0),
    vec2f(distance, corner.y * length(point.zw - point.xy)), vec3f(outerDirection.x, 0.0, outerDirection.y), edgeMaterial, 2u);
}

// Instance 0 front board, 1 back board, 2 spine or spine strip.
fn boardVertex(vertex: u32, instance: u32) -> Surface {
  if (instance == 2u) { return shellVertex(vertex); }
  let hard = book.binding.y > 1.5;
  if (!hard && (instance == 0u || book.binding.z <= 0.0)) { return hidden(); }
  // A box of six faces, two triangles each.
  if (vertex >= 36u) { return hidden(); }
  let front = instance == 0u;
  let square = book.board.y;
  let width = book.page.x + square;
  let halfLength = 0.5 * book.page.y + square;
  var angle = select(0.0, book.stacks.w, front);
  var hinge = vec2f(0.0, book.board.z);
  var inner = select(-book.board.w, book.board.w, front);
  var outer = select(-book.board.w - book.board.x, book.board.w + book.board.x, front);
  if (!hard) {
    // A pad's backing board lies flat on the table under its leaves.
    angle = 0.0;
    hinge = vec2f(0.0, 0.0);
    inner = book.binding.z;
    outer = 0.0;
  }
  let axes = boardAxes(angle);
  let face = vertex / 6u;
  var corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1));
  let c = corners[vertex % 6u];
  let outward = sign(outer - inner);
  var local: vec3f;   // along, y, across
  var localNormal: vec3f;
  var material = select(MATERIAL_CARD, MATERIAL_BOARD_EDGE, hard);
  let outsideMaterial = select(MATERIAL_CARD, MATERIAL_BOARD_OUTSIDE, hard);
  let insideMaterial = select(MATERIAL_CARD, MATERIAL_BOARD_INSIDE, hard);
  switch face {
    case 0u: { local = vec3f(c.x * width, (c.y * 2.0 - 1.0) * halfLength, outer); localNormal = vec3f(0, 0, outward); material = outsideMaterial; }
    case 1u: { local = vec3f(c.x * width, (c.y * 2.0 - 1.0) * halfLength, inner); localNormal = vec3f(0, 0, -outward); material = insideMaterial; }
    case 2u: { local = vec3f(width, (c.x * 2.0 - 1.0) * halfLength, mix(inner, outer, c.y)); localNormal = vec3f(1, 0, 0); }
    case 3u: { local = vec3f(c.x * width, halfLength, mix(inner, outer, c.y)); localNormal = vec3f(0, 1, 0); }
    case 4u: { local = vec3f(c.x * width, -halfLength, mix(inner, outer, c.y)); localNormal = vec3f(0, -1, 0); }
    default: { local = vec3f(0.0, (c.x * 2.0 - 1.0) * halfLength, mix(inner, outer, c.y)); localNormal = vec3f(-1, 0, 0); }
  }
  let planar = hinge + axes * vec2f(local.x, local.z);
  let planarNormal = axes * vec2f(localNormal.x, localNormal.z);
  let tangent = axes * vec2f(1.0, 0.0);
  return surface(vec3f(planar.x, local.y, planar.y), vec3f(planarNormal.x, localNormal.y, planarNormal.y),
    vec2f(local.x, local.y), vec3f(tangent.x, 0.0, tangent.y), material, instance);
}

@vertex
fn vs_board(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Surface {
  return boardVertex(vertex, instance);
}

// ---------------------------------------------------------------- wire

const RING_SEGMENTS = 48u;
const WIRE_SIDES = 8u;

// A ring binding's wire loops: one ring through the holes per instance.
fn ringVertex(vertex: u32, instance: u32) -> Surface {
  if (book.binding.w < 0.5 || f32(instance) >= book.holes.w) { return hidden(); }
  let corner = gridCorner(vertex, RING_SEGMENTS);
  let around = corner.x / f32(RING_SEGMENTS) * 2.0 * PI;
  let across = corner.y / f32(WIRE_SIDES) * 2.0 * PI;
  let centre = book.rings.xy;
  let radial = vec2f(cos(around), sin(around));
  let y = (f32(instance) - 0.5 * (book.holes.w - 1.0)) * book.holes.z;
  let normal = vec3f(radial.x * cos(across), sin(across), radial.y * cos(across));
  let position = vec3f(centre.x, y, centre.y) + book.rings.z * vec3f(radial.x, 0.0, radial.y) + book.rings.w * normal;
  return surface(position, normal, vec2f(around * book.rings.z, across), vec3f(-radial.y, 0.0, radial.x), MATERIAL_WIRE, 0u);
}

@vertex
fn vs_rings(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Surface {
  return ringVertex(vertex, instance);
}

// A saddle stitch's two staples: the crown on the outside of the fold and
// the clinched legs inside the middle spread. Instance: staple × (crown,
// leg, leg); each a thin box.
fn stapleVertex(vertex: u32, instance: u32) -> Surface {
  if (book.covers.w < 0.5 || vertex >= 36u) { return hidden(); }
  let staple = instance / 3u;
  let piece = instance % 3u;
  let crownLength = 12.0;
  let wire = 0.45;
  let centreY = select(-0.25, 0.25, staple == 1u) * book.page.y;
  let outward = book.staple.zw;
  var start = centreY - 0.5 * crownLength;
  var end = centreY + 0.5 * crownLength;
  var offset = 0.5 * wire;
  if (piece == 1u) { end = start + 3.5; offset = -0.5 * wire; }
  if (piece == 2u) { start = end - 3.5; offset = -0.5 * wire; }
  let middle = book.staple.xy + offset * outward;
  let side = vec2f(-outward.y, outward.x);
  let face = vertex / 6u;
  var corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1));
  let c = corners[vertex % 6u] * 2.0 - 1.0;
  var local: vec3f;   // across the wire (side), along y, out (outward); in half extents
  var normal: vec3f;
  switch face {
    case 0u: { local = vec3f(c.x, c.y, 1.0); normal = vec3f(0, 0, 1); }
    case 1u: { local = vec3f(c.x, c.y, -1.0); normal = vec3f(0, 0, -1); }
    case 2u: { local = vec3f(1.0, c.x, c.y); normal = vec3f(1, 0, 0); }
    case 3u: { local = vec3f(-1.0, c.x, c.y); normal = vec3f(-1, 0, 0); }
    case 4u: { local = vec3f(c.x, 1.0, c.y); normal = vec3f(0, 1, 0); }
    default: { local = vec3f(c.x, -1.0, c.y); normal = vec3f(0, -1, 0); }
  }
  let planar = middle + 0.5 * wire * (local.x * side + local.z * outward);
  let y = mix(start, end, 0.5 * local.y + 0.5);
  let planarNormal = normal.x * side + normal.z * outward;
  return surface(vec3f(planar.x, y, planar.y), vec3f(planarNormal.x, normal.y, planarNormal.y), vec2f(y, 0.0),
    vec3f(0, 1, 0), MATERIAL_WIRE, 1u);
}

@vertex
fn vs_staples(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Surface {
  return stapleVertex(vertex, instance);
}

// ---------------------------------------------------------------- table

@vertex
fn vs_table(@builtin(vertex_index) vertex: u32) -> Surface {
  var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let point = corners[vertex] * 1600.0;
  // The table is already in the world; a top binding's turn leaves it unchanged.
  var output = surface(vec3f(point, 0.0), vec3f(0, 0, 1), point, vec3f(1, 0, 0), MATERIAL_TABLE, 0u);
  output.world = vec3f(point, 0.0);
  output.clip = project(output.world);
  output.normal = vec3f(0, 0, 1);
  output.tangent = vec3f(1, 0, 0);
  return output;
}
