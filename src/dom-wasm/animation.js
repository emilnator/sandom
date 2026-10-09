import { sharedDomCore as core } from "./core.js";
import { parseCSSEasing } from "./easing.js";

const measurementSymbol = Symbol.for("sandom.domCore.measurement");
export function normalizeAnimationOffsets(keyframes) {
  const frames = keyframes.map((frame) => ({ ...frame }));
  const pointer = core.exports.abi_allocate(frames.length * 16);
  let view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < frames.length; index++) {
    const offset = frames[index].offset;
    // Property access and Number.isFinite's noncoercing contract belong here.
    if (index > 0 && offset != null && typeof offset !== "number") {
      throw new TypeError("keyframe offset must be finite");
    }
    view.setFloat64(pointer + index * 16, offset ?? NaN, true);
    view.setUint32(pointer + index * 16 + 8, index, true);
    view.setUint32(pointer + index * 16 + 12, offset == null ? 0 : 1, true);
  }
  const count = core.status("animation_offsets", pointer, frames.length);
  view = new DataView(core.refreshBytes().buffer);
  const output = core.exports.abi_output_pointer();
  const result = new Array(count);
  for (let index = 0; index < count; index++) {
    const frame = frames[view.getUint32(output + index * 16 + 8, true)];
    frame.offset = view.getFloat64(output + index * 16, true);
    result[index] = frame;
  }
  return result;
}

// The engine memory is addressed through the Memory object, never a view
// captured before the call: the core call can grow the memory the engine
// shares with it, and a view taken before that growth is detached.
function transfer(exportName, pointer, engineMemory, address) {
  const output = core.status(exportName, pointer);
  const length = core.exports.abi_output_length();
  const bytes = core.refreshBytes().subarray(output, output + length);
  new Uint8Array(engineMemory.buffer, address, length).set(bytes);
  const measurement = globalThis[measurementSymbol];
  if (measurement) measurement.record({ category: "animation", operation: exportName,
    direction: "core-to-engine", bytes: length });
}

export function writeAnimationTrack(engineMemory, address, nodeIndex, propertyId, timing,
  transition, composite, keyframeOffset, count, base, effectiveKind) {
  const fill = ({ forwards: 1, backwards: 2, both: 3 })[timing.fill] ?? 0;
  const direction = ({ normal: 0, reverse: 1, alternate: 2, "alternate-reverse": 3 })[timing.direction] ?? 0;
  const start = animationNumber(timing.startTime ?? 0);
  const duration = animationNumber(timing.duration ?? 0);
  const delay = animationNumber(timing.delay ?? 0);
  const iterations = animationNumber(timing.iterations ?? 1, undefined, 2);
  const pointer = core.exports.abi_allocate(120);
  const view = new DataView(core.refreshBytes().buffer);
  new Uint8Array(view.buffer, pointer, 120).fill(0);
  view.setUint32(pointer, nodeIndex, true);
  view.setUint32(pointer + 4, propertyId, true);
  view.setUint32(pointer + 8, fill, true);
  view.setUint32(pointer + 12, direction, true);
  view.setUint32(pointer + 16, transition ? 1 : 0, true);
  view.setUint32(pointer + 20, composite, true);
  view.setFloat64(pointer + 48, start, true);
  view.setFloat64(pointer + 56, duration, true);
  view.setFloat64(pointer + 64, delay, true);
  view.setFloat64(pointer + 72, iterations, true);
  view.setUint32(pointer + 80, keyframeOffset, true);
  view.setUint32(pointer + 84, count, true);
  view.setUint32(pointer + 88, base.tag, true);
  for (let index = 0; index < 6; index++) view.setFloat32(pointer + 92 + index * 4, base.values[index] ?? 0, true);
  view.setUint32(pointer + 116, effectiveKind, true);
  transfer("animation_track_write", pointer, engineMemory, address);
}

