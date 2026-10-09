// A book as a physical model, in millimetres, grams and seconds.
//
// Frame: the binding's cross-section. x runs across the binding, with the
// bound edge at x ≈ 0 and the right stack at x > 0; y runs along the bound
// edge; z is up from the table. A top-bound pad uses the same frame, and
// page.js turns it a quarter turn so its bound edge runs across the head.
//
// Leaves are numbered from the front: 0 is the front free endpaper of a
// hardcover or the front cover of a soft-covered book. At any moment leaves
// 0 … leftCount − 1 rest on the left stack, leaves rightStart … leafCount − 1
// rest on the right stack, and the leaves between them are turning.
//
// A resting leaf lies on its rest curve (leaf-curves.js), from its pivot
// (bindings.js) to its level on the stack. A turning leaf is an inextensible
// plate on a particle grid, solved with small-step XPBD: rigid stretch and
// shear, plate bending and twist from the paper's measured stiffness,
// gravity, quadratic air drag normal to the sheet, an air cushion above the
// stacks, and friction on contact. Its bound edge is held at its pivot; the
// hole of a ring-bound leaf slides on the ring instead, and the margin
// beyond the hole points into the ring.
//
// A hardcover's boards are rigid: the back board lies under the right
// stack, and the front board turns about the hinge in the middle of the
// block's thickness, onto the table under the left stack.

import { BookBlock, bookType, PAPER_GRAMMAGES, turningCentre } from "./bindings.js";
import { LeafCurves, writeRestCurve, LEAF_STRIDE, CURVE_SAMPLES } from "./leaf-curves.js";

export { PAPER_GRAMMAGES, LEAF_STRIDE, CURVE_SAMPLES };
export const GRID_COLUMNS = 22;
export const GRID_ROWS = 15;
export const PARTICLES_PER_LEAF = GRID_COLUMNS * GRID_ROWS;
export const MAXIMUM_TURNING_LEAVES = 8;

const GRAVITY = 9810;
const AIR_DENSITY = 1.2e-6;
const PLATE_DRAG_COEFFICIENT = 1.2;
// 1 Pa is 1 g/(mm·s²) in these units.
const YOUNGS_MODULUS = 4e9;
const POISSON_RATIO = 0.3;
const CALIPER_PER_GRAMMAGE = 0.00125;
const FIXED_STEP = 1 / 120;
const SUBSTEPS = 8;
const STRETCH_SWEEPS = 4;
const MAXIMUM_STEP = 1 / 30;
// Stiff enough that the grip holds the paper within about a millimetre
// against its own weight; the hand's easing supplies the softness.
const HAND_COMPLIANCE = 2e-5;
const HAND_FOLLOW_RATE = 20;
const MINIMUM_GRIP_REACH = 0.85;
// Fastest the hand moves: angle about the leaf's pivot (rad/s), distance
// from it (mm/s), and along the bound edge (mm/s).
const HAND_SPEED_LIMITS = [5, 400, 400];
// Squeeze film under a leaf approaching a stack: viscous damping rate of
// normal motion at contact, and the gap over which it falls to one eighth.
const SQUEEZE_FILM_RATE = 220;
const SQUEEZE_FILM_GAP = 20;
// Internal friction of the paper: the share of each particle's velocity
// relative to its neighbours removed per substep.
const PAPER_DAMPING = 0.12;
const SETTLE_COMPLIANCE = 0.2;
const FRICTION = 0.6;
const BOARD_HAND_STIFFNESS = 900;
const BOARD_AIR_DRAG = 0.4;
const BOARD_HINGE_FRICTION = 2;
const BOARD_RESTITUTION = 0.15;
// Fastest a turning leaf's bound edge moves to a new pivot (mm/s), as when
// the fold of a glued back shifts under a leaf that joins a stack.
const PIVOT_SPEED = 60;

// ---------------------------------------------------------------- grid topology

const particleIndex = (column, row) => row * GRID_COLUMNS + column;

// Constraint index lists. In a ring binding column 0 is the margin beyond
// the hole, placed from the hole each substep, so no constraint acts on it:
// the hole slides on the ring and the leaf pivots there freely.
const buildTopology = (freeAtHole) => {
  const stretch = [];
  const columnBends = [];
  const rowBends = [];
  const twists = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let column = 0; column < GRID_COLUMNS; column++) {
      if (freeAtHole && column === 0) continue;
      const here = particleIndex(column, row);
      if (column + 1 < GRID_COLUMNS) stretch.push(here, particleIndex(column + 1, row));
      if (row + 1 < GRID_ROWS) stretch.push(here, particleIndex(column, row + 1));
      if (column + 1 < GRID_COLUMNS && row + 1 < GRID_ROWS) {
        stretch.push(here, particleIndex(column + 1, row + 1));
        stretch.push(particleIndex(column + 1, row), particleIndex(column, row + 1));
        twists.push(here, particleIndex(column + 1, row), particleIndex(column, row + 1), particleIndex(column + 1, row + 1));
      }
      if (column + 2 < GRID_COLUMNS) columnBends.push(here, particleIndex(column + 1, row), particleIndex(column + 2, row));
      if (row + 2 < GRID_ROWS) rowBends.push(here, particleIndex(column, row + 1), particleIndex(column, row + 2));
    }
  }
  return {
    stretch: Uint16Array.from(stretch),
    columnBends: Uint16Array.from(columnBends),
    rowBends: Uint16Array.from(rowBends),
    twists: Uint16Array.from(twists),
  };
};

const restLengthsFor = (stretch, columnSpacing, rowSpacing) => {
  const restLengths = new Float64Array(stretch.length / 2);
  for (let constraint = 0; constraint < restLengths.length; constraint++) {
    const a = stretch[2 * constraint];
    const b = stretch[2 * constraint + 1];
    const columnDelta = (a % GRID_COLUMNS - b % GRID_COLUMNS) * columnSpacing;
    const rowDelta = (Math.floor(a / GRID_COLUMNS) - Math.floor(b / GRID_COLUMNS)) * rowSpacing;
    restLengths[constraint] = planarLength(columnDelta, rowDelta);
  }
  return restLengths;
};

// Leaf angle about a centre, continuous from the right stack (0) over the
// top (π / 2) to the left stack (π).
const pivotAngle = (x, height) => {
  const angle = Math.atan2(height, x);
  return angle < -Math.PI / 2 ? angle + 2 * Math.PI : angle;
};

// ---------------------------------------------------------------- turning leaf

class TurningLeaf {
  constructor(index, material, positions) {
    this.index = index;
    this.material = material;
    this.positions = Float64Array.from(positions);
    this.previous = Float64Array.from(positions);
    this.velocities = new Float64Array(positions.length);
    this.normals = new Float64Array(positions.length);
    this.centre = [0, 0];
    // Where the bound edge is held; it starts at the rest pivot.
    this.bound = [positions[0], positions[2]];
    this.hand = null;
    this.settleTarget = null;
    this.settleSide = 0;
  }
}

