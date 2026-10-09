// Bookbindings as cross-sections, in the frame of book-model.js: x across
// the binding (the bound edge at x ≈ 0, the right stack at x > 0), y along
// the bound edge, z up from the table; millimetres.
//
// A binding decides where each leaf is attached for the current opening
// state: its pivot in the cross-section. Everything else about a resting
// leaf follows from its pivot, its level on its stack and the paper's
// stiffness (leaf-curves.js).
//
//   case     rounded spine of a hardcover: pivots spread along the inner
//            arc of the spine, which sweeps between the boards' joints.
//   perfect  glued flat back: a straight back folded at the opening, each
//            half hanging from the fold toward its own stack.
//   saddle   nested folded sheets stapled through the fold: both halves of
//            every sheet meet at the staple.
//   rings    wire loops through punched holes: each hole slides on the ring
//            circle, so a leaf turns about the ring's centre.
//
// A book type is a binding with its orientation (`side`, or `top` for a pad
// whose bound edge runs across the head), a cover, a trim and paper.

export const PAPER_GRAMMAGES = [90, 150, 250];
export const COVER_GRAMMAGE = 300;
// Uncoated book paper and card bulk at about 1.25 cm³/g.
export const CALIPER_PER_GRAMMAGE = 0.00125;
export const MAXIMUM_LEAVES = 256;
// The first hole of a ring binding sits this far round the ring from its
// lowest point (radians), so the margins of the two bottom leaves, which
// point into the ring, stay apart.
const RING_FIRST_HOLE_ANGLE = 0.6;

// Leaves along the binding (y) by across it (x), in millimetres; the printed
// page is `pageWidth` by `pageHeight` as the reader holds it.
export const BOOK_TYPES = {
  hardcover: {
    name: "hardcover",
    label: "Hardcover",
    description: "Case bound, rounded spine, cloth over boards",
    binding: "case",
    orientation: "side",
    leafCount: 64,
    leafAcross: 130,
    leafAlong: 200,
    grammage: 150,
    stock: 1,
    tone: "ivory",
    // Leaves 0 and leafCount − 1 are the free endpapers.
    pageLeaves: [1, 62],
    endpapers: true,
    cover: { kind: "hard", boardThickness: 2.6, square: 3, colour: [0.16, 0.22, 0.3] },
  },
  paperback: {
    name: "paperback",
    label: "Paperback",
    description: "Perfect bound, flat glued spine, card cover",
    binding: "perfect",
    orientation: "side",
    // Leaf 0 is the front cover and leafCount − 1 the back cover.
    leafCount: 98,
    leafAcross: 110,
    leafAlong: 178,
    grammage: 90,
    stock: 0,
    tone: "cream",
    pageLeaves: [1, 96],
    endpapers: false,
    // The cover card wraps the glued back: a strip of card along the spine.
    cover: { kind: "soft", grammage: COVER_GRAMMAGE, front: true, back: true, wrapsSpine: true, colour: [0.95, 0.94, 0.91] },
  },
  booklet: {
    name: "booklet",
    label: "Saddle-stitched booklet",
    description: "Six folded sheets, stapled through the fold",
    binding: "saddle",
    orientation: "side",
    // Six sheets folded into twelve leaves; the outer sheet is the cover.
    leafCount: 12,
    leafAcross: 148,
    leafAlong: 210,
    grammage: 90,
    stock: 0,
    tone: "white",
    pageLeaves: [0, 11],
    endpapers: false,
    cover: { kind: "none", colour: [0.95, 0.95, 0.94] },
  },
  notebook: {
    name: "notebook",
    label: "Ring-bound notebook",
    description: "Wire loops through punched holes, card covers",
    binding: "rings",
    orientation: "side",
    leafCount: 52,
    leafAcross: 148,
    leafAlong: 210,
    grammage: 90,
    stock: 0,
    tone: "white",
    pageLeaves: [1, 50],
    endpapers: false,
    cover: { kind: "soft", grammage: COVER_GRAMMAGE, front: true, back: true, colour: [0.66, 0.53, 0.39] },
    rings: { pitch: 12.7, wireRadius: 0.55, holeRadius: 2.2, minimumRadius: 9.5 },
  },
  sketchpad: {
    name: "sketchpad",
    label: "Top-bound sketchpad",
    description: "Padded at the head over a backing board; pages flip up and over",
    binding: "perfect",
    orientation: "top",
    // Leaf 0 is the card cover; the backing board is not a leaf.
    leafCount: 33,
    leafAcross: 148,
    leafAlong: 210,
    grammage: 150,
    stock: 1,
    tone: "white",
    pageLeaves: [1, 32],
    endpapers: false,
    // The card cover is glued into the padded head like the leaves; the
    // backing board lies under them.
    cover: {
      kind: "soft", grammage: COVER_GRAMMAGE, front: true, back: false, colour: [0.36, 0.41, 0.37],
      backBoardThickness: 1.6,
    },
  },
};