export function writeAnimationKeyframe(engineMemory, address, frame, transformOffset) {
  const pointer = core.exports.abi_allocate(88);
  const view = new DataView(core.refreshBytes().buffer);
  new Uint8Array(view.buffer, pointer, 88).fill(0);
  view.setFloat64(pointer, frame.offset, true);
  for (let index = 0; index < 6; index++) view.setFloat64(pointer + 32 + index * 8, frame.value.values[index] ?? 0, true);
  view.setUint32(pointer + 80, transformOffset, true);
  view.setUint32(pointer + 84, frame.transformCount, true);
  transfer("animation_keyframe_write", pointer, engineMemory, address);
}

export function updateAnimationTransition(previous, sample, target, startValues) {
  const pointer = core.exports.abi_allocate(144);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < 6; index++) {
    view.setFloat64(pointer + index * 8, sample[index] ?? 0, true);
    view.setFloat64(pointer + 48 + index * 8, target[index] ?? 0, true);
    view.setFloat64(pointer + 96 + index * 8, startValues[index] ?? 0, true);
  }
  return core.handle("animation_transition_update", previous ?? 0n, pointer, pointer + 48, target.length, pointer + 96);
}
export function animationTransitionFactor(handle) { return core.status("animation_transition_factor", handle); }
export function animationTransitionRevision(handle) { return core.status("animation_transition_revision", handle); }
export function animationTransitionDuration(handle, duration) { return core.status("animation_transition_duration", handle, duration); }
export function releaseAnimationTransition(handle) { core.status("animation_transition_release", handle); }
export function animationTransitionChanged(previous, next, duration, delay) {
  return core.status("animation_transition_changed", ...core.input(JSON.stringify(previous)),
    ...core.input(JSON.stringify(next)), duration, delay) !== 0;
}

export function createAnimationTrackIdentity(owner = 0n) {
  return core.handle("animation_track_identity_create", owner);
}
export function releaseAnimationTrackIdentity(handle) {
  core.status("animation_track_identity_release", handle);
}
function snapshotAnimationTracks(engineView, allocations, tableBase, recordSize) {
  // Read the engine rows first: abi_allocate can grow the shared memory,
  // which detaches the caller's engine view.
  const rows = [];
  for (const [slot, allocation] of allocations) {
    const address = tableBase + slot * recordSize;
    rows.push([allocation.identity, slot,
      engineView.getUint16(address, true), engineView.getUint16(address + 2, true),
      engineView.getUint8(address + 5), engineView.getUint8(address + 4),
      engineView.getUint8(address + 59), engineView.getUint32(address + 96, true),
      engineView.getUint8(address + 6)]);
  }
  const pointer = core.exports.abi_allocate(rows.length * 40);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < rows.length; index++) {
    const row = pointer + index * 40;
    const fields = rows[index];
    view.setBigUint64(row, fields[0], true);
    for (let field = 1; field < 9; field++) view.setUint32(row + 4 + field * 4, fields[field], true);
  }
  return pointer;
}
export function identifyAnimationFeedback(engineView, allocations, tableBase, recordSize,
  nodeIndex, propertyId, type, expectedTrackIndex) {
  return core.status("animation_feedback_track", snapshotAnimationTracks(engineView, allocations, tableBase, recordSize),
    allocations.size, nodeIndex, propertyId, type, expectedTrackIndex ?? -1);
}
export function nextAnimationReplacement(engineView, allocations, tableBase, recordSize, nodeIndex, propertyId, cursor) {
  return core.status("animation_replacement_next", snapshotAnimationTracks(engineView, allocations, tableBase, recordSize),
    allocations.size, nodeIndex, propertyId, cursor);
}
export function animationTransitionProperties(name) {
  const count = core.status("animation_transition_properties", ...core.input(name));
  const pointer = core.exports.abi_output_pointer();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  return Array.from({ length: count }, (_, index) => {
    const row = pointer + index * 8;
    const text = view.getUint32(row, true);
    return core.decoder.decode(bytes.subarray(text, text + view.getUint32(row + 4, true)));
  });
}

