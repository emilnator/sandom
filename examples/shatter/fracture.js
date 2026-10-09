// Voronoi fracture of a rectangular pane into extruded convex shards.
//
// Pane space: x right, y up, origin at the pane centre, in scene metres.
// Every shard geometry is centred on its own polygon centroid so a rigid
// transform rotates it about its mass; `centroid` says where the shard sits
// in pane space when the pane is intact. UVs are pane space mapped to
// [0, 1] with v = 0 at the top edge: the ExternalTexture samples Sandom's
// row 0 (the top of the document) at v = 0.

import { BufferGeometry, Float32BufferAttribute } from "three";

// Deterministic PRNG so the same impact point always yields the same shards.
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeds dense around the impact and sparse across the rest of the pane.
export function impactSeeds({ width, height, impact, random, dense = 26, sparse = 44 }) {
  const seeds = [];
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const inside = (x, y) =>
    Math.abs(x) < halfWidth - 0.005 && Math.abs(y) < halfHeight - 0.005;
  const far = (x, y) =>
    seeds.every((seed) => (seed.x - x) ** 2 + (seed.y - y) ** 2 > 0.0004);
  let attempts = 0;
  while (seeds.length < dense && attempts++ < dense * 40) {
    const angle = random() * Math.PI * 2;
    const radius = 0.02 + random() ** 2 * 0.55;
    const x = impact.x + Math.cos(angle) * radius;
    const y = impact.y + Math.sin(angle) * radius * 1.15;
    if (inside(x, y) && far(x, y)) seeds.push({ x, y });
  }
  attempts = 0;
  while (seeds.length < dense + sparse && attempts++ < sparse * 40) {
    const x = (random() - 0.5) * width;
    const y = (random() - 0.5) * height;
    if (inside(x, y) && far(x, y)) seeds.push({ x, y });
  }
  return seeds;
}

// Sutherland–Hodgman clip of a convex polygon against the half-plane
// (p - m) · n <= 0.
function clipHalfPlane(polygon, midX, midY, normalX, normalY) {
  const output = [];
  const count = polygon.length;
  for (let index = 0; index < count; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % count];
    const currentSide = (current.x - midX) * normalX + (current.y - midY) * normalY;
    const nextSide = (next.x - midX) * normalX + (next.y - midY) * normalY;
    if (currentSide <= 0) output.push(current);
    if ((currentSide <= 0) !== (nextSide <= 0)) {
      const t = currentSide / (currentSide - nextSide);
      output.push({
        x: current.x + (next.x - current.x) * t,
        y: current.y + (next.y - current.y) * t,
      });
    }
  }
  return output;
}

export function voronoiCells({ width, height, seeds }) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const rectangle = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ];
  const cells = [];
  for (const seed of seeds) {
    let polygon = rectangle;
    for (const other of seeds) {
      if (other === seed) continue;
      polygon = clipHalfPlane(
        polygon,
        (seed.x + other.x) / 2,
        (seed.y + other.y) / 2,
        other.x - seed.x,
        other.y - seed.y,
      );
      if (polygon.length < 3) break;
    }
    if (polygon.length >= 3) cells.push(polygon);
  }
  return cells;
}

function polygonCentroid(polygon) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-9) {
    const mean = polygon.reduce((sum, p) => ({ x: sum.x + p.x, y: sum.y + p.y }), { x: 0, y: 0 });
    return { x: mean.x / polygon.length, y: mean.y / polygon.length, area: 0 };
  }
  return { x: cx / (6 * area), y: cy / (6 * area), area: Math.abs(area) };
}

// One extruded shard. Geometry group 0 is the front and back faces (the
// screen material); group 1 is the side walls (the glass edge material).
export function shardGeometry({ polygon, width, height, thickness }) {
  const centroid = polygonCentroid(polygon);
  const halfThickness = thickness / 2;
  const count = polygon.length;
  const positions = [];
  const normals = [];
  const uvs = [];
  const local = polygon.map((point) => ({
    x: point.x - centroid.x,
    y: point.y - centroid.y,
    u: (point.x + width / 2) / width,
    v: (height / 2 - point.y) / height,
  }));
  const pushVertex = (point, z, nx, ny, nz) => {
    positions.push(point.x, point.y, z);
    normals.push(nx, ny, nz);
    uvs.push(point.u, point.v);
  };
  for (let index = 1; index < count - 1; index++) {
    pushVertex(local[0], halfThickness, 0, 0, 1);
    pushVertex(local[index], halfThickness, 0, 0, 1);
    pushVertex(local[index + 1], halfThickness, 0, 0, 1);
  }
  for (let index = 1; index < count - 1; index++) {
    pushVertex(local[0], -halfThickness, 0, 0, -1);
    pushVertex(local[index + 1], -halfThickness, 0, 0, -1);
    pushVertex(local[index], -halfThickness, 0, 0, -1);
  }
  const faceVertexCount = positions.length / 3;
  for (let index = 0; index < count; index++) {
    const a = local[index];
    const b = local[(index + 1) % count];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = dy / length;
    const ny = -dx / length;
    pushVertex(a, halfThickness, nx, ny, 0);
    pushVertex(a, -halfThickness, nx, ny, 0);
    pushVertex(b, -halfThickness, nx, ny, 0);
    pushVertex(a, halfThickness, nx, ny, 0);
    pushVertex(b, -halfThickness, nx, ny, 0);
    pushVertex(b, halfThickness, nx, ny, 0);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.addGroup(0, faceVertexCount, 0);
  geometry.addGroup(faceVertexCount, positions.length / 3 - faceVertexCount, 1);
  let radius = 0;
  for (const point of local) {
    radius = Math.max(radius, Math.hypot(point.x, point.y, halfThickness));
  }
  // Contact vertices for the floor test: both rings of the prism.
  const contactPoints = [];
  for (const point of local) {
    contactPoints.push(point.x, point.y, halfThickness, point.x, point.y, -halfThickness);
  }
  return {
    geometry,
    centroid: { x: centroid.x, y: centroid.y },
    radius,
    contactPoints: new Float32Array(contactPoints),
  };
}