export const bookType = (name) => {
  const type = BOOK_TYPES[name];
  if (!type) throw new Error(`Unknown book type "${name}"; known types: ${Object.keys(BOOK_TYPES).join(", ")}`);
  return type;
};

// The printed page as the reader holds it: side bindings print across the
// leaf from the bound edge; a top binding prints along it.
export const printedPageSize = (type) => type.orientation === "top"
  ? { pageWidth: type.leafAlong, pageHeight: type.leafAcross }
  : { pageWidth: type.leafAcross, pageHeight: type.leafAlong };

// ---------------------------------------------------------------- the block

// The leaves as a block: each leaf's paper and caliper, and what the two
// stacks lie on. Soft covers are leaves of card; boards are not leaves.
export class BookBlock {
  constructor(type, { leafCount = type.leafCount, grammage = type.grammage, holeInset = 0 } = {}) {
    if (!Number.isInteger(leafCount) || leafCount < 2 || leafCount > MAXIMUM_LEAVES) {
      throw new Error(`A ${type.name} needs between 2 and ${MAXIMUM_LEAVES} leaves; got ${leafCount}`);
    }
    if (type.binding === "saddle" && leafCount % 2 !== 0) {
      throw new Error(`A saddle-stitched ${type.name} folds whole sheets into two leaves each; ${leafCount} leaves is odd`);
    }
    const cover = type.cover;
    this.type = type;
    this.binding = type.binding;
    this.leafCount = leafCount;
    this.grammage = grammage;
    this.frontCover = cover.kind === "soft" && cover.front;
    this.backCover = cover.kind === "soft" && cover.back;
    this.grammages = new Float64Array(leafCount).fill(grammage);
    if (this.frontCover) this.grammages[0] = cover.grammage;
    if (this.backCover) this.grammages[leafCount - 1] = cover.grammage;
    this.calipers = this.grammages.map((leafGrammage) => leafGrammage * CALIPER_PER_GRAMMAGE);
    this.before = new Float64Array(leafCount + 1);
    for (let leaf = 0; leaf < leafCount; leaf++) this.before[leaf + 1] = this.before[leaf] + this.calipers[leaf];
    this.thickness = this.before[leafCount];
    this.hard = cover.kind === "hard";
    this.boardThickness = this.hard ? cover.boardThickness : 0;
    this.backBoardThickness = this.hard ? cover.boardThickness : cover.backBoardThickness ?? 0;
    // The back board carries the right stack; once open, the front board
    // carries the left one. Without boards a stack lies on the table.
    this.baseRight = this.backBoardThickness;
    this.baseLeft = this.boardThickness;
    // A soft cover wrapped round a flat back is a strip of card along it.
    this.spinePanel = this.binding === "perfect" && cover.wrapsSpine ? cover.grammage * CALIPER_PER_GRAMMAGE : 0;
    // The pivot of a ring-bound leaf is its hole, `holeInset` from its edge.
    this.pivotArc = this.binding === "rings" ? holeInset : 0;
    if (this.binding === "rings") {
      if (!(holeInset > 0)) throw new Error(`A ring binding needs the holes' distance from the edge; got ${holeInset}`);
      const rings = type.rings;
      this.ringRadius = Math.max(rings.minimumRadius, (this.thickness + 4) / (Math.PI - 2 * RING_FIRST_HOLE_ANGLE));
      this.ringCentre = [0, this.ringRadius + rings.wireRadius];
    }
  }

  isCover(leaf) {
    return (leaf === 0 && this.frontCover) || (leaf === this.leafCount - 1 && this.backCover);
  }

  // Mid-surface level of a leaf lying on either stack.
  leftLevel(leaf) {
    return this.baseLeft + this.before[leaf] + this.calipers[leaf] / 2;
  }

  rightLevel(leaf) {
    return this.baseRight + this.thickness - this.before[leaf + 1] + this.calipers[leaf] / 2;
  }

  level(leaf, side) {
    return side > 0 ? this.rightLevel(leaf) : this.leftLevel(leaf);
  }

  // Top face of each stack; an empty stack's top is what it lies on.
  leftTop(leftCount) {
    return this.baseLeft + this.before[leftCount];
  }

  rightTop(rightStart) {
    return this.baseRight + this.thickness - this.before[rightStart];
  }
}

// ---------------------------------------------------------------- pivots

