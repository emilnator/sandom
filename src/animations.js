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
  LAYOUT_NODE_OFFSET_OPACITY,
  LAYOUT_NODE_OFFSET_TRANSFORM,
  LAYOUT_NODE_OFFSET_VISIBILITY_HIDDEN,
  LAYOUT_NODE_OFFSET_WIDTH,
  LAYOUT_NODE_OFFSET_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_WIDTH_TAG,
  LAYOUT_NODE_SIZE,
  LINEAR_EASING_ENTRY_SIZE,
  LINEAR_EASING_POOL_BASE,
  LINEAR_EASING_POOL_CAPACITY,
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
  if (measurement) {
    measurement.record({ category: "animation", operation: "engine-view.create", direction: "host", allocations: 1 });
    view = measurement.wrapDataView(view, measurementOptions);
  }
  engine.onMemoryGrowth(() => {
    view = new DataView(engine.memory.buffer);
    if (measurement) {
      measurement.record({ category: "animation", operation: "engine-view.create", direction: "host", allocations: 1 });
      view = measurement.wrapDataView(view, measurementOptions);
    }
  });
  const {
    trackReservations,
    keyframeOccupancy,
    transformOccupancy,
    linearOccupancy,
    effectStackOccupancy,
  } = engineAnimationPools(engine);
  const allocations = new Map();
  const liveTransitions = new Map();
  const effectStacks = new Map();
  let suppressEvents = false;
  let declarationSequence = 0;
  // Engine-table suspension (shared-engine renderer coexistence). A
  // suspended track keeps its record bytes and JS bookkeeping but carries
  // state 0, so a sibling controller's engine tick neither samples it onto
  // the sibling's scene nodes nor emits its events. Time-based sampling
  // makes suspend/restore lossless: progress is a pure function of the
  // tick time, never of elapsed ticks. The shared trackReservations set
  // keeps a suspended (state 0) slot from being claimed by a sibling.
  const suspendedTrackStates = new Map();

  function ensurePublished(trackIndex) {
    const suspendedState = suspendedTrackStates.get(trackIndex);
    if (suspendedState === undefined) return;
    suspendedTrackStates.delete(trackIndex);
    view.setUint8(
      ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE + 4,
      suspendedState,
    );
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

  function restore() {
    for (const trackIndex of [...suspendedTrackStates.keys()]) {
      ensurePublished(trackIndex);
    }
  }

  function cancelAll() {
    let writeCount = 0;
    const transitions = [...liveTransitions].map(([key, state]) => [key, state, animationTransitionRevision(state)]);
    try {
      for (const [trackIndex, owned] of [...allocations]) {
        if (allocations.get(trackIndex) !== owned) continue;
        ensurePublished(trackIndex);
        writeCount += engine.exports.cancel_animation(trackIndex);
        try { drainEvents(trackIndex); }
        finally { freeTrack(trackIndex, owned); }
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
    if (property.kind === 6) {
      return {
        tag: view.getUint8(nodeAddress + property.valueOffset),
        values: [view.getUint8(nodeAddress + property.valueOffset)],
      };
    }
    return {
      tag: 0,
      values: [view.getFloat32(nodeAddress + property.valueOffset, true)],
    };
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
      engine.exports.cancel_animation(trackIndex);
      try { drainEvents(trackIndex); }
      finally { freeTrack(trackIndex, owned); }
    }
  }

  function freeTrack(trackIndex, expected = allocations.get(trackIndex)) {
    const owned = allocations.get(trackIndex);
    if (!owned) return;
    if (owned !== expected) return;
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

  function declareTrack(
    nodeIndex,
    propertyName,
    rawFrames,
    timing = {},
    transition = false,
    declarationOptions = {},
  ) {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= 819) {
      throw new RangeError("nodeIndex is outside the layout buffer");
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
      (property.kind === 3 || property.kind === 5 || property.kind === 6) &&
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
      const base = stack?.base ?? snapshotBase(nodeIndex, property);
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
        engine.exports.cancel_animation(trackIndex);
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
    const normalized = normalizeValue(property, target);
    const baseValues = property.kind === 4
      ? transformAffineValues(normalized)
      : normalized.values;
    stack.base = { tag: normalized.tag, values: [...baseValues] };
    for (const trackIndex of stack.tracks) {
      const address = ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE;
      view.setUint8(address + 58, normalized.tag);
      for (let index = 0; index < 6; index++) {
        view.setFloat32(address + 60 + index * 4, baseValues[index] ?? 0, true);
      }
    }
    return true;
  }

  function transition(nodeIndex, propertyName, target, timing = {}) {
    const property = PROPERTY_REGISTRY[propertyName];
    if (!property) {
      throw new TypeError(
        `Property is not registered for transition: ${propertyName}`,
      );
    }
    const base = snapshotBase(nodeIndex, property);
    const key = `${nodeIndex}:${property.id}`;
    // The node's live affine is the only transform value the layout buffer
    // can report, and it is the right start while an earlier effect is
    // still sampling this node: an interrupted transition continues from
    // where it is. With no effect on the node the live affine IS the
    // before-change computed value, so a caller-supplied CSS function list
    // is preferred there — a start list that matches the end list is what
    // makes a rotate() transition interpolate its angle instead of its
    // matrix.
    const transformStart = timing.startValue !== undefined &&
        !effectStacks.has(key)
      ? timing.startValue
      : {
        kind: "transform",
        components: [{ kind: "matrix", value: base.values.slice(0, 6) }],
      };
    const start = property.kind === 2
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
      : transformStart;
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
      liveTransitions.get(key), base.values, reversalTarget, reversalStart);
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
    return animationHandle([trackIndex]);
  }

  function animationHandle(trackIndices) {
    const identities = new Map(trackIndices.map((slot) => [slot, allocations.get(slot)]));
    return Object.freeze({
      trackIndices: [...trackIndices],
      cancel() {
        let writeCount = 0;
        for (const trackIndex of trackIndices) {
          const owned = identities.get(trackIndex);
          if (allocations.get(trackIndex) !== owned) continue;
          ensurePublished(trackIndex);
          writeCount += engine.exports.cancel_animation(trackIndex);
          try { drainEvents(trackIndex); }
          finally { freeTrack(trackIndex, owned); }
        }
        return writeCount;
      },
      cancelSilently() {
        suppressEvents = true;
        try {
          let writeCount = 0;
          for (const trackIndex of trackIndices) {
            const owned = identities.get(trackIndex);
            if (allocations.get(trackIndex) !== owned) continue;
            ensurePublished(trackIndex);
            writeCount += engine.exports.cancel_animation(trackIndex);
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
          ensurePublished(trackIndex);
          engine.exports.pause_animation(
            trackIndex,
            finite(time, "pause time"),
          );
        }
      },
      resume(time) {
        for (const trackIndex of trackIndices) {
          if (allocations.get(trackIndex) !== identities.get(trackIndex)) continue;
          ensurePublished(trackIndex);
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
          ensurePublished(trackIndex);
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
    let writeCount = 0;
    for (const [trackIndex, owned] of [...allocations]) {
      if (allocations.get(trackIndex) !== owned) continue;
      ensurePublished(trackIndex);
      const address = ANIMATION_TABLE_BASE + trackIndex * ANIMATION_RECORD_SIZE;
      const previousNodeIndex = view.getUint16(address, true);
      const nextNodeIndex = indexMap.get(previousNodeIndex);
      if (nextNodeIndex === undefined) {
        writeCount += engine.exports.cancel_animation(trackIndex);
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
    restore();
    const resultAddress = engine.exports.tick(finite(time, "tick time"));
    const result = {
      writeCount: view.getUint32(resultAddress, true),
      transformSampleCount: view.getUint32(resultAddress + 4, true),
      liveTrackCount: view.getUint32(resultAddress + 8, true),
      eventCount: view.getUint32(resultAddress + 12, true),
    };
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
      ) freeTrack(trackIndex);
    }
    return result;
  }

  return Object.freeze({
    animate,
    transition,
    declareTrack,
    tick,
    remapNodes,
    replaceBase,
    suspend,
    restore,
    cancelAll,
    properties: PROPERTY_REGISTRY,
  });
}

export { PROPERTY_REGISTRY };
