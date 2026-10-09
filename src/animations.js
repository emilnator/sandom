import {
  normalizeAnimationOffsets,
  writeAnimationTrack,
  writeAnimationKeyframe,
  updateAnimationTransition,
  animationTransitionRevision,
  animationTransitionDuration,
  releaseAnimationTransition,
  createAnimationTrackIdentity,
  releaseAnimationTrackIdentity,
  identifyAnimationFeedback,
  nextAnimationReplacement,
  normalizeAnimationValue as normalizeValue,
  normalizeAnimationEasing as normalizeEasing,
  animationPropertyFrames,
} from "./dom-wasm/animation.js";
import { boxSnapshotFor } from "./dom-wasm/geometry-wire.js";
import {
  ANIMATION_EVENT_ENTRY_SIZE,
  ANIMATION_EVENT_QUEUE_BASE,
  ANIMATION_EVENT_QUEUE_SIZE,
  ANIMATION_RECORD_SIZE,
  ANIMATION_RESULT_BASE,
  ANIMATION_TABLE_BASE,
  ANIMATION_TABLE_CAPACITY,
  EFFECT_STACK_ENTRY_SIZE,
  EFFECT_STACK_TABLE_BASE,
  EFFECT_STACK_TABLE_CAPACITY,
  KEYFRAME_ENTRY_SIZE,
  KEYFRAME_POOL_BASE,
  KEYFRAME_POOL_CAPACITY,
  LAYOUT_NODE_OFFSET_BG_COLOR,
  LAYOUT_NODE_OFFSET_FLEX_BASIS,
  LAYOUT_NODE_OFFSET_FLEX_BASIS_PERCENT,
  LAYOUT_NODE_OFFSET_FLEX_BASIS_TAG,
  LAYOUT_NODE_OFFSET_FONT_SIZE,
  LAYOUT_NODE_OFFSET_HEIGHT,
  LAYOUT_NODE_OFFSET_HEIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_HEIGHT_TAG,
  LAYOUT_NODE_OFFSET_INSET_BOTTOM,
  LAYOUT_NODE_OFFSET_INSET_BOTTOM_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_BOTTOM_TAG,
  LAYOUT_NODE_OFFSET_INSET_LEFT,
  LAYOUT_NODE_OFFSET_INSET_LEFT_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_LEFT_TAG,
  LAYOUT_NODE_OFFSET_INSET_RIGHT,
  LAYOUT_NODE_OFFSET_INSET_RIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_RIGHT_TAG,
  LAYOUT_NODE_OFFSET_INSET_TOP,
  LAYOUT_NODE_OFFSET_INSET_TOP_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_TOP_TAG,
  LAYOUT_NODE_OFFSET_MAX_H_TAG,
  LAYOUT_NODE_OFFSET_MAX_HEIGHT,
  LAYOUT_NODE_OFFSET_MAX_HEIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_MAX_W_TAG,
  LAYOUT_NODE_OFFSET_MAX_WIDTH,
  LAYOUT_NODE_OFFSET_MAX_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_MIN_H_TAG,
  LAYOUT_NODE_OFFSET_MIN_HEIGHT,
  LAYOUT_NODE_OFFSET_MIN_HEIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_MIN_W_TAG,
  LAYOUT_NODE_OFFSET_MIN_WIDTH,
  LAYOUT_NODE_OFFSET_MIN_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_LINE_HEIGHT,
  LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG,
  LAYOUT_NODE_OFFSET_OPACITY,
  LAYOUT_NODE_OFFSET_PADDING_TOP,
  LAYOUT_NODE_OFFSET_PADDING_RIGHT,
  LAYOUT_NODE_OFFSET_PADDING_BOTTOM,
  LAYOUT_NODE_OFFSET_PADDING_LEFT,
  LAYOUT_NODE_OFFSET_ROW_GAP,
  LAYOUT_NODE_OFFSET_COLUMN_GAP,
  LAYOUT_NODE_OFFSET_SHADOW_COUNT,
  LAYOUT_NODE_OFFSET_SHADOW_OFFSET,
  LAYOUT_NODE_OFFSET_TEXT_COLOR,
  LAYOUT_NODE_OFFSET_TRANSFORM,
  LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT,
  LAYOUT_NODE_OFFSET_VISIBILITY_HIDDEN,
  LAYOUT_NODE_OFFSET_WIDTH,
  LAYOUT_NODE_OFFSET_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_WIDTH_TAG,
  LAYOUT_NODE_SIZE,
  LAYOUT_NODE_OFFSET_FLAGS,
  LAYOUT_FLAG_HAS_BOX_SHADOW,
  LINEAR_EASING_ENTRY_SIZE,
  LINEAR_EASING_POOL_BASE,
  LINEAR_EASING_POOL_CAPACITY,
  SHADOW_ENTRY_SIZE,
  SHADOW_OFFSET_COLOR,
  SHADOW_OFFSET_INSET,
  SHADOW_POOL_BASE,
  SIZE_TAG_CALC_PAIR,
  SIZE_TAG_LENGTH,
  SIZE_TAG_PERCENT,
  TRANSFORM_COMPONENT_ENTRY_SIZE,
  TRANSFORM_COMPONENT_POOL_BASE,
  TRANSFORM_COMPONENT_POOL_CAPACITY,
} from "./wasm/layout.js";

const animationMeasurementKey = Symbol.for("sandom.domCore.measurement");