// Writes every leaf's pivot for an opening state { leftCount, rightStart,
// boardAngle } into pivotX and pivotZ. A resting leaf's rest curve starts at
// its pivot; a turning leaf's bound edge is held there, except in a ring
// binding, where it slides on the ring (see turningCentre). For a glued back
// `gluedFrom`, when given, receives per leaf the unit normal from the cover's
// spine strip toward that leaf.
export const placePivots = (block, state, pivotX, pivotZ, gluedFrom = null) => {
  const { leftCount, rightStart } = state;
  const { leafCount, before, calipers, thickness } = block;
  const middle = (leaf) => before[leaf] + calipers[leaf] / 2;
  switch (block.binding) {
    case "case": {
      // The rounded back is the inner arc of the spine, about the boards'
      // hinge. Closed, each leaf is sewn at the height it lies at, so the
      // leaves are flat; as the front board opens the arc sweeps less and
      // its pivots close up toward the back board's joint.
      const halfBlock = thickness / 2;
      const hinge = block.boardThickness + halfBlock;
      const radius = halfBlock - Math.min(calipers[0], calipers[leafCount - 1]) / 2;
      const sweep = Math.PI - state.boardAngle;
      for (let leaf = 0; leaf < leafCount; leaf++) {
        const height = Math.min(1, Math.max(-1, (middle(leaf) - halfBlock) / radius));
        const angle = -Math.PI / 2 - sweep * Math.acos(height) / Math.PI;
        pivotX[leaf] = radius * Math.cos(angle);
        pivotZ[leaf] = hinge + radius * Math.sin(angle);
      }
      return;
    }
    case "perfect": {
      // The glued back folds where the book is open: each half hangs from
      // the fold toward its own stack. A closed book's back stands upright;
      // opened in the middle it lies flat under the gutter. The positions
      // here are the mid-line of the cover's spine strip; each half's leaves
      // are glued to its own face of the strip, so where the halves fold
      // together the strip lies between them.
      const panel = block.spinePanel;
      const left = before[leftCount];
      const right = thickness - before[rightStart];
      const lift = panel / 2 * (1 - Math.abs(right - left) / thickness);
      const footRight = block.baseRight + lift;
      const footLeft = block.baseLeft + lift;
      const fold = Math.max(footRight + right - left, footLeft + left - right, footRight, footLeft);
      const rightSine = right > 0 ? Math.min(1, (fold - footRight) / right) : 1;
      const leftSine = left > 0 ? Math.min(1, (fold - footLeft) / left) : 1;
      const rightCosine = Math.sqrt(1 - rightSine * rightSine);
      const leftCosine = Math.sqrt(1 - leftSine * leftSine);
      // From the strip toward the leaves glued to it, on each half and at the fold.
      const rightNormal = [rightSine, rightCosine];
      const leftNormal = [-leftSine, leftCosine];
      let apexX = rightNormal[0] + leftNormal[0];
      let apexZ = rightNormal[1] + leftNormal[1];
      const apexLength = Math.hypot(apexX, apexZ);
      [apexX, apexZ] = apexLength < 1e-6 ? [0, 1] : [apexX / apexLength, apexZ / apexLength];
      const glue = panel / 2;
      for (let leaf = 0; leaf < leafCount; leaf++) {
        let normal = [apexX, apexZ];
        if (leaf >= rightStart) {
          const along = middle(leaf) - before[rightStart];
          normal = rightNormal;
          pivotX[leaf] = along * rightCosine + glue * normal[0];
          pivotZ[leaf] = fold - along * rightSine + glue * normal[1];
        } else if (leaf < leftCount) {
          const along = before[leftCount] - middle(leaf);
          normal = leftNormal;
          pivotX[leaf] = -along * leftCosine + glue * normal[0];
          pivotZ[leaf] = fold - along * leftSine + glue * normal[1];
        } else {
          pivotX[leaf] = glue * apexX;
          pivotZ[leaf] = fold + glue * apexZ;
        }
        if (gluedFrom) {
          gluedFrom[2 * leaf] = normal[0];
          gluedFrom[2 * leaf + 1] = normal[1];
        }
      }
      return;
    }
    case "saddle": {
      // Every sheet passes through the staple: a closed booklet folds about
      // the middle of its thickness, one open at its centre spread lies on
      // the staple at the bottom.
      const left = before[leftCount];
      const right = thickness - before[rightStart];
      const staple = Math.min(block.baseLeft, block.baseRight) + calipers[0] / 2 + Math.abs(right - left) / 2;
      pivotX.fill(0);
      pivotZ.fill(staple);
      return;
    }
    case "rings": {
      // Holes sit on the ring packed one caliper apart, from near its
      // lowest point up each side: the bottom leaf of a stack lowest.
      const radius = block.ringRadius;
      const [centreX, centreZ] = block.ringCentre;
      for (let leaf = 0; leaf < leafCount; leaf++) {
        let angle = Math.PI / 2;
        if (leaf >= rightStart) {
          angle = -Math.PI / 2 + RING_FIRST_HOLE_ANGLE + (thickness - before[leaf + 1] + calipers[leaf] / 2) / radius;
        } else if (leaf < leftCount) {
          angle = -Math.PI / 2 - RING_FIRST_HOLE_ANGLE - middle(leaf) / radius;
        }
        pivotX[leaf] = centreX + radius * Math.cos(angle);
        pivotZ[leaf] = centreZ + radius * Math.sin(angle);
      }
      return;
    }
    default:
      throw new Error(`Unknown binding "${block.binding}" for ${block.type.name}; known: case, perfect, saddle, rings`);
  }
};

// The point a turning leaf swings about: its pivot, or the ring's centre.
export const turningCentre = (block, pivotX, pivotZ, leaf) =>
  block.binding === "rings" ? block.ringCentre : [pivotX[leaf], pivotZ[leaf]];