export class BookModel {
  // options: { type: a BOOK_TYPES name (default "hardcover"), grammage, leafCount }.
  constructor({ type = "hardcover", grammage, leafCount } = {}) {
    this.type = bookType(type);
    this.leafAcross = this.type.leafAcross;
    this.leafAlong = this.type.leafAlong;
    this.leafCount = leafCount ?? this.type.leafCount;
    this.columnSpacing = this.leafAcross / (GRID_COLUMNS - 1);
    this.rowSpacing = this.leafAlong / (GRID_ROWS - 1);
    this.rings = this.type.binding === "rings";
    // The margin column sits outside the constraint sweeps of a ring binding.
    this.pinnedColumn = 0;
    this.anchorColumn = this.rings ? 1 : 0;
    this.topology = buildTopology(this.rings);
    this.topology.restLengths = restLengthsFor(this.topology.stretch, this.columnSpacing, this.rowSpacing);
    const cover = this.type.cover;
    this.square = cover.kind === "hard" ? cover.square : 0;
    this.boardWidth = this.leafAcross + this.square;
    this.boardLength = this.leafAlong + 2 * this.square;
    this.leftCount = 0;
    this.rightStart = 0;
    this.turning = [];
    this.board = cover.kind === "hard" ? { angle: 0, velocity: 0, hand: null } : null;
    this.script = null;
    this.unsimulated = 0;
    this.setGrammage(grammage ?? this.type.grammage);
  }

  setGrammage(grammage) {
    if (this.turning.length > 0) throw new Error("Paper weight cannot change while a leaf is turning");
    if (!PAPER_GRAMMAGES.includes(grammage)) {
      throw new Error(`No paper of ${grammage} g/m²; supported: ${PAPER_GRAMMAGES.join(", ")}`);
    }
    this.grammage = grammage;
    this.block = new BookBlock(this.type, { leafCount: this.leafCount, grammage, holeInset: this.columnSpacing });
    this.curves = new LeafCurves(this.block, this.leafAcross);
    this.leafThickness = grammage * CALIPER_PER_GRAMMAGE;
    this.blockThickness = this.block.thickness;
    this.halfBlock = this.blockThickness / 2;
    // The boards turn about the middle of the block's thickness.
    if (this.board) this.hingeHeight = this.block.boardThickness + this.halfBlock;
    this.materials = new Map();
    for (const leafGrammage of new Set(this.block.grammages)) this.materials.set(leafGrammage, this.materialFor(leafGrammage));
    if (this.board) this.board.angle = Math.min(Math.PI, Math.max(this.board.angle, this.boardStackLimit()));
    this.refreshCurves();
  }

  // Mass, stiffness and air coupling of one paper on this grid.
  materialFor(grammage) {
    const thickness = grammage * CALIPER_PER_GRAMMAGE;
    const arealDensity = grammage * 1e-6;
    const bendingStiffness = YOUNGS_MODULUS * thickness ** 3 / 12;
    const particleInverseMass = 1 / (arealDensity * this.columnSpacing * this.rowSpacing);
    return {
      grammage,
      thickness,
      particleInverseMass,
      // The bound column is held by the binding.
      inverseMasses: new Float64Array(PARTICLES_PER_LEAF).map((_, particle) =>
        particle % GRID_COLUMNS === this.pinnedColumn ? 0 : particleInverseMass),
      columnBendCompliance: this.columnSpacing ** 3 / (bendingStiffness * this.rowSpacing),
      rowBendCompliance: this.rowSpacing ** 3 / (bendingStiffness * this.columnSpacing),
      twistCompliance: this.columnSpacing * this.rowSpacing / (2 * bendingStiffness * (1 - POISSON_RATIO)),
      airCoefficient: AIR_DENSITY * PLATE_DRAG_COEFFICIENT / (2 * arealDensity),
      // Added mass of a flat plate moving face-on: ρ·π·(W/2)² per unit span,
      // relative to the paper's own σ·W.
      addedMassRatio: AIR_DENSITY * Math.PI * this.leafAcross / (4 * arealDensity),
    };
  }

  // ---------------------------------------------------------------- resting geometry

  openingState() {
    return { leftCount: this.leftCount, rightStart: this.rightStart, boardAngle: this.board ? this.board.angle : Math.PI };
  }

  // Brings the rest curves up to the opening state and moves each turning
  // leaf's centre with them.
  refreshCurves() {
    this.curves.update(this.openingState());
    for (const leaf of this.turning) leaf.centre = turningCentre(this.block, this.curves.pivotX, this.curves.pivotZ, leaf.index);
  }

  // Height of the top face of each stack; an empty stack's top is its board.
  rightTopLevel() {
    return this.block.rightTop(this.rightStart);
  }

  leftTopLevel() {
    return this.block.leftTop(this.leftCount);
  }

  // Particle positions on a rest curve.
  poseOn(spec) {
    const arcs = Float64Array.from({ length: GRID_COLUMNS }, (_, column) => column * this.columnSpacing);
    const points = new Float64Array(GRID_COLUMNS * 4);
    writeRestCurve(points, 0, spec, arcs);
    const positions = new Float64Array(PARTICLES_PER_LEAF * 3);
    for (let column = 0; column < GRID_COLUMNS; column++) {
      for (let row = 0; row < GRID_ROWS; row++) {
        const offset = 3 * particleIndex(column, row);
        positions[offset] = points[4 * column];
        positions[offset + 1] = -this.leafAlong / 2 + row * this.rowSpacing;
        positions[offset + 2] = points[4 * column + 1];
      }
    }
    return positions;
  }

  // Resting pose of a leaf on a side: where it lies now, or where it would
  // lie as the next leaf to join that stack.
  restPose(index, side) {
    this.refreshCurves();
    if (this.curves.sides[index] === side) return this.poseOn(this.curves.restingSpec(index));
    const joining = this.curves.joining[side];
    if (joining?.leaf === index) return this.poseOn(joining.spec);
    throw new Error(`Leaf ${index} neither rests on nor can join the ${side > 0 ? "right" : "left"} stack ` +
      `(left ${this.leftCount}, right from ${this.rightStart})`);
  }

  // The surface a turning leaf's mid-plane may not pass below: the next
  // leaf's rest curve on either stack, and past the fore edge the board or
  // the table.
  floorHeight(x) {
    const curve = this.curves.floorAt(x);
    if (!Number.isNaN(curve)) return curve;
    const half = this.leafThickness / 2;
    if (x >= 0) return (x <= this.boardWidth ? this.block.baseRight : 0) + half;
    const boardUnder = this.board !== null && this.board.angle > Math.PI - 0.05 && -x <= this.boardWidth;
    return (boardUnder ? this.block.baseLeft : 0) + half;
  }

  // Centre a turning leaf swings about.
  leafPivot(leaf) {
    return leaf.centre;
  }

  // ---------------------------------------------------------------- front board

  // The lowest board angle the right stack's fore edge allows.
  boardStackLimit() {
    const reach = planarLength(this.leafAcross, this.halfBlock);
    const rise = (this.rightTopLevel() - this.hingeHeight) / reach;
    return Math.asin(Math.max(-1, Math.min(1, rise))) - Math.atan2(this.halfBlock, this.leafAcross);
  }