const PROPERTY_REGISTRY = Object.freeze({
  width: lengthProperty(
    1,
    LAYOUT_NODE_OFFSET_WIDTH,
    LAYOUT_NODE_OFFSET_WIDTH_TAG,
    LAYOUT_NODE_OFFSET_WIDTH_PERCENT,
  ),
  "min-width": lengthProperty(
    2,
    LAYOUT_NODE_OFFSET_MIN_WIDTH,
    LAYOUT_NODE_OFFSET_MIN_W_TAG,
    LAYOUT_NODE_OFFSET_MIN_WIDTH_PERCENT,
  ),
  "max-width": lengthProperty(
    3,
    LAYOUT_NODE_OFFSET_MAX_WIDTH,
    LAYOUT_NODE_OFFSET_MAX_W_TAG,
    LAYOUT_NODE_OFFSET_MAX_WIDTH_PERCENT,
  ),
  height: lengthProperty(
    4,
    LAYOUT_NODE_OFFSET_HEIGHT,
    LAYOUT_NODE_OFFSET_HEIGHT_TAG,
    LAYOUT_NODE_OFFSET_HEIGHT_PERCENT,
  ),
  "min-height": lengthProperty(
    5,
    LAYOUT_NODE_OFFSET_MIN_HEIGHT,
    LAYOUT_NODE_OFFSET_MIN_H_TAG,
    LAYOUT_NODE_OFFSET_MIN_HEIGHT_PERCENT,
  ),
  "max-height": lengthProperty(
    6,
    LAYOUT_NODE_OFFSET_MAX_HEIGHT,
    LAYOUT_NODE_OFFSET_MAX_H_TAG,
    LAYOUT_NODE_OFFSET_MAX_HEIGHT_PERCENT,
  ),
  left: lengthProperty(
    7,
    LAYOUT_NODE_OFFSET_INSET_LEFT,
    LAYOUT_NODE_OFFSET_INSET_LEFT_TAG,
    LAYOUT_NODE_OFFSET_INSET_LEFT_PERCENT,
  ),
  right: lengthProperty(
    8,
    LAYOUT_NODE_OFFSET_INSET_RIGHT,
    LAYOUT_NODE_OFFSET_INSET_RIGHT_TAG,
    LAYOUT_NODE_OFFSET_INSET_RIGHT_PERCENT,
  ),
  top: lengthProperty(
    9,
    LAYOUT_NODE_OFFSET_INSET_TOP,
    LAYOUT_NODE_OFFSET_INSET_TOP_TAG,
    LAYOUT_NODE_OFFSET_INSET_TOP_PERCENT,
  ),
  bottom: lengthProperty(
    10,
    LAYOUT_NODE_OFFSET_INSET_BOTTOM,
    LAYOUT_NODE_OFFSET_INSET_BOTTOM_TAG,
    LAYOUT_NODE_OFFSET_INSET_BOTTOM_PERCENT,
  ),
  "flex-basis": lengthProperty(
    11,
    LAYOUT_NODE_OFFSET_FLEX_BASIS,
    LAYOUT_NODE_OFFSET_FLEX_BASIS_TAG,
    LAYOUT_NODE_OFFSET_FLEX_BASIS_PERCENT,
  ),
  opacity: { id: 12, kind: 1, valueOffset: LAYOUT_NODE_OFFSET_OPACITY },
  "background-color": {
    id: 13,
    kind: 3,
    valueOffset: LAYOUT_NODE_OFFSET_BG_COLOR,
  },
  visibility: {
    id: 14,
    kind: 6,
    valueOffset: LAYOUT_NODE_OFFSET_VISIBILITY_HIDDEN,
  },
  transform: { id: 15, kind: 4, valueOffset: LAYOUT_NODE_OFFSET_TRANSFORM },
  // Text colour, same f32[4] rgba shape as background-color. The property
  // a design system transitions most often: shadcn's controls declare
  // `transition-property: color, box-shadow` on every trigger, tab and
  // button, so leaving it unregistered made all of them snap.
  color: {
    id: 16,
    kind: 3,
    valueOffset: LAYOUT_NODE_OFFSET_TEXT_COLOR,
  },
  // The shadow list (kind 7). Its keyframes are component spans; the
  // node's span pointer is what the track owns and restores.
  "box-shadow": {
    id: 17,
    kind: 7,
    valueOffset: LAYOUT_NODE_OFFSET_SHADOW_OFFSET,
  },
  "padding-top": { id: 18, kind: 1, valueOffset: LAYOUT_NODE_OFFSET_PADDING_TOP },
  "padding-right": { id: 19, kind: 1, valueOffset: LAYOUT_NODE_OFFSET_PADDING_RIGHT },
  "padding-bottom": { id: 20, kind: 1, valueOffset: LAYOUT_NODE_OFFSET_PADDING_BOTTOM },
  "padding-left": { id: 21, kind: 1, valueOffset: LAYOUT_NODE_OFFSET_PADDING_LEFT },
  "row-gap": { id: 22, kind: 1, valueOffset: LAYOUT_NODE_OFFSET_ROW_GAP },
  "column-gap": { id: 23, kind: 1, valueOffset: LAYOUT_NODE_OFFSET_COLUMN_GAP },
  "font-size": { id: 24, kind: 1, valueOffset: LAYOUT_NODE_OFFSET_FONT_SIZE },
  "line-height": {
    id: 25,
    kind: 8,
    valueOffset: LAYOUT_NODE_OFFSET_LINE_HEIGHT,
    tagOffset: LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG,
  },
  translate: {
    id: 26,
    kind: 9,
    // An active translate sample occupies the percentage-coefficient slots:
    // the post-layout resolver has already consumed the authored transform's
    // box-linear coefficients by then.
    valueOffset: LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT,
  },
});

const PROPERTY_NAMES = new Map(
  Object.entries(PROPERTY_REGISTRY).map(([name, value]) => [value.id, name]),
);
const COMPOSITE_VALUES = Object.freeze({ replace: 0, add: 1, accumulate: 2 });
const EVENT_NAMES = Object.freeze([
  "",
  "animationstart",
  "animationend",
  "animationcancel",
  "transitionstart",
  "transitionend",
  "transitioncancel",
]);

