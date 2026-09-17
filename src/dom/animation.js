import { canonicalizeAnimationKeyframes, resolvedElementFields } from "./style.js";
import { parseCSSEasing } from "../dom-wasm/easing.js";
import { deferAnimationBinding } from "../dom-wasm/animation.js";
import { installAnimationBindings, createAnimationEffectBindings } from "./dom-bindings.generated.js";

const STATES = ["idle", "running", "paused", "finished"];
const FILL_MODES = ["none", "forwards", "backwards", "both"];
const LIFECYCLE = { animationstart: 1, animationend: 2, animationcancel: 3 };
const MEASUREMENT = Symbol.for("sandom.domCore.measurement");
const animationFinalizer = new FinalizationRegistry(({ core, handle, keyframes }) => {
  core.status("animation_release", handle);
  core.status("animation_keyframes_release", keyframes);
});

// A single NUL prefix tags a non-JSON number; doubling authored NUL prefixes
// makes the transport reversible without reserving any authored object keys.
function encodeCanonicalNumber(_key, value) {
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return `\0${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  return typeof value === "string" && value.startsWith("\0") ? `\0${value}` : value;
}
function decodeCanonicalNumber(_key, value) {
  if (typeof value !== "string" || !value.startsWith("\0")) return value;
  return value.startsWith("\0\0") ? value.slice(1) : Number(value.slice(1));
}

export class SDAnimation {
  constructor(surface, element, keyframes, timing, engineDeclarationOptions = {}) {
    this._surface = surface;
    this._element = element;
    this._core = element._domCore;
    // A surface is a timeline; a PendingAnimationTimeline is not. An
    // animation created before any surface claimed the element holds at its
    // current time until one adopts it and resolves its start time.
    this._timelinePending = false;
    const canonicalKeyframes = canonicalizeAnimationKeyframes(keyframes);
    this._inputKeyframes = structuredClone(keyframes);
    this._timing = typeof timing === "number" ? { duration: timing } : { ...timing };
    this._timelineOption = this._timing.timeline;
    this._rangeStartOption = this._timing.rangeStart;
    this._rangeEndOption = this._timing.rangeEnd;
    delete this._timing.timeline;
    delete this._timing.rangeStart;
    delete this._timing.rangeEnd;
    this._engineDeclarationOptions = engineDeclarationOptions;
    this._timing.duration = Number(this._timing.duration ?? 0);
    this._timing.delay = Number(this._timing.delay ?? 0);
    this._timing.iterations = this._timing.iterations ?? 1;
    const scroll = this._isScrollDriven();
    const defaults = this._core.status("animation_timing_defaults", this._timing.duration, scroll ? 1 : 0);
    const defaultView = new DataView(this._core.refreshBytes().buffer);
    this._timing.duration = defaultView.getFloat64(defaults, true);
    const defaultFill = defaultView.getUint32(defaults + 8, true);
    const measurement = globalThis[MEASUREMENT];
    if (measurement) measurement.record({
      category: "animation", operation: "animation.timing-defaults",
      direction: "core-to-host", bytes: 12, allocations: 1,
    });
    if (defaultFill && this._timing.fill === undefined) this._timing.fill = FILL_MODES[defaultFill];
    this._animationId = this._core.handle("animation_create", element._coreHandle,
      this._timing.duration, this._timing.delay, Number(this._timing.iterations),
      Number(this._timing.startTime ?? surface.currentTime), scroll ? 1 : 0);
    try {
      this._keyframesHandle = this._core.handle("animation_keyframes_create",
        ...this._core.input(JSON.stringify(canonicalKeyframes, encodeCanonicalNumber)));
      this._ready = Promise.resolve(this);
      this._resetFinishedPromise();
      this.effect = Object.freeze(createAnimationEffectBindings({
        cloneAuthoredKeyframes: () => structuredClone(this._inputKeyframes),
        cloneAuthoredTiming: () => ({ ...this._timing }),
      }));
      this._replaceEngineHandle();
    } catch (error) {
      if (this._keyframesHandle) this._core.status("animation_keyframes_release", this._keyframesHandle);
      this._core.status("animation_release", this._animationId);
      throw error;
    }
    animationFinalizer.register(this, {
      core: this._core, handle: this._animationId, keyframes: this._keyframesHandle,
    });
  }

  get _canonicalKeyframes() {
    return JSON.parse(this._core.string("animation_keyframes_export", this._keyframesHandle), decodeCanonicalNumber);
  }

  _value(field) {
    return this._core.status("animation_value", this._animationId, field, this._surface.currentTime);
  }
  _resetFinishedPromise() {
    this._promiseGeneration = this._value(4);
    this._finishedPromise = new Promise((resolve, reject) => {
      this._resolveFinished = resolve;
      this._rejectFinished = reject;
    });
    // Cancelling rejects `finished` whether or not anyone awaits it (a CSS
    // animation whose declaration goes away is cancelled by the surface);
    // an unobserved rejection must not become a host-level failure.
    this._finishedPromise.catch(() => {});
  }
  _replaceEngineHandle() {
    let direction = this._timing.direction ?? "normal";
    if (this._value(9)) {
      direction = { normal: "reverse", reverse: "normal", alternate: "alternate-reverse", "alternate-reverse": "alternate" }[direction];
    }
    this._engineHandle = this._surface._declareAnimation(this._element, this._canonicalKeyframes, {
      ...this._timing,
      direction,
      easing: typeof this._timing.easing === "string" ? parseCSSEasing(this._timing.easing) : this._timing.easing,
      duration: this._value(7), delay: this._value(8), startTime: this._value(6),
    }, { ...this._engineDeclarationOptions, animationId: this._animationId, trackGeneration: this._value(5) });
  }
  _applyActions(actions) {
    if (actions & 512) this._resetFinishedPromise();
    if (actions & 1024) {
      const generation = this._value(12);
      this._surface._animationCancelingThroughEngine = this;
      try { this._engineHandle.cancel(); }
      finally { this._surface._animationCancelingThroughEngine = null; }
      this._applyActions(this._core.status("animation_control", this._animationId, 10, generation, this._surface.currentTime));
    }
    if (actions & 1) this._engineHandle.cancelSilently();
    if (actions & 16) this._surface._restoreAnimation(this);
    if (actions & 2) this._replaceEngineHandle();
    if (actions & 4) this._engineHandle.pause(this._surface.currentTime);
    if (actions & 8) this._engineHandle.resume(this._surface.currentTime);
    if (actions & 2048) this._engineHandle.seek(this._value(11), this._surface.currentTime);
    if (actions & 32) this._surface._removeAnimation(this);
    if (actions & 64) this._rejectFinished(new DOMException("Animation canceled", "AbortError"));
    if (actions & 128) this._resolveFinished(this);
    if (actions & 256) this._surface._scheduleAnimationFrame(this._element);
    return actions !== 0;
  }
  _control(operation, value = 0) {
    return this._applyActions(this._core.status("animation_control", this._animationId, operation, value, this._surface.currentTime));
  }
  // The surface that adopted this animation has reached a frame, so its
  // timeline finally has a time. The animation held at the current time it
  // reached without a timeline (0 unless the host seeked or paused it), so
  // replaying that time against the live clock starts it at exactly that
  // sample and declares the engine track the pending binding stood in for.
  _resolveTimeline() {
    this._timelinePending = false;
    const state = this._value(3);
    if (state === 0) return;
    const held = this._core.status("animation_value", this._animationId, 0, 0);
    this._control(1, Number.isNaN(held) ? 0 : held);
    if (state === 3) this._control(7);
  }
  _timelineValue() {
    return this._timelineOption ?? resolvedElementFields(this._element).animationTimeline?.[0] ?? "auto";
  }
  _timelineRangeStart() {
    return this._rangeStartOption ?? resolvedElementFields(this._element).animationRangeStart?.[0] ?? "normal";
  }
  _timelineRangeEnd() {
    return this._rangeEndOption ?? resolvedElementFields(this._element).animationRangeEnd?.[0] ?? "normal";
  }
  _isScrollDriven() {
    const value = this._timelineValue();
    return value !== "auto" && value !== "none";
  }
  _sampleScrollTimeline(progress) { return this._control(9, progress === null ? NaN : progress); }
  _needsFrame() { return this._value(10) !== 0; }
  *_iterationEventsAtCurrentTime() {
    for (;;) {
      const elapsed = this._core.status("animation_iteration_next", this._animationId, this._surface.currentTime);
      if (Number.isNaN(elapsed)) return;
      yield elapsed;
    }
  }
  _beginEngineLifecycle(record) {
    const handle = this._core.handle("animation_feedback_begin", this._animationId,
      record.trackGeneration, LIFECYCLE[record.type], this._surface.currentTime);
    if (!handle) return null;
    return { handle, token: this._core.handle("animation_feedback_next", handle) };
  }
  _completeEngineLifecycle(feedback) {
    try {
      this._applyActions(this._core.status("animation_feedback_complete", feedback.handle, feedback.token, this._surface.currentTime));
    } finally { this._core.status("animation_feedback_release", feedback.handle); }
  }
  _elapsedTimeForEvent(type) {
    return this._core.status("animation_elapsed", this._animationId, LIFECYCLE[type] ?? 0, this._surface.currentTime);
  }
}
installAnimationBindings({
  readTime(animation, field) {
    // Field 1 is the start time. Without a timeline there is no time to
    // report one in, so a pending animation reports it unresolved, as a
    // play-pending animation does in Chrome.
    if (field === 1 && animation._timelinePending) return null;
    const value = animation._value(field);
    return Number.isNaN(value) ? null : value;
  },
  readState(animation) { return STATES[animation._value(3)]; },
  currentTimeInput(value) {
    if (value === null) throw new TypeError("currentTime cannot be null");
    const time = Number(value);
    if (!Number.isFinite(time)) throw new TypeError("currentTime must be finite");
    return time;
  },
  startTimeInput(value) {
    const time = value === null ? NaN : Number(value);
    if (value !== null && !Number.isFinite(time)) throw new TypeError("startTime must be finite or null");
    return time;
  },
  rateInput(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate)) throw new TypeError("playbackRate must be finite");
    return rate;
  },
}, SDAnimation.prototype);

export function createDOMAnimation(surface, element, keyframes, timing, engineDeclarationOptions = {}) {
  return new SDAnimation(surface, element, keyframes, timing, engineDeclarationOptions);
}

export function animationsForElement(animations, element, subtree) {
  return animations.filter((animation) => {
    if (animation.playState === "idle") return false;
    if (animation._element === element) return true;
    if (!subtree) return false;
    for (
      let node = animation._element.parentElement;
      node;
      node = node.parentElement
    ) {
      if (node === element) return true;
    }
    return false;
  });
}

// `element.animate()` does not require a render surface: the Web Animations
// API has none of that, and a host that builds a whole animating document
// before rendering it must not lose the document to an exception. Until a
// surface claims the element, its animations live on this per-document
// timeline, which has no clock: each one holds at its current time the way a
// play-pending animation does in Chrome, and the surface that adopts the
// element resolves their start times on its next frame
// (DOMRenderSurface._adoptPendingAnimations and SDAnimation._resolveTimeline).
const pendingAnimationTimelines = new WeakMap();

// A pending animation's engine handle is a deferred binding, which queues
// the host's commands natively; the adopting surface declares the real
// track from the core's own state, so this is never reached.
function declareWithoutRenderer() {
  throw new Error("a pending animation has no renderer to declare against");
}

class PendingAnimationTimeline {
  constructor() {
    this._animations = [];
    this._animationsByElement = new Map();
    // _applyActions writes this slot while cancelling through the engine.
    this._animationCancelingThroughEngine = null;
  }
  get currentTime() {
    return 0;
  }
  _createAnimation(element, keyframes, options) {
    const animation = createDOMAnimation(this, element, keyframes, options);
    animation._timelinePending = true;
    this._animations.push(animation);
    const forElement = this._animationsByElement.get(element);
    if (forElement === undefined) {
      this._animationsByElement.set(element, [animation]);
    } else {
      forElement.push(animation);
    }
    return animation;
  }
  _declareAnimation() {
    return deferAnimationBinding(declareWithoutRenderer).handle;
  }
  _animationsForElement(element, subtree) {
    return animationsForElement(this._animations, element, subtree);
  }
  _removeAnimation(animation) {
    const index = this._animations.indexOf(animation);
    if (index >= 0) this._animations.splice(index, 1);
    const forElement = this._animationsByElement.get(animation._element);
    const elementIndex = forElement?.indexOf(animation) ?? -1;
    if (elementIndex >= 0) forElement.splice(elementIndex, 1);
    if (forElement?.length === 0) {
      this._animationsByElement.delete(animation._element);
    }
  }
  _restoreAnimation(animation) {
    if (!this._animations.includes(animation)) this._animations.push(animation);
  }
  // Nothing renders yet; the adopting surface schedules the first frame.
  _scheduleAnimationFrame() {}
  _takeAnimationsFor(element) {
    const taken = this._animationsByElement.get(element);
    if (taken === undefined) return null;
    this._animationsByElement.delete(element);
    for (const animation of taken) {
      const index = this._animations.indexOf(animation);
      if (index >= 0) this._animations.splice(index, 1);
    }
    return taken;
  }
}

// The `animate`/`getAnimations` binding hook: the element's live surface owns
// its animations, and its document's pending timeline holds them until one
// does.
export function elementAnimationHost(element, surface) {
  if (surface) return surface;
  const owner = element.ownerDocument ?? element;
  let timeline = pendingAnimationTimelines.get(owner);
  if (timeline === undefined) {
    timeline = new PendingAnimationTimeline();
    pendingAnimationTimelines.set(owner, timeline);
  }
  return timeline;
}

// The animations a surface must adopt as it claims `node`, or null.
export function takePendingAnimations(node) {
  const timeline = pendingAnimationTimelines.get(node.ownerDocument ?? node);
  return timeline === undefined ? null : timeline._takeAnimationsFor(node);
}