export function reconcileAnimationDefinitions(definitions, previous = []) {
  const desired = definitions.map((definition) => ({
    definition,
    signature: JSON.stringify({ name: definition.name, keyframes: definition.keyframes,
      composition: definition.composition, timing: definition.timing, paused: definition.paused }),
  }));
  const pointer = core.exports.abi_allocate((previous.length + desired.length) * 24);
  const rows = [...previous, ...desired];
  for (let index = 0; index < rows.length; index++) {
    const record = rows[index];
    const [name, nameLength] = core.input(record.definition.name);
    const [signature, signatureLength] = core.input(record.signature);
    const view = new DataView(core.refreshBytes().buffer);
    const row = pointer + index * 24;
    view.setUint32(row, name, true); view.setUint32(row + 4, nameLength, true);
    view.setUint32(row + 8, signature, true); view.setUint32(row + 12, signatureLength, true);
    view.setUint32(row + 16, record.occurrence ?? 0, true);
    view.setUint32(row + 20, index, true);
  }
  core.status("animation_css_reconcile", pointer, previous.length,
    pointer + previous.length * 24, desired.length);
  const output = core.exports.abi_output_pointer();
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < desired.length; index++) {
    const record = desired[index];
    const row = output + index * 16;
    record.occurrence = view.getUint32(row + 4, true);
    record.identity = `${record.definition.name}\u0000${record.occurrence}`;
    record.reusable = previous[view.getInt32(row, true)];
    record.previous = previous[view.getInt32(row + 8, true)];
  }
  return desired;
}
export function animationCSSInsertion(following, preceding, previous, first, count) {
  return core.status("animation_css_insertion", following, preceding, previous ?? -1, first, count);
}

export function animationTransitionDefinitions(element) {
  const native = element._domCore;
  const count = native.status("animation_transition_definitions", element._coreHandle);
  const pointer = native.exports.abi_output_pointer();
  const bytes = native.refreshBytes();
  const view = new DataView(bytes.buffer);
  const result = new Array(count);
  for (let index = 0; index < count; index++) {
    const row = pointer + index * 40;
    const name = view.getUint32(row, true);
    const nameLength = view.getUint32(row + 4, true);
    const easing = view.getUint32(row + 24, true);
    const easingLength = view.getUint32(row + 28, true);
    result[index] = {
      propertyName: native.decoder.decode(bytes.subarray(name, name + nameLength)),
      duration: view.getFloat64(row + 8, true), delay: view.getFloat64(row + 16, true),
      easing: native.decoder.decode(bytes.subarray(easing, easing + easingLength)),
    };
  }
  for (const definition of result) definition.easing = parseCSSEasing(definition.easing);
  return result;
}

const TRANSFORM_KINDS = { translate: 1, translateX: 2, translateY: 3, scale: 4,
  scaleX: 5, scaleY: 6, rotate: 7, skew: 8, skewX: 9, skewY: 10, matrix: 11 };