  boardLowerLimit() {
    let limit = this.boardStackLimit();
    const clearance = this.halfBlock + this.leafThickness / 2;
    for (const leaf of this.turning) {
      const { positions } = leaf;
      const masses = leaf.material.inverseMasses;
      for (let particle = 0; particle < PARTICLES_PER_LEAF; particle++) {
        if (masses[particle] === 0) continue;
        const x = positions[3 * particle];
        const height = positions[3 * particle + 2] - this.hingeHeight;
        const radius = planarLength(x, height);
        if (radius <= clearance) continue;
        limit = Math.max(limit, pivotAngle(x, height) - Math.asin(clearance / radius));
      }
    }
    return Math.min(limit, Math.PI);
  }

  boardLocked() {
    return this.leftCount > 0;
  }

  stepBoard(step) {
    const board = this.board;
    if (this.boardLocked()) {
      board.angle = Math.PI;
      board.velocity = 0;
      return;
    }
    let acceleration;
    if (board.hand) {
      acceleration = BOARD_HAND_STIFFNESS * (board.hand.target - board.angle) -
        2 * Math.sqrt(BOARD_HAND_STIFFNESS) * board.velocity;
    } else {
      acceleration = -3 * GRAVITY / (2 * this.boardWidth) * Math.cos(board.angle) -
        BOARD_AIR_DRAG * board.velocity * Math.abs(board.velocity) - BOARD_HINGE_FRICTION * board.velocity;
    }
    board.velocity += acceleration * step;
    board.angle += board.velocity * step;
    const lower = this.boardLowerLimit();
    // Contacts are inelastic below a small rebound speed, so the board comes to rest.
    if (board.angle < lower) {
      board.angle = lower;
      if (board.velocity < 0) board.velocity = board.velocity < -1 ? -board.velocity * BOARD_RESTITUTION : 0;
    }
    if (board.angle > Math.PI) {
      board.angle = Math.PI;
      if (board.velocity > 0) board.velocity = board.velocity > 1 ? -board.velocity * BOARD_RESTITUTION : 0;
    }
  }

  boardAtRest() {
    if (!this.board) return true;
    if (this.board.hand) return false;
    if (Math.abs(this.board.velocity) > 1e-3) return false;
    return this.boardLocked() || this.board.angle >= Math.PI - 1e-4 ||
      this.board.angle <= this.boardLowerLimit() + 1e-4;
  }

  // How far the front of the book is open, 0 closed to π flat: the front
  // board, or else the first leaf.
  frontOpening() {
    if (this.board) return this.board.angle;
    if (this.leftCount > 0) return Math.PI;
    const first = this.turning.find((leaf) => leaf.index === 0);
    if (!first) return 0;
    const edge = 3 * particleIndex(GRID_COLUMNS - 1, Math.floor(GRID_ROWS / 2));
    return Math.min(Math.PI, Math.max(0, pivotAngle(first.positions[edge] - first.centre[0], first.positions[edge + 2] - first.centre[1])));
  }

  // ---------------------------------------------------------------- simulation

  isActive() {
    return this.turning.length > 0 || this.script !== null || !this.boardAtRest();
  }

  // Display frames arrive at uneven intervals (8 and 17 ms alternate on a
  // 120 Hz display that drops frames). XPBD stiffness depends on the substep
  // size, so the simulation advances on a fixed clock of FIXED_STEP and the
  // remainder carries over to the next frame.
  step(elapsed) {
    this.unsimulated += Math.min(elapsed, MAXIMUM_STEP);
    while (this.unsimulated >= FIXED_STEP) {
      for (const leaf of this.turning) (leaf.displayPrevious ??= new Float64Array(leaf.positions.length)).set(leaf.positions);
      this.advance(FIXED_STEP);
      this.unsimulated -= FIXED_STEP;
    }
  }

  advance(frameStep) {
    const step = frameStep / SUBSTEPS;
    this.driveScript(frameStep);
    // The bound edge follows its pivot, which moves as the front board turns
    // and whenever a leaf leaves or joins a stack; a settling leaf's edge
    // goes where it will rest. It moves there at a hand's pace, not in a jump.
    this.refreshCurves();
    if (!this.rings) {
      const reach = PIVOT_SPEED * frameStep;
      for (const leaf of this.turning) {
        const goal = leaf.boundGoal ?? leaf.centre;
        const goalX = goal[0];
        const goalZ = goal[1];
        const bound = leaf.bound;
        const distance = planarLength(goalX - bound[0], goalZ - bound[1]);
        const share = distance > reach ? reach / distance : 1;
        bound[0] += (goalX - bound[0]) * share;
        bound[1] += (goalZ - bound[1]) * share;
        for (let row = 0; row < GRID_ROWS; row++) {
          const offset = 3 * particleIndex(0, row);
          leaf.positions[offset] = bound[0];
          leaf.positions[offset + 2] = bound[1];
        }
      }
    }
    for (let substep = 0; substep < SUBSTEPS; substep++) {
      for (const leaf of this.turning) {
        this.followHand(leaf, step);
        this.integrate(leaf, step);
        this.solveLeaf(leaf, step);
        this.holdInBinding(leaf);
      }
      this.solveOrdering();
      // Contact, then inextensibility with the final word, then contact
      // again so the stretch pass cannot push a leaf into a stack.
      for (const leaf of this.turning) {
        this.collide(leaf, true);
        this.solveStretch(leaf);
        // Friction here would pin paper that inextensibility just moved,
        // stretching the sheet between the grip and the stack.
        this.collide(leaf, false);
        this.holdInBinding(leaf);
      }
      for (const leaf of this.turning) {
        const { positions, previous, velocities } = leaf;
        for (let component = 0; component < positions.length; component++) {
          velocities[component] = (positions[component] - previous[component]) / step;
        }
        this.dampInternally(leaf);
      }
      if (this.board) this.stepBoard(step);
    }
    this.settle(frameStep);
    this.refreshCurves();
  }

  // A ring-bound leaf's holes stay on the ring, the margin beyond them
  // points into the ring, and the rest of the leaf stays outside it: the
  // wire passes through the sheet only at the holes, so a leaf lifted from
  // one side wraps over the ring and its holes slide round.
  holdInBinding(leaf) {
    if (!this.rings) return;
    const positions = leaf.positions;
    this.keepOnRing(leaf);
    const [centreX, centreZ] = this.block.ringCentre;
    const inner = (this.block.ringRadius - this.columnSpacing) / this.block.ringRadius;
    for (let row = 0; row < GRID_ROWS; row++) {
      const hole = 3 * particleIndex(1, row);
      const margin = 3 * particleIndex(0, row);
      positions[margin] = centreX + inner * (positions[hole] - centreX);
      positions[margin + 1] = positions[hole + 1];
      positions[margin + 2] = centreZ + inner * (positions[hole + 2] - centreZ);
    }
  }

