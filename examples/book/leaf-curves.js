// The resting leaves of a book as one family of cross-section curves, the
// single source of the resting geometry: the stack tops, fore edges, head
// and tail faces and the spine's inner surface are all drawn from these
// samples, turning leaves land on them, and settling leaves relax into them.
//
// A resting leaf runs from its pivot (bindings.js) to its level on its
// stack. Between the two it takes the shape of a heavy elastic sheet pinned
// at one end and lying on a flat support beyond:
//
//   height(d) = level + drop · (1 − d/ℓ)³ (1 + d/ℓ)   for d < ℓ, else level
//
// where d is the distance from the pivot across the binding and drop the
// pivot's height above the level. The small-slope theory of that sheet gives
// this profile with ℓ growing as the fourth root of the drop; the scale of ℓ
// for each paper is fitted to the simulated leaf of book-model.js, relaxed
// freely from a pivot lifted 0.5 … 48 mm above a flat support (worst
// deviation from the profile 0.04 mm up to 6 mm, 1.6 mm at 48 mm).
//
// Each curve is sampled at fixed arc lengths from the leaf's bound edge, so
// samples with the same index on neighbouring leaves face each other.

import { placePivots } from "./bindings.js";

export const CURVE_SAMPLES = 65;
// Samples crowd toward the bound edge, where the curves bend.
const SAMPLE_DISTRIBUTION = 1.4;
// ℓ = scale · drop^¼ / (1 + drop / GUTTER_SATURATION), in millimetres.
const GUTTER_SCALES = { 90: 37.8, 150: 35.2, 250: 33.0, 300: 32.5 };
const GUTTER_SATURATION = 400;
const ARC_STEPS = 64;
// Floats per leaf in the GPU buffer: a header and the samples, four each.
export const LEAF_STRIDE = 4 * (CURVE_SAMPLES + 1);

const gutterLength = (grammage, drop) => {
  const scale = GUTTER_SCALES[grammage];
  if (scale === undefined) {
    throw new Error(`No fitted gutter for ${grammage} g/m²; fitted papers: ${Object.keys(GUTTER_SCALES).join(", ")} g/m²`);
  }
  const size = Math.abs(drop);
  return scale * size ** 0.25 / (1 + size / GUTTER_SATURATION);
};

const profile = (fraction) => {
  if (fraction >= 1) return 0;
  const rest = 1 - fraction;
  return rest * rest * rest * (1 + fraction);
};

const profileSlope = (fraction) => {
  if (fraction >= 1) return 0;
  const rest = 1 - fraction;
  return -rest * rest * (2 + 4 * fraction);
};

export const sampleArcs = (leafAcross) => Float64Array.from({ length: CURVE_SAMPLES }, (_, sample) =>
  leafAcross * (sample / (CURVE_SAMPLES - 1)) ** SAMPLE_DISTRIBUTION);

// Writes x, z and the unit normal on the leaf's upper side at each arc
// length of `arcs` (from the bound edge) into `target`, four floats apart.
// `curve`: { pivotX, pivotZ, side, level, grammage, pivotArc, centreX, centreZ }.
// Before its pivot a ring-bound leaf's margin runs straight into the ring,
// toward the ring's centre.
export const writeRestCurve = (target, offset, curve, arcs) => {
  const { pivotX, pivotZ, side, level, grammage, pivotArc } = curve;
  const drop = pivotZ - level;
  const flat = Math.abs(drop) < 1e-9;
  const length = flat ? 1 : gutterLength(grammage, drop);
  const cumulative = new Float64Array(ARC_STEPS + 1);
  const step = length / ARC_STEPS;
  let previous = flat ? 1 : Math.hypot(1, drop * profileSlope(0) / length);
  for (let index = 1; index <= ARC_STEPS; index++) {
    const current = flat ? 1 : Math.hypot(1, drop * profileSlope(index / ARC_STEPS) / length);
    cumulative[index] = cumulative[index - 1] + step * (previous + current) / 2;
    previous = current;
  }
  let marginX = 0;
  let marginZ = 0;
  if (pivotArc > 0) {
    const towardX = curve.centreX - pivotX;
    const towardZ = curve.centreZ - pivotZ;
    const distance = Math.hypot(towardX, towardZ);
    marginX = towardX / distance;
    marginZ = towardZ / distance;
  }
  for (let index = 0; index < arcs.length; index++) {
    const along = arcs[index] - pivotArc;
    const base = offset + 4 * index;
    let tangentX;
    let tangentZ;
    if (along < 0) {
      target[base] = pivotX - along * marginX;
      target[base + 1] = pivotZ - along * marginZ;
      tangentX = -marginX;
      tangentZ = -marginZ;
    } else {
      let distance;
      if (along >= cumulative[ARC_STEPS]) {
        distance = length + along - cumulative[ARC_STEPS];
      } else {
        let low = 0;
        let high = ARC_STEPS;
        while (high - low > 1) {
          const middle = (low + high) >> 1;
          if (cumulative[middle] <= along) low = middle;
          else high = middle;
        }
        distance = step * (low + (along - cumulative[low]) / (cumulative[high] - cumulative[low]));
      }
      const fraction = distance / length;
      const slope = flat ? 0 : drop * profileSlope(fraction) / length;
      const norm = Math.hypot(1, slope);
      target[base] = pivotX + side * distance;
      target[base + 1] = flat ? level : level + drop * profile(fraction);
      tangentX = side / norm;
      tangentZ = slope / norm;
    }
    // The upper side: the tangent turned toward +z for a leaf running right
    // from its pivot, and likewise for one running left.
    target[base + 2] = side > 0 ? -tangentZ : tangentZ;
    target[base + 3] = side > 0 ? tangentX : -tangentX;
  }
};