// A box-shadow list travels as component pairs in the transform component
// pool (engine-layout.watpart $animationWriteShadowSample): geometry
// (offset-x, offset-y, blur, spread; kind bit 0 = inset) then colour.
export const SHADOW_COMPONENT_GEOMETRY = 0x40;
export const SHADOW_COMPONENT_COLOR = 0x41;
export const SHADOW_LIST_MAX = 8;
function nativeTransform(component) {
  const kind = component.kind;
  let values;
  if (kind === "translate") {
    const x = normalizeAnimationValue({ id: 1, kind: 2 }, component.x ?? { pixels: 0, percentage: 0 });
    const y = normalizeAnimationValue({ id: 1, kind: 2 }, component.y ?? { pixels: 0, percentage: 0 });
    values = [x.values[0], x.values[1], y.values[0], y.values[1]];
  } else if (kind === "translateX" || kind === "translateY") {
    values = normalizeAnimationValue({ id: 1, kind: 2 }, component.value).values;
  } else if (kind === "scale") values = [component.x, component.y];
  else if (kind === "scaleX" || kind === "scaleY") values = [component.value];
  else if (kind === "rotate" || kind === "skewX" || kind === "skewY") values = [component.radians];
  else if (kind === "skew") values = [component.xRadians, component.yRadians];
  else if (kind === "matrix") {
    if (!Array.isArray(component.value) || component.value.length !== 6) throw new TypeError("A matrix component needs six values");
    values = component.value;
  } else values = [];
  const pointer = core.exports.abi_allocate(48);
  let view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < 6; index++) {
    const value = index < values.length ? values[index] : 0;
    view.setFloat64(pointer + index * 8, typeof value === "number" ? value : NaN, true);
  }
  const output = core.status("animation_transform_normalize", TRANSFORM_KINDS[kind] ?? 0, pointer);
  view = new DataView(core.refreshBytes().buffer);
  return { kind: view.getUint32(output, true),
    parameters: Array.from({ length: 6 }, (_, index) => view.getFloat64(output + 16 + index * 8, true)) };
}
export function normalizeAnimationValue(property, input) {
  let kind = 0, tag = 0, values = [], components;
  if (property.kind === 2) {
    if (input?.kind === "lengthPercentage" || (input && "pixels" in input && "percentage" in input)) {
      kind = 2; values = [input.pixels, input.percentage, 0];
    } else if (input?.kind === "keyword") {
      kind = 5; tag = ({ auto: 0, none: 0, zero: 0, "min-content": 3, "max-content": 4, "fit-content": 8 })[input.keyword] ?? -1;
      values = [0, 0, 0];
    }
  } else if (property.kind === 1) {
    if (input?.kind === "scalar") { kind = 1; values = [input.value]; }
    else if (input?.kind === "lengthPercentage") {
      kind = 2; values = [input.pixels, input.percentage];
    }
  } else if (property.kind === 3) {
    if (input?.kind === "color" && Array.isArray(input.value) && input.value.length === 4) {
      kind = 3; values = input.value;
    }
  } else if (property.kind === 6) {
    kind = 6; tag = ({ visible: 0, hidden: 1 })[input?.keyword ?? input] ?? -1;
    values = [tag];
  } else if (property.kind === 4) {
    if (input?.kind === "transform" && Array.isArray(input.components)) {
      kind = 4; values = [0, 0, 0, 0, 0, 0];
      components = input.components.map(nativeTransform);
    }
  } else if (property.kind === 7) {
    if (input?.kind === "shadowList" && Array.isArray(input.shadows)) {
      if (input.shadows.length > SHADOW_LIST_MAX) {
        throw new RangeError(`A box-shadow list animates at most ${SHADOW_LIST_MAX} shadows, got ${input.shadows.length}`);
      }
      kind = 7;
      // The envelope's vector is the first shadow's numbers (the reversing
      // rule measures progress along it; every shadow shares the progress).
      const first = input.shadows[0];
      values = first
        ? [first.offsetX, first.offsetY, first.blur, first.spread, first.color[3], 0]
        : [0, 0, 0, 0, 0, 0];
      components = input.shadows.flatMap((shadow) => {
        for (const number of [shadow.offsetX, shadow.offsetY, shadow.blur, shadow.spread, ...shadow.color]) {
          if (!Number.isFinite(number)) throw new TypeError("A shadow needs finite lengths and colour channels");
        }
        return [
          { kind: SHADOW_COMPONENT_GEOMETRY | (shadow.inset ? 1 : 0), parameters: [shadow.offsetX, shadow.offsetY, shadow.blur, shadow.spread, 0, 0] },
          { kind: SHADOW_COMPONENT_COLOR, parameters: [shadow.color[0], shadow.color[1], shadow.color[2], shadow.color[3], 0, 0] },
        ];
      });
    }
  } else if (property.kind === 8 && input?.kind === "lineHeight") {
    kind = 8;
    tag = ({ normal: 0, length: 1, number: 2 })[input.unit] ?? -1;
    values = [input.value, tag];
  } else if (property.kind === 9 && input?.kind === "translate") {
    const x = input.x ?? { pixels: 0, percentage: 0 };
    const y = input.y ?? { pixels: 0, percentage: 0 };
    kind = 9;
    values = [x.pixels, x.percentage, y.pixels, y.percentage];
  }
  const pointer = core.exports.abi_allocate(64);
  let view = new DataView(core.refreshBytes().buffer);
  new Uint8Array(view.buffer, pointer, 64).fill(0);
  view.setUint32(pointer, kind, true); view.setUint32(pointer + 4, tag, true);
  view.setUint32(pointer + 8, values.length, true);
  for (let index = 0; index < values.length; index++) {
    view.setFloat64(pointer + 16 + index * 8, typeof values[index] === "number" ? values[index] : NaN, true);
  }
  const output = core.status("animation_value_normalize", property.id, pointer);
  view = new DataView(core.refreshBytes().buffer);
  const normalized = { kind: view.getUint32(output, true), tag: view.getUint32(output + 4, true),
    values: Array.from({ length: view.getUint32(output + 8, true) }, (_, index) => view.getFloat64(output + 16 + index * 8, true)) };
  if (components) normalized.components = components;
  return normalized;
}