  // The wire through a hole holds it on the ring and in place along the
  // bound edge; everywhere else the sheet is outside the ring.
  keepOnRing(leaf) {
    const positions = leaf.positions;
    const radius = this.block.ringRadius;
    const outside = radius + this.type.rings.wireRadius + leaf.material.thickness / 2;
    const [centreX, centreZ] = this.block.ringCentre;
    for (let row = 0; row < GRID_ROWS; row++) {
      const hole = 3 * particleIndex(1, row);
      const deltaX = positions[hole] - centreX;
      const deltaZ = positions[hole + 2] - centreZ;
      const distance = planarLength(deltaX, deltaZ) || 1;
      positions[hole] = centreX + radius * deltaX / distance;
      positions[hole + 1] = -this.leafAlong / 2 + row * this.rowSpacing;
      positions[hole + 2] = centreZ + radius * deltaZ / distance;
      for (let column = 2; column < GRID_COLUMNS; column++) {
        const offset = 3 * particleIndex(column, row);
        const awayX = positions[offset] - centreX;
        const awayZ = positions[offset + 2] - centreZ;
        const away = planarLength(awayX, awayZ);
        if (away >= outside || away === 0) continue;
        positions[offset] = centreX + outside * awayX / away;
        positions[offset + 2] = centreZ + outside * awayZ / away;
      }
    }
  }

