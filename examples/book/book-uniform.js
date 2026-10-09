// What the book shaders read about a model, and the turn between the
// binding's frame (book-model.js) and the world: a top-bound pad lies a
// quarter turn round, its bound edge across the head.

import { GRID_COLUMNS, GRID_ROWS } from "./book-model.js";
import { FOLIO_COLUMNS, FOLIO_HEIGHT, FOLIO_ROWS, FOLIO_WIDTH, SLOT_COLUMNS, SLOT_ROWS } from "./book-document.js";

const PAPER_TONES = { white: [0.955, 0.952, 0.94], ivory: [0.953, 0.935, 0.885], cream: [0.945, 0.915, 0.84] };
const PAPER_TRANSLUCENCY = { 90: 0.34, 150: 0.22, 250: 0.12 };
const CARD_TRANSLUCENCY = 0.05;
export const MAXIMUM_RING_LOOPS = 24;
const COVER_KINDS = { none: 0, soft: 1, hard: 2 };

const isTopBound = (model) => model.type.orientation === "top";

export const toWorld = (model, point) => isTopBound(model) ? [point[1], -point[0], point[2]] : point;

export const toBinding = (model, point) => isTopBound(model) ? [-point[1], point[0], point[2]] : point;

// Wire loops of a ring binding, evenly spaced along the bound edge.
export const ringLoops = (model) => {
  if (!model.rings) return 0;
  const loops = Math.floor((model.leafAlong - 10) / model.type.rings.pitch) + 1;
  if (loops > MAXIMUM_RING_LOOPS) {
    throw new Error(`${loops} ring loops exceed the ${MAXIMUM_RING_LOOPS} drawn; lengthen the pitch or raise MAXIMUM_RING_LOOPS`);
  }
  return loops;
};

// Direction a leaf leaves its pivot in the cross-section.
const leavingDirection = (model, leaf) => {
  const turning = model.turning.find((candidate) => candidate.index === leaf);
  let deltaX;
  let deltaZ;
  if (turning) {
    const middle = 3 * (Math.floor(GRID_ROWS / 2) * GRID_COLUMNS);
    deltaX = turning.positions[middle + 3] - turning.positions[middle];
    deltaZ = turning.positions[middle + 5] - turning.positions[middle + 2];
  } else {
    const [x0, z0] = model.curves.point(leaf, 0);
    const [x1, z1] = model.curves.point(leaf, 2);
    deltaX = x1 - x0;
    deltaZ = z1 - z0;
  }
  const length = Math.hypot(deltaX, deltaZ) || 1;
  return [deltaX / length, deltaZ / length];
};

// The staples of a saddle stitch sit at the fold, their crowns on the
// outside of the outer sheet: opposite the two halves' mean direction.
const stapleFrame = (model) => {
  if (model.type.binding !== "saddle") return [0, 0, 0, -1];
  const first = leavingDirection(model, 0);
  const last = leavingDirection(model, model.leafCount - 1);
  let outwardX = -(first[0] + last[0]);
  let outwardZ = -(first[1] + last[1]);
  let length = Math.hypot(outwardX, outwardZ);
  if (length < 0.2) {
    // Opened flat: the outside is below.
    outwardX = 0;
    outwardZ = -1;
    length = 1;
  }
  return [model.curves.pivotX[0], model.curves.pivotZ[0], outwardX / length, outwardZ / length];
};

// Values for the Book uniform of book-geometry.wgsl. `flow`, when the book
// prints an edited document, gives the face each flow sheet cell holds and
// the cell size in uv; the document's own numbered pages then give way to
// it, and its covers and templates stay.
export const bookUniformValues = ({ model, document, paper, flow = null }) => {
  const { type, block } = model;
  const turning = new Array(8).fill(0);
  model.turning.forEach((leaf, slot) => { turning[slot] = leaf.index; });
  const firstPage = type.pageLeaves[0];
  const lastPage = model.leafCount - (type.leafCount - type.pageLeaves[1]);
  const numbered = (face) => face >= 2 * firstPage && face <= 2 * lastPage + 1;
  const faces = flow ? document.slotFaces.map((face) => numbered(face) ? -1 : face) : document.slotFaces;
  const flowFaces = flow ? flow.faces : new Array(8).fill(-1);
  const loops = ringLoops(model);
  return {
    page: [model.leafAcross, model.leafAlong, model.leafThickness, model.curves.shell.length],
    board: [block.boardThickness, model.square, model.hingeHeight ?? 0, model.halfBlock],
    stacks: [model.leftCount, model.rightStart, model.leafCount, model.board ? model.board.angle : Math.PI],
    grid: [GRID_COLUMNS, GRID_ROWS, model.turning.length, 0],
    turning: [turning.slice(0, 4), turning.slice(4, 8)],
    sheet: [
      document.slotWidth / document.documentWidth, document.slotHeight / document.documentHeight, SLOT_COLUMNS,
      SLOT_ROWS * document.slotHeight / document.documentHeight,
    ],
    folio: [FOLIO_WIDTH / document.documentWidth, FOLIO_HEIGHT / document.documentHeight, FOLIO_COLUMNS, FOLIO_ROWS],
    slots: faces.slice(0, 4),
    slotsMore: [faces[4], faces[5], document.templateSlot, document.templateFaces === "recto" ? 1 : 0],
    pages: [firstPage, lastPage, document.folios ? 1 : 0, type.endpapers ? 1 : 0],
    paper: [...PAPER_TONES[paper.tone], PAPER_TRANSLUCENCY[model.grammage]],
    // Cover colour: bookcloth or card; w is the paper stock index (see paper.wgsl).
    cloth: [...type.cover.colour, paper.stock],
    binding: [isTopBound(model) ? 1 : 0, COVER_KINDS[type.cover.kind], block.backBoardThickness, model.rings ? 1 : 0],
    rings: model.rings ? [...block.ringCentre, block.ringRadius, type.rings.wireRadius] : [0, 0, 0, 0],
    holes: model.rings ? [block.pivotArc, type.rings.holeRadius, type.rings.pitch, loops] : [0, 0, 1, 0],
    covers: [block.frontCover ? 1 : 0, block.backCover ? 1 : 0, CARD_TRANSLUCENCY, type.binding === "saddle" ? 1 : 0],
    staple: stapleFrame(model),
    flow: [flowFaces.slice(0, 4), flowFaces.slice(4, 8)],
    flowGrid: flow ? flow.grid : [0, 0, 1, 0],
  };
};