export function animationProperty(name) {
  const id = core.status("animation_property", ...core.input(name));
  return id ? { id, name: core.outputString() } : null;
}
export function animationLength(value) {
  if (typeof value === "number") return { kind: "lengthPercentage", pixels: value, percentage: 0 };
  const pointer = core.status("animation_length_parse", ...core.input(String(value)));
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  if (view.getUint32(pointer + 16, true) === 2) {
    return { kind: "lengthPercentage", pixels: view.getFloat64(pointer, true), percentage: view.getFloat64(pointer + 8, true) };
  }
  const text = view.getUint32(pointer + 24, true);
  const length = view.getUint32(pointer + 28, true);
  return { kind: "keyword", keyword: core.decoder.decode(bytes.subarray(text, text + length)) };
}
export function animationLineHeight(value) {
  const pointer = core.status("animation_length_parse", ...core.input(String(value)));
  const view = new DataView(core.refreshBytes().buffer);
  return {
    kind: "lineHeight",
    value: view.getFloat64(pointer, true),
    unit: ["normal", "length", "number"][view.getUint32(pointer + 20, true)],
  };
}


export function animationNumber(value, _label, mode = 0) {
  return core.status("animation_number", typeof value === "number" ? value : NaN, mode);
}
export function normalizeAnimationEasing(easing = "linear") {
  let kind, pointer, count, values;
  if (typeof easing === "string") {
    kind = 0;
    [pointer, count] = core.input(easing);
  } else {
    if (easing.kind === "cubicBezier") {
      kind = 1;
      values = [easing.x1, easing.y1, easing.x2, easing.y2].map((value) => animationNumber(value));
    } else if (easing.kind === "steps") {
      kind = 2;
      const steps = animationNumber(easing.count, undefined, 1);
      const positions = { "jump-start": 0, "jump-end": 1, "jump-none": 2, "jump-both": 3 };
      values = [steps, positions[easing.position] ?? -1];
    } else if (easing.kind === "linear") {
      kind = 3;
      if (!Array.isArray(easing.points)) throw new TypeError("linear() needs at least one point");
      values = easing.points.flatMap((point) => [animationNumber(point.input), animationNumber(point.output)]);
    } else { kind = 4; values = []; }
    count = kind === 3 ? values.length / 2 : values.length;
    pointer = core.exports.abi_allocate(values.length * 8);
    const view = new DataView(core.refreshBytes().buffer);
    for (let index = 0; index < values.length; index++) view.setFloat64(pointer + index * 8, values[index], true);
  }
  const output = core.status("animation_easing_normalize", kind, pointer, count);
  const view = new DataView(core.refreshBytes().buffer);
  const result = { kind: view.getUint32(output, true) };
  if (result.kind === 3) {
    result.points = Array.from({ length: view.getUint32(output + 40, true) }, (_, index) => ({
      input: view.getFloat64(output + 48 + index * 16, true), output: view.getFloat64(output + 56 + index * 16, true),
    }));
  } else {
    result.payload = Array.from({ length: result.kind === 1 ? 4 : result.kind === 2 ? 2 : 0 },
      (_, index) => view.getFloat64(output + 8 + index * 8, true));
  }
  return result;
}