// ---------------------------------------------------------------- the family

export class LeafCurves {
  constructor(block, leafAcross) {
    const count = block.leafCount;
    this.block = block;
    this.leafAcross = leafAcross;
    this.arcs = sampleArcs(leafAcross);
    this.samples = new Float64Array(count * CURVE_SAMPLES * 4);
    this.sides = new Int8Array(count);
    this.pivotX = new Float64Array(count);
    this.pivotZ = new Float64Array(count);
    this.scratchX = new Float64Array(count);
    this.scratchZ = new Float64Array(count);
    // Per leaf, from the cover's spine strip toward the leaf (glued backs only).
    this.gluedFrom = block.spinePanel > 0 ? new Float64Array(2 * count) : null;
    // Per side: the curve of the leaf that would join that stack next.
    this.joining = { 1: null, [-1]: null };
    // Inner and outer outline of the spine or the cover's spine strip.
    this.shell = [];
    this.key = "";
    this.version = 0;
  }

  // Recomputes the family for an opening state { leftCount, rightStart,
  // boardAngle }; returns whether anything changed.
  update(state) {
    const key = `${state.leftCount} ${state.rightStart} ${state.boardAngle}`;
    if (key === this.key) return false;
    this.key = key;
    this.version++;
    const { block } = this;
    const { leftCount, rightStart } = state;
    placePivots(block, state, this.pivotX, this.pivotZ, this.gluedFrom);
    for (let leaf = 0; leaf < block.leafCount; leaf++) {
      const side = leaf < leftCount ? -1 : leaf >= rightStart ? 1 : 0;
      this.sides[leaf] = side;
      const offset = leaf * CURVE_SAMPLES * 4;
      if (side !== 0) {
        writeRestCurve(this.samples, offset, this.curveSpec(leaf, side, this.pivotX, this.pivotZ), this.arcs);
        continue;
      }
      for (let sample = 0; sample < CURVE_SAMPLES; sample++) {
        this.samples.set([this.pivotX[leaf], this.pivotZ[leaf], 0, 1], offset + 4 * sample);
      }
    }
    this.joining[1] = rightStart - 1 >= leftCount
      ? this.joiningCurve(rightStart - 1, 1, { ...state, rightStart: rightStart - 1 })
      : null;
    this.joining[-1] = leftCount < rightStart
      ? this.joiningCurve(leftCount, -1, { ...state, leftCount: leftCount + 1 })
      : null;
    this.buildShell(state);
    return true;
  }

  curveSpec(leaf, side, pivotX, pivotZ) {
    const { block } = this;
    return {
      pivotX: pivotX[leaf], pivotZ: pivotZ[leaf], side, level: block.level(leaf, side),
      grammage: block.grammages[leaf], pivotArc: block.pivotArc,
      centreX: block.ringCentre?.[0] ?? 0, centreZ: block.ringCentre?.[1] ?? 0,
    };
  }

  joiningCurve(leaf, side, state) {
    placePivots(this.block, state, this.scratchX, this.scratchZ);
    const spec = this.curveSpec(leaf, side, this.scratchX, this.scratchZ);
    const samples = new Float64Array(CURVE_SAMPLES * 4);
    writeRestCurve(samples, 0, spec, this.arcs);
    // The floor starts at the pivot: a ring-bound leaf's margin is inside
    // the ring, clear of the turning leaves.
    let first = 0;
    while (first + 1 < CURVE_SAMPLES && this.arcs[first] < this.block.pivotArc) first++;
    return { leaf, side, spec, samples, first };
  }

  restingSpec(leaf) {
    const side = this.sides[leaf];
    if (side === 0) throw new Error(`Leaf ${leaf} is turning, not resting; it has no rest curve`);
    return this.curveSpec(leaf, side, this.pivotX, this.pivotZ);
  }

  // Height of the mid-surface of the next leaf to join the stack under x, or
  // NaN beyond both joining curves.
  floorAt(x) {
    const right = this.joining[1];
    if (right && x >= right.samples[4 * right.first]) return curveHeightAt(right, x, 1);
    const left = this.joining[-1];
    if (left && x <= left.samples[4 * left.first]) return curveHeightAt(left, x, -1);
    return NaN;
  }