function lengthProperty(id, valueOffset, tagOffset, percentageOffset) {
  return { id, kind: 2, valueOffset, tagOffset, percentageOffset };
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function firstFit(occupancy, count) {
  if (count === 0) return 0;
  let run = 0;
  for (let index = 0; index < occupancy.length; index++) {
    run = occupancy[index] === 0 ? run + 1 : 0;
    if (run === count) return index - count + 1;
  }
  return -1;
}

function reserve(occupancy, offset, count) {
  occupancy.fill(1, offset, offset + count);
}

function release(occupancy, offset, count) {
  occupancy.fill(0, offset, offset + count);
}

export const normalizeOffsets = normalizeAnimationOffsets;



// Per-ENGINE animation pool bookkeeping. Several controllers can share one
// engine (persistent renderers created through one scene-renderer runtime),
// so slot and pool occupancy must live per engine, not per controller —
// otherwise two controllers double-book the same table rows and pool spans.
// The table's occupant is per engine for the same reason (see acquire in
// createAnimationController).
const ENGINE_ANIMATION_POOLS = new WeakMap();

function engineAnimationPools(engine) {
  let pools = ENGINE_ANIMATION_POOLS.get(engine);
  if (!pools) {
    pools = {
      trackReservations: new Set(),
      keyframeOccupancy: new Uint8Array(KEYFRAME_POOL_CAPACITY),
      transformOccupancy: new Uint8Array(TRANSFORM_COMPONENT_POOL_CAPACITY),
      linearOccupancy: new Uint8Array(LINEAR_EASING_POOL_CAPACITY),
      effectStackOccupancy: new Uint8Array(EFFECT_STACK_TABLE_CAPACITY),
      occupant: null,
    };
    ENGINE_ANIMATION_POOLS.set(engine, pools);
  }
  return pools;
}

export function createAnimationController(engine, options = {}) {
  // Long-lived view over the shared engine+HarfBuzz memory — re-derived
  // on HarfBuzz heap growth (the one refresh rule, src/wasm/loader.js).
  const measurement = globalThis[animationMeasurementKey];
  const measurementOptions = measurement ? {
    module: "animation", category: "animation",
    ranges: [{ start: ANIMATION_EVENT_QUEUE_BASE, end: ANIMATION_EVENT_QUEUE_BASE + ANIMATION_EVENT_QUEUE_SIZE, category: "lifecycle" }],
  } : null;
  let view = new DataView(engine.memory.buffer);
  let sampleTime = null;
  let computedSamples = null;
  function bindComputedSamples(binding) {
    computedSamples = binding;
  }
  function captureComputedSamples() {
    if (!computedSamples || sampleTime === null) return;
    const { core, owner, elements } = computedSamples;
    for (const [slot, allocation] of allocations) {
      const address = ANIMATION_TABLE_BASE + slot * ANIMATION_RECORD_SIZE;
      const index = view.getUint16(address, true);
      const element = elements[index];
      if (!element || element._domCore !== core) continue;
      const property = PROPERTY_REGISTRY[PROPERTY_NAMES.get(view.getUint16(address + 2, true))];
      core.captureComputedSample(engine, owner, allocation.identity,
        element._coreHandle, index, address, property, sampleTime);
    }
  }
  // `generatedRows`: the rows of the scene's ::before and ::after boxes,
  // or undefined for a scene that does not list them.
  function captureComputedPseudos(nodes, boxes, generatedRows) {
    if (!computedSamples) return;
    const { core, owner, elements } = computedSamples;
    core.captureComputedPseudos(engine, owner, nodes, elements, boxes, generatedRows);
  }
  function captureComputedGeometry(boxes) {
    if (!computedSamples) return;
    const { core, owner } = computedSamples;
    const snapshot = boxSnapshotFor(boxes, core);
    try {
      core.status("computed_samples_geometry", owner, snapshot.handle);
    } finally {
      snapshot.release();
    }
  }
  function forgetComputedSample(identity) {
    if (computedSamples) computedSamples.core.status(
      "computed_samples_cancel", computedSamples.owner, identity);
  }
  if (measurement) {
    measurement.record({ category: "animation", operation: "engine-view.create", direction: "host", allocations: 1 });
    view = measurement.wrapDataView(view, measurementOptions);
  }
  // A controller ends before a shared engine does: dispose() removes this
  // listener, which otherwise retains the controller and its owner's scene.
  const removeViewRefresh = engine.onMemoryGrowth(() => {
    view = new DataView(engine.memory.buffer);
    if (measurement) {
      measurement.record({ category: "animation", operation: "engine-view.create", direction: "host", allocations: 1 });
      view = measurement.wrapDataView(view, measurementOptions);
    }
  });
  const pools = engineAnimationPools(engine);
  const {
    trackReservations,
    keyframeOccupancy,
    transformOccupancy,
    linearOccupancy,
    effectStackOccupancy,
  } = pools;
  const allocations = new Map();
  const liveTransitions = new Map();
  const effectStacks = new Map();
  let suppressEvents = false;
  let declarationSequence = 0;
  // Engine-table occupancy (shared-engine renderer coexistence). The engine
  // tick samples every published track of the shared table and queues its
  // events, so the table publishes the tracks of one controller only: the
  // occupant's. The tracks of every other controller are suspended. A
  // suspended track keeps its record bytes and JS bookkeeping but carries
  // state 0, so the occupant's tick neither samples it onto the occupant's
  // scene nodes nor queues an event that the occupant cannot identify.
  // Time-based sampling makes suspension lossless: progress is a pure
  // function of the tick time, never of elapsed ticks. The shared
  // trackReservations set keeps a suspended (state 0) slot from being
  // claimed by another controller.
  const suspendedTrackStates = new Map();
  const occupancy = Object.freeze({ suspend });

  // Every operation that publishes a track or ticks the table acquires the
  // table first, in the same synchronous turn. An acquisition does not hold
  // across an await: another controller can acquire the table meanwhile.
  function acquire() {
    if (pools.occupant === occupancy) return;
    pools.occupant?.suspend();
    for (const [trackIndex, state] of suspendedTrackStates) {
      view.setUint8(
        ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE + 4,
        state,
      );
    }
    suspendedTrackStates.clear();
    pools.occupant = occupancy;
  }

  function suspend() {
    for (const trackIndex of allocations.keys()) {
      if (suspendedTrackStates.has(trackIndex)) continue;
      const address = ANIMATION_TABLE_BASE +
        trackIndex * ANIMATION_RECORD_SIZE + 4;
      const state = view.getUint8(address);
      if (state === 0) continue;
      suspendedTrackStates.set(trackIndex, state);
      view.setUint8(address, 0);
    }
  }

  // Layout-row ownership (shared-engine renderer coexistence). Renderers
  // that share one engine also share its layout buffer, and each frame
  // fills it with the rows of one scene. A track's base is its node's value
  // in this controller's own scene, so it is read from those rows and
  // restored into them only while they fill the buffer. A controller alone
  // on its engine always owns the rows.
  const ownsLayoutRows = options.ownsLayoutRows ?? (() => true);
  // Effect stacks declared while another scene's rows filled the buffer.
  // Their base waits until this controller's rows are back.
  const deferredBaseStacks = new Set();
  // A deferred stack's base until it is read. The engine does not read it:
  // a cancel before the read restores nothing, and every tick and layout
  // of this controller's rows comes after the read.
  const DEFERRED_BASE = Object.freeze({ tag: 0, values: Object.freeze([]) });

  function writeStackBase(stack, base) {
    stack.base = base;
    const entryAddress = EFFECT_STACK_TABLE_BASE +
      stack.index * EFFECT_STACK_ENTRY_SIZE;
    view.setUint8(entryAddress + 4, base.tag);
    for (let index = 0; index < 6; index++) {
      view.setFloat32(entryAddress + 8 + index * 4, base.values[index] ?? 0, true);
    }
    for (const trackIndex of stack.tracks) {
      const address = ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE;
      view.setUint8(address + 58, base.tag);
      for (let index = 0; index < 6; index++) {
        view.setFloat32(address + 60 + index * 4, base.values[index] ?? 0, true);
      }
    }
  }

  // The caller guarantees that this controller's rows fill the buffer.
  function readDeferredBases() {
    for (const stack of deferredBaseStacks) {
      const entryAddress = EFFECT_STACK_TABLE_BASE +
        stack.index * EFFECT_STACK_ENTRY_SIZE;
      const property = PROPERTY_REGISTRY[
        PROPERTY_NAMES.get(view.getUint16(entryAddress + 2, true))
      ];
      writeStackBase(stack, snapshotBase(view.getUint16(entryAddress, true), property));
    }
    deferredBaseStacks.clear();
  }

  // Whether this controller's rows fill the buffer. Owning them, the
  // controller first reads every base it deferred.
  function ownsRows() {
    if (!ownsLayoutRows()) return false;
    readDeferredBases();
    return true;
  }

  // A cancelled track restores its base into this controller's rows. While
  // another scene's rows fill the buffer it restores nothing: those rows are
  // not this controller's to write, and the next frame of this controller
  // writes every row of its scene again after that foreign write.
  function cancelTrack(trackIndex) {
    return engine.exports.cancel_animation(trackIndex, ownsRows() ? 1 : 0);
  }

  // The layout that follows reads the table and this controller's rows,
  // which the caller guarantees fill the buffer.
  function prepareLayout() {
    acquire();
    readDeferredBases();
  }

  function cancelAll() {
    if (computedSamples) computedSamples.core.status("computed_samples_clear", computedSamples.owner);
    let writeCount = 0;
    const transitions = [...liveTransitions].map(([key, state]) => [key, state, animationTransitionRevision(state)]);
    try {
      for (const [trackIndex, owned] of [...allocations]) {
        if (allocations.get(trackIndex) !== owned) continue;
        acquire();
        writeCount += cancelTrack(trackIndex);
        try { drainEvents(trackIndex); }
        finally { freeTrack(trackIndex, owned); }
      }
      // A controller without tracks releases the table, so the engine keeps
      // no reference to a controller that has shut down.
      if (allocations.size === 0 && pools.occupant === occupancy) {
        pools.occupant = null;
      }
    } finally {
      for (const [key, state, revision] of transitions) {
        if (liveTransitions.get(key) !== state || animationTransitionRevision(state) !== revision) continue;
        liveTransitions.delete(key);
        releaseAnimationTransition(state);
      }
    }
    return writeCount;
  }


  function compactDeclarationSequences() {
    const activeTrackIndices = [...allocations.keys()].sort((
      left,
      right,
    ) =>
      view.getUint32(
        ANIMATION_TABLE_BASE + left * ANIMATION_RECORD_SIZE + 96,
        true,
      ) -
      view.getUint32(
        ANIMATION_TABLE_BASE + right * ANIMATION_RECORD_SIZE + 96,
        true,
      )
    );
    for (
      let sequenceIndex = 0;
      sequenceIndex < activeTrackIndices.length;
      sequenceIndex++
    ) {
      view.setUint32(
        ANIMATION_TABLE_BASE +
          activeTrackIndices[sequenceIndex] * ANIMATION_RECORD_SIZE + 96,
        (sequenceIndex + 1) * 1024,
        true,
      );
    }
    declarationSequence = activeTrackIndices.length * 1024;
  }

  function writeEasing(kindAddress, payloadAddress, easing, reservations) {
    view.setUint8(kindAddress, easing.kind);
    for (let index = 0; index < 4; index++) {
      view.setFloat32(
        payloadAddress + index * 4,
        easing.payload?.[index] ?? 0,
        true,
      );
    }
    if (easing.kind === 3) {
      const pointOffset = firstFit(linearOccupancy, easing.points.length);
      if (pointOffset < 0) throw new RangeError("LINEAR_EASING_POOL is full");
      reserve(linearOccupancy, pointOffset, easing.points.length);
      reservations.push(() =>
        release(linearOccupancy, pointOffset, easing.points.length)
      );
      for (let index = 0; index < easing.points.length; index++) {
        const pointAddress = LINEAR_EASING_POOL_BASE +
          (pointOffset + index) * LINEAR_EASING_ENTRY_SIZE;
        view.setFloat32(pointAddress, easing.points[index].input, true);
        view.setFloat32(pointAddress + 4, easing.points[index].output, true);
      }
      view.setUint32(
        payloadAddress,
        pointOffset * LINEAR_EASING_ENTRY_SIZE,
        true,
      );
      view.setUint32(payloadAddress + 4, easing.points.length, true);
    }
  }

  function snapshotBase(nodeIndex, property) {
    const nodeAddress = engine.exports.layout_buffer_base() + nodeIndex * LAYOUT_NODE_SIZE;
    if (property.kind === 2) {
      const tag = view.getUint8(nodeAddress + property.tagOffset);
      const stored = view.getFloat32(nodeAddress + property.valueOffset, true);
      if (tag === SIZE_TAG_LENGTH) return { tag, values: [stored, 0, stored] };
      if (tag === SIZE_TAG_PERCENT) {
        return { tag, values: [0, stored / 100, stored] };
      }
      if (tag === SIZE_TAG_CALC_PAIR) {
        return {
          tag,
          values: [
            stored,
            view.getFloat32(nodeAddress + property.percentageOffset, true),
            stored,
          ],
        };
      }
      return { tag, values: [0, 0, stored] };
    }
    if (property.kind === 3) {
      return {
        tag: 0,
        values: [0, 1, 2, 3].map((index) =>
          view.getFloat32(nodeAddress + property.valueOffset + index * 4, true)
        ),
      };
    }
    if (property.kind === 4) {
      return {
        tag: 0,
        values: [0, 1, 2, 3, 4, 5].map((index) =>
          view.getFloat32(nodeAddress + property.valueOffset + index * 4, true)
        ),
      };
    }
    if (property.kind === 9) {
      return {
        tag: 0,
        values: [0, 1, 2, 3].map((index) =>
          view.getFloat32(nodeAddress + property.valueOffset + index * 4, true)
        ),
      };
    }
    if (property.kind === 6) {
      return {
        tag: view.getUint8(nodeAddress + property.valueOffset),
        values: [view.getUint8(nodeAddress + property.valueOffset)],
      };
    }
    if (property.kind === 7) {
      // The node's own span: what the track's end restores.
      return {
        tag: 0,
        values: [
          view.getUint32(nodeAddress + LAYOUT_NODE_OFFSET_SHADOW_OFFSET, true),
          view.getUint8(nodeAddress + LAYOUT_NODE_OFFSET_SHADOW_COUNT),
          (view.getUint16(nodeAddress + LAYOUT_NODE_OFFSET_FLAGS, true) & LAYOUT_FLAG_HAS_BOX_SHADOW) ? 1 : 0,
        ],
      };
    }
    if (property.kind === 8) {
      const tag = view.getUint8(nodeAddress + property.tagOffset);
      return { tag, values: [view.getFloat32(nodeAddress + property.valueOffset, true), tag] };
    }
    return {
      tag: 0,
      values: [view.getFloat32(nodeAddress + property.valueOffset, true)],
    };
  }

  // The shadow list the node paints now: its record's span, or the span an
  // earlier box-shadow track is sampling into. The start of an interrupting
  // transition.
  function liveShadowList(nodeIndex) {
    const nodeAddress = engine.exports.layout_buffer_base() + nodeIndex * LAYOUT_NODE_SIZE;
    const painted = (view.getUint16(nodeAddress + LAYOUT_NODE_OFFSET_FLAGS, true) & LAYOUT_FLAG_HAS_BOX_SHADOW) !== 0;
    const count = painted ? view.getUint8(nodeAddress + LAYOUT_NODE_OFFSET_SHADOW_COUNT) : 0;
    const span = SHADOW_POOL_BASE + view.getUint32(nodeAddress + LAYOUT_NODE_OFFSET_SHADOW_OFFSET, true);
    const shadows = [];
    for (let index = 0; index < count; index++) {
      const entry = span + index * SHADOW_ENTRY_SIZE;
      shadows.push({
        offsetX: view.getFloat32(entry, true),
        offsetY: view.getFloat32(entry + 4, true),
        blur: view.getFloat32(entry + 8, true),
        spread: view.getFloat32(entry + 12, true),
        color: [0, 1, 2, 3].map((k) => view.getFloat32(entry + SHADOW_OFFSET_COLOR + k * 4, true)),
        inset: view.getUint8(entry + SHADOW_OFFSET_INSET) === 1,
      });
    }
    return { kind: "shadowList", shadows };
  }

  function drainEvents(expectedTrackIndex = null) {
    const eventCount = view.getUint32(ANIMATION_RESULT_BASE + 12, true);
    const events = [];
    // Resolve every old queue record before invoking host code. A nested cancel
    // or tick owns a new queue and cannot overwrite the batch being delivered.
    for (let index = 0; index < eventCount; index++) {
      const eventAddress = ANIMATION_EVENT_QUEUE_BASE + index * ANIMATION_EVENT_ENTRY_SIZE;
      const nodeIndex = view.getUint16(eventAddress, true);
      const propertyId = view.getUint16(eventAddress + 2, true);
      const typeId = view.getUint8(eventAddress + 4);
      const trackIndex = identifyAnimationFeedback(view, allocations, ANIMATION_TABLE_BASE,
        ANIMATION_RECORD_SIZE, nodeIndex, propertyId, typeId, expectedTrackIndex);
      if (trackIndex < 0) {
        throw new Error(`Cannot identify ${EVENT_NAMES[typeId]} track for node ${nodeIndex} property ${propertyId}`);
      }
      const allocation = allocations.get(trackIndex);
      events.push({ nodeIndex, propertyId, propertyName: PROPERTY_NAMES.get(propertyId),
        trackIndex, type: EVENT_NAMES[typeId], animationId: allocation.animationId,
        trackGeneration: allocation.trackGeneration, identity: allocation.identity });
    }
    view.setUint32(ANIMATION_RESULT_BASE + 12, 0, true);
    if (!suppressEvents) {
      for (const event of events) {
        if (allocations.get(event.trackIndex)?.identity === event.identity) options.onEvent?.(event);
      }
    }
    return eventCount;
  }

  function cancelReplacedTracks(nodeIndex, propertyId) {
    let cursor = 0;
    for (;;) {
      const trackIndex = nextAnimationReplacement(view, allocations, ANIMATION_TABLE_BASE,
        ANIMATION_RECORD_SIZE, nodeIndex, propertyId, cursor);
      if (trackIndex < 0) return;
      cursor = trackIndex + 1;
      const owned = allocations.get(trackIndex);
      cancelTrack(trackIndex);
      try { drainEvents(trackIndex); }
      finally { freeTrack(trackIndex, owned); }
    }
  }

  function freeTrack(trackIndex, expected = allocations.get(trackIndex), sampled = false) {
    const owned = allocations.get(trackIndex);
    if (!owned) return;
    if (owned !== expected) return;
    if (!sampled) forgetComputedSample(owned.identity);
    const recordAddress = ANIMATION_TABLE_BASE +
      trackIndex * ANIMATION_RECORD_SIZE;
    const stackIndex = view.getUint16(recordAddress + 110, true);
    const nodeIndex = view.getUint16(recordAddress, true);
    const propertyId = view.getUint16(recordAddress + 2, true);
    const key = `${nodeIndex}:${propertyId}`;
    const stack = effectStacks.get(key);
    if (stack && stack.index === stackIndex) {
      stack.tracks = stack.tracks.filter((index) => index !== trackIndex);
      for (let index = 0; index < stack.tracks.length; index++) {
        const next = stack.tracks[index + 1] ?? 0xffff;
        view.setUint16(
          ANIMATION_TABLE_BASE + stack.tracks[index] * ANIMATION_RECORD_SIZE +
            92,
          next,
          true,
        );
      }
      const entryAddress = EFFECT_STACK_TABLE_BASE +
        stack.index * EFFECT_STACK_ENTRY_SIZE;
      if (stack.tracks.length === 0) {
        view.setUint8(entryAddress + 6, 0);
        effectStackOccupancy[stack.index] = 0;
        effectStacks.delete(key);
        deferredBaseStacks.delete(stack);
      } else {
        view.setUint16(entryAddress + 32, stack.tracks[0], true);
        view.setUint16(entryAddress + 34, stack.tracks.at(-1), true);
      }
    }
    for (const releaseAllocation of owned) releaseAllocation();
    allocations.delete(trackIndex);
    trackReservations.delete(trackIndex);
    suspendedTrackStates.delete(trackIndex);
    releaseAnimationTrackIdentity(owned.identity);
  }

  // A track record, its effect stack entry and its events store the node
  // index in 16 bits.
  function requireRecordNodeIndex(nodeIndex) {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex > 0xffff) {
      throw new RangeError(
        `nodeIndex ${nodeIndex} does not fit the 16-bit node field of an animation track`,
      );
    }
  }

  function declareTrack(
    nodeIndex,
    propertyName,
    rawFrames,
    timing = {},
    transition = false,
    declarationOptions = {},
  ) {
    requireRecordNodeIndex(nodeIndex);
    // The declaration reads the node's row. The layout buffer holds the
    // engine's live node capacity, which grows with the scene
    // (node_tables_reserve); the caller reserves the scene's rows first.
    const nodeCapacity = engine.exports.node_capacity();
    if (nodeIndex >= nodeCapacity) {
      throw new RangeError(
        `nodeIndex ${nodeIndex} is outside the layout buffer of ${nodeCapacity} nodes; reserve the scene's node tables before declaring its animations`,
      );
    }
    const property = PROPERTY_REGISTRY[propertyName];
    if (!property) {
      throw new TypeError(
        `Property is not registered for animation: ${propertyName}`,
      );
    }
    const composite = COMPOSITE_VALUES[timing.composite ?? "replace"];
    if (composite == null) {
      throw new TypeError(`Unsupported composite mode: ${timing.composite}`);
    }
    if (
      (property.kind === 3 || property.kind === 5 || property.kind === 6 || property.kind === 7 || property.kind === 8) &&
      composite !== 0
    ) {
      throw new TypeError(`${propertyName} only supports replace composition`);
    }
    const frames = normalizeOffsets(rawFrames).map((frame) => ({
      offset: frame.offset,
      easing: normalizeEasing(frame.easing ?? "linear"),
      value: normalizeValue(property, frame.value),
    }));
    const effectiveKind = frames.some((frame) => frame.value.kind === 5)
      ? 5
      : property.kind;
    if (effectiveKind === 5 && composite !== 0) {
      throw new TypeError("Discrete tracks only support replace composition");
    }
    if (
      frames.some((frame) =>
        frame.value.kind !== effectiveKind &&
        !(effectiveKind === 5 && frame.value.kind === 2)
      )
    ) {
      throw new TypeError(
        "Every keyframe in a track must have a compatible value kind",
      );
    }

    // The declared track publishes immediately, and its replaced tracks
    // publish their cancellation.
    acquire();
    const reservations = [];
    let publishedTrack = -1;
    try {
      const trackIndex = [...Array(ANIMATION_TABLE_CAPACITY).keys()].find((
        index,
      ) =>
        !trackReservations.has(index) &&
        view.getUint8(
          ANIMATION_TABLE_BASE + index * ANIMATION_RECORD_SIZE + 4,
        ) === 0
      );
      if (trackIndex == null) throw new RangeError("ANIMATION_TABLE is full");
      trackReservations.add(trackIndex);
      reservations.push(() => trackReservations.delete(trackIndex));
      const keyframeOffset = firstFit(keyframeOccupancy, frames.length);
      if (keyframeOffset < 0) {
        throw new RangeError(
          "KEYFRAME_POOL has no contiguous span large enough",
        );
      }
      reserve(keyframeOccupancy, keyframeOffset, frames.length);
      reservations.push(() =>
        release(keyframeOccupancy, keyframeOffset, frames.length)
      );

      const normalizedFrames = [];
      for (const frame of frames) {
        let transformOffset = 0;
        let transformCount = 0;
        if (frame.value.components) {
          transformCount = frame.value.components.length;
          transformOffset = firstFit(transformOccupancy, transformCount);
          if (transformOffset < 0) {
            throw new RangeError(
              "TRANSFORM_COMPONENT_POOL has no contiguous span large enough",
            );
          }
          reserve(transformOccupancy, transformOffset, transformCount);
          reservations.push(() =>
            release(transformOccupancy, transformOffset, transformCount)
          );
          for (let index = 0; index < transformCount; index++) {
            const component = frame.value.components[index];
            const componentAddress = TRANSFORM_COMPONENT_POOL_BASE +
              (transformOffset + index) * TRANSFORM_COMPONENT_ENTRY_SIZE;
            view.setUint8(componentAddress, component.kind);
            for (let parameter = 0; parameter < 6; parameter++) {
              view.setFloat32(
                componentAddress + 4 + parameter * 4,
                component.parameters[parameter],
                true,
              );
            }
          }
        }
        normalizedFrames.push({ ...frame, transformOffset, transformCount });
      }

      if (composite === 0 && !declarationOptions.preserveReplacedTracks) {
        cancelReplacedTracks(nodeIndex, property.id);
      }
      const stackKey = `${nodeIndex}:${property.id}`;
      let stack = effectStacks.get(stackKey);
      const rowsOwned = ownsRows();
      const base = stack?.base ??
        (rowsOwned ? snapshotBase(nodeIndex, property) : DEFERRED_BASE);
      const address = ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE;
      writeAnimationTrack(engine.memory, address, nodeIndex, property.id, timing,
        transition, composite, keyframeOffset * KEYFRAME_ENTRY_SIZE,
        normalizedFrames.length, base, effectiveKind);
      const defaultEasing = normalizeEasing(timing.easing ?? "linear");
      writeEasing(address + 7, address + 8, defaultEasing, reservations);
      const beforeTrackIndices = declarationOptions.beforeTrackIndices;
      let nextDeclarationSequence;
      if (beforeTrackIndices?.size) {
        let followingSequence = Infinity;
        for (const beforeTrackIndex of beforeTrackIndices) {
          if (!allocations.has(beforeTrackIndex)) continue;
          const sequence = view.getUint32(
            ANIMATION_TABLE_BASE +
              beforeTrackIndex * ANIMATION_RECORD_SIZE + 96,
            true,
          );
          if (sequence < followingSequence) followingSequence = sequence;
        }
        if (followingSequence !== Infinity) {
          let previousSequence = 0;
          for (
            let candidateTrackIndex = 0;
            candidateTrackIndex < ANIMATION_TABLE_CAPACITY;
            candidateTrackIndex++
          ) {
            if (!allocations.has(candidateTrackIndex)) continue;
            const sequence = view.getUint32(
              ANIMATION_TABLE_BASE +
                candidateTrackIndex * ANIMATION_RECORD_SIZE + 96,
              true,
            );
            if (sequence < followingSequence && sequence > previousSequence) {
              previousSequence = sequence;
            }
          }
          if (followingSequence - previousSequence <= 1) {
            compactDeclarationSequences();
            followingSequence = Math.min(
              ...[...beforeTrackIndices]
                .filter((beforeTrackIndex) => allocations.has(beforeTrackIndex))
                .map((beforeTrackIndex) =>
                  view.getUint32(
                    ANIMATION_TABLE_BASE +
                      beforeTrackIndex * ANIMATION_RECORD_SIZE + 96,
                    true,
                  )
                ),
            );
            previousSequence = 0;
            for (
              let candidateTrackIndex = 0;
              candidateTrackIndex < ANIMATION_TABLE_CAPACITY;
              candidateTrackIndex++
            ) {
              if (!allocations.has(candidateTrackIndex)) continue;
              const sequence = view.getUint32(
                ANIMATION_TABLE_BASE +
                  candidateTrackIndex * ANIMATION_RECORD_SIZE + 96,
                true,
              );
              if (
                sequence < followingSequence && sequence > previousSequence
              ) {
                previousSequence = sequence;
              }
            }
          }
          nextDeclarationSequence = Math.floor(
            (previousSequence + followingSequence) / 2,
          );
        }
      }
      if (nextDeclarationSequence === undefined) {
        if (declarationSequence > 0xfffffbff) {
          compactDeclarationSequences();
        }
        declarationSequence += 1024;
        nextDeclarationSequence = declarationSequence;
      }
      view.setUint32(address + 96, nextDeclarationSequence, true);
      let newStack = false;
      if (!stack) {
        const stackIndex = effectStackOccupancy.indexOf(0);
        if (stackIndex < 0) throw new RangeError("EFFECT_STACK_TABLE is full");
        stack = { index: stackIndex, base, kind: effectiveKind, tracks: [] };
        newStack = true;
      }
      view.setUint16(address + 110, stack.index, true);

      for (let index = 0; index < normalizedFrames.length; index++) {
        const frame = normalizedFrames[index];
        const frameAddress = KEYFRAME_POOL_BASE +
          (keyframeOffset + index) * KEYFRAME_ENTRY_SIZE;
        writeAnimationKeyframe(engine.memory, frameAddress, frame,
          frame.transformOffset * TRANSFORM_COMPONENT_ENTRY_SIZE);
        writeEasing(
          frameAddress + 4,
          frameAddress + 8,
          frame.easing,
          reservations,
        );
      }
      const entryAddress = EFFECT_STACK_TABLE_BASE +
        stack.index * EFFECT_STACK_ENTRY_SIZE;
      if (newStack) {
        new Uint8Array(
          engine.memory.buffer,
          entryAddress,
          EFFECT_STACK_ENTRY_SIZE,
        ).fill(0);
        if (measurement) measurement.record({ category: "animation", operation: "effect-stack.zero", direction: "host-to-engine", bytes: EFFECT_STACK_ENTRY_SIZE, allocations: 1 });
        view.setUint16(entryAddress, nodeIndex, true);
        view.setUint16(entryAddress + 2, property.id, true);
        view.setUint8(entryAddress + 4, base.tag);
        view.setUint8(entryAddress + 5, effectiveKind);
        for (let index = 0; index < 6; index++) {
          view.setFloat32(
            entryAddress + 8 + index * 4,
            base.values[index] ?? 0,
            true,
          );
        }
        effectStackOccupancy[stack.index] = 1;
        effectStacks.set(stackKey, stack);
        if (!rowsOwned) deferredBaseStacks.add(stack);
      }
      const insertionIndex = beforeTrackIndices?.size
        ? stack.tracks.findIndex((existingTrackIndex) =>
          beforeTrackIndices.has(existingTrackIndex)
        )
        : -1;
      if (insertionIndex < 0) stack.tracks.push(trackIndex);
      else stack.tracks.splice(insertionIndex, 0, trackIndex);
      for (let index = 0; index < stack.tracks.length; index++) {
        view.setUint16(
          ANIMATION_TABLE_BASE +
            stack.tracks[index] * ANIMATION_RECORD_SIZE + 92,
          stack.tracks[index + 1] ?? 0xffff,
          true,
        );
      }
      view.setUint16(entryAddress + 32, stack.tracks[0], true);
      view.setUint16(entryAddress + 34, stack.tracks.at(-1), true);
      view.setUint8(entryAddress + 6, 1);
      reservations.identity = createAnimationTrackIdentity(declarationOptions.animationId);
      reservations.animationId = declarationOptions.animationId ?? reservations.identity;
      reservations.trackGeneration = declarationOptions.trackGeneration ?? 1;
      allocations.set(trackIndex, reservations);
      view.setUint8(address + 4, 1); // publish last
      publishedTrack = trackIndex;
      return trackIndex;
    } catch (error) {
      if (publishedTrack >= 0) {
        view.setUint8(
          ANIMATION_TABLE_BASE + publishedTrack * ANIMATION_RECORD_SIZE + 4,
          0,
        );
      }
      if (reservations.identity) releaseAnimationTrackIdentity(reservations.identity);
      for (let index = reservations.length - 1; index >= 0; index--) {
        reservations[index]();
      }
      throw error;
    }
  }

  function animate(
    nodeIndex,
    keyframes,
    timing = {},
    declarationOptions = {},
  ) {
    if (!Array.isArray(keyframes) || keyframes.length < 2) {
      throw new TypeError("keyframes must be an array");
    }
    const reserved = new Set(["offset", "easing", "composite"]);
    const properties = new Set(
      keyframes.flatMap((frame) =>
        Object.keys(frame).filter((key) => !reserved.has(key))
      ),
    );
    const beforeTrackIndices = new Set(
      declarationOptions.beforeTrackIndices ?? [],
    );
    const trackIndices = [];
    try {
      for (const propertyName of properties) {
        const propertyFrames = animationPropertyFrames(keyframes, propertyName);
        trackIndices.push(
          declareTrack(
            nodeIndex,
            propertyName,
            propertyFrames,
            {
              ...timing,
              composite: keyframes.at(-1).composite ?? timing.composite,
            },
            false,
            {
              beforeTrackIndices,
              animationId: declarationOptions.animationId,
              trackGeneration: declarationOptions.trackGeneration,
              preserveReplacedTracks:
                declarationOptions.preserveReplacedTracks === true,
            },
          ),
        );
      }
    } catch (error) {
      for (const trackIndex of trackIndices) {
        cancelTrack(trackIndex);
        freeTrack(trackIndex);
      }
      throw error;
    }
    return animationHandle(trackIndices);
  }

  // A transform value's own 6-float affine, when it is one matrix()
  // function. Every other transform is a function list whose numbers live
  // in its components, not in the 6-value vector: a track's base and the
  // reversing-shortening rule both need the affine, never the list.
  function transformAffineValues(normalized) {
    return normalized.components?.length === 1 &&
        normalized.components[0].kind === 5
      ? normalized.components[0].parameters
      : normalized.values;
  }

  function replaceBase(nodeIndex, propertyName, target) {
    const property = PROPERTY_REGISTRY[propertyName];
    if (!property) {
      throw new TypeError(
        `Property is not registered for animation: ${propertyName}`,
      );
    }
    const stack = effectStacks.get(`${nodeIndex}:${property.id}`);
    if (!stack) return false;
    // A shadow track's base is the node's own span, which the engine
    // captures at the sample write (the row's pointer is not known here).
    if (property.kind === 7) return false;
    const normalized = normalizeValue(property, target);
    const baseValues = property.kind === 4
      ? transformAffineValues(normalized)
      : normalized.values;
    writeStackBase(stack, { tag: normalized.tag, values: [...baseValues] });
    deferredBaseStacks.delete(stack);
    return true;
  }

  // Where each effect stack's node is after this controller's last layout:
  // the composed sample, and for a shadow list the painted list. The caller
  // guarantees that the rows it reads are this controller's, laid out and
  // with their post-layout transforms resolved.
  function captureLiveValues() {
    for (const stack of effectStacks.values()) {
      const entryAddress = EFFECT_STACK_TABLE_BASE +
        stack.index * EFFECT_STACK_ENTRY_SIZE;
      const nodeIndex = view.getUint16(entryAddress, true);
      const property = PROPERTY_REGISTRY[
        PROPERTY_NAMES.get(view.getUint16(entryAddress + 2, true))
      ];
      stack.liveValue = {
        base: snapshotBase(nodeIndex, property),
        shadowList: property.kind === 7 ? liveShadowList(nodeIndex) : null,
      };
    }
  }

  // Where the node of an interrupted stack is while another scene's rows
  // fill the buffer. The value captured after this controller's last
  // layout states it. A stack not laid out since its declaration leaves the
  // node at the value beneath it: the caller's start value, or the stack's
  // base.
  function interruptedValue(stack, nodeIndex, propertyName, property, timing) {
    if (stack.liveValue) return { ...stack.liveValue, callerStart: false };
    const callerStart = timing.startValue !== undefined;
    const baseKnown = !deferredBaseStacks.has(stack) && property.kind !== 7;
    if (!baseKnown && (!callerStart || property.kind === 4)) {
      throw new Error(
        `Cannot start the ${propertyName} transition of node ${nodeIndex}: another scene's layout rows fill the engine, and the running effect has not been laid out in this renderer's rows. Render this renderer first${callerStart ? "" : " or pass timing.startValue"}.`,
      );
    }
    return { base: stack.base, shadowList: null, callerStart };
  }

  function transition(nodeIndex, propertyName, target, timing = {}) {
    const property = PROPERTY_REGISTRY[propertyName];
    if (!property) {
      throw new TypeError(
        `Property is not registered for transition: ${propertyName}`,
      );
    }
    const key = `${nodeIndex}:${property.id}`;
    const stack = effectStacks.get(key);
    // An interrupted transition continues from where its node is. This
    // controller's rows show that; while another scene's rows fill the
    // buffer, the value captured after this controller's last layout does.
    const interrupted = stack !== undefined && !ownsRows()
      ? interruptedValue(stack, nodeIndex, propertyName, property, timing)
      : null;
    const base = interrupted?.base ?? snapshotBase(nodeIndex, property);
    // The engine buffer is the right start only while an earlier effect is
    // still sampling this node: an interrupted transition continues from
    // where it is. Otherwise the caller's before-change value is the start.
    // The buffer is shared with synchronous layout getters, which rewrite
    // it with the after-change scene before this frame runs; a start read
    // from it then equals the end and the transition snaps. For the
    // transform this also keeps the CSS function list: a start list that
    // matches the end list is what makes a rotate() transition interpolate
    // its angle instead of its matrix.
    const callerStart = timing.startValue !== undefined &&
      (stack === undefined || interrupted?.callerStart === true);
    const start = callerStart
      ? timing.startValue
      : property.kind === 2
      ? {
        kind: "lengthPercentage",
        pixels: base.values[0],
        percentage: base.values[1],
      }
      : property.kind === 1
      ? { kind: "scalar", value: base.values[0] }
      : property.kind === 3
      ? { kind: "color", value: base.values.slice(0, 4) }
      : property.kind === 6
      ? (base.values[0] ? "hidden" : "visible")
      : property.kind === 7
      ? interrupted?.shadowList ?? liveShadowList(nodeIndex)
      : property.kind === 8
      ? { kind: "lineHeight", value: base.values[0], unit: ["normal", "length", "number"][base.tag] }
      : property.kind === 9
      ? {
        kind: "translate",
        x: { pixels: base.values[0], percentage: base.values[1] },
        y: { pixels: base.values[2], percentage: base.values[3] },
      }
      : {
        kind: "transform",
        components: [{ kind: "matrix", value: base.values.slice(0, 6) }],
      };
    const normalizedTarget = normalizeValue(property, target);
    const duration = finite(timing.duration ?? 0, "duration");
    // Reversing shortening measures how far the running transition got
    // along its own start-to-end vector. A transform list carries no
    // numbers in that vector, so the transform compares affines: the end
    // value's resolved matrix against the node's live one.
    const reversalTarget = property.kind === 4
      ? transformAffineValues(
        normalizeValue(property, timing.baseTarget ?? target),
      )
      : normalizedTarget.values;
    const reversalStart = property.kind === 4
      ? base.values.slice(0, 6)
      : normalizeValue(property, start).values;
    const transitionState = updateAnimationTransition(
      liveTransitions.get(key),
      callerStart ? reversalStart : base.values,
      reversalTarget,
      reversalStart,
    );
    liveTransitions.set(key, transitionState);
    const adjustedTiming = {
      ...timing,
      duration: animationTransitionDuration(transitionState, duration),
    };
    const trackIndex = declareTrack(
      nodeIndex,
      propertyName,
      [
        { offset: 0, value: start },
        { offset: 1, value: target },
      ],
      adjustedTiming,
      true,
    );
    replaceBase(nodeIndex, propertyName, timing.baseTarget ?? target);
    return Object.freeze({
      ...animationHandle([trackIndex]),
      // The track's duration: the requested one times the reversing
      // shortening factor.
      duration: adjustedTiming.duration,
      // The value the track starts from: the caller's before-change value,
      // or where an interrupted effect left the node.
      start,
      // The identity the track's events carry.
      animationId: allocations.get(trackIndex).animationId,
    });
  }

  // A transition track declared again over its own endpoints (a
  // CSSTransition whose time, rate or direction changed): the keyframes
  // and the transition's events, with no reversing shortening and no new
  // base, which the first declaration already wrote.
  function declareTransitionTrack(nodeIndex, propertyName, keyframes, timing, declarationOptions = {}) {
    return animationHandle([
      declareTrack(nodeIndex, propertyName, keyframes, timing, true, declarationOptions),
    ]);
  }

  function animationHandle(trackIndices) {
    const identities = new Map(trackIndices.map((slot) => [slot, allocations.get(slot)]));
    return Object.freeze({
      trackIndices: [...trackIndices],
      cancel() {
        for (const owned of identities.values()) forgetComputedSample(owned.identity);
        let writeCount = 0;
        for (const trackIndex of trackIndices) {
          const owned = identities.get(trackIndex);
          if (allocations.get(trackIndex) !== owned) continue;
          acquire();
          writeCount += cancelTrack(trackIndex);
          try { drainEvents(trackIndex); }
          finally { freeTrack(trackIndex, owned); }
        }
        return writeCount;
      },
      cancelSilently() {
        for (const owned of identities.values()) forgetComputedSample(owned.identity);
        suppressEvents = true;
        try {
          let writeCount = 0;
          for (const trackIndex of trackIndices) {
            const owned = identities.get(trackIndex);
            if (allocations.get(trackIndex) !== owned) continue;
            acquire();
            writeCount += cancelTrack(trackIndex);
            try { drainEvents(trackIndex); }
            finally { freeTrack(trackIndex, owned); }
          }
          return writeCount;
        } finally {
          suppressEvents = false;
        }
      },
      pause(time) {
        for (const trackIndex of trackIndices) {
          if (allocations.get(trackIndex) !== identities.get(trackIndex)) continue;
          acquire();
          engine.exports.pause_animation(
            trackIndex,
            finite(time, "pause time"),
          );
        }
      },
      resume(time) {
        for (const trackIndex of trackIndices) {
          if (allocations.get(trackIndex) !== identities.get(trackIndex)) continue;
          acquire();
          engine.exports.resume_animation(
            trackIndex,
            finite(time, "resume time"),
          );
        }
      },
      seek(localTime, sampleTime) {
        const resolvedLocalTime = finite(localTime, "animation local time");
        const resolvedSampleTime = finite(sampleTime, "animation sample time");
        for (const trackIndex of trackIndices) {
          if (allocations.get(trackIndex) !== identities.get(trackIndex)) continue;
          acquire();
          const address = ANIMATION_TABLE_BASE +
            trackIndex * ANIMATION_RECORD_SIZE;
          view.setFloat64(
            address + 24,
            resolvedSampleTime - resolvedLocalTime,
            true,
          );
          view.setFloat64(address + 84, resolvedSampleTime, true);
          view.setUint8(address + 4, 1);
        }
      },
    });
  }

  function remapNodes(indexMap) {
    if (!(indexMap instanceof Map)) {
      throw new TypeError("indexMap must be a Map");
    }
    // Check every new index before any state changes. The next frame's
    // row write reserves the node tables for the remapped scene.
    for (const trackIndex of allocations.keys()) {
      const nextNodeIndex = indexMap.get(view.getUint16(
        ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE,
        true,
      ));
      if (nextNodeIndex !== undefined) requireRecordNodeIndex(nextNodeIndex);
    }
    computedSamples?.core.remapComputedSamples(computedSamples.owner, indexMap);
    let writeCount = 0;
    for (const [trackIndex, owned] of [...allocations]) {
      if (allocations.get(trackIndex) !== owned) continue;
      acquire();
      const address = ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE;
      const previousNodeIndex = view.getUint16(address, true);
      const nextNodeIndex = indexMap.get(previousNodeIndex);
      if (nextNodeIndex === undefined) {
        writeCount += cancelTrack(trackIndex);
        try { drainEvents(trackIndex); }
        finally { freeTrack(trackIndex, owned); }
      } else {
        view.setUint16(address, nextNodeIndex, true);
      }
    }
    const remappedStacks = new Map();
    for (const [key, stack] of effectStacks) {
      const separator = key.indexOf(":");
      const previousNodeIndex = Number(key.slice(0, separator));
      const propertyId = key.slice(separator + 1);
      const nextNodeIndex = indexMap.get(previousNodeIndex);
      if (nextNodeIndex === undefined || stack.tracks.length === 0) continue;
      view.setUint16(
        EFFECT_STACK_TABLE_BASE + stack.index * EFFECT_STACK_ENTRY_SIZE,
        nextNodeIndex,
        true,
      );
      remappedStacks.set(`${nextNodeIndex}:${propertyId}`, stack);
    }
    effectStacks.clear();
    for (const [key, stack] of remappedStacks) effectStacks.set(key, stack);
    const remappedTransitions = new Map();
    for (const [key, transition] of liveTransitions) {
      const separator = key.indexOf(":");
      const previousNodeIndex = Number(key.slice(0, separator));
      const propertyId = key.slice(separator + 1);
      const nextNodeIndex = indexMap.get(previousNodeIndex);
      if (nextNodeIndex !== undefined) {
        remappedTransitions.set(`${nextNodeIndex}:${propertyId}`, transition);
      } else {
        releaseAnimationTransition(transition);
      }
    }
    liveTransitions.clear();
    for (const [key, transition] of remappedTransitions) {
      liveTransitions.set(key, transition);
    }
    return writeCount;
  }

  function tick(time) {
    acquire();
    sampleTime = time;
    const resultAddress = engine.exports.tick(finite(time, "tick time"));
    const result = {
      writeCount: view.getUint32(resultAddress, true),
      transformSampleCount: view.getUint32(resultAddress + 4, true),
      liveTrackCount: view.getUint32(resultAddress + 8, true),
      eventCount: view.getUint32(resultAddress + 12, true),
    };
    captureComputedSamples();
    drainEvents();
    for (
      let trackIndex = 0;
      trackIndex < ANIMATION_TABLE_CAPACITY;
      trackIndex++
    ) {
      if (
        view.getUint8(
          ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE + 4,
        ) === 0
      ) freeTrack(trackIndex, allocations.get(trackIndex), true);
    }
    return result;
  }
  // Samples this controller's tracks onto its rows, which the caller has
  // just written to the engine. The layout that follows reads the table
  // and the bases, so both are prepared even when there is nothing to
  // sample.
  function resample() {
    prepareLayout();
    if (sampleTime !== null && allocations.size !== 0) return tick(sampleTime);
    return null;
  }

  // Whether this controller runs an effect on the node's property: a
  // transition declared there interrupts it.
  function hasEffect(nodeIndex, propertyName) {
    const property = PROPERTY_REGISTRY[propertyName];
    if (!property) {
      throw new TypeError(`Property is not registered for animation: ${propertyName}`);
    }
    return effectStacks.has(`${nodeIndex}:${property.id}`);
  }

  // Brings the running transitions to the time of a style change before it
  // declares new ones (css-transitions-1 §3: the change sees them updated
  // to its own time, not to the last frame). A transition whose end that
  // time reaches has completed: it reports transitionend and leaves its
  // effect stack, so the change starts a new transition from its end value
  // instead of cancelling and reversing it. While this controller's rows
  // fill the buffer, the tick also leaves each running track's value at
  // that time in its node's row, where an interrupting transition reads
  // its start and a reversal its progress. Another scene's rows take no
  // sample; the value after this controller's last layout stands in for a
  // running one, and a completed one is finished without touching them.
  function advance(time) {
    acquire();
    if (ownsRows()) return tick(time);
    finite(time, "advance time");
    for (const [trackIndex, owned] of [...allocations]) {
      if (allocations.get(trackIndex) !== owned) continue;
      const address = ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE;
      // A running transition track; paused and filled tracks do not end.
      if (view.getUint8(address + 4) !== 1) continue;
      if ((view.getUint8(address + 5) & 16) === 0) continue;
      // The engine's end test (engine-layout.watpart, tick).
      const localTime = time -
        (view.getFloat64(address + 24, true) + view.getFloat64(address + 40, true));
      const iterationCount = view.getFloat32(address + 48, true);
      const total = iterationCount < 0
        ? Infinity
        : view.getFloat64(address + 32, true) * iterationCount;
      if (!(localTime >= total)) continue;
      const types = view.getUint8(address + 59) === 0
        ? ["transitionstart", "transitionend"]
        : ["transitionend"];
      view.setUint8(address + 4, 0);
      const nodeIndex = view.getUint16(address, true);
      const propertyId = view.getUint16(address + 2, true);
      try {
        if (!suppressEvents) {
          for (const type of types) {
            if (allocations.get(trackIndex)?.identity !== owned.identity) break;
            options.onEvent?.({
              nodeIndex,
              propertyId,
              propertyName: PROPERTY_NAMES.get(propertyId),
              trackIndex,
              type,
              animationId: owned.animationId,
              trackGeneration: owned.trackGeneration,
              identity: owned.identity,
            });
          }
        }
      } finally {
        freeTrack(trackIndex, owned);
      }
    }
    return null;
  }

  // Ends the controller: its view stops following the engine's memory.
  // The owner cancels the tracks it still holds first (cancelAll).
  function dispose() {
    removeViewRefresh();
  }

  return Object.freeze({
    bindComputedSamples,
    captureComputedSamples,
    captureLiveValues,
    captureComputedGeometry,
    captureComputedPseudos,
    animate,
    transition,
    declareTransitionTrack,
    declareTrack,
    tick,
    advance,
    hasEffect,
    resample,
    remapNodes,
    replaceBase,
    prepareLayout,
    cancelAll,
    dispose,
    properties: PROPERTY_REGISTRY,
  });
}

export { PROPERTY_REGISTRY };