export function animationPropertyFrames(keyframes, propertyName) {
  const frames = keyframes.map((frame) => {
    let value;
    if (frame[propertyName] !== undefined) value = frame[propertyName];
    return { offset: frame.offset, easing: frame.easing, value };
  });
  const pointer = core.exports.abi_allocate(frames.length * 4);
  let view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < frames.length; index++) view.setInt32(pointer + index * 4,
    frames[index].value === undefined ? -1 : index, true);
  core.status("animation_property_fill", pointer, frames.length);
  view = new DataView(core.refreshBytes().buffer);
  return frames.map((frame, index) => ({ ...frame, value: frames[view.getInt32(pointer + index * 4, true)].value }));
}
export function sampleAnimationContent(record, timeMilliseconds) {
  const { timing, keyframes } = record.definition;
  const easing = keyframes[0]?.easing ?? timing.easing;
  const parsed = typeof easing === "string" ? parseCSSEasing(easing) : easing;
  const normalized = normalizeAnimationEasing(parsed);
  if (normalized.kind !== 2 || normalized.payload[0] !== 1 || normalized.payload[1] !== 1) {
    throw new TypeError(`Generated content animation ${JSON.stringify(record.definition.name)} requires step-end easing`);
  }
  const pointer = core.exports.abi_allocate(keyframes.length * 16);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < keyframes.length; index++) {
    view.setFloat64(pointer + index * 16, keyframes[index].offset ?? NaN, true);
    view.setUint32(pointer + index * 16 + 8, keyframes[index].content === undefined ? 0 : 1, true);
  }
  const index = core.status("animation_content_sample", pointer, keyframes.length,
    Number(timing.duration), Number(timing.iterations),
    timeMilliseconds - record.startTimeMilliseconds - Number(timing.delay ?? 0),
    ({ normal: 0, reverse: 1, alternate: 2, "alternate-reverse": 3 })[timing.direction] ?? 0,
    ({ forwards: 1, backwards: 2, both: 3 })[timing.fill] ?? 0, record.definition.paused ? 1 : 0);
  return index < 0 ? record.initialContent : keyframes[index]?.content;
}

const deferredBindingFinalizer = new FinalizationRegistry((handle) => {
  core.status("animation_binding_release", handle);
});
export function deferAnimationBinding(declare) {
  let binding = core.handle("animation_binding_create");
  let engineHandle = null;
  const command = (kind, value = 0, sample = 0) => {
    if (binding) core.status("animation_binding_command", binding, kind, value, sample);
  };
  const handle = Object.freeze({
    get trackIndices() { return engineHandle?.trackIndices ?? []; },
    pause(time) { if (engineHandle) engineHandle.pause(time); else command(1, time); },
    resume(time) { if (engineHandle) engineHandle.resume(time); else command(2, time); },
    seek(local, sample) { if (engineHandle) engineHandle.seek(local, sample); else command(3, local, sample); },
    cancelSilently() { if (engineHandle) engineHandle.cancelSilently(); else command(4); },
    cancel() { if (engineHandle) engineHandle.cancel(); else command(4); },
  });
  deferredBindingFinalizer.register(handle, binding, handle);
  const release = () => {
    if (!binding) return;
    deferredBindingFinalizer.unregister(handle);
    core.status("animation_binding_release", binding);
    binding = 0n;
  };
  return {
    handle, release,
    bind(renderer, nodeIndex) {
      if (!binding) return;
      if (core.status("animation_binding_canceled", binding)) { release(); return; }
      engineHandle = declare(renderer, nodeIndex);
      const count = core.status("animation_binding_export", binding);
      const pointer = core.exports.abi_output_pointer();
      const view = new DataView(core.refreshBytes().buffer);
      const commands = Array.from({ length: count }, (_, index) => {
        const row = pointer + index * 24;
        return [view.getUint32(row, true), view.getFloat64(row + 8, true), view.getFloat64(row + 16, true)];
      });
      for (const [kind, value, sample] of commands) {
        if (kind === 3) engineHandle.seek(value, sample);
        else engineHandle[kind === 1 ? "pause" : "resume"](value);
      }
      release();
    },
  };
}