  computeNormals(leaf) {
    const { positions, normals } = leaf;
    for (let row = 0; row < GRID_ROWS; row++) {
      const below = Math.max(row - 1, 0);
      const above = Math.min(row + 1, GRID_ROWS - 1);
      for (let column = 0; column < GRID_COLUMNS; column++) {
        const before = 3 * particleIndex(Math.max(column - 1, 0), row);
        const after = 3 * particleIndex(Math.min(column + 1, GRID_COLUMNS - 1), row);
        const down = 3 * particleIndex(column, below);
        const up = 3 * particleIndex(column, above);
        const ux = positions[after] - positions[before];
        const uy = positions[after + 1] - positions[before + 1];
        const uz = positions[after + 2] - positions[before + 2];
        const vx = positions[up] - positions[down];
        const vy = positions[up + 1] - positions[down + 1];
        const vz = positions[up + 2] - positions[down + 2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const length = spatialLength(nx, ny, nz) || 1;
        const offset = 3 * particleIndex(column, row);
        normals[offset] = nx / length;
        normals[offset + 1] = ny / length;
        normals[offset + 2] = nz / length;
      }
    }
  }

  integrate(leaf, step) {
    this.computeNormals(leaf);
    const { positions, previous, velocities, normals, material } = leaf;
    const masses = material.inverseMasses;
    const inertia = 1 + material.addedMassRatio;
    for (let particle = 0; particle < PARTICLES_PER_LEAF; particle++) {
      const offset = 3 * particle;
      previous[offset] = positions[offset];
      previous[offset + 1] = positions[offset + 1];
      previous[offset + 2] = positions[offset + 2];
      if (masses[particle] === 0) {
        velocities[offset] = velocities[offset + 1] = velocities[offset + 2] = 0;
        continue;
      }
      // Face-on, a sheet must also move the air around it: roughly a
      // cylinder of air as wide as the page, which adds inertia (and so
      // slows gravity and drag alike) only for motion normal to the sheet.
      const nx = normals[offset];
      const ny = normals[offset + 1];
      const nz = normals[offset + 2];
      let vx = velocities[offset];
      let vy = velocities[offset + 1];
      let vz = velocities[offset + 2] - GRAVITY * step;
      const gravityNormal = -GRAVITY * step * nz;
      vx -= gravityNormal * nx * (1 - 1 / inertia);
      vy -= gravityNormal * ny * (1 - 1 / inertia);
      vz -= gravityNormal * nz * (1 - 1 / inertia);
      // Quadratic form drag, plus a viscous squeeze film once the sheet
      // nears a stack: the air under it must escape sideways, which it does
      // ever more slowly as the gap closes. Both are integrated implicitly.
      const normalSpeed = vx * nx + vy * ny + vz * nz;
      const gap = Math.max(0, positions[offset + 2] - this.floorHeight(positions[offset]));
      const film = SQUEEZE_FILM_RATE * (SQUEEZE_FILM_GAP / (gap + SQUEEZE_FILM_GAP)) ** 3;
      const quadratic = material.airCoefficient * Math.abs(normalSpeed);
      const dampedNormal = normalSpeed / (1 + ((quadratic + film) / inertia) * step);
      const normalChange = dampedNormal - normalSpeed;
      vx += normalChange * nx;
      vy += normalChange * ny;
      vz += normalChange * nz;
      velocities[offset] = vx;
      velocities[offset + 1] = vy;
      velocities[offset + 2] = vz;
      positions[offset] += vx * step;
      positions[offset + 1] += vy * step;
      positions[offset + 2] += vz * step;
    }
  }

  solveLeaf(leaf, step) {
    const { positions, material } = leaf;
    const masses = material.inverseMasses;
    const squaredStep = step * step;
    if (leaf.hand) {
      const { particles, weights, target } = leaf.hand;
      let denominator = HAND_COMPLIANCE / squaredStep;
      for (let corner = 0; corner < 4; corner++) denominator += weights[corner] ** 2 * masses[particles[corner]];
      for (let axis = 0; axis < 3; axis++) {
        let held = 0;
        for (let corner = 0; corner < 4; corner++) held += weights[corner] * positions[3 * particles[corner] + axis];
        const correction = (target[axis] - held) / denominator;
        for (let corner = 0; corner < 4; corner++) {
          positions[3 * particles[corner] + axis] += masses[particles[corner]] * weights[corner] * correction;
        }
      }
    }

    if (leaf.settleTarget) {
      const weight = material.particleInverseMass;
      const blend = weight / (weight + leaf.settleCompliance / squaredStep);
      const target = leaf.settleTarget;
      for (let component = 0; component < positions.length; component++) {
        if (masses[Math.floor(component / 3)] === 0) continue;
        positions[component] += (target[component] - positions[component]) * blend;
      }
    }
    const solveTriples = (triples, compliance) => {
      const scaled = compliance / squaredStep;
      for (let constraint = 0; constraint < triples.length; constraint += 3) {
        const a = triples[constraint];
        const b = triples[constraint + 1];
        const c = triples[constraint + 2];
        const wa = masses[a];
        const wb = masses[b];
        const wc = masses[c];
        const denominator = wa + 4 * wb + wc + scaled;
        if (denominator === scaled) continue;
        for (let axis = 0; axis < 3; axis++) {
          const error = positions[3 * a + axis] + positions[3 * c + axis] - 2 * positions[3 * b + axis];
          const correction = -error / denominator;
          positions[3 * a + axis] += wa * correction;
          positions[3 * c + axis] += wc * correction;
          positions[3 * b + axis] -= 2 * wb * correction;
        }
      }
    };
    solveTriples(this.topology.columnBends, material.columnBendCompliance);
    solveTriples(this.topology.rowBends, material.rowBendCompliance);

    const twists = this.topology.twists;
    const twistScaled = material.twistCompliance / squaredStep;
    for (let constraint = 0; constraint < twists.length; constraint += 4) {
      const first = twists[constraint];
      const second = twists[constraint + 1];
      const third = twists[constraint + 2];
      const fourth = twists[constraint + 3];
      const firstWeight = masses[first];
      const secondWeight = masses[second];
      const thirdWeight = masses[third];
      const fourthWeight = masses[fourth];
      const denominator = firstWeight + secondWeight + thirdWeight + fourthWeight + twistScaled;
      for (let axis = 0; axis < 3; axis++) {
        const error = positions[3 * first + axis] - positions[3 * second + axis] -
          positions[3 * third + axis] + positions[3 * fourth + axis];
        const correction = -error / denominator;
        positions[3 * first + axis] += firstWeight * correction;
        positions[3 * second + axis] -= secondWeight * correction;
        positions[3 * third + axis] -= thirdWeight * correction;
        positions[3 * fourth + axis] += fourthWeight * correction;
      }
    }
  }

  // Paper does not stretch or shear measurably, so inextensibility is solved
  // after the hand and the bending and has the final word.
  solveStretch(leaf) {
    const { positions, material } = leaf;
    const masses = material.inverseMasses;
    const { stretch, restLengths } = this.topology;
    for (let sweep = 0; sweep < STRETCH_SWEEPS; sweep++) {
      for (let constraint = 0; constraint < restLengths.length; constraint++) {
        const a = stretch[2 * constraint];
        const b = stretch[2 * constraint + 1];
        const wa = masses[a];
        const wb = masses[b];
        if (wa + wb === 0) continue;
        const dx = positions[3 * a] - positions[3 * b];
        const dy = positions[3 * a + 1] - positions[3 * b + 1];
        const dz = positions[3 * a + 2] - positions[3 * b + 2];
        const length = spatialLength(dx, dy, dz);
        if (length === 0) continue;
        const correction = (length - restLengths[constraint]) / ((wa + wb) * length);
        positions[3 * a] -= wa * correction * dx;
        positions[3 * a + 1] -= wa * correction * dy;
        positions[3 * a + 2] -= wa * correction * dz;
        positions[3 * b] += wb * correction * dx;
        positions[3 * b + 1] += wb * correction * dy;
        positions[3 * b + 2] += wb * correction * dz;
      }
      if (this.rings) this.keepOnRing(leaf);
    }
    // Long-range tethers: a pull at the fore edge reaches the binding only
    // after many sweeps of neighbour constraints, so each particle is also
    // kept within its paper distance of the bound point in its row.
    const anchorColumn = this.anchorColumn;
    for (let row = 0; row < GRID_ROWS; row++) {
      const anchor = 3 * particleIndex(anchorColumn, row);
      for (let column = anchorColumn + 2; column < GRID_COLUMNS; column++) {
        const offset = 3 * particleIndex(column, row);
        const dx = positions[offset] - positions[anchor];
        const dy = positions[offset + 1] - positions[anchor + 1];
        const dz = positions[offset + 2] - positions[anchor + 2];
        const length = spatialLength(dx, dy, dz);
        const limit = (column - anchorColumn) * this.columnSpacing;
        if (length <= limit) continue;
        const scale = limit / length;
        positions[offset] = positions[anchor] + dx * scale;
        positions[offset + 1] = positions[anchor + 1] + dy * scale;
        positions[offset + 2] = positions[anchor + 2] + dz * scale;
      }
    }
  }

  // Internal friction: each particle loses a share of its velocity relative
  // to its neighbours, which damps bending waves and leaves the leaf's
  // overall swing to gravity and the air.
  dampInternally(leaf) {
    const velocities = leaf.velocities;
    const smoothed = leaf.smoothedVelocities ??= new Float64Array(velocities.length);
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let column = 1; column < GRID_COLUMNS; column++) {
        const offset = 3 * particleIndex(column, row);
        const before = 3 * particleIndex(column - 1, row);
        const after = 3 * particleIndex(Math.min(column + 1, GRID_COLUMNS - 1), row);
        const below = 3 * particleIndex(column, Math.max(row - 1, 0));
        const above = 3 * particleIndex(column, Math.min(row + 1, GRID_ROWS - 1));
        for (let axis = 0; axis < 3; axis++) {
          const mean = (velocities[before + axis] + velocities[after + axis] +
            velocities[below + axis] + velocities[above + axis]) / 4;
          smoothed[offset + axis] = velocities[offset + axis] + PAPER_DAMPING * (mean - velocities[offset + axis]);
        }
      }
    }
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let column = 1; column < GRID_COLUMNS; column++) {
        const offset = 3 * particleIndex(column, row);
        for (let axis = 0; axis < 3; axis++) velocities[offset + axis] = smoothed[offset + axis];
      }
    }
  }

  // The hand eases toward the pointer like a real arm, so a jumpy pointer
  // does not jerk the paper: a critically damped follower at 20 rad/s. It
  // eases the grip's angle about the leaf's pivot, its distance from it and
  // its position along the bound edge separately, so a hand crossing the
  // book swings over the binding instead of cutting through it.
  followHand(leaf, step) {
    const hand = leaf.hand;
    if (!hand) return;
    const [centreX, centreZ] = leaf.centre;
    const polar = (point) => [
      pivotAngle(point[0] - centreX, point[2] - centreZ),
      planarLength(point[0] - centreX, point[2] - centreZ),
      point[1],
    ];
    hand.polar ??= polar(hand.target);
    hand.speed ??= [0, 0, 0];
    const goal = polar(hand.goal);
    for (let axis = 0; axis < 3; axis++) {
      const pull = HAND_FOLLOW_RATE * HAND_FOLLOW_RATE * (goal[axis] - hand.polar[axis]) -
        2 * HAND_FOLLOW_RATE * hand.speed[axis];
      hand.speed[axis] += pull * step;
      // A hand turning a page sweeps at a few radians a second; a pointer
      // that jumps across the book is followed at that pace, not in one frame.
      const limit = HAND_SPEED_LIMITS[axis];
      hand.speed[axis] = Math.max(-limit, Math.min(limit, hand.speed[axis]));
      hand.polar[axis] += hand.speed[axis] * step;
    }
    const [angle, radius, y] = hand.polar;
    const [x, z] = this.withinPaper(leaf, centreX + radius * Math.cos(angle), centreZ + radius * Math.sin(angle));
    hand.target = [x, y, Math.max(z, this.floorHeight(x) + 1)];
  }

  // A ring-bound leaf swings about the ring's centre, but its hole lags on
  // the ring, so its grip is also kept within its paper distance of the hole.
  withinPaper(leaf, x, z) {
    if (!this.rings) return [x, z];
    const row = Math.floor(leaf.hand.particles[0] / GRID_COLUMNS);
    const hole = 3 * particleIndex(1, row);
    const holeX = leaf.positions[hole];
    const holeZ = leaf.positions[hole + 2];
    const distance = planarLength(x - holeX, z - holeZ);
    const limit = leaf.hand.holeReach;
    if (distance <= limit) return [x, z];
    return [holeX + (x - holeX) * limit / distance, holeZ + (z - holeZ) * limit / distance];
  }

  // Leaves keep their order about the binding: a lower-numbered leaf is
  // always at a larger angle about its centre than the next one, by at
  // least a caliper.
  solveOrdering() {
    for (let pair = 0; pair + 1 < this.turning.length; pair++) {
      const upperLeaf = this.turning[pair];
      const lowerLeaf = this.turning[pair + 1];
      const upper = upperLeaf.positions;
      const lower = lowerLeaf.positions;
      const masses = upperLeaf.material.inverseMasses;
      const [upperCentreX, upperCentreZ] = upperLeaf.centre;
      const [lowerCentreX, lowerCentreZ] = lowerLeaf.centre;
      const caliper = (upperLeaf.material.thickness + lowerLeaf.material.thickness) / 2;
      for (let particle = 0; particle < PARTICLES_PER_LEAF; particle++) {
        if (masses[particle] === 0) continue;
        const offset = 3 * particle;
        const upperX = upper[offset] - upperCentreX;
        const upperHeight = upper[offset + 2] - upperCentreZ;
        const lowerX = lower[offset] - lowerCentreX;
        const lowerHeight = lower[offset + 2] - lowerCentreZ;
        const upperRadius = planarLength(upperX, upperHeight);
        const lowerRadius = planarLength(lowerX, lowerHeight);
        const minimum = caliper / Math.max(1, (upperRadius + lowerRadius) / 2);
        const upperAngle = pivotAngle(upperX, upperHeight);
        const lowerAngle = pivotAngle(lowerX, lowerHeight);
        const violation = minimum - (upperAngle - lowerAngle);
        if (violation <= 0) continue;
        const raised = upperAngle + violation / 2;
        const dropped = lowerAngle - violation / 2;
        upper[offset] = upperCentreX + upperRadius * Math.cos(raised);
        upper[offset + 2] = upperCentreZ + upperRadius * Math.sin(raised);
        lower[offset] = lowerCentreX + lowerRadius * Math.cos(dropped);
        lower[offset + 2] = lowerCentreZ + lowerRadius * Math.sin(dropped);
      }
    }
  }

  collide(leaf, withFriction) {
    const { positions, previous } = leaf;
    const masses = leaf.material.inverseMasses;
    const board = this.board;
    const alongX = board ? Math.cos(board.angle) : 0;
    const alongZ = board ? Math.sin(board.angle) : 0;
    const normalX = board ? -Math.sin(board.angle) : 0;
    const normalZ = board ? Math.cos(board.angle) : 0;
    const boardLimit = this.halfBlock - leaf.material.thickness / 2;
    for (let particle = 0; particle < PARTICLES_PER_LEAF; particle++) {
      if (masses[particle] === 0) continue;
      const offset = 3 * particle;
      // Under the front board.
      if (board) {
        const relativeHeight = positions[offset + 2] - this.hingeHeight;
        const along = positions[offset] * alongX + relativeHeight * alongZ;
        const across = positions[offset] * normalX + relativeHeight * normalZ;
        if (along > 0 && across > boardLimit) {
          positions[offset] -= (across - boardLimit) * normalX;
          positions[offset + 2] -= (across - boardLimit) * normalZ;
        }
      }
      // On the stacks, boards and table, with friction.
      const floor = this.floorHeight(positions[offset]);
      const penetration = floor - positions[offset + 2];
      if (penetration > 0) {
        positions[offset + 2] = floor;
        const slideX = positions[offset] - previous[offset];
        const slideY = positions[offset + 1] - previous[offset + 1];
        const slide = planarLength(slideX, slideY);
        if (withFriction && slide > 0) {
          const kept = Math.max(0, 1 - FRICTION * penetration / slide);
          positions[offset] = previous[offset] + slideX * kept;
          positions[offset + 1] = previous[offset + 1] + slideY * kept;
        }
      }
    }
  }

  // A released leaf that comes to lie on the stack it can join relaxes into
  // that stack's resting shape and then becomes part of it.
  settle(frameStep) {
    for (const leaf of [...this.turning]) {
      const wasSettling = leaf.settleTarget !== null;
      leaf.settleTarget = null;
      leaf.boundGoal = null;
      if (leaf.hand) continue;
      const { positions, velocities } = leaf;
      let edgeX = 0;
      for (let row = 0; row < GRID_ROWS; row++) edgeX += positions[3 * particleIndex(GRID_COLUMNS - 1, row)];
      const side = edgeX >= 0 ? 1 : -1;
      const joinable = side > 0 ? leaf.index === this.rightStart - 1 : leaf.index === this.leftCount;
      if (!joinable || Math.abs(edgeX / GRID_ROWS) < this.leafAcross * 0.6) continue;
      // The target follows the stack while the leaf settles.
      if (leaf.settleSide !== side || leaf.restVersion !== this.curves.version) {
        leaf.settleSide = side;
        leaf.restVersion = this.curves.version;
        leaf.restTarget = this.poseOn(this.curves.joining[side].spec);
      }
      // A free leaf over the stack it can join is bound where it will rest there.
      leaf.boundGoal = [leaf.restTarget[0], leaf.restTarget[2]];
      let deviation = 0;
      let speed = 0;
      for (let particle = 0; particle < PARTICLES_PER_LEAF; particle++) {
        const offset = 3 * particle;
        deviation = Math.max(deviation, spatialLength(positions[offset] - leaf.restTarget[offset], positions[offset + 1] - leaf.restTarget[offset + 1], positions[offset + 2] - leaf.restTarget[offset + 2]));
        speed = Math.max(speed, spatialLength(velocities[offset], velocities[offset + 1], velocities[offset + 2]));
      }
      // Chords of the gutter curve are slightly shorter than the grid spacing,
      // so the inextensible leaf rests within a few tenths of a millimetre of
      // the rest curve rather than on it.
      if (deviation < 0.4 && speed < 5) {
        this.turning.splice(this.turning.indexOf(leaf), 1);
        if (side > 0) this.rightStart -= 1;
        else this.leftCount += 1;
        this.refreshCurves();
        continue;
      }
      // Lying still on its stack: a brief pull into the resting shape, which
      // differs from the simulated one by about a millimetre in the gutter.
      // A ring-bound leaf's holes also slide round the ring to their place,
      // which the leaf's weight alone does only slowly.
      const settleReach = this.rings ? 2 * this.block.ringRadius : 3;
      if (speed < 25 && deviation < settleReach) {
        leaf.settleTime = wasSettling ? leaf.settleTime + frameStep : 0;
        leaf.settleCompliance = SETTLE_COMPLIANCE * Math.exp(-15 * leaf.settleTime);
        leaf.settleTarget = leaf.restTarget;
      }
    }
  }

  // ---------------------------------------------------------------- hands

  canTurnFrom(side) {
    if (this.turning.length >= MAXIMUM_TURNING_LEAVES) return false;
    return side > 0 ? this.rightStart < this.leafCount : this.leftCount > 0;
  }

  // Lifts the top leaf of a stack and holds it at a point given as arc
  // length from the leaf's bound edge and position along that edge.
  liftFromStack(side, arc, y) {
    if (!this.canTurnFrom(side)) return null;
    this.refreshCurves();
    const index = side > 0 ? this.rightStart : this.leftCount - 1;
    const material = this.materials.get(this.block.grammages[index]);
    const leaf = new TurningLeaf(index, material, this.poseOn(this.curves.restingSpec(index)));
    if (side > 0) {
      this.rightStart += 1;
      this.turning.push(leaf);
    } else {
      this.leftCount -= 1;
      this.turning.unshift(leaf);
    }
    this.refreshCurves();
    this.hold(leaf, arc / this.columnSpacing, (y + this.leafAlong / 2) / this.rowSpacing);
    return leaf;
  }

  hold(leaf, column, row) {
    const baseColumn = Math.min(Math.max(Math.floor(column), 0), GRID_COLUMNS - 2);
    const baseRow = Math.min(Math.max(Math.floor(row), 0), GRID_ROWS - 2);
    const across = Math.min(Math.max(column - baseColumn, 0), 1);
    const along = Math.min(Math.max(row - baseRow, 0), 1);
    const particles = [
      particleIndex(baseColumn, baseRow), particleIndex(baseColumn + 1, baseRow),
      particleIndex(baseColumn, baseRow + 1), particleIndex(baseColumn + 1, baseRow + 1),
    ];
    const weights = [(1 - across) * (1 - along), across * (1 - along), (1 - across) * along, across * along];
    const target = [0, 0, 0];
    for (let corner = 0; corner < 4; corner++) {
      for (let axis = 0; axis < 3; axis++) target[axis] += weights[corner] * leaf.positions[3 * particles[corner] + axis];
    }
    // The grip's paper distance from the centre the leaf swings about.
    const reach = this.rings
      ? this.block.ringRadius + Math.max(column - this.anchorColumn, 1) * this.columnSpacing
      : Math.max(column, 1) * this.columnSpacing;
    const holeReach = Math.max(column - this.anchorColumn, 1) * this.columnSpacing;
    leaf.hand = { particles, weights, target, goal: [...target], reach, holeReach };
  }

  // Dragging turns the page: the pointer sets the grip's angle about the
  // leaf's centre, and the grip stays between MINIMUM_GRIP_REACH and all of
  // its paper distance from it. A pointer moved toward the binding along the
  // table would otherwise push the fore edge in and force the sheet into a
  // loop it cannot hold, where it folds through itself.
  moveLeafHand(leaf, point) {
    if (!leaf.hand) return;
    const [centreX, centreZ] = leaf.centre;
    const height = point[2] - centreZ;
    const angle = pivotAngle(point[0] - centreX, height);
    const reach = leaf.hand.reach;
    const radius = Math.min(reach, Math.max(MINIMUM_GRIP_REACH * reach, planarLength(point[0] - centreX, height)));
    const [x, z] = this.withinPaper(leaf, centreX + radius * Math.cos(angle), centreZ + radius * Math.sin(angle));
    leaf.hand.goal = [x, point[1], Math.max(z, this.floorHeight(x) + 1)];
  }

  holdBoard(point) {
    if (!this.board || this.boardLocked()) return false;
    const pointAngle = pivotAngle(point[0], point[2] - this.hingeHeight);
    this.board.hand = { offset: pointAngle - this.board.angle, target: this.board.angle };
    return true;
  }

  moveBoardHand(point) {
    if (!this.board?.hand) return;
    const pointAngle = pivotAngle(point[0], point[2] - this.hingeHeight);
    this.board.hand.target = Math.min(Math.PI, Math.max(-0.2, pointAngle - this.board.hand.offset));
  }

  release() {
    for (const leaf of this.turning) leaf.hand = null;
    if (this.board) this.board.hand = null;
  }

  // ---------------------------------------------------------------- scripted turns

  // Next: open the front board, or carry the right stack's top leaf over.
  turnForward() {
    if (this.script) return false;
    if (this.board && !this.boardLocked() && this.board.angle < Math.PI - 0.02 && this.turning.length === 0) {
      return this.scriptBoard(Math.PI * 0.8);
    }
    return this.scriptLeaf(1);
  }

  // Previous: carry the left stack's top leaf back, or close the front board.
  turnBackward() {
    if (this.script) return false;
    if (this.board && !this.boardLocked() && this.turning.length === 0 && this.board.angle > Math.PI / 2) {
      return this.scriptBoard(0.2);
    }
    return this.scriptLeaf(-1);
  }

  scriptBoard(finalAngle) {
    const start = this.board.angle;
    this.board.hand = { offset: 0, target: start };
    this.script = {
      elapsed: 0, duration: 0.5,
      drive: (progress) => { this.board.hand.target = start + (finalAngle - start) * progress; },
      finish: () => { this.board.hand = null; },
    };
    return true;
  }

  scriptLeaf(side) {
    const arc = this.leafAcross * 0.97;
    const leaf = this.liftFromStack(side, arc, -this.leafAlong * 0.25);
    if (!leaf) return false;
    // The hand starts exactly where it took hold and swings about the leaf's centre.
    const [startX, y, startZ] = leaf.hand.target;
    const [centreX, centreZ] = leaf.centre;
    const startAngle = pivotAngle(startX - centreX, startZ - centreZ);
    const finalAngle = side > 0 ? Math.PI * 0.88 : Math.PI * 0.12;
    const radius = planarLength(startX - centreX, startZ - centreZ);
    this.script = {
      elapsed: 0, duration: 0.9,
      drive: (progress) => {
        const angle = startAngle + (finalAngle - startAngle) * progress;
        const [currentX, currentZ] = leaf.centre;
        this.moveLeafHand(leaf, [currentX + radius * Math.cos(angle), y, currentZ + radius * Math.sin(angle)]);
      },
      finish: () => { leaf.hand = null; },
    };
    return true;
  }

  driveScript(frameStep) {
    const script = this.script;
    if (!script) return;
    script.elapsed += frameStep;
    const linear = Math.min(script.elapsed / script.duration, 1);
    // Accelerate from rest and let go while still moving, like a flick.
    script.drive(linear ** 1.6);
    if (linear >= 1) {
      script.finish();
      this.script = null;
    }
  }

  // ---------------------------------------------------------------- picking

  // Nearest grabbable surface along a ray in the binding's frame, or null.
  raycast(origin, direction) {
    this.refreshCurves();
    let nearest = null;
    const consider = (hit) => {
      if (hit && hit.distance > 0 && (!nearest || hit.distance < nearest.distance)) nearest = hit;
    };
    if (this.board) consider(this.raycastBoard(origin, direction));
    for (const leaf of this.turning) consider(this.raycastLeaf(leaf, origin, direction));
    for (const side of [-1, 1]) consider(this.raycastStack(side, origin, direction));
    return nearest;
  }

  raycastBoard(origin, direction) {
    const angle = this.board.angle;
    const alongAxis = [Math.cos(angle), Math.sin(angle)];
    const normalAxis = [-Math.sin(angle), Math.cos(angle)];
    const relative = [origin[0], origin[2] - this.hingeHeight];
    const local = [
      relative[0] * alongAxis[0] + relative[1] * alongAxis[1],
      origin[1],
      relative[0] * normalAxis[0] + relative[1] * normalAxis[1],
    ];
    const localDirection = [
      direction[0] * alongAxis[0] + direction[2] * alongAxis[1],
      direction[1],
      direction[0] * normalAxis[0] + direction[2] * normalAxis[1],
    ];
    const minimum = [0, -this.boardLength / 2, this.halfBlock];
    const maximum = [this.boardWidth, this.boardLength / 2, this.halfBlock + this.block.boardThickness];
    let enter = -Infinity;
    let exit = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(localDirection[axis]) < 1e-12) {
        if (local[axis] < minimum[axis] || local[axis] > maximum[axis]) return null;
        continue;
      }
      const first = (minimum[axis] - local[axis]) / localDirection[axis];
      const second = (maximum[axis] - local[axis]) / localDirection[axis];
      enter = Math.max(enter, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }
    if (enter > exit || exit < 0) return null;
    const distance = Math.max(enter, 0);
    return { kind: "board", distance, point: origin.map((value, axis) => value + direction[axis] * distance) };
  }

  raycastLeaf(leaf, origin, direction) {
    const positions = leaf.positions;
    let best = null;
    const vertex = (column, row) => {
      const offset = 3 * particleIndex(column, row);
      return [positions[offset], positions[offset + 1], positions[offset + 2]];
    };
    const triangle = (a, b, c, parameterA, parameterB, parameterC) => {
      const edgeOne = b.map((value, axis) => value - a[axis]);
      const edgeTwo = c.map((value, axis) => value - a[axis]);
      const p = cross(direction, edgeTwo);
      const determinant = dot(edgeOne, p);
      if (Math.abs(determinant) < 1e-12) return;
      const toOrigin = origin.map((value, axis) => value - a[axis]);
      const first = dot(toOrigin, p) / determinant;
      if (first < 0 || first > 1) return;
      const q = cross(toOrigin, edgeOne);
      const second = dot(direction, q) / determinant;
      if (second < 0 || first + second > 1) return;
      const distance = dot(edgeTwo, q) / determinant;
      if (distance <= 0 || (best && distance >= best.distance)) return;
      const weightA = 1 - first - second;
      best = {
        kind: "leaf", leaf, distance,
        column: weightA * parameterA[0] + first * parameterB[0] + second * parameterC[0],
        row: weightA * parameterA[1] + first * parameterB[1] + second * parameterC[1],
        point: origin.map((value, axis) => value + direction[axis] * distance),
      };
    };
    for (let row = 0; row + 1 < GRID_ROWS; row++) {
      for (let column = 0; column + 1 < GRID_COLUMNS; column++) {
        const corners = [[column, row], [column + 1, row], [column, row + 1], [column + 1, row + 1]];
        const points = corners.map(([c, r]) => vertex(c, r));
        triangle(points[0], points[1], points[3], corners[0], corners[1], corners[3]);
        triangle(points[0], points[3], points[2], corners[0], corners[3], corners[2]);
      }
    }
    return best;
  }

  // The stack's top face is its top leaf's rest curve raised half a caliper.
  raycastStack(side, origin, direction) {
    const count = side > 0 ? this.leafCount - this.rightStart : this.leftCount;
    if (count === 0) return null;
    const top = side > 0 ? this.rightStart : this.leftCount - 1;
    const faceX = new Float64Array(CURVE_SAMPLES);
    const faceZ = new Float64Array(CURVE_SAMPLES);
    let highest = -Infinity;
    for (let sample = 0; sample < CURVE_SAMPLES; sample++) {
      [faceX[sample], faceZ[sample]] = this.curves.face(top, sample, 1);
      highest = Math.max(highest, faceZ[sample]);
    }
    const nearX = Math.min(faceX[0], faceX[CURVE_SAMPLES - 1]);
    const farX = Math.max(faceX[0], faceX[CURVE_SAMPLES - 1]);
    const minimum = [nearX, -this.leafAlong / 2, 0];
    const maximum = [farX, this.leafAlong / 2, highest + 1];
    let enter = 0;
    let exit = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(direction[axis]) < 1e-12) {
        if (origin[axis] < minimum[axis] || origin[axis] > maximum[axis]) return null;
        continue;
      }
      const first = (minimum[axis] - origin[axis]) / direction[axis];
      const second = (maximum[axis] - origin[axis]) / direction[axis];
      enter = Math.max(enter, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }
    if (enter > exit) return null;
    // Height of the face and its arc length at x, between samples.
    const faceAt = (x) => {
      let low = 0;
      let high = CURVE_SAMPLES - 1;
      while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (side * (x - faceX[middle]) >= 0) low = middle;
        else high = middle;
      }
      const span = faceX[high] - faceX[low];
      const blend = span === 0 ? 0 : Math.min(1, Math.max(0, (x - faceX[low]) / span));
      return {
        height: faceZ[low] + (faceZ[high] - faceZ[low]) * blend,
        arc: this.curves.arcs[low] + (this.curves.arcs[high] - this.curves.arcs[low]) * blend,
      };
    };
    const above = (distance) => origin[2] + direction[2] * distance - faceAt(origin[0] + direction[0] * distance).height;
    let near = enter;
    if (above(near) < 0) return null;
    for (let far = enter + 0.5; near < exit; far += 0.5) {
      const end = Math.min(far, exit);
      if (above(end) < 0) {
        let low = near;
        let high = end;
        for (let iteration = 0; iteration < 24; iteration++) {
          const middle = (low + high) / 2;
          if (above(middle) < 0) high = middle;
          else low = middle;
        }
        const point = origin.map((value, axis) => value + direction[axis] * high);
        return { kind: "stack", side, distance: high, point, arc: faceAt(point[0]).arc, y: point[1] };
      }
      near = end;
    }
    return null;
  }

  // The point on a stack's top face at an arc length from the bound edge
  // and a position along it, in the binding's frame: the inverse of the arc
  // and y raycastStack reports. Null for an empty stack.
  stackPoint(side, arc, y) {
    const count = side > 0 ? this.leafCount - this.rightStart : this.leftCount;
    if (count === 0) return null;
    this.refreshCurves();
    const top = side > 0 ? this.rightStart : this.leftCount - 1;
    const arcs = this.curves.arcs;
    let low = 0;
    let high = CURVE_SAMPLES - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (arc >= arcs[middle]) low = middle;
      else high = middle;
    }
    const span = arcs[high] - arcs[low];
    const blend = span === 0 ? 0 : Math.min(1, Math.max(0, (arc - arcs[low]) / span));
    const [lowX, lowZ] = this.curves.face(top, low, 1);
    const [highX, highZ] = this.curves.face(top, high, 1);
    return [lowX + (highX - lowX) * blend, y, lowZ + (highZ - lowZ) * blend];
  }

  // ---------------------------------------------------------------- GPU data

  // What to draw: the state between the last two fixed steps that the
  // display frame's time falls on, so uneven display frames still show
  // even motion.
  displayedPositions(leaf) {
    const blend = this.unsimulated / FIXED_STEP;
    const before = leaf.displayPrevious;
    const shown = leaf.displayed ??= new Float64Array(leaf.positions.length);
    for (let component = 0; component < shown.length; component++) {
      shown[component] = before ? before[component] + (leaf.positions[component] - before[component]) * blend : leaf.positions[component];
    }
    return shown;
  }

  writeParticles(target) {
    target.fill(0);
    this.turning.forEach((leaf, slot) => {
      const base = slot * PARTICLES_PER_LEAF * 4;
      const positions = this.displayedPositions(leaf);
      for (let particle = 0; particle < PARTICLES_PER_LEAF; particle++) {
        target[base + 4 * particle] = positions[3 * particle];
        target[base + 4 * particle + 1] = positions[3 * particle + 1];
        target[base + 4 * particle + 2] = positions[3 * particle + 2];
      }
    });
  }

  // The rest curves and the spine outline, in the layout of leaf-curves.js.
  writeCurves(target) {
    this.refreshCurves();
    this.curves.write(target);
    return this.curves.version;
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function planarLength(x, y) {
  return Math.sqrt(x * x + y * y);
}
function spatialLength(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}