  // Sample `sample` of leaf `leaf`: x, z, upper normal x, z.
  point(leaf, sample) {
    const offset = (leaf * CURVE_SAMPLES + sample) * 4;
    return [this.samples[offset], this.samples[offset + 1], this.samples[offset + 2], this.samples[offset + 3]];
  }

  // A face of a leaf: the mid-surface moved half a caliper along the normal.
  face(leaf, sample, direction) {
    const [x, z, normalX, normalZ] = this.point(leaf, sample);
    const half = direction * this.block.calipers[leaf] / 2;
    return [x + half * normalX, z + half * normalZ];
  }

  // The block's outline next to the binding, from the front to the back: the
  // bound edges of the left stack from its bottom face up, the pivots of the
  // turning leaves, then the right stack from its top face down. Each point
  // is [x, z, the leaf it belongs to].
  spineOutline(state) {
    const { leftCount, rightStart } = state;
    const count = this.block.leafCount;
    const outline = [];
    const pivot = (leaf) => [this.pivotX[leaf], this.pivotZ[leaf], leaf];
    if (leftCount > 0) {
      outline.push([...this.face(0, 0, -1), 0]);
      for (let leaf = 0; leaf < leftCount; leaf++) outline.push(pivot(leaf));
      outline.push([...this.face(leftCount - 1, 0, 1), leftCount - 1]);
    }
    for (let leaf = leftCount; leaf < rightStart; leaf++) outline.push(pivot(leaf));
    if (rightStart < count) {
      outline.push([...this.face(rightStart, 0, 1), rightStart]);
      for (let leaf = rightStart; leaf < count; leaf++) outline.push(pivot(leaf));
      outline.push([...this.face(count - 1, 0, -1), count - 1]);
    }
    return outline;
  }

  // The spine of a hardcover is an arc about the boards' hinge between the
  // two boards' joints; a soft cover's spine strip is glued along the back,
  // one card's thickness behind the leaves. Either one's inner surface is
  // the block's outline.
  buildShell(state) {
    const { block } = this;
    this.shell = [];
    if (block.hard) {
      const halfBlock = block.thickness / 2;
      const hinge = block.boardThickness + halfBlock;
      const outerRadius = halfBlock + block.boardThickness;
      const angle = state.boardAngle;
      const frontJoint = [-halfBlock * Math.sin(angle), hinge + halfBlock * Math.cos(angle)];
      const backJoint = [0, hinge - halfBlock];
      const inner = [frontJoint, ...this.spineOutline(state), backJoint];
      const lowest = angle - 1.5 * Math.PI;
      for (const [x, z] of inner) {
        let direction = Math.atan2(z - hinge, x);
        if (direction > 0) direction -= 2 * Math.PI;
        direction = Math.min(-Math.PI / 2, Math.max(lowest, direction));
        this.shell.push([x, z, outerRadius * Math.cos(direction), hinge + outerRadius * Math.sin(direction)]);
      }
      return;
    }
    if (block.spinePanel > 0) {
      for (const [x, z, leaf] of this.spineOutline(state)) {
        const normalX = this.gluedFrom[2 * leaf];
        const normalZ = this.gluedFrom[2 * leaf + 1];
        this.shell.push([x, z, x - block.spinePanel * normalX, z - block.spinePanel * normalZ]);
      }
    }
  }

  // The GPU copy: per leaf a header (caliper, side, pivot arc, level) and
  // the samples; then the shell's inner and outer points.
  write(target) {
    const { block } = this;
    for (let leaf = 0; leaf < block.leafCount; leaf++) {
      const base = leaf * LEAF_STRIDE;
      const side = this.sides[leaf];
      target[base] = block.calipers[leaf];
      target[base + 1] = side;
      target[base + 2] = block.pivotArc;
      target[base + 3] = side === 0 ? 0 : block.level(leaf, side);
      target.set(this.samples.subarray(leaf * CURVE_SAMPLES * 4, (leaf + 1) * CURVE_SAMPLES * 4), base + 4);
    }
    const shellBase = block.leafCount * LEAF_STRIDE;
    this.shell.forEach((point, index) => target.set(point, shellBase + 4 * index));
  }
}

const curveHeightAt = (curve, x, side) => {
  const { samples, first } = curve;
  let low = first;
  let high = CURVE_SAMPLES - 1;
  const lastX = samples[4 * high];
  if (side * (x - lastX) >= 0) return NaN;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (side * (x - samples[4 * middle]) >= 0) low = middle;
    else high = middle;
  }
  const lowX = samples[4 * low];
  const highX = samples[4 * high];
  const blend = highX === lowX ? 0 : (x - lowX) / (highX - lowX);
  return samples[4 * low + 1] + (samples[4 * high + 1] - samples[4 * low + 1]) * blend;
};
