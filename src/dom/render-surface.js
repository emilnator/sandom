import { serializeToScene } from "./serialize.js";
import {
  createSceneRendererForCurrentModule,
  layoutTreeBoxes,
  renderScenePixels,
} from "../scene-renderer.js";
import {
  deliverRenderingObservers,
  documentHasRenderingObservers,
} from "./rendering-observers.js";
import { encodePNG } from "../output/png.js";
import {
  animationsForElement,
  createDOMAnimation,
  takePendingAnimations,
} from "./animation.js";
import { createEvent, dispatchEvent } from "./events.js";
import { SandomViewport } from "./viewport.js";
import { computeScrollbars, snapshotScrollbars } from "./scrollbars.js";
import { sampleScrollTimeline } from "./scroll-timeline.js";
import {
  NativeScrollCapture,
  NativeScrollCollection,
  NativeScrollMotions,
  NativeScrollSuppression,
  scrollCore,
  scrollRead,
  scrollRequest,
  scrollState,
  withScrollGeometry,
} from "./scroll-core.js";
import { BOX_SNAPSHOT, releaseBoxSnapshot } from "../dom-wasm/geometry-wire.js";
import { buildInteractionSnapshot } from "./presented-frame.js";
import {
  caretRectangle,
  keptTextGeometryFor,
  selectionRectangles,
  selectionRectanglesForText,
  uniqueCaretStops,
} from "./geometry.js";
import { resolvedElementFields } from "./style.js";
import {
  animationCSSInsertion,
  deferAnimationBinding,
  reconcileAnimationDefinitions,
  sampleAnimationContent as pseudoContentAt,
} from "../dom-wasm/animation.js";
import { normalizeOffsets } from "../animations.js";
import { instantiate as instantiateMotionCapture } from "../wasm/motion-capture-binary.js";
import { createFrameBindings } from "./dom-bindings.generated.js";
import { geometryBox } from "./geometry.js";
const requestHostAnimationFrame =
  typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : (callback) => setTimeout(() => callback(performance.now()), 0);
const renderSurfaceNow = globalThis.performance.now.bind(
  globalThis.performance,
);
const cancelHostAnimationFrame =
  typeof globalThis.cancelAnimationFrame === "function"
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : (request) => clearTimeout(request);

const MOTION_CLASSIFICATIONS = ["static", "finite", "unbounded", "external"];
function freezeMotionValue(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeMotionValue(entry)));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          freezeMotionValue(entry),
        ]),
      ),
    );
  }
  return value;
}

// The caret is ink the document specifies: `caret-color` when authored,
// otherwise the element's own `color` (CSS `caret-color: auto` is
// currentColor). A hardcoded black caret disappears on any dark control.
const OPAQUE_BLACK = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
function caretPaintColor(element) {
  const fields = resolvedElementFields(element);
  const color = fields.caretColor ?? fields.color ?? OPAQUE_BLACK;
  return typeof color === "object" && color !== null ? color : OPAQUE_BLACK;
}

function motionValueSignature(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => motionValueSignature(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((name) =>
        `${JSON.stringify(name)}:${motionValueSignature(value[name])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function normalizeMotionKeyframes(keyframes) {
  return Object.freeze(keyframes.map((keyframe) => {
    const values = Object.fromEntries(
      Object.entries(keyframe).filter(([name]) =>
        name !== "offset" && name !== "easing" && name !== "composite"
      ).map(([name, value]) => [name, freezeMotionValue(value)]),
    );
    return Object.freeze({
      offset: keyframe.offset,
      easing: keyframe.easing ?? null,
      composite: keyframe.composite ?? null,
      values: Object.freeze(values),
      valueSignatures: Object.freeze(
        Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            motionValueSignature(value),
          ]),
        ),
      ),
    });
  }));
}

function renderedChangeFromKeyframes(propertyNames, keyframes) {
  let hasUnknownProperty = false;
  for (const propertyName of propertyNames) {
    const signatures = keyframes.flatMap((keyframe) =>
      propertyName in keyframe.valueSignatures
        ? [keyframe.valueSignatures[propertyName]]
        : []
    );
    if (new Set(signatures).size > 1) return true;
    if (signatures.length < 2) hasUnknownProperty = true;
  }
  return hasUnknownProperty ? null : false;
}

function createMotionModel(surface) {
  if (surface._preparedState === null) {
    throw new Error("inspectMotion() requires prepared render state");
  }
  const exports = instantiateMotionCapture({}).exports;
  exports.motion_reset();
  const effects = [];
  const scheduleEffects = [];

  for (const animation of surface._animations) {
    if (animation.playState === "idle" || animation.playState === "finished") {
      continue;
    }
    const timing = animation.effect.getTiming();
    const keyframes = normalizeOffsets(animation._canonicalKeyframes);
    const propertyNames = [
      ...new Set(
        keyframes.flatMap((keyframe) =>
          Object.keys(keyframe).filter((name) =>
            name !== "offset" && name !== "easing" && name !== "composite"
          )
        ),
      ),
    ];
    const normalizedKeyframes = normalizeMotionKeyframes(keyframes);
    const changesRenderedOutput = renderedChangeFromKeyframes(
      propertyNames,
      normalizedKeyframes,
    );
    const external = animation._isScrollDriven();
    const progressing = animation.playState === "running" &&
      animation.playbackRate !== 0 && changesRenderedOutput !== false;
    const startTimeMilliseconds = animation.startTime ??
      surface.currentTime -
        (animation.currentTime ?? 0) / (Math.abs(animation.playbackRate) || 1);
    const delayMilliseconds = Number(timing.delay ?? 0);
    const durationMilliseconds = Number(timing.duration ?? 0);
    const iterationCount = Number(timing.iterations ?? 1);
    const localTimeMilliseconds =
      (surface.currentTime - startTimeMilliseconds) * animation.playbackRate;
    const activeTimeMilliseconds = localTimeMilliseconds - delayMilliseconds;
    const activeDurationMilliseconds = durationMilliseconds * iterationCount;
    const phase = external
      ? "external"
      : activeTimeMilliseconds < 0
      ? "before"
      : activeTimeMilliseconds < activeDurationMilliseconds
      ? "active"
      : "after";
    const fill = timing.fill ?? "none";
    const effectMembershipAtInspection = phase === "active" ||
      (phase === "before" && (fill === "backwards" || fill === "both")) ||
      (phase === "after" && (fill === "forwards" || fill === "both"));
    const iterationIndex = phase === "active" && durationMilliseconds > 0
      ? Math.floor(activeTimeMilliseconds / durationMilliseconds)
      : null;
    const iterationProgress = iterationIndex === null
      ? null
      : (activeTimeMilliseconds -
        iterationIndex * durationMilliseconds) / durationMilliseconds;
    const effectIndex = exports.motion_add_effect(
      (progressing ? 1 : 0) | (external ? 2 : 0),
      startTimeMilliseconds,
      delayMilliseconds,
      durationMilliseconds,
      iterationCount,
      animation.playbackRate,
    );
    if (effectIndex < 0) {
      throw new Error(
        `Cannot inspect motion: WebAssembly error ${exports.motion_error()}`,
      );
    }
    const endTime = exports.motion_effect_end(effectIndex);
    const record = Object.freeze({
      kind: animation._cssAnimationName ? "css-animation" : "web-animation",
      element: animation._element,
      propertyNames: Object.freeze(propertyNames),
      animationName: animation._cssAnimationName ?? "",
      effectOrder: effects.length,
      startTimeMilliseconds,
      delayMilliseconds,
      durationMilliseconds,
      iterationCount,
      endTimeMilliseconds: Number.isFinite(endTime) ? endTime : null,
      keyframeOffsets: Object.freeze(
        keyframes.map((keyframe) => keyframe.offset),
      ),
      keyframes: normalizedKeyframes,
      direction: timing.direction ?? "normal",
      fill,
      easing: timing.easing ?? "linear",
      composite: timing.composite ?? "replace",
      playState: animation.playState,
      playbackRate: animation.playbackRate,
      timeline: external ? "external" : "time",
      phase,
      localTimeMilliseconds,
      activeTimeMilliseconds,
      iterationIndex,
      iterationProgress,
      effectMembershipAtInspection,
      changesRenderedOutput,
      changesUnderlyingState: false,
    });
    effects.push(record);
    scheduleEffects.push({
      effectIndex,
      progressing,
      external,
      keyframes,
      discrete: propertyNames.includes("visibility"),
    });
  }

  for (const pseudoElements of surface._pseudoContentAnimations.values()) {
    for (const records of pseudoElements.values()) {
      for (const record of records) {
        const { timing, keyframes } = record.definition;
        if (record.definition.paused) continue;
        const normalizedKeyframes = normalizeMotionKeyframes(keyframes);
        const changesRenderedOutput = renderedChangeFromKeyframes(
          ["content"],
          normalizedKeyframes,
        );
        const delayMilliseconds = Number(timing.delay ?? 0);
        const durationMilliseconds = Number(timing.duration ?? 0);
        const iterationCount = Number(timing.iterations ?? 1);
        const activeTimeMilliseconds = surface.currentTime -
          record.startTimeMilliseconds - delayMilliseconds;
        const activeDurationMilliseconds = durationMilliseconds *
          iterationCount;
        const phase = activeTimeMilliseconds < 0
          ? "before"
          : activeTimeMilliseconds < activeDurationMilliseconds
          ? "active"
          : "after";
        const fill = timing.fill ?? "none";
        const effectMembershipAtInspection = phase === "active" ||
          (phase === "before" && (fill === "backwards" || fill === "both")) ||
          (phase === "after" && (fill === "forwards" || fill === "both"));
        const iterationIndex = phase === "active" && durationMilliseconds > 0
          ? Math.floor(activeTimeMilliseconds / durationMilliseconds)
          : null;
        const iterationProgress = iterationIndex === null
          ? null
          : (activeTimeMilliseconds -
            iterationIndex * durationMilliseconds) / durationMilliseconds;
        const effectIndex = exports.motion_add_effect(
          changesRenderedOutput === false ? 0 : 1,
          record.startTimeMilliseconds,
          delayMilliseconds,
          durationMilliseconds,
          iterationCount,
          1,
        );
        if (effectIndex < 0) {
          throw new Error(
            `Cannot inspect generated content motion: WebAssembly error ${exports.motion_error()}`,
          );
        }
        const endTime = exports.motion_effect_end(effectIndex);
        effects.push(Object.freeze({
          kind: "css-animation",
          element: record.element,
          propertyNames: Object.freeze(["content"]),
          animationName: record.definition.name,
          effectOrder: effects.length,
          startTimeMilliseconds: record.startTimeMilliseconds,
          delayMilliseconds,
          durationMilliseconds,
          iterationCount,
          endTimeMilliseconds: Number.isFinite(endTime) ? endTime : null,
          keyframeOffsets: Object.freeze(
            keyframes.map((frame) => frame.offset),
          ),
          keyframes: normalizedKeyframes,
          direction: timing.direction ?? "normal",
          fill,
          easing: timing.easing ?? "linear",
          composite: timing.composite ?? "replace",
          playState: "running",
          playbackRate: 1,
          timeline: "time",
          pseudoElement: record.pseudoElement,
          phase,
          localTimeMilliseconds: surface.currentTime -
            record.startTimeMilliseconds,
          activeTimeMilliseconds,
          iterationIndex,
          iterationProgress,
          effectMembershipAtInspection,
          changesRenderedOutput,
          changesUnderlyingState: false,
          initialGeneratedContent: freezeMotionValue(record.initialContent),
        }));
        scheduleEffects.push({
          effectIndex,
          progressing: changesRenderedOutput !== false,
          external: false,
          keyframes,
          discrete: true,
        });
      }
    }
  }

  for (const [element, timings] of surface._transitionRecords) {
    for (const [propertyName, timing] of timings) {
      const delayMilliseconds = Number(timing.delay ?? 0);
      const durationMilliseconds = Number(timing.duration ?? 0);
      const effectIndex = exports.motion_add_effect(
        1,
        timing.startTimeMilliseconds,
        delayMilliseconds,
        durationMilliseconds,
        1,
        1,
      );
      if (effectIndex < 0) {
        throw new Error(
          `Cannot inspect motion: WebAssembly error ${exports.motion_error()}`,
        );
      }
      const endTime = exports.motion_effect_end(effectIndex);
      const activeTimeMilliseconds = surface.currentTime -
        timing.startTimeMilliseconds - delayMilliseconds;
      const phase = activeTimeMilliseconds < 0
        ? "before"
        : activeTimeMilliseconds < durationMilliseconds
        ? "active"
        : "after";
      effects.push(Object.freeze({
        kind: "transition",
        element,
        propertyNames: Object.freeze([propertyName]),
        animationName: "",
        effectOrder: effects.length,
        startTimeMilliseconds: timing.startTimeMilliseconds,
        delayMilliseconds,
        durationMilliseconds,
        iterationCount: 1,
        endTimeMilliseconds: endTime,
        keyframeOffsets: Object.freeze([0, 1]),
        keyframes: normalizeMotionKeyframes([{ offset: 0 }, { offset: 1 }]),
        direction: "normal",
        fill: "none",
        easing: timing.easing ?? "linear",
        composite: "replace",
        playState: "running",
        playbackRate: 1,
        timeline: "time",
        phase,
        localTimeMilliseconds: surface.currentTime -
          timing.startTimeMilliseconds,
        activeTimeMilliseconds,
        iterationIndex: phase === "active" ? 0 : null,
        iterationProgress: phase === "active" && durationMilliseconds > 0
          ? activeTimeMilliseconds / durationMilliseconds
          : null,
        effectMembershipAtInspection: phase === "active",
        changesRenderedOutput: true,
        changesUnderlyingState: true,
      }));
      scheduleEffects.push({
        effectIndex,
        progressing: true,
        external: false,
        keyframes: [{ offset: 0 }, { offset: 1 }],
        discrete: propertyName === "visibility",
      });
    }
  }

  const classification =
    MOTION_CLASSIFICATIONS[exports.motion_classification()];
  const finiteEnd = exports.motion_finite_end();
  const inspection = Object.freeze({
    classification,
    inspectedAtMilliseconds: surface.currentTime,
    finiteDurationMilliseconds: classification === "finite"
      ? Math.max(0, finiteEnd - surface.currentTime)
      : null,
    effects: Object.freeze(effects),
  });
  return { exports, inspection, scheduleEffects };
}
const NODE_DESCRIPTIONS = {
  1: "an element",
  3: "a text node",
  4: "a CDATA section",
  7: "a processing instruction",
  8: "a comment node",
  9: "a document",
  10: "a document type",
  11: "a document fragment",
};
function describeRoot(root) {
  if (root === null || root === undefined) return String(root);
  if (typeof root !== "object") return `a ${typeof root}`;
  if (!root._domCore) return "an object that is not a DOM node";
  return NODE_DESCRIPTIONS[root.nodeType] ?? `a node of type ${root.nodeType}`;
}
// A surface renders one element's box tree. A document is the root a host
// rendering a whole page has, so it resolves to its document element — which
// is also what makes a host-owned top element unnecessary. Anything else is
// refused here, by type, rather than by a statistic from the first frame's
// animation-candidate scan.
function resolveSurfaceRoot(root, operation) {
  const nodeType = root?._domCore ? root.nodeType : 0;
  if (nodeType === 9) {
    const documentElement = root.documentElement;
    if (!documentElement) {
      throw new TypeError(
        `${operation}: root must be an element or a document with a document ` +
          `element, received a document with no document element`,
      );
    }
    return documentElement;
  }
  if (nodeType !== 1) {
    throw new TypeError(
      `${operation}: root must be an element or a document, received ${
        describeRoot(root)
      }`,
    );
  }
  return root;
}
export function createRenderSurface(root, options = {}) {
  return new DOMRenderSurface(root, options);
}

let frameTransactionSequence = 0;
export function createFrameTransaction() {
  return {
    id: ++frameTransactionSequence,
    surfaces: new Set(),
    targets: new Map(),
    instances: new Map(),
    created: new Set(),
    retired: new Set(),
    workingSurfaces: new Map(),
    committed: false,
  };
}

// A session prepares all targets while every public surface/target still
// exposes its predecessor. The synchronous commit below invokes no authored
// callbacks; notification is a separate phase after all state is visible.
export async function commitFrameTransaction(transaction) {
  for (const [target, publication] of transaction.targets) {
    if (target._frameTransaction !== transaction || publication === null) {
      throw new Error("Frame transaction target is not prepared");
    }
  }
  const groups = new Map();
  for (const surface of transaction.surfaces) {
    const staged = surface._stagedFrame;
    if (!staged) continue;
    surface._frameCore.status(
      "frame_validate_commit",
      staged.handle,
      staged.revision,
    );
    const entries = groups.get(surface._frameCore) ?? [];
    entries.push(staged);
    groups.set(surface._frameCore, entries);
  }
  const packets = [];
  for (const [core, entries] of groups) {
    packets.push({
      core,
      pointer: core.frameCommitGroupInput(entries),
      count: entries.length,
    });
  }
  for (const { core, pointer, count } of packets) {
    core.status("frame_commit_group", pointer, count);
  }
  for (const surface of transaction.created) {
    const registry = surface._root._renderSurfaces;
    const previous = registry.get(surface._canonicalEnvironmentKey);
    if (previous && previous !== surface) {
      registry.delete(surface._canonicalEnvironmentKey);
      previous._environmentKey =
        `${surface._canonicalEnvironmentKey}#retired:${transaction.id}`;
      registry.set(previous._environmentKey, previous);
      transaction.retired.add(previous);
      for (const surfaces of transaction.workingSurfaces.values()) {
        const index = surfaces.indexOf(previous);
        if (index !== -1) surfaces[index] = undefined;
      }
      if (surface._root._renderSurface === previous) {
        previous._disconnectSubtree(surface._root);
        surface._connectSubtree(surface._root);
      }
    }
    registry.delete(surface._environmentKey);
    surface._environmentKey = surface._canonicalEnvironmentKey;
    registry.set(surface._environmentKey, surface);
  }
  for (const surface of transaction.surfaces) surface._stagedFrame?.publish();
  for (const [instance, publication] of transaction.instances) {
    Object.assign(instance, publication);
  }
  for (const [target, publication] of transaction.targets) {
    Object.assign(target, publication);
    target._frameTransaction = null;
  }
  transaction.committed = true;
  const errors = [];
  for (const surface of transaction.surfaces) {
    const staged = surface._stagedFrame;
    surface._stagedFrame = null;
    surface._frameTransaction = null;
    try {
      await staged?.present?.();
      staged?.notify();
    } catch (error) {
      errors.push(error);
    } finally {
      staged?.dispose();
      surface._schedule();
    }
  }
  for (const surface of transaction.retired) {
    surface.shutdown().catch((error) =>
      surface._reportBackgroundException(error)
    );
  }
  if (errors.length) {
    throw new AggregateError(errors, "Frame transaction listener errors");
  }
}

export async function abortFrameTransaction(transaction) {
  for (const surface of transaction.surfaces) {
    const staged = surface._stagedFrame;
    surface._stagedFrame = null;
    surface._frameTransaction = null;
    staged?.rollback();
    staged?.dispose();
  }
  for (const target of transaction.targets.keys()) {
    if (target._frameTransaction === transaction) {
      target._frameTransaction = null;
    }
  }
  for (const surface of transaction.created) await surface.shutdown();
  for (const surface of transaction.surfaces) surface._schedule();
}

function boxRectangle(box, deviceScale) {
  if (!box || box.w <= 0 || box.h <= 0) return null;
  return {
    x: Math.floor(box.x * deviceScale),
    y: Math.floor(box.y * deviceScale),
    width: Math.ceil(box.w * deviceScale),
    height: Math.ceil(box.h * deviceScale),
  };
}

function pixelsDifferInRectangles(previous, current, width, rectangles) {
  if (!previous || previous.length !== current.length) return true;
  for (const rectangle of rectangles) {
    const right = Math.min(width, rectangle.x + rectangle.width);
    const bottom = Math.min(
      current.length / 4 / width,
      rectangle.y + rectangle.height,
    );
    for (let y = Math.max(0, rectangle.y); y < bottom; y++) {
      let offset = (y * width + Math.max(0, rectangle.x)) * 4;
      const end = (y * width + right) * 4;
      for (; offset < end; offset++) {
        if (previous[offset] !== current[offset]) return true;
      }
    }
  }
  return false;
}

class DOMRenderSurface {
  constructor(root, {
    viewportWidth = 1280,
    viewportHeight = 720,
    deviceScale = 1,
    viewport = null,
    now = () => performance.now(),
    requestFrame = requestHostAnimationFrame,
    cancelFrame = cancelHostAnimationFrame,
    renderPixels = renderScenePixels,
    usePersistentRenderer = renderPixels === renderScenePixels,
    layoutScene = layoutTreeBoxes,
    // The default persistent renderer shares this module realm's
    // scene-renderer runtime: one WASM engine, glyph manager, and WebGPU
    // device across every surface, with a per-surface renderer + render
    // context. Callers needing full isolation (fresh engine + device) pass
    // createPersistentSceneRenderer here explicitly.
    createPersistentRenderer = createSceneRendererForCurrentModule,
    initializePersistentRenderer = true,
    encodePixels = undefined,
    renderMode = undefined,
    renderPrecision = undefined,
    resolveResource = null,
    presentFrame = null,
    capturePaintArtifact = false,
    textSelection = true,
    graphicsBackend = "auto",
    glyphResourceManager = null,
    frameTransaction = null,
  } = {}) {
    root = resolveSurfaceRoot(root, "createRenderSurface");
    if (root.parentElement) {
      const documentElement = root.ownerDocument?.documentElement;
      if (!documentElement?.contains(root)) {
        throw new Error(
          "createRenderSurface: root must be a detached DOM tree root or belong to a document",
        );
      }
      root = documentElement;
    }
    this.viewport = viewport ?? new SandomViewport({
      width: viewportWidth,
      height: viewportHeight,
      deviceScale,
    });
    if (!(this.viewport instanceof SandomViewport) || this.viewport._surface) {
      throw new Error(
        "createRenderSurface: viewport must be an unattached SandomViewport",
      );
    }
    this.viewport._surface = this;
    this.viewport.root = root;
    const ownerDocument = root.ownerDocument;
    ownerDocument?._styleSystem?.setEnvironment({
      viewportWidth: this.viewport.width,
      viewportHeight: this.viewport.height,
    });
    if (ownerDocument?._reevaluateMediaQueryLists) {
      // Component documents keep single-valued window semantics
      // (window.innerWidth, requestAnimationFrame, visualViewport) bound to
      // ONE surface — the first live one. Additional surfaces coexist as
      // followers; shutdown promotes a remaining surface into this slot.
      ownerDocument._componentRenderSurface ??= this;
    }
    // Keyed surface registry: many live surfaces coexist over one root,
    // one per environment (width x height @ deviceScale) — mirroring
    // DocumentSession.layout()'s per-(root, environment) worlds. The first
    // surface to claim the node slots is the primary: it owns every node's
    // _renderSurface pointer (interaction targeting, layout getters, and
    // scrolling address exactly one surface). Followers receive mutation
    // fanout through the primary (_broadcastMutation and
    // _broadcastDisconnectSubtree below). Two surfaces at the SAME
    // (root, environment) never coexist: the second construction rejects
    // loudly; DocumentSession.render() serializes by shutting the existing
    // occupant down before creating a replacement.
    this._environmentKey =
      `${this.viewport.width}x${this.viewport.height}@${this.viewport.deviceScale}`;
    const surfaceRegistry = root._renderSurfaces ??= new Map();
    this._canonicalEnvironmentKey = this._environmentKey;
    if (frameTransaction) {
      this._environmentKey +=
        `#staged:${frameTransaction.id}:${frameTransaction.created.size}`;
    }
    if (surfaceRegistry.has(this._environmentKey)) {
      throw new Error(
        `createRenderSurface: root already has a live render surface for ` +
          `environment ${this._environmentKey}`,
      );
    }
    if (
      surfaceRegistry.size > 0 &&
      ownerDocument?._environmentObservations?.size > 0
    ) {
      throw new Error(
        `The document observed ${
          [...ownerDocument._environmentObservations].join(", ")
        }; one root cannot render under multiple environments.`,
      );
    }
    surfaceRegistry.set(this._environmentKey, this);
    this._now = now;
    this._requestFrame = requestFrame;
    this._cancelFrame = cancelFrame;
    this._renderPixels = renderPixels;
    this._usesDefaultRenderer = usePersistentRenderer;
    this._glyphResourceManager = glyphResourceManager;
    this._encodePixels = encodePixels === undefined
      ? ownerDocument._sandomSceneRendererRuntime?.codecRuntime?.encodePNG ??
        encodePNG
      : encodePixels;
    if (presentFrame !== null && typeof presentFrame !== "function") {
      throw new TypeError("presentFrame must be a function or null");
    }
    this._presentFrame = presentFrame;
    this._persistentRenderer = null;
    this._createPersistentRenderer = createPersistentRenderer;
    this._persistentRendererOptions = Object.freeze({
      graphicsBackend,
      ...(renderMode === undefined ? {} : { renderMode }),
      ...(renderPrecision === undefined ? {} : { renderPrecision }),
      ...(glyphResourceManager === null ? {} : { glyphResourceManager }),
    });
    this._animationEventUnsubscribe = null;
    this._persistentRendererPromise =
      this._usesDefaultRenderer && initializePersistentRenderer
        ? createPersistentRenderer({
          width: this.viewport.width,
          height: this.viewport.height,
          deviceScale: this.viewport.deviceScale,
          ...this._persistentRendererOptions,
        }).then((renderer) => {
          this._persistentRenderer = renderer;
          this._animationEventUnsubscribe = renderer.onAnimationEvent(
            (record) => {
              const element =
                (this._eventElementAtIndex ?? this._elementAtIndex)[
                  record.nodeIndex
                ];
              if (!element) {
                throw new RangeError(
                  `No DOM element for animated layout index ${record.nodeIndex}`,
                );
              }
              const matchingAnimation =
                this._animationCancelingThroughEngine?._animationId ===
                    record.animationId
                  ? this._animationCancelingThroughEngine
                  : this._animations.find((animation) =>
                    animation._animationId === record.animationId
                  );
              const transitionTiming = this._transitionTimings.get(element)
                ?.get(
                  record.propertyName,
                );
              const elapsedTime = matchingAnimation
                ? matchingAnimation._elapsedTimeForEvent(record.type)
                : record.type === "transitionend"
                ? (transitionTiming?.duration ?? 0) / 1000
                : Math.max(0, -(transitionTiming?.delay ?? 0)) / 1000;
              const feedback = matchingAnimation?._beginEngineLifecycle(record);
              if (matchingAnimation && !feedback) return;
              try {
                dispatchEvent(
                  element,
                  createEvent(record.type, {
                    bubbles: true,
                    propertyName: record.propertyName,
                    animationName: matchingAnimation?._cssAnimationName ?? "",
                    elapsedTime,
                    pseudoElement: "",
                  }),
                );
              } finally {
                if (feedback) {
                  matchingAnimation._completeEngineLifecycle(feedback);
                }
              }
              if (
                record.type === "transitionend" ||
                record.type === "transitioncancel"
              ) {
                const timings = this._transitionTimings.get(element);
                if (timings?.delete(record.propertyName)) {
                  const records = this._transitionRecords.get(element);
                  records?.delete(record.propertyName);
                  if (records?.size === 0) {
                    this._transitionRecords.delete(element);
                  }
                  if (this._activeTransitionCount > 0) {
                    this._activeTransitionCount--;
                  }
                }
              }
            },
          );
          return renderer;
        })
        : null;
    this._resolveResource = resolveResource;
    this._capturePaintArtifact = capturePaintArtifact;
    this._textSelectionEnabled = Boolean(textSelection);
    this._layoutTreeBoxes = (scene) => {
      this._stageCounters.layoutPasses++;
      // Over the tree this surface renders, under its own claim: the
      // engine relayouts only the rows whose records changed and keeps the
      // rows for the frame that follows (scene-renderer's syncLayoutWrite).
      const engineWriteOwner = this._persistentRenderer?.engineWriteToken ??
        null;
      return layoutScene(scene, {
        resolveResource: this._resolveResource,
        ...(engineWriteOwner === null ? {} : { engineWriteOwner }),
      });
    };
    // Permanent frame-stage counters (presented-frame refactor verification
    // contract): a scroll-only frame MUST NOT advance serializations or
    // layoutPasses. Live checks inspect these instead of trusting a small
    // dirty rectangle.
    this._stageCounters = {
      serializations: 0,
      layoutPasses: 0,
      scrollOnlyFrames: 0,
      retainedTransformFrames: 0,
      retainedCleanFrames: 0,
      retainedDeliveries: 0,
      deliveredFrames: 0,
      currentStage: "idle",
    };
    this._frameListeners = [];
    this._frameRequest = null;
    this._frameTransaction = frameTransaction;
    this._stagedFrame = null;
    this._frameSequence = 0;
    this._viewportRevision = 0n;
    this._eventElementAtIndex = null;
    this._dirty = true;
    this._rendering = false;
    this._running = true;
    this._idleWaiters = [];
    this._shutdown = false;
    this._lastPixels = null;
    this._lastDeliveredFrame = null;
    this._lastRendered = null;
    this._indexOfElement = new Map();
    this._elementAtIndex = [];
    this._lastBoxes = [];
    this._documentSelectionRects = [];
    this._presentedFrame = null;
    this._preparedState = null;
    this._syncLayout = null;
    // Style-generation checkpoints (frame-incrementality): the style system
    // bumps its generation on EVERY DOM mutation and on stylesheet, font,
    // and environment changes - the same key its per-element resolution
    // cache trusts. An unchanged generation therefore proves the CSS
    // animation-definition scan and the serialized scene are both current.
    // Canvas draws (canvas-paint/canvas-size) bypass the style system by
    // design; they invalidate through _mutatedNodes, never through these.
    this._animationSyncStyleGeneration = -1;
    this._serializedStyleGeneration = -1;
    // The serialized scene is viewport-shaped; a resize invalidates it even
    // when the style environment (width x height only) already caught it.
    this._serializedViewportWidth = -1;
    this._serializedViewportHeight = -1;
    this._serializedViewportScale = -1;
    // Observer delivery is owed only while an observation registered since
    // the last delivery pass awaits its initial entry. Every later
    // notification requires a geometry change, and a clean frame reuses
    // both the retained scene and the retained boxes, so its signature
    // diff is a proven no-op.
    this._pendingObserverDelivery = true;
    this._mutatedNodes = new Set();
    this._forcedGenerationNodes = new Set();
    this._selectionChanged = false;
    this._transformOnlyMutations = new Set();
    this._hasNonTransformMutation = false;
    this._scrollOwner = root._domCore.status("scroll_owner_create");
    root._domCore.status(
      "scroll_owner_bind",
      this._scrollOwner,
      root._coreHandle,
    );
    this._scrollAnchors = new NativeScrollCollection(this, 4);
    this._anchoringSuppressionProperties = new NativeScrollSuppression(this, 1);
    this._positionSuppressionNodes = new NativeScrollSuppression(this, 2);
    this._forceFullInvalidation = false;
    this._preservedScrollMetrics = null;
    // Visible-region rasterization (raster-scale plan, slice 3): the
    // CSS-px rectangle of the scene the raster target covers; null
    // covers the full scene.
    this._visibleRectangle = null;
    this._forceStateDelivery = false;
    this._currentTime = 0;
    this._activeTransitionCount = 0;
    this._transitionTimings = new WeakMap();
    this._transitionRecords = new Map();
    this._animations = [];
    // Animations this surface adopted from a document's pending timeline
    // (element.animate() before any surface existed). They hold until the
    // first frame gives them a time to start from.
    this._animationsAwaitingTimeline = new Set();
    this._animationCancelingThroughEngine = null;
    this._cssAnimations = new Map();
    this._pseudoContentAnimations = new Map();
    this._pendingScrollSources = new NativeScrollCollection(this, 0);
    this._pendingScrollEndTargets = new NativeScrollCollection(this, 1);
    this._capturingFrames = false;
    this._pendingSnapOrigins = new NativeScrollCollection(this, 2);
    this._snappedTargets = new NativeScrollCollection(this, 3);
    this._snapCheckPending = false;
    // A layout consequence owes a snap-container check; the frame that
    // renders it asks the core, which resolved every box element, and only
    // a tree with snap containers keeps a snap frame scheduled.
    this._snapCheckOwed = false;
    this._smoothScrolls = new NativeScrollMotions(this);
    this._scrollbars = [];
    this._pendingAnimationDeclarations = [];
    this._animationFrameCore = root._domCore;
    this._animationFrameOwner = this._animationFrameCore.status(
      "animation_frame_surface_create",
    );
    this._frameCore = root._domCore;
    this._frameOwner = this._frameCore.status(
      "frame_surface_create",
      root._coreHandle,
    );
    this._frameBindings = createFrameBindings(this._frameCore);
    this._animationFrameCallbacks = new Map();
    this._root = root;
    if (frameTransaction) {
      frameTransaction.created.add(this);
      frameTransaction.surfaces.add(this);
    }
    this._snapCheckOwed = true;
    if (root._renderSurfaces.size === 1) this._connectSubtree(root);
    this._schedule();
  }

  get root() {
    return this._root;
  }

  get currentTime() {
    return this._currentTime;
  }

  get indexOfElement() {
    return this._indexOfElement;
  }

  get elementAtIndex() {
    return this._elementAtIndex;
  }

  // The immutable presented-frame interaction snapshot for the last
  // DELIVERED frame (design/interaction.md).
  // Host input targeting and presented scroll-range reads consume this; it
  // is null until the first frame delivers.
  get presentedFrame() {
    return this._presentedFrame;
  }

  // Permanent frame-stage counters (Slice 2 verification contract). Frozen
  // copy: consumers inspect, never mutate.
  get frameStageCounters() {
    return Object.freeze({ ...this._stageCounters });
  }

  get scrollbars() {
    return this._scrollbars;
  }
  inspectScrolling(target = this.viewport) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (target !== this.viewport && target._renderSurface !== this) {
      throw new Error(
        "inspectScrolling: target is not connected to this render surface",
      );
    }
    const snapshot = this._presentedFrame;
    const node = target === this.viewport ? 0n : target._coreHandle;
    const fact = (field) =>
      snapshot?.geometryHandle
        ? this._root._domCore.status(
          "geometry_value",
          snapshot.geometryHandle,
          node,
          field,
        )
        : 0;
    const smoothMotion = this._smoothScrolls.get(target);
    const activeOwner = smoothMotion
      ? Object.freeze({ kind: "smooth", source: smoothMotion.source })
      : this._scrollMomentum && this._scrollMomentumTarget === target
      ? Object.freeze({ kind: "momentum", source: "pointer" })
      : this._scrollInteractionActive &&
          this._scrollInteractionTarget === target
      ? Object.freeze({ kind: "interaction", source: "pointer" })
      : this._pendingScrollSources.has(target)
      ? Object.freeze({
        kind: "request",
        source: this._pendingScrollSources.get(target),
      })
      : null;
    return Object.freeze({
      requestedLeft: target === this.viewport
        ? target._requestedLeft
        : target._requestedScrollLeft,
      requestedTop: target === this.viewport
        ? target._requestedTop
        : target._requestedScrollTop,
      effectiveLeft: target === this.viewport
        ? target.scrollX
        : target.scrollLeft,
      effectiveTop: target === this.viewport
        ? target.scrollY
        : target.scrollTop,
      minimumLeft: fact(16),
      maximumLeft: fact(17),
      minimumTop: fact(18),
      maximumTop: fact(19),
      scrollWidth: fact(10),
      scrollHeight: fact(11),
      activeOwner,
      pendingScroll: this._pendingScrollSources.has(target),
      pendingScrollEnd: this._pendingScrollEndTargets.has(target),
    });
  }

  onFrame(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("onFrame callback must be a function");
    }
    if (this._shutdown) throw new Error("render surface is shut down");
    this._frameListeners.push(callback);
    return () => {
      const index = this._frameListeners.indexOf(callback);
      if (index !== -1) this._frameListeners.splice(index, 1);
    };
  }
  _connectSubtree(node) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (node._renderSurface && node._renderSurface !== this) {
      throw new Error("node belongs to another live render surface");
    }
    node._renderSurface = this;
    this._adoptPendingAnimations(node);
    for (const child of node.childNodes) this._connectSubtree(child);
    if (node._shadowRoot) this._connectSubtree(node._shadowRoot);
  }
  // The animations `node` collected while it had no surface become this
  // surface's, in creation order, the moment it claims the node. Their start
  // times are still unresolved: this surface's timeline has no time until it
  // renders, and _render resolves them on its next frame.
  _adoptPendingAnimations(node) {
    const pending = takePendingAnimations(node);
    if (pending === null) return;
    for (const animation of pending) {
      animation._surface = this;
      this._animations.push(animation);
      this._animationsAwaitingTimeline.add(animation);
    }
    this._scheduleAnimationFrame(node);
  }
  _disconnectSubtree(node) {
    if (node._renderSurface !== this) return;
    this._forgetNodeState(node);
    if (node._scrollState) {
      node._domCore.status("scroll_detach", node._scrollState);
    }
    node._renderSurface = null;
    for (const child of node.childNodes) this._disconnectSubtree(child);
    if (node._shadowRoot) this._disconnectSubtree(node._shadowRoot);
  }
  // Per-surface bookkeeping cleanup for one removed node — shared between
  // the primary's slot-releasing disconnect above and the follower fanout
  // below, which must never touch the primary's _renderSurface slots.
  _forgetNodeState(node) {
    this._mutatedNodes.delete(node);
    this._forcedGenerationNodes.delete(node);
    this._scrollAnchors.delete(node);
    for (const [container, state] of this._scrollAnchors) {
      if (state.element === node) this._scrollAnchors.delete(container);
    }
    this._anchoringSuppressionProperties.delete(node);
    this._positionSuppressionNodes.delete(node);
    this._pendingScrollSources.delete(node);
    this._pendingScrollEndTargets.delete(node);
    this._pendingSnapOrigins.delete(node);
    this._smoothScrolls.delete(node);
    this._snappedTargets.delete(node);
    for (const [container, targets] of this._snappedTargets) {
      if (targets.horizontal === node || targets.vertical === node) {
        this._snappedTargets.delete(container);
      }
    }
  }
  _forgetSubtreeState(node) {
    this._forgetNodeState(node);
    for (const child of node.childNodes) this._forgetSubtreeState(child);
    if (node._shadowRoot) this._forgetSubtreeState(node._shadowRoot);
  }
  // Mutation fanout: the DOM layer holds one _renderSurface pointer per
  // node (the primary); these broadcasts deliver the notification to every
  // live surface registered over the same root.
  _broadcastMutation(kind, node, detail) {
    const registry = this._root._renderSurfaces;
    if (!registry || registry.size <= 1) {
      this._recordMutation(kind, node, detail);
      return;
    }
    for (const surface of registry.values()) {
      surface._recordMutation(kind, node, detail);
    }
  }
  _broadcastDisconnectSubtree(node) {
    const registry = this._root._renderSurfaces;
    if (registry && registry.size > 1) {
      for (const surface of registry.values()) {
        if (surface !== this) surface._forgetSubtreeState(node);
      }
    }
    this._disconnectSubtree(node);
  }
  _broadcastReplaceAnimationBase(element, propertyName, target) {
    const registry = this._root._renderSurfaces;
    if (!registry || registry.size <= 1) {
      this._replaceAnimationBase(element, propertyName, target);
      return;
    }
    for (const surface of registry.values()) {
      surface._replaceAnimationBase(element, propertyName, target);
    }
  }
  get _mutationConsequence() {
    return this._frameCore.status(
      "frame_surface_consequence",
      this._frameOwner,
    );
  }

  _frameFlags(rasterize, deliverObservers, pixelReadback) {
    const document = this._root.ownerDocument;
    const style = document?._styleSystem;
    return (this._usesDefaultRenderer ? 1 : 0) |
      (this._preparedState !== null && this._presentedFrame !== null ? 2 : 0) |
      (this._pendingScrollSources.size > 0 ? 4 : 0) |
      (this._animations.length + this._cssAnimations.size +
            this._pseudoContentAnimations.size + this._activeTransitionCount +
            this._pendingAnimationDeclarations.length > 0
        ? 8
        : 0) |
      // An animation sample the retained scene cannot carry, and only that,
      // owes a re-serialization. Every declared animation and transition is
      // an engine track sampled natively from the retained rows, so a frame
      // whose only change is such a sample reuses the scene; animated
      // generated content is authored INTO the serialized rows here
      // (_animatedGeneratedContent), and an unbound declaration still needs
      // a scene to take its node index from.
      (this._pseudoContentAnimations.size > 0 ||
          this._pendingAnimationDeclarations.length > 0
        ? 131072
        : 0) |
      (documentHasRenderingObservers(document) ? 16 : 0) |
      (this._pendingObserverDelivery ? 32 : 0) |
      (this._forceFullInvalidation ? 64 : 0) |
      (style !== undefined &&
          this._serializedStyleGeneration === style.generation &&
          this._serializedViewportWidth === this.viewport.width &&
          this._serializedViewportHeight === this.viewport.height &&
          this._serializedViewportScale === this.viewport.deviceScale
        ? 128
        : 0) |
      (rasterize ? 256 : 0) |
      (pixelReadback && this._presentFrame !== null &&
          this._persistentRenderer?.graphicsBackend !== "webgl2"
        ? 512
        : 0) |
      (this._scrollAnchors.size > 0 ? 2048 : 0) |
      (this._animations.some((animation) => animation._isScrollDriven())
        ? 4096
        : 0) |
      (deliverObservers ? 8192 : 0) |
      (this._lastBoxes.length > 0 ? 16384 : 0) |
      (this._lastPixels !== null ||
          (this._presentFrame !== null && this._frameSequence > 0)
        ? 65536
        : 0);
  }

  _frameClaim(frame, expected, bindings = this._frameBindings) {
    const action = bindings.frame_next(frame);
    if (action !== expected) {
      throw new Error(
        `Frame executor expected ${expected}, received ${action}`,
      );
    }
    return bindings.frame_token(frame);
  }

  _frameResume(
    frame,
    token,
    facts = 0,
    depth = -1,
    bindings = this._frameBindings,
  ) {
    return bindings.frame_resume(frame, token, 0, facts, depth);
  }

  _recordMutation(kind, node, detail) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (node && kind !== "selection") this._mutatedNodes.add(node);
    if (kind === "style" && detail === "transform" && node) {
      this._transformOnlyMutations.add(node);
    } else {
      this._hasNonTransformMutation = true;
    }
    if (kind === "selection") this._selectionChanged = true;
    // Native records classify DOM fields before callback delivery. Only
    // host-owned bitmap and interaction changes enter as normalized facts.
    if (kind === "state" || kind === "selection" || kind === "canvas-paint") {
      this._frameCore.status("frame_surface_invalidate", this._frameOwner, 1);
    } else if (kind === "canvas-size") {
      this._frameCore.status("frame_surface_invalidate", this._frameOwner, 2);
    }
    const consequence = this._mutationConsequence;
    if (consequence === 3) this._forceFullInvalidation = true;
    if (kind === "style") {
      node._domCore.status(
        "scroll_suppress",
        this._scrollOwner,
        node._coreHandle,
        ...node._domCore.input(detail),
      );
    }
    // Frame listeners observe interaction state as well as pixels. Preserve
    // a state-only checkpoint even when focus does not change the raster.
    if (kind === "state") this._forceStateDelivery = true;
    if (kind === "canvas-paint" || kind === "canvas-size") {
      this._forcedGenerationNodes.add(node);
    }
    this._dirty = true;
    // A paint-only mutation cannot move boxes, so it cannot owe a snap
    // re-check; a layout or structural consequence owes one, which the
    // frame answers from the core's snap-container list.
    if (consequence >= 2) {
      this._preservedScrollMetrics = null;
      this._snapCheckOwed = true;
    }
    this._schedule();
  }

  _advanceSmoothScrolls(timeMilliseconds) {
    if (
      this._root._domCore.status(
        "scroll_step",
        this._scrollOwner,
        timeMilliseconds,
      )
    ) {
      this._dirty = true;
    }
  }

  _captureScrollRequests() {
    return new NativeScrollCapture(this);
  }

  _acceptScrollFeedback(serialized, effectiveBoxes, requestGenerations) {
    const changed = [];
    for (const [target, { generation }] of requestGenerations) {
      const index = target === this.viewport
        ? serialized.viewportIndex
        : serialized.indexOf.get(target);
      const box = index == null ? null : effectiveBoxes[index];
      if (!box) continue;
      if (
        scrollCore(target).status(
          "scroll_accept",
          scrollState(target),
          generation,
          box.scrollLeft,
          box.scrollTop,
        )
      ) changed.push(target);
      if (!scrollRead(target, 5)) this._pendingScrollSources.delete(target);
    }
    return changed;
  }

  _requestElementScroll(element, left, top, source, behavior = "instant") {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (!scrollRequest(element, left, top, behavior, source)) return;
    this._snapCheckPending = true;
    this._dirty = true;
    this._schedule();
  }

  _requestViewportScroll(left, top, source, behavior = "auto") {
    this._requestElementScroll(this.viewport, left, top, source, behavior);
  }

  _scrollViewport(left, top, source) {
    this._requestViewportScroll(left, top, source, "instant");
  }

  _requestDocumentAnimationFrame(callback, onDiscard = null) {
    if (this._shutdown) throw new Error("render surface is shut down");
    const identifier = this._animationFrameCore.status(
      "animation_frame_request",
      this._animationFrameOwner,
    );
    this._animationFrameCallbacks.set(identifier, { callback, onDiscard });
    this._schedule();
    return identifier;
  }

  _cancelDocumentAnimationFrame(identifier) {
    if (this._shutdown) return;
    if (
      this._animationFrameCore.status(
        "animation_frame_cancel",
        this._animationFrameOwner,
        identifier,
      )
    ) {
      const record = this._animationFrameCallbacks.get(identifier);
      this._animationFrameCallbacks.delete(identifier);
      record.onDiscard?.();
    }
  }

  _releaseDocumentAnimationFrameCheckpoint(checkpoint) {
    const core = this._animationFrameCore;
    const owner = this._animationFrameOwner;
    for (;;) {
      const identifier = core.status(
        "animation_frame_checkpoint_abort_next",
        owner,
        checkpoint,
      );
      if (!identifier) break;
      const record = this._animationFrameCallbacks.get(identifier);
      this._animationFrameCallbacks.delete(identifier);
      record?.onDiscard?.();
    }
    core.status("animation_frame_checkpoint_release", owner, checkpoint);
  }

  _runDocumentAnimationFrameCheckpoint(timeMilliseconds) {
    const core = this._animationFrameCore;
    const owner = this._animationFrameOwner;
    const checkpoint = core.status("animation_frame_checkpoint_begin", owner);
    if (!checkpoint) return;
    try {
      for (;;) {
        const token = core.status(
          "animation_frame_checkpoint_next",
          owner,
          checkpoint,
        );
        if (!token) break;
        const identifier = core.status(
          "animation_frame_checkpoint_callback",
          owner,
          checkpoint,
          token,
        );
        const callback = this._animationFrameCallbacks.get(identifier).callback;
        this._animationFrameCallbacks.delete(identifier);
        try {
          callback(timeMilliseconds);
        } catch (error) {
          this._reportBackgroundException(error);
        } finally {
          core.status(
            "animation_frame_checkpoint_complete",
            owner,
            checkpoint,
            token,
          );
        }
      }
    } finally {
      this._releaseDocumentAnimationFrameCheckpoint(checkpoint);
    }
  }

  _recordViewportResize(previousEnvironment = null) {
    if (this._shutdown) throw new Error("render surface is shut down");
    this._viewportRevision++;
    this._frameCore.status("frame_surface_invalidate", this._frameOwner, 2);
    const registry = this._root._renderSurfaces;
    const nextEnvironmentKey =
      `${this.viewport.width}x${this.viewport.height}@${this.viewport.deviceScale}`;
    if (nextEnvironmentKey !== this._environmentKey) {
      const occupying = registry?.get(nextEnvironmentKey);
      if (occupying && occupying !== this) {
        throw new Error(
          `viewport resize: root already has a live render surface for ` +
            `environment ${nextEnvironmentKey}`,
        );
      }
      registry?.delete(this._environmentKey);
      registry?.set(nextEnvironmentKey, this);
      this._environmentKey = nextEnvironmentKey;
    }
    const densityOnlyResize = previousEnvironment !== null &&
      previousEnvironment.width === this.viewport.width &&
      previousEnvironment.height === this.viewport.height &&
      previousEnvironment.deviceScale !== this.viewport.deviceScale;
    if (
      densityOnlyResize &&
      this._preservedScrollMetrics === null &&
      this._lastBoxes.length > 0
    ) {
      this._preservedScrollMetrics = this._lastBoxes.map((box) => ({
        scrollWidth: box.scrollWidth,
        scrollHeight: box.scrollHeight,
      }));
      for (const scrollbar of this._scrollbars) {
        const index = scrollbar.element === this.viewport
          ? 0
          : this._indexOfElement.get(scrollbar.element);
        if (index === undefined || index === null) continue;
        const metrics = this._preservedScrollMetrics[index];
        if (!metrics) continue;
        if (scrollbar.orientation === "vertical") {
          metrics.scrollHeight = scrollbar.scrollLength;
        } else {
          metrics.scrollWidth = scrollbar.scrollLength;
        }
      }
      this._lastBoxes = this._lastBoxes.map((box, index) => ({
        ...box,
        ...this._preservedScrollMetrics[index],
      }));
    } else if (!densityOnlyResize) {
      this._preservedScrollMetrics = null;
    }
    const ownerDocument = this._root.ownerDocument;
    ownerDocument?._styleSystem?.setEnvironment({
      viewportWidth: this.viewport.width,
      viewportHeight: this.viewport.height,
    });
    ownerDocument?._reevaluateMediaQueryLists?.();
    this._forceFullInvalidation = true;
    this._pendingScrollSources.set(this.viewport, "resize");
    this._dirty = true;
    this._schedule();
  }

  /** Selects the CSS-px rectangle of the scene the raster target
   * covers, or the full scene with null. Raster-only: layout and the
   * display list are unaffected; the next frame re-rasters the region.
   */
  setVisibleRectangle(rectangle) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (rectangle !== null) {
      const { x, y, width, height } = rectangle;
      if (
        !(width > 0) || !(height > 0) || !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        throw new RangeError(
          "visibleRectangle requires finite x/y and positive width/height",
        );
      }
    }
    const previous = this._visibleRectangle;
    if (
      previous === rectangle ||
      (previous !== null && rectangle !== null &&
        previous.x === rectangle.x && previous.y === rectangle.y &&
        previous.width === rectangle.width &&
        previous.height === rectangle.height)
    ) return;
    this._visibleRectangle = rectangle === null ? null : {
      x: Number(rectangle.x),
      y: Number(rectangle.y),
      width: Number(rectangle.width),
      height: Number(rectangle.height),
    };
    this._forceFullInvalidation = true;
    this._dirty = true;
    this._schedule();
  }

  get _scrollMomentum() {
    return !!this._scrollOwner &&
      !!this._root._domCore.status("scroll_momentum_active", this._scrollOwner);
  }

  get _scrollMomentumTarget() {
    if (!this._scrollMomentum) return null;
    const node = this._root._domCore.status(
      "scroll_motion_target",
      this._scrollOwner,
      0,
    );
    return node ? this._root._domCore.wrapperFor(node) : this.viewport;
  }

  get _scrollInteractionActive() {
    return !!this._scrollOwner &&
      !!this._root._domCore.status(
        "scroll_interaction_active",
        this._scrollOwner,
      );
  }

  get _scrollInteractionTarget() {
    if (!this._scrollInteractionActive) return null;
    const node = this._root._domCore.status(
      "scroll_motion_target",
      this._scrollOwner,
      1,
    );
    return node ? this._root._domCore.wrapperFor(node) : this.viewport;
  }

  _beginScrollInteraction(target) {
    this._root._domCore.status(
      "scroll_interaction",
      this._scrollOwner,
      target._coreHandle ?? 0n,
      1,
    );
  }

  _endScrollInteraction() {
    this._root._domCore.status("scroll_interaction", this._scrollOwner, 0n, 0);
    this._schedule();
  }

  _startScrollMomentum(target, velocityX, velocityY, timeMilliseconds) {
    const core = this._root._domCore;
    core.status(
      "scroll_presented",
      this._scrollOwner,
      this._presentedFrame?.geometryHandle ?? 0n,
    );
    const active = !!core.status(
      "scroll_momentum",
      this._scrollOwner,
      target._coreHandle ?? 0n,
      velocityX,
      velocityY,
      timeMilliseconds,
    );
    this._dirty ||= active;
    this._schedule();
  }

  _interruptScrolling() {
    this._smoothScrolls.clear();
  }

  _applyScrollAnchoring(serialized, boxes, capturedScrollRequests) {
    if (!this._scrollAnchors.size || !boxes.length) return false;
    return withScrollGeometry(
      this._root,
      this.viewport,
      boxes,
      serialized,
      (core, snapshot) => {
        const changed = !!core.status(
          "scroll_anchor_apply",
          this._scrollOwner,
          snapshot,
          capturedScrollRequests.handle,
        );
        if (!changed) return false;
        for (const [target, request] of capturedScrollRequests) {
          const index = target === this.viewport
            ? serialized.viewportIndex
            : serialized.indexOf.get(target);
          if (index == null) continue;
          serialized.nodes[index].scrollLeft = request.left;
          serialized.nodes[index].scrollTop = request.top;
          if (target !== this.viewport) this._mutatedNodes.add(target);
        }
        return true;
      },
    );
  }

  _refreshScrollAnchors(serialized, boxes, geometryHandle) {
    const core = this._root._domCore;
    const focused = this._root._activeElement;
    const focusedHandle =
      focused && (focused.tag === "input" || focused.tag === "textarea")
        ? focused._coreHandle
        : 0n;
    if (geometryHandle) {
      core.status(
        "scroll_anchor_refresh",
        this._scrollOwner,
        geometryHandle,
        this._root._coreHandle,
        focusedHandle,
      );
      return;
    }
    withScrollGeometry(
      this._root,
      this.viewport,
      boxes,
      serialized,
      (geometryCore, snapshot) =>
        geometryCore.status(
          "scroll_anchor_refresh",
          this._scrollOwner,
          snapshot,
          this._root._coreHandle,
          focusedHandle,
        ),
    );
  }

  // The elements of the rendered tree whose stored scroll-snap-type is not
  // none: the core's list over the records the last build resolved.
  _snapContainers() {
    const containers = [];
    for (
      const element of this._root._domCore.snapContainers(
        this._root._coreHandle,
      )
    ) {
      if (this._indexOfElement.has(element)) containers.push(element);
    }
    return containers;
  }

  _applyScrollSnapping() {
    if (
      this._scrollInteractionActive || this._scrollMomentum ||
      !this._presentedFrame?.geometryHandle
    ) return false;
    const changed = !!this._root._domCore.status(
      "scroll_snap_apply",
      this._scrollOwner,
      this._presentedFrame.geometryHandle,
      this._root._coreHandle,
      this._snapCheckPending ? 1 : 0,
      0,
    );
    this._snapCheckPending = false;
    if (changed) {
      this._dirty = true;
      this._schedule();
    }
    return changed;
  }

  _beginFrameTransaction(transaction) {
    if (this._frameTransaction && this._frameTransaction !== transaction) {
      throw new Error("Render surface already belongs to a frame transaction");
    }
    this._frameTransaction = transaction;
    transaction.surfaces.add(this);
  }

  get _candidatePresentedFrame() {
    return this._stagedFrame?.snapshot ?? this._presentedFrame;
  }

  _flushScrollEndEvents() {
    const core = this._root._domCore;
    const checkpoint = core.status("scroll_end_begin", this._scrollOwner);
    if (!checkpoint) return;
    try {
      for (;;) {
        const token = core.status("scroll_end_next", checkpoint);
        if (!token) break;
        const node = core.status("scroll_end_target", checkpoint, token);
        try {
          dispatchEvent(
            node ? core.wrapperFor(node) : this.viewport,
            createEvent("scrollend"),
          );
        } finally {
          core.status("scroll_end_ack", checkpoint, token);
        }
      }
    } finally {
      core.status("scroll_end_release", checkpoint);
    }
  }

  _schedule() {
    if (
      this._frameTransaction ||
      !this._running || this._shutdown || this._rendering ||
      (!this._animationFrameCore.status(
        "animation_frame_pending",
        this._animationFrameOwner,
      ) &&
        !this._dirty &&
        ((this._pendingScrollEndTargets.size === 0 &&
          !this._snapCheckPending) ||
          this._scrollInteractionActive)) ||
      this._frameRequest !== null
    ) return;
    this._frameRequest = this._requestFrame((timeMilliseconds) => {
      this._frameRequest = null;
      const frameTimeMilliseconds = timeMilliseconds ?? this._now();
      // Native snapshots detach before invoking. Exceptions still reach the
      // realm sink without preventing the remaining callbacks or the render.
      this._runDocumentAnimationFrameCheckpoint(frameTimeMilliseconds);
      if (!this._dirty) {
        if (this._applyScrollSnapping()) return null;
        this._flushScrollEndEvents();
        return null;
      }
      const forceStateDelivery = this._forceStateDelivery;
      this._forceStateDelivery = false;
      // Nothing awaits a loop-scheduled render (the host animation frame
      // discards this return value), so a rejection here is otherwise an
      // unobserved promise rejection: a crash in Deno, silence in a
      // browser worker. Route it to the exception sink.
      return this._renderOpportunity(
        frameTimeMilliseconds,
        forceStateDelivery,
      ).catch((error) => this._reportBackgroundException(error));
    });
  }

  // Background exceptions (animation-frame callbacks, loop-scheduled
  // renders) have no awaiting caller. A component session installs a
  // sink on its document and fails loudly through the session API; any
  // other host falls back to the realm's reportError so the error
  // surfaces instead of vanishing.
  _reportBackgroundException(error) {
    const ownerDocument = this._root.ownerDocument;
    const report = ownerDocument?._reportException;
    if (report) {
      report(error);
      return;
    }
    if (typeof globalThis.reportError === "function") {
      globalThis.reportError(error);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  }

  _scheduleObserverFrame() {
    this._pendingObserverDelivery = true;
    this._dirty = true;
    this._schedule();
  }

  // The presented frame is reusable verbatim when the scene is retained
  // (frame mode 3: the serialization inputs and the viewport are unchanged,
  // no pending scroll, no forced invalidation) AND nothing the scene reuse
  // does not already cover changed: no host-state/selection/canvas
  // consequence, no mutated or forced-generation node, no animation or
  // transition sampling this frame, the same resources, the same capture
  // requirements, and a retained raster result to re-deliver. A pixel
  // capture and a staged transaction always render.
  _retainedDeliveryPossible(
    cleanSceneReuse,
    pixelReadback,
    sourceRevisions,
    mutatedNodes,
    forcedGenerationNodes,
    capturedScrollRequests,
    continuation,
  ) {
    const rendered = this._lastRendered;
    const presented = this._presentedFrame;
    return cleanSceneReuse && !pixelReadback &&
      this._frameTransaction === null &&
      rendered !== null && presented !== null &&
      this._lastDeliveredFrame !== null &&
      this._frameCore.status("frame_consequence", continuation) === 0 &&
      mutatedNodes.size === 0 && forcedGenerationNodes.size === 0 &&
      capturedScrollRequests.size === 0 &&
      !this._hasActiveAnimationWork() && !this._scrollMomentum &&
      !rendered.animationActive &&
      this._pendingAnimationDeclarations.length === 0 &&
      this._frameCore.status(
          "geometry_revision",
          presented.geometryHandle,
          2,
        ) === sourceRevisions.resource &&
      (rendered.paintArtifact !== undefined ||
          rendered.textGeometryArtifact !== undefined) ===
        (this._capturePaintArtifact ||
          (this._textSelectionEnabled &&
            this._preparedState.serialized.textBoxes > 0)) &&
      (rendered.pixels !== undefined) ===
        (this._presentFrame === null ||
          this._persistentRenderer?.graphicsBackend === "webgl2");
  }

  _notifyFrameListeners(frame, resizeObserverLoopError) {
    const errors = [];
    for (const listener of [...this._frameListeners]) {
      try {
        listener(frame);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} render-surface frame listener(s) threw`,
      );
    }
    if (resizeObserverLoopError) {
      throw new Error(
        "ResizeObserver loop completed with undelivered notifications",
      );
    }
  }

  _hasActiveAnimationWork() {
    if (this._shutdown) return false;
    const pseudoContentIsActive = [...this._pseudoContentAnimations.values()]
      .some((pseudoElements) =>
        [...pseudoElements.values()].some((records) =>
          records.some((record) => {
            if (record.definition.paused) return false;
            const { duration, delay = 0, iterations = 1 } =
              record.definition.timing;
            const endTimeMilliseconds = record.startTimeMilliseconds + delay +
              duration * iterations;
            return !Number.isFinite(endTimeMilliseconds) ||
              this._currentTime < endTimeMilliseconds;
          })
        )
      );
    return this._smoothScrolls.size > 0 ||
      this._activeTransitionCount > 0 ||
      pseudoContentIsActive ||
      this._animations.some((animation) => animation._needsFrame());
  }

  _renderOpportunity(
    timeMilliseconds,
    forceDelivery,
    snapshotPixels = true,
    pixelReadback = false,
    transaction = null,
  ) {
    if (this._frameTransaction && this._frameTransaction !== transaction) {
      return Promise.resolve(this._lastDeliveredFrame);
    }
    this._currentTime = timeMilliseconds;
    this._advanceSmoothScrolls(timeMilliseconds);
    if (this._hasActiveAnimationWork()) {
      this._dirty = true;
      for (const animation of this._animations) {
        if (animation._needsFrame()) this._mutatedNodes.add(animation._element);
      }
      for (const [element] of this._transitionRecords) {
        this._mutatedNodes.add(element);
      }
      if (this._pseudoContentAnimations.size > 0) {
        this._forceFullInvalidation = true;
      }
    }
    return this._render(
      timeMilliseconds,
      forceDelivery,
      snapshotPixels,
      true,
      true,
      pixelReadback,
    );
  }

  _createAnimation(
    element,
    keyframes,
    options,
    {
      insertionIndex = this._animations.length,
      beforeEngineHandles = [],
      preserveReplacedTracks = false,
      diagnosticAnimationName = null,
    } = {},
  ) {
    if (this._shutdown) throw new Error("render surface is shut down");
    const animation = createDOMAnimation(this, element, keyframes, options, {
      beforeEngineHandles,
      preserveReplacedTracks,
      diagnosticAnimationName,
    });
    this._animations.splice(insertionIndex, 0, animation);
    this._scheduleAnimationFrame(element);
    return animation;
  }

  _declareAnimation(
    element,
    keyframes,
    timing,
    {
      beforeEngineHandles = [],
      preserveReplacedTracks = false,
      diagnosticAnimationName = null,
      animationId,
      trackGeneration,
    } = {},
  ) {
    const nodeIndex = this._indexOfElement.get(element);
    const declarationOptions = {
      beforeTrackIndices: beforeEngineHandles.flatMap((handle) =>
        handle.trackIndices
      ),
      preserveReplacedTracks,
      animationId,
      trackGeneration,
    };
    const declareEngineAnimation = (renderer, animationNodeIndex) => {
      try {
        return renderer.animate(
          animationNodeIndex,
          keyframes,
          timing,
          declarationOptions,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (diagnosticAnimationName === null) throw error;
        throw new TypeError(
          `CSS animation "${diagnosticAnimationName}" declaration failed: ${error.message}`,
          { cause: error },
        );
      }
    };
    if (this._persistentRenderer && nodeIndex !== undefined) {
      return declareEngineAnimation(this._persistentRenderer, nodeIndex);
    }
    const deferred = deferAnimationBinding(declareEngineAnimation);
    this._pendingAnimationDeclarations.push({
      element,
      bind: deferred.bind,
      release: deferred.release,
    });
    return deferred.handle;
  }
  _replaceAnimationBase(element, propertyName, target) {
    const nodeIndex = this._indexOfElement.get(element);
    if (!this._persistentRenderer || nodeIndex === undefined) return false;
    return this._persistentRenderer.replaceAnimationBase(
      nodeIndex,
      propertyName,
      target,
    );
  }

  _animationsForElement(element, subtree) {
    return animationsForElement(this._animations, element, subtree);
  }

  _removeAnimation(animation) {
    const index = this._animations.indexOf(animation);
    if (index >= 0) this._animations.splice(index, 1);
    this._animationsAwaitingTimeline.delete(animation);
  }

  _restoreAnimation(animation) {
    if (!this._animations.includes(animation)) this._animations.push(animation);
  }

  // The current text of every animated ::before/::after, for the core's
  // scene build: an entry per element and pseudo-element whose content
  // animation has a record.
  // A synchronous layout getter's serialization, offered by
  // computeLayoutBoxes (src/dom/layout-getters.js): the next frame under
  // the same style generation, resource revision and viewport takes it
  // instead of serializing again. One is held at a time; a newer offer
  // or a mismatch releases it.
  _offerSyncLayout(layout, styleGeneration, resourceRevision) {
    if (this._shutdown || this._pseudoContentAnimations.size > 0) return false;
    const held = this._syncLayout;
    if (held !== null) {
      // Under the same generation the held one already describes this
      // tree, so the new one is dropped. Under a new generation the held
      // one is stale and the new one takes its place: its lowered rows are
      // relative to the held publication rather than the frame's last, so
      // the renderer's provenance check sends that frame to a full row
      // write, but the frame still skips serializing and laying out again.
      if (
        held.styleGeneration === styleGeneration &&
        held.resourceRevision === resourceRevision
      ) return false;
      this._releaseSyncLayout();
    }
    this._syncLayout = { layout, styleGeneration, resourceRevision };
    return true;
  }
  _takeSyncLayout(styleGeneration, viewport, resourceRevision) {
    const held = this._syncLayout;
    if (held === null) return null;
    this._syncLayout = null;
    const { layout } = held;
    if (
      held.styleGeneration === styleGeneration &&
      held.resourceRevision === resourceRevision &&
      layout.viewport.width === viewport.width &&
      layout.viewport.height === viewport.height &&
      (layout.viewport.deviceScale ?? 1) === (viewport.deviceScale ?? 1)
    ) {
      return layout;
    }
    this._releaseSyncLayoutState(layout);
    return null;
  }
  _releaseSyncLayout() {
    const held = this._syncLayout;
    if (held === null) return;
    this._syncLayout = null;
    this._releaseSyncLayoutState(held.layout);
  }
  _releaseSyncLayoutState(layout) {
    layout.serialized.release();
    this._root._domCore.releaseSceneResources(layout.serialized.nodes);
    releaseBoxSnapshot(layout.boxes);
  }
  _animatedGeneratedContent(timeMilliseconds) {
    if (this._pseudoContentAnimations.size === 0) return null;
    const overrides = [];
    for (const [element, pseudoElements] of this._pseudoContentAnimations) {
      for (const [pseudoElement, records] of pseudoElements) {
        if (!records?.length) continue;
        const text = pseudoContentAt(records.at(-1), timeMilliseconds);
        if (text === undefined) continue;
        overrides.push({ element, pseudoElement, text });
      }
    }
    return overrides;
  }

  // An animation's own state change (declaration, seek, play, pause, cancel,
  // finish) re-samples exactly one element. The retained scene carries the
  // engine's tracks, not their samples, so the element must enter the
  // mutation set: it is what damages its rect and what refreshes its row's
  // generation so the engine re-emits it. A running animation's per-frame
  // progression enters the same set through _renderOpportunity.
  _scheduleAnimationFrame(element = null) {
    if (element) this._mutatedNodes.add(element);
    this._dirty = true;
    this._schedule();
  }

  async _render(
    timeMilliseconds,
    forceDelivery,
    snapshotPixels = true,
    rasterize = true,
    deliverObservers = true,
    pixelReadback = false,
    continuation = null,
  ) {
    if (this._shutdown) return null;
    if (this._stagedFrame) return this._stagedFrame.frame;
    if (this._rendering) {
      this._dirty = true;
      return null;
    }
    if (!this._dirty && !forceDelivery) return null;
    this._rendering = true;
    this._dirty = false;
    this._currentTime = timeMilliseconds;
    // An adopted animation's timeline had no time until now. This frame's
    // time is its first, so it starts here and samples from its first
    // keyframe instead of from a clock it never saw.
    if (this._animationsAwaitingTimeline.size > 0) {
      const awaiting = [...this._animationsAwaitingTimeline];
      this._animationsAwaitingTimeline.clear();
      for (const animation of awaiting) animation._resolveTimeline();
    }
    this._stageCounters.currentStage = "prepare";
    let resizeObserverLoopError = false;
    const renderStartedAt = renderSurfaceNow();
    let rasterStartedAt = null;
    let rendererReadyAt = null;
    let rendererResizedAt = null;
    let visibleRectangleSetAt = null;
    let rasterFinishedAt = null;
    let pendingPresentation = null;
    const ownsContinuation = continuation === null;
    const core = this._frameCore;
    const frameOwner = this._frameOwner;
    const frameBindings = this._frameBindings;
    continuation ??= core.status(
      "frame_begin",
      frameOwner,
      timeMilliseconds,
      this._frameFlags(rasterize, deliverObservers, pixelReadback),
      BigInt(this._root.ownerDocument?._styleSystem?.generation ?? 0),
      BigInt(core.status("resource_revision")),
      this._viewportRevision,
    );
    let accepted = false;
    let frameMutatedNodes = null;
    let frameForcedGenerationNodes = null;
    let capturedScrollRequests = null;
    let releaseUnpublishedSuccessor = null;
    const previousPublication = {
      presentedFrame: this._presentedFrame,
      preparedState: this._preparedState,
      lastBoxes: this._lastBoxes,
      lastPixels: this._lastPixels,
      indexOfElement: this._indexOfElement,
      elementAtIndex: this._elementAtIndex,
      scrollbars: this._scrollbars,
      documentSelectionRects: this._documentSelectionRects,
    };
    const rollback = () => {
      core.status("frame_abort", continuation);
      if (this._frameCore !== core || this._frameOwner !== frameOwner) return;
      if (frameMutatedNodes) {
        for (const node of frameMutatedNodes) this._mutatedNodes.add(node);
        for (const node of frameForcedGenerationNodes) {
          this._forcedGenerationNodes.add(node);
        }
      }
      this._presentedFrame = previousPublication.presentedFrame;
      this._preparedState = previousPublication.preparedState;
      this._lastBoxes = previousPublication.lastBoxes;
      this._lastPixels = previousPublication.lastPixels;
      this._indexOfElement = previousPublication.indexOfElement;
      this._elementAtIndex = previousPublication.elementAtIndex;
      this._scrollbars = previousPublication.scrollbars;
      this._documentSelectionRects = previousPublication.documentSelectionRects;
      this._serializedStyleGeneration = -1;
      this._dirty = true;
    };
    try {
      const observerDocument = this._root.ownerDocument;
      const styleSystem = observerDocument?._styleSystem;
      let preparationToken = this._frameClaim(continuation, 1, frameBindings);
      for (;;) {
        const resourceRevision = core.status("resource_revision");
        await observerDocument?._readyForRendering();
        const changed = core.status("resource_revision") !== resourceRevision;
        if (!changed) break;
        this._frameResume(
          continuation,
          preparationToken,
          16,
          -1,
          frameBindings,
        );
        preparationToken = this._frameClaim(continuation, 1, frameBindings);
      }
      core.status(
        "frame_configure",
        continuation,
        this._frameFlags(rasterize, deliverObservers, pixelReadback) | 32768,
      );
      let scrollOnly = core.status("frame_mode", continuation) === 1;
      let transformOnly = core.status("frame_mode", continuation) === 2;
      if (styleSystem && !scrollOnly) {
        // Multi-environment coexistence: serialization and style-driven
        // animation sync below read styles under THIS surface's viewport
        // environment. setEnvironment bumps the style generation only on an
        // actual change, so the single-surface path stays free.
        styleSystem.setEnvironment({
          viewportWidth: this.viewport.width,
          viewportHeight: this.viewport.height,
        });
      }
      // The animation-definition reconciliation resolves definitions for
      // the elements whose cascade names an animation. Its inputs are
      // exactly the style system's cascade output plus tree membership, and
      // every change to either bumps the style generation - the same key
      // the per-element resolution cache trusts. An unchanged generation
      // owes no scan. Recorded BEFORE the scan: a scan whose side effects
      // mutate the DOM re-scans next frame. The core lists the candidates
      // (animation_candidates: a native walk over its resolved records);
      // an element that stopped being one has its animations cancelled
      // here, exactly as an empty definition list would.
      if (
        styleSystem && !scrollOnly &&
        this._animationSyncStyleGeneration !== styleSystem.generation
      ) {
        this._animationSyncStyleGeneration = styleSystem.generation;
        core.mediaEnvironmentSet(styleSystem.environment);
        core.lengthViewport(this.viewport.width, this.viewport.height);
        const activeElements = new Set(
          core.animationCandidates(this._root._coreHandle, 0),
        );
        // Resolving natively can raise font-family requests; answering them
        // bumps the style generation, which must land before serialization
        // samples its checkpoint or the next frame re-serializes for nothing.
        styleSystem.answerFontFamilyRequests();
        for (const [element, records] of this._cssAnimations) {
          if (activeElements.has(element)) continue;
          for (const record of records) record.animation.cancel();
          this._cssAnimations.delete(element);
        }
        for (const element of activeElements) {
          const previousRecords = this._cssAnimations.get(element) ?? [];
          const desiredDefinitions = reconcileAnimationDefinitions(
            styleSystem.animationDefinitions(element),
            previousRecords,
          );
          const previousAnimationIndices = new Map(
            previousRecords.map((record) => [
              record.identity,
              this._animations.indexOf(record.animation),
            ]),
          );
          const reusableByIdentity = new Map();
          for (const desired of desiredDefinitions) {
            if (desired.reusable) {
              reusableByIdentity.set(desired.identity, desired.reusable);
            }
          }
          for (const previous of previousRecords) {
            if (reusableByIdentity.get(previous.identity) !== previous) {
              previous.animation.cancel();
            }
          }

          const nextRecords = [];
          for (
            let definitionIndex = 0;
            definitionIndex < desiredDefinitions.length;
            definitionIndex++
          ) {
            const desired = desiredDefinitions[definitionIndex];
            const reusable = reusableByIdentity.get(desired.identity);
            if (reusable) {
              nextRecords.push(reusable);
              continue;
            }
            const followingReusableRecords = desiredDefinitions.slice(
              definitionIndex + 1,
            ).map((following) => reusableByIdentity.get(following.identity))
              .filter(Boolean);
            const followingAnimationIndex = followingReusableRecords.length > 0
              ? this._animations.indexOf(
                followingReusableRecords[0].animation,
              )
              : -1;
            const precedingAnimationIndex = nextRecords.length > 0
              ? this._animations.indexOf(nextRecords.at(-1).animation)
              : -1;
            const previousAnimationIndex = previousAnimationIndices.get(
              desired.identity,
            );
            const firstPreviousAnimationIndex = previousAnimationIndices.size >
                0
              ? Math.min(...previousAnimationIndices.values())
              : this._animations.length;
            const insertionIndex = animationCSSInsertion(
              followingAnimationIndex,
              precedingAnimationIndex,
              previousAnimationIndex,
              firstPreviousAnimationIndex,
              this._animations.length,
            );
            const animation = this._createAnimation(
              element,
              desired.definition.keyframes,
              {
                ...desired.definition.timing,
                composite: desired.definition.composition,
              },
              {
                insertionIndex,
                beforeEngineHandles: followingReusableRecords.map((record) =>
                  record.animation._engineHandle
                ),
                preserveReplacedTracks: true,
                diagnosticAnimationName: desired.definition.name,
              },
            );
            animation._cssAnimationName = desired.definition.name;
            animation._cascadingStyleSheetsAnimationIdentity = desired.identity;
            if (desired.definition.paused) animation.pause();
            nextRecords.push({
              ...desired,
              animation,
            });
          }
          for (
            let recordIndex = 0;
            recordIndex < nextRecords.length;
            recordIndex++
          ) {
            nextRecords[recordIndex].animation._engineDeclarationOptions
              .beforeEngineHandles = nextRecords.slice(recordIndex + 1).map(
                (record) => record.animation._engineHandle,
              );
          }
          if (nextRecords.length === 0) {
            this._cssAnimations.delete(element);
            continue;
          }
          const cascadingStyleSheetsAnimationSlots = [];
          for (
            let animationIndex = 0;
            animationIndex < this._animations.length;
            animationIndex++
          ) {
            const animation = this._animations[animationIndex];
            if (
              animation._element === element &&
              animation._cascadingStyleSheetsAnimationIdentity !== undefined
            ) {
              cascadingStyleSheetsAnimationSlots.push(animationIndex);
            }
          }
          for (
            let recordIndex = 0;
            recordIndex < nextRecords.length;
            recordIndex++
          ) {
            this._animations[cascadingStyleSheetsAnimationSlots[recordIndex]] =
              nextRecords[recordIndex].animation;
          }
          this._cssAnimations.set(element, nextRecords);
        }

        const nextPseudoContentAnimations = new Map();
        for (const pseudoElement of ["::before", "::after"]) {
          for (
            const element of core.animationCandidates(
              this._root._coreHandle,
              pseudoElement === "::before" ? 1 : 2,
            )
          ) {
            const contentDefinitions = styleSystem.animationDefinitions(
              element,
              pseudoElement,
            ).filter((definition) => {
              const propertyNames = new Set(
                definition.keyframes.flatMap((keyframe) =>
                  Object.keys(keyframe).filter((name) =>
                    name !== "offset" && name !== "easing" &&
                    name !== "composite"
                  )
                ),
              );
              return propertyNames.size === 1 && propertyNames.has("content");
            });
            if (contentDefinitions.length === 0) continue;
            const unsupportedContentDefinition = contentDefinitions.find((
              definition,
            ) => definition.composition !== "replace");
            if (unsupportedContentDefinition) {
              const cause = new TypeError(
                "content only supports replace composition",
              );
              throw new TypeError(
                `CSS animation "${unsupportedContentDefinition.name}" declaration failed: ${cause.message}`,
                { cause },
              );
            }
            const previousContentRecords =
              this._pseudoContentAnimations.get(element)
                ?.get(pseudoElement) ?? [];
            const desiredRecords = reconcileAnimationDefinitions(
              contentDefinitions,
              previousContentRecords,
            );
            const nextRecords = desiredRecords.map((desired) => {
              if (desired.reusable) return desired.reusable;
              return {
                ...desired,
                element,
                pseudoElement,
                startTimeMilliseconds: timeMilliseconds,
                initialContent: desired.definition.keyframes[0]?.content,
              };
            });
            let pseudoElements = nextPseudoContentAnimations.get(element);
            if (!pseudoElements) {
              pseudoElements = new Map();
              nextPseudoContentAnimations.set(element, pseudoElements);
            }
            pseudoElements.set(pseudoElement, nextRecords);
          }
        }
        this._pseudoContentAnimations = nextPseudoContentAnimations;
      }
      core.status(
        "frame_configure",
        continuation,
        this._frameFlags(rasterize, deliverObservers, pixelReadback) | 32768,
      );
      this._frameResume(continuation, preparationToken, 0, -1, frameBindings);
      scrollOnly = core.status("frame_mode", continuation) === 1;
      transformOnly = core.status("frame_mode", continuation) === 2;
      const cleanSceneReuse = core.status("frame_mode", continuation) === 3;
      const retainedScene = core.status("frame_mode", continuation) !== 0;
      const sceneToken = this._frameClaim(continuation, 2, frameBindings);
      capturedScrollRequests = this._captureScrollRequests();
      const capturedViewportScroll = capturedScrollRequests.get(this.viewport);
      const frameViewport = {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScale: this.viewport.deviceScale,
        _requestedLeft: capturedViewportScroll?.left ??
          this.viewport._requestedLeft,
        _requestedTop: capturedViewportScroll?.top ??
          this.viewport._requestedTop,
      };
      const reuseTextGeometry = this._textSelectionEnabled &&
        (
          scrollOnly ||
          (
            this._selectionChanged &&
            cleanSceneReuse &&
            this._mutatedNodes.size === 0
          )
        );
      let captureTextGeometry = this._textSelectionEnabled &&
        !reuseTextGeometry;
      let serialized;
      let declaredChangedNodeIndices = null;
      // A frame that takes a getter's serialization also takes the rows the
      // getter wrote into the engine and the boxes it read: the rows whose
      // scroll offsets this frame restates (the capture, after anchoring)
      // are the only ones the renderer publishes again, and the pre-render
      // layout (scroll anchoring, scroll timelines) reads the getter's
      // boxes instead of laying out again.
      let syncLayoutSource = null;
      let syncLayoutBoxes = null;
      if (scrollOnly) {
        // Reuse the retained scene. Only the scrolled nodes' offset fields
        // change; the renderer receives the changed indices as a declared
        // set, so no full-scene signature pass runs either.
        serialized = {
          ...this._preparedState.serialized,
          nodes: this._preparedState.serialized.nodes.slice(),
        };
        declaredChangedNodeIndices = new Set();
        for (const [target, request] of capturedScrollRequests) {
          const index = target === this.viewport
            ? serialized.viewportIndex
            : serialized.indexOf.get(target);
          if (index === undefined || index === null) continue;
          const node = serialized.nodes[index] = { ...serialized.nodes[index] };
          node.scrollLeft = request.left;
          node.scrollTop = request.top;
          declaredChangedNodeIndices.add(index);
        }
        this._stageCounters.scrollOnlyFrames++;
      } else if (transformOnly) {
        serialized = {
          ...this._preparedState.serialized,
          nodes: this._preparedState.serialized.nodes.slice(),
        };
        declaredChangedNodeIndices = new Set();
        for (const element of this._transformOnlyMutations) {
          const index = serialized.indexOf.get(element);
          if (!Number.isInteger(index)) continue;
          const fields = resolvedElementFields(element);
          const transform = fields.transform;
          serialized.nodes[index] = {
            ...serialized.nodes[index],
            transform,
            transformOrigin: fields.transformOrigin,
            _coreTransformOverride: transform,
            _coreTransformOverrideBox: this._lastBoxes[index],
          };
          declaredChangedNodeIndices.add(index);
        }
        this._stageCounters.retainedTransformFrames++;
      } else if (cleanSceneReuse) {
        // Nothing that feeds serialization changed: reuse the retained
        // scene verbatim. The empty declared set skips the engine's
        // full-scene signature pass; canvas damage still merges in through
        // the mutation and forced-generation node indices below.
        serialized = { ...this._preparedState.serialized };
        declaredChangedNodeIndices = new Set();
        this._stageCounters.retainedCleanFrames++;
      } else {
        this._stageCounters.serializations++;
        this._stageCounters.currentStage = "serialize";
        // Sampled BEFORE the walk: a mutation landing during serialization
        // bumps the generation past this checkpoint, so the next frame
        // re-serializes instead of trusting a torn scene.
        this._serializedStyleGeneration = styleSystem === undefined
          ? -1
          : styleSystem.generation;
        this._serializedViewportWidth = frameViewport.width;
        this._serializedViewportHeight = frameViewport.height;
        this._serializedViewportScale = frameViewport.deviceScale;
        const generatedContent = this._animatedGeneratedContent(
          timeMilliseconds,
        );
        const syncLayout = generatedContent === null
          ? this._takeSyncLayout(
            this._serializedStyleGeneration,
            frameViewport,
            core.status("resource_revision"),
          )
          : null;
        if (syncLayout !== null) {
          serialized = syncLayout.serialized;
          syncLayoutSource = serialized.nodes;
          syncLayoutBoxes = syncLayout.boxes;
          // The getter serialized before this frame's scroll requests were
          // captured: restate them on the rows, as a scroll-only frame does.
          if (capturedScrollRequests.size > 0) {
            serialized = { ...serialized, nodes: serialized.nodes.slice() };
            core.shareSceneResources(
              syncLayout.serialized.nodes,
              serialized.nodes,
            );
            for (const [target, request] of capturedScrollRequests) {
              const index = target === this.viewport
                ? serialized.viewportIndex
                : serialized.indexOf.get(target);
              if (index === undefined || index === null) continue;
              const node = serialized.nodes[index] = {
                ...serialized.nodes[index],
              };
              node.scrollLeft = request.left;
              node.scrollTop = request.top;
            }
            core.releaseSceneResources(syncLayout.serialized.nodes);
          }
        } else {
          serialized = serializeToScene(this._root, {
            viewportWidth: frameViewport.width,
            viewportHeight: frameViewport.height,
            generatedContent,
            viewport: frameViewport,
          });
        }
      }
      if (scrollOnly || transformOnly) {
        core.shareSceneResources(
          this._preparedState.serialized.nodes,
          serialized.nodes,
        );
      }
      // The paint artifact exists for text geometry; a scene without text
      // boxes reads nothing from it, and building it walks every command.
      if (serialized.textBoxes === 0) captureTextGeometry = false;
      if (
        !retainedScene && this._persistentRenderer &&
        this._indexOfElement.size > 0
      ) {
        const remappedIndices = new Map();
        for (const [element, previousIndex] of this._indexOfElement) {
          const nextIndex = serialized.indexOf.get(element);
          if (nextIndex !== undefined) {
            remappedIndices.set(previousIndex, nextIndex);
          }
        }
        this._persistentRenderer.remapAnimations(remappedIndices);
        for (const animation of [...this._animations]) {
          if (!serialized.indexOf.has(animation._element)) {
            this._removeAnimation(animation);
          }
        }
      }
      // Visible-region rasterization (raster-scale plan, slice 3): the
      // raster target covers the visible rectangle at the raster scale.
      // Damage and overlay rectangles are produced in full-scene device
      // coordinates; toTargetRectangle shifts them into target space.
      const visibleRegion = this._visibleRectangle;
      const originDeviceX = (visibleRegion?.x ?? 0) *
        frameViewport.deviceScale;
      const originDeviceY = (visibleRegion?.y ?? 0) *
        frameViewport.deviceScale;
      // Damage uses the same integer extent as the native raster allocation;
      // the origin and device scale remain in unrounded device coordinates.
      const physicalWidth = Math.trunc(
        (visibleRegion?.width ?? frameViewport.width) *
          frameViewport.deviceScale,
      );
      const physicalHeight = Math.trunc(
        (visibleRegion?.height ?? frameViewport.height) *
          frameViewport.deviceScale,
      );
      const toTargetRectangle = (rectangle) =>
        originDeviceX === 0 && originDeviceY === 0 ? rectangle : {
          ...rectangle,
          x: rectangle.x - originDeviceX,
          y: rectangle.y - originDeviceY,
        };
      let boxes = syncLayoutBoxes ?? (retainedScene ? this._lastBoxes : []);
      core.status(
        "frame_configure",
        continuation,
        this._frameFlags(rasterize, deliverObservers, pixelReadback) |
          32768,
      );
      const sourceRevisions = {
        document: BigInt(
          core.status(
            "document_style_generation",
            observerDocument._coreHandle,
          ),
        ),
        style: BigInt(styleSystem?.generation ?? 0),
        resource: BigInt(core.status("resource_revision")),
        viewport: this._viewportRevision,
        scene: BigInt(this._frameSequence + 1),
        presentation: BigInt(this._frameSequence + 1),
      };
      serialized.sourceRevisions = sourceRevisions;
      serialized.root = this._root;
      core.status(
        "frame_sources",
        continuation,
        sourceRevisions.style,
        sourceRevisions.resource,
        sourceRevisions.viewport,
      );
      this._frameResume(continuation, sceneToken, 0, -1, frameBindings);
      frameMutatedNodes = this._mutatedNodes;
      frameForcedGenerationNodes = this._forcedGenerationNodes;
      this._mutatedNodes = new Set();
      this._forcedGenerationNodes = new Set();
      this._transformOnlyMutations = new Set();
      this._hasNonTransformMutation = false;
      this._forceFullInvalidation = false;
      this._selectionChanged = false;
      this._eventElementAtIndex = new Array(serialized.nodes.length).fill(null);
      for (const [element, index] of serialized.indexOf) {
        this._eventElementAtIndex[index] = element;
      }
      for (;;) {
        const action = core.status("frame_stage", continuation);
        if (action === 8) break;
        const token = this._frameClaim(continuation, action, frameBindings);
        let facts = 0;
        let depth = -1;
        switch (action) {
          case 3:
            if (
              boxes !== syncLayoutBoxes ||
              boxes.length !== serialized.nodes.length
            ) {
              boxes = await this._layoutTreeBoxes({
                width: frameViewport.width,
                height: frameViewport.height,
                nodes: serialized.nodes,
                imageSources: serialized.imageSources,
              });
            }
            break;
          case 5:
            facts = this._applyScrollAnchoring(
                serialized,
                boxes,
                capturedScrollRequests,
              )
              ? 1
              : 0;
            break;
          case 6:
            for (const animation of this._animations) {
              if (!animation._isScrollDriven()) continue;
              const progress = sampleScrollTimeline(
                animation,
                this._root,
                this.viewport,
                serialized,
                boxes,
              );
              if (animation._sampleScrollTimeline(progress)) {
                this._mutatedNodes.add(animation._element);
              }
            }
            break;
          case 7: {
            this._pendingObserverDelivery = false;
            const delivery = deliverRenderingObservers(
              observerDocument,
              serialized,
              boxes,
              this.viewport,
              timeMilliseconds,
              core.status("frame_depth", continuation),
            );
            facts = (this._dirty ? 2 : 0) | (delivery.skippedResize ? 4 : 0);
            depth = Number.isFinite(delivery.shallowestResizeDepth)
              ? delivery.shallowestResizeDepth
              : -1;
            break;
          }
          case 11:
            break;
          default:
            throw new Error(`Unsupported frame action ${action}`);
        }
        this._frameResume(continuation, token, facts, depth, frameBindings);
        if (core.status("frame_stage", continuation) === 1) {
          for (const node of frameMutatedNodes) this._mutatedNodes.add(node);
          for (const node of frameForcedGenerationNodes) {
            this._forcedGenerationNodes.add(node);
          }
          this._rendering = false;
          const result = await this._render(
            timeMilliseconds,
            forceDelivery,
            snapshotPixels,
            rasterize,
            deliverObservers,
            pixelReadback,
            continuation,
          );
          accepted = true;
          return result;
        }
      }
      // The getter's boxes predate this frame's scroll requests. They stand
      // in for the pre-render layout (anchoring, scroll timelines), not for
      // the presented geometry a renderer without boxes of its own reads
      // below: that geometry must carry the requested offsets.
      if (boxes === syncLayoutBoxes && capturedScrollRequests.size > 0) {
        releaseBoxSnapshot(boxes);
        boxes = [];
      }
      resizeObserverLoopError =
        core.status("frame_loop_error", continuation) !== 0;
      // Retained delivery: every input the raster, the overlays and the
      // interaction snapshot read is unchanged since the presented frame,
      // so this frame IS the presented frame. Nothing is rebuilt; a forced
      // delivery re-presents the retained result (texture or pixels) under
      // the presented frame's sequence. Decided AFTER the observer stages:
      // an observer mutation restarts preparation above and re-decides.
      if (
        this._retainedDeliveryPossible(
          cleanSceneReuse,
          pixelReadback,
          sourceRevisions,
          frameMutatedNodes,
          frameForcedGenerationNodes,
          capturedScrollRequests,
          continuation,
        )
      ) {
        for (const stage of [8, 9, 10]) {
          this._frameResume(
            continuation,
            this._frameClaim(continuation, stage, frameBindings),
            0,
            -1,
            frameBindings,
          );
        }
        core.status("frame_finish", continuation);
        accepted = true;
        this._stageCounters.retainedDeliveries++;
        if (!forceDelivery) return null;
        const frame = this._lastDeliveredFrame;
        if (this._presentFrame !== null) {
          this._presentingFrame = true;
          try {
            await this._presentFrame(this._lastRendered);
          } finally {
            this._presentingFrame = false;
          }
        }
        this._notifyFrameListeners(frame, resizeObserverLoopError);
        return frame;
      }
      const damageToken = this._frameClaim(continuation, 8, frameBindings);
      const damageMode = core.status(
        "frame_damage_begin",
        continuation,
        physicalWidth,
        physicalHeight,
      );
      const pureScrollMutation = damageMode === 2;
      let requestedDirtyRectangles = damageMode === 0
        ? core.frameDamageRectangles(continuation)
        : [];
      let dirtyTiles = damageMode === 0 ? null : new Uint8Array(0);
      for (const target of capturedScrollRequests.keys()) {
        const index = target === this.viewport
          ? serialized.viewportIndex
          : serialized.indexOf.get(target);
        if (index === undefined || index === null) continue;
        const rectangle = boxRectangle(
          this._lastBoxes[index],
          frameViewport.deviceScale,
        );
        if (!rectangle) continue;
        const translated = toTargetRectangle(rectangle);
        core.status(
          "frame_damage_rect",
          continuation,
          1,
          translated.x,
          translated.y,
          translated.width,
          translated.height,
        );
      }

      // Scrollbars (wide-color plan, package 4): computed BEFORE the
      // render from a synchronous layout pass and emitted as overlay
      // rects through the render graph's own rect pipeline, replacing
      // the old CPU byte compositing over the readback. Keeps scrollbar
      // color in the floating-point path.
      if (this._lastBoxes.length === 0 && boxes.length === 0) {
        // First frame only: no engine baseline exists yet, so scrollbar
        // descriptors take one JS layout pass. Every later frame reads the
        // retained engine boxes.
        boxes = await this._layoutTreeBoxes({
          width: frameViewport.width,
          height: frameViewport.height,
          nodes: serialized.nodes,
          imageSources: serialized.imageSources,
        });
      }
      // ONE geometry source for scrollbar descriptors: the presented
      // snapshot (the engine's boxes, the same family the delivered pixels
      // paint). It describes the PREVIOUS frame; THIS frame's pending
      // scroll deltas are known exactly, so scrollbars_build predicts
      // current geometry natively instead of lagging one frame behind the
      // painted content: each pending target takes its clamped requested
      // offset and each scroller box shifts by its frozen ancestors'
      // pending deltas. The first frame has no snapshot and builds one from
      // the layout pass once. No layout pass runs here.
      const snapshot = this._presentedFrame;
      const predictScroll = (target, slot) =>
        this._root._domCore.status(
          "scroll_prediction",
          capturedScrollRequests.handle,
          snapshot.geometryHandle,
          target === this.viewport ? 0n : target?._coreHandle ?? 0n,
          slot,
        );
      const pendingContentShift = (node) =>
        snapshot
          ? { shiftX: predictScroll(node, 4), shiftY: predictScroll(node, 5) }
          : { shiftX: 0, shiftY: 0 };
      // The same slots for every node of a list in one crossing: a page of
      // text has a text owner per line, and four crossings each, every one
      // walking the ancestor chain, were a measured share of the frame.
      // Returns Float64Array rows of [pending x, pending y, committed x,
      // committed y] in list order.
      const contentShifts = (nodes) => {
        if (!snapshot || nodes.length === 0) return null;
        const core = this._root._domCore;
        const pointer = core.exports.abi_allocate(nodes.length * 8);
        if (!pointer) core.throwIfError();
        const input = new DataView(core.refreshBytes().buffer);
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes[index];
          input.setBigUint64(
            pointer + index * 8,
            node === this.viewport ? 0n : node?._coreHandle ?? 0n,
            true,
          );
        }
        core.status(
          "scroll_prediction_shifts",
          capturedScrollRequests.handle,
          snapshot.geometryHandle,
          pointer,
          nodes.length,
        );
        const base = core.exports.abi_output_pointer();
        return new Float64Array(
          core.refreshBytes().buffer.slice(base, base + nodes.length * 32),
        );
      };
      const scrollbars = snapshot
        ? snapshotScrollbars(
          this._root,
          this.viewport,
          snapshot.geometryCore,
          snapshot.geometryHandle,
          capturedScrollRequests.size > 0 ? capturedScrollRequests.handle : 0n,
        )
        : computeScrollbars(serialized, boxes, this.viewport);
      const overlayRects = [];
      for (const scrollbar of scrollbars) {
        for (
          const [rectangle, color] of [
            [scrollbar.track, scrollbar.colors.track],
            [scrollbar.thumb, scrollbar.colors.thumb],
          ]
        ) {
          // Overlay rects bypass the engine's clip stack, so the
          // descriptor's ancestor clip applies here: a bar on a scroller
          // that protrudes past a clipping ancestor paints only its
          // visible part, exactly as the scroller box itself does.
          let { x, y, width: rectWidth, height: rectHeight } = rectangle;
          if (scrollbar.clip) {
            const right = Math.min(
              x + rectWidth,
              scrollbar.clip.x + scrollbar.clip.width,
            );
            const bottom = Math.min(
              y + rectHeight,
              scrollbar.clip.y + scrollbar.clip.height,
            );
            x = Math.max(x, scrollbar.clip.x);
            y = Math.max(y, scrollbar.clip.y);
            rectWidth = right - x;
            rectHeight = bottom - y;
            if (rectWidth <= 0 || rectHeight <= 0) continue;
          }
          // Same floor/ceil snap the CPU byte paint applied, in physical
          // pixels (the overlay contract matches the command stream).
          const left = Math.floor(x * frameViewport.deviceScale);
          const top = Math.floor(y * frameViewport.deviceScale);
          overlayRects.push(toTargetRectangle({
            x: left,
            y: top,
            width: Math.ceil(
              (x + rectWidth) * frameViewport.deviceScale,
            ) - left,
            height: Math.ceil(
              (y + rectHeight) * frameViewport.deviceScale,
            ) - top,
            color,
          }));
        }
      }
      const focusedElement = this._root.ownerDocument?._focusedElement ?? null;
      const textGeometry = this._presentedFrame?.textGeometryByElement.get(
        focusedElement,
      );
      if (textGeometry) {
        const { shiftX, shiftY } = pendingContentShift(focusedElement);
        const selectionStart = focusedElement.selectionStart ??
          focusedElement.value.length;
        const selectionEnd = focusedElement.selectionEnd ?? selectionStart;
        if (selectionStart === selectionEnd) {
          const caret = caretRectangle(
            this._presentedFrame,
            focusedElement,
            selectionStart,
            {
              deltaX: -shiftX,
              deltaY: -shiftY,
              deviceScale: frameViewport.deviceScale,
            },
          );
          if (caret) {
            overlayRects.push(toTargetRectangle({
              ...caret,
              color: caretPaintColor(focusedElement),
            }));
          }
        } else {
          for (
            const rectangle of selectionRectangles(
              this._presentedFrame,
              [{
                node: focusedElement,
                start: selectionStart,
                end: selectionEnd,
                deltaX: -shiftX,
                deltaY: -shiftY,
              }],
              { physical: true, deviceScale: frameViewport.deviceScale },
            )
          ) {
            overlayRects.push(toTargetRectangle({
              ...rectangle,
              color: { r: 0.15, g: 0.45, b: 0.9, a: 0.35 },
            }));
          }
        }
      }
      const documentSelectionRects = [];
      const selectionDocument = this._root.ownerDocument;
      const documentSelection = selectionDocument?.getSelection();
      if (
        documentSelection?.rangeCount === 1 && !documentSelection.isCollapsed &&
        this._presentedFrame
      ) {
        const selectedByNode = new Map();
        for (const span of documentSelection._selectedSpans()) {
          selectedByNode.set(span[0], span);
        }
        const spans = [];
        // Preserve imported engine text order while transporting native range
        // membership and native pending-scroll deltas, never walking the DOM.
        for (const [node] of this._presentedFrame.textGeometryByNode) {
          const span = selectedByNode.get(node);
          if (!span) continue;
          const { shiftX, shiftY } = pendingContentShift(node);
          spans.push({
            node,
            start: span[1],
            end: span[2],
            deltaX: -shiftX,
            deltaY: -shiftY,
          });
        }
        for (
          const rectangle of selectionRectangles(
            this._presentedFrame,
            spans,
            { physical: true, deviceScale: frameViewport.deviceScale },
          )
        ) {
          documentSelectionRects.push(toTargetRectangle({
            ...rectangle,
            color: { r: 0.15, g: 0.45, b: 0.9, a: 0.35 },
          }));
        }
        overlayRects.push(...documentSelectionRects);
      }
      // Overlay scrollbars bypass the engine's dirty map. Repaint only a
      // changed track or the old and new thumb bounds; an unchanged scrollbar
      // must not turn every localized frame into a full-axis repaint.
      if (dirtyTiles !== null) {
        for (
          const rectangle of [
            ...this._documentSelectionRects,
            ...documentSelectionRects,
          ]
        ) {
          requestedDirtyRectangles.push(rectangle);
        }
        if (textGeometry) {
          const textControlBox = geometryBox(
            this._presentedFrame.geometryCore,
            this._presentedFrame.geometryHandle,
            focusedElement._coreHandle,
          );
          if (textControlBox) {
            requestedDirtyRectangles.push(toTargetRectangle({
              x: Math.floor(
                textControlBox.x * frameViewport.deviceScale,
              ),
              y: Math.floor(
                textControlBox.y * frameViewport.deviceScale,
              ),
              width: Math.ceil(
                textControlBox.w * frameViewport.deviceScale,
              ),
              height: Math.ceil(
                textControlBox.h * frameViewport.deviceScale,
              ),
            }));
          }
        }
        for (const rectangle of requestedDirtyRectangles) {
          core.status(
            "frame_damage_rect",
            continuation,
            0,
            rectangle.x,
            rectangle.y,
            rectangle.width,
            rectangle.height,
          );
        }
        const previousByOrientation = new Map(
          this._scrollbars.map((scrollbar) => [
            scrollbar.orientation,
            scrollbar,
          ]),
        );
        const nextByOrientation = new Map(
          scrollbars.map((scrollbar) => [scrollbar.orientation, scrollbar]),
        );
        for (
          const orientation of new Set([
            ...previousByOrientation.keys(),
            ...nextByOrientation.keys(),
          ])
        ) {
          core.frameOverlayDamage(
            continuation,
            previousByOrientation.get(orientation),
            nextByOrientation.get(orientation),
            frameViewport.deviceScale,
            originDeviceX,
            originDeviceY,
          );
        }
        requestedDirtyRectangles = core.frameDamageRectangles(continuation);
        dirtyTiles = core.frameDamageTiles(
          continuation,
          physicalWidth,
          physicalHeight,
          64,
        );
      }
      const scene = {
        width: frameViewport.width,
        height: frameViewport.height,
        nodes: serialized.nodes,
        imageSources: serialized.imageSources,
        styleGeneration: serialized.styleGeneration,
        changedRows: serialized.changedRows,
        publicationRevision: serialized.publicationRevision,
        previousPublicationRevision: serialized.previousPublicationRevision,
        syncLayoutSource,
        syncLayoutScrollIndices: null,
      };
      // Only a pure-scroll frame keeps its declared JS tiles authoritative
      // (the engine's scroll table localizes within them). Every mutation
      // frame merges the engine's generation-derived tile map in; JS tiles
      // there carry only overlay scrollbar damage.
      const authoritativeDirtyTiles = dirtyTiles !== null && pureScrollMutation;
      let mutationNodeIndices = null;
      if (!this._dirty) {
        this._anchoringSuppressionProperties.clear();
        this._positionSuppressionNodes.clear();
      }
      this._frameResume(continuation, damageToken, 0, -1, frameBindings);
      let forceGenerationNodeIndices = null;
      if (frameMutatedNodes.size > 0) {
        mutationNodeIndices = new Set();
        forceGenerationNodeIndices = new Set();
        for (const node of frameMutatedNodes) {
          const index = serialized.indexOf.get(node);
          if (Number.isInteger(index)) mutationNodeIndices.add(index);
          if (
            frameForcedGenerationNodes.has(node) && Number.isInteger(index)
          ) {
            forceGenerationNodeIndices.add(index);
          }
          if (node.nodeType !== 3) continue;
          for (
            let ancestor = node.parentNode;
            ancestor;
            ancestor = ancestor.parentNode
          ) {
            const ancestorIndex = serialized.indexOf.get(ancestor);
            if (!Number.isInteger(ancestorIndex)) continue;
            forceGenerationNodeIndices.add(ancestorIndex);
            break;
          }
        }
      }
      // Native changedRows describes lowered style, not host scroll requests.
      // A mixed scroll/paint frame serializes anew instead of taking the
      // scroll-only branch, but still owes the renderer every requested offset.
      for (const target of capturedScrollRequests.keys()) {
        const index = target === this.viewport
          ? serialized.viewportIndex
          : serialized.indexOf.get(target);
        if (!Number.isInteger(index)) continue;
        mutationNodeIndices ??= new Set();
        mutationNodeIndices.add(index);
        if (syncLayoutSource !== null) {
          scene.syncLayoutScrollIndices ??= new Set();
          scene.syncLayoutScrollIndices.add(index);
        }
      }
      const renderOptions = {
        ...(dirtyTiles
          ? {
            authoritativeDirtyTiles,
            dirtyTiles,
            tileSize: 64,
          }
          : {}),
        ...(scrollOnly && declaredChangedNodeIndices !== null
          ? { scrollOnlyNodeIndices: declaredChangedNodeIndices }
          : {}),
        ...(overlayRects.length > 0 ? { overlayRects } : {}),
        ...(declaredChangedNodeIndices !== null
          ? { declaredChangedNodeIndices }
          : {}),
        ...(mutationNodeIndices?.size ? { mutationNodeIndices } : {}),
        ...(forceGenerationNodeIndices?.size
          ? { forceGenerationNodeIndices }
          : {}),
        timeMilliseconds,
        ...(this._glyphResourceManager === null
          ? {}
          : { glyphResourceManager: this._glyphResourceManager }),
        ...(this._pendingAnimationDeclarations.length > 0
          ? {
            prepareEngine: () => {
              for (const declaration of this._pendingAnimationDeclarations) {
                const nodeIndex = serialized.indexOf.get(declaration.element);
                if (nodeIndex !== undefined) {
                  declaration.bind(this._persistentRenderer, nodeIndex);
                }
              }
              this._pendingAnimationDeclarations.length = 0;
            },
          }
          : {}),
        ...(this._resolveResource
          ? { resolveResource: this._resolveResource }
          : {}),
        ...(this._capturePaintArtifact
          ? { capturePaintArtifact: true }
          : captureTextGeometry
          ? { captureTextGeometry: true }
          : {}),
      };
      if (!rasterize) {
        this._indexOfElement = serialized.indexOf;
        const elementAtIndex = new Array(serialized.nodes.length).fill(null);
        for (const [element, index] of serialized.indexOf) {
          elementAtIndex[index] = element;
        }
        this._elementAtIndex = elementAtIndex;
        this._lastBoxes = boxes;
        const supersededSerialized = this._preparedState?.serialized ?? null;
        this._preparedState = Object.freeze({
          scene: Object.freeze({
            width: scene.width,
            height: scene.height,
            nodes: Object.freeze(scene.nodes),
          }),
          serialized,
          boxes: Object.freeze(boxes),
        });
        if (
          supersededSerialized !== null &&
          supersededSerialized.publication !== serialized.publication
        ) supersededSerialized.release();
        const publicationToken = this._frameClaim(
          continuation,
          10,
          frameBindings,
        );
        this._frameResume(continuation, publicationToken, 0, -1, frameBindings);
        core.status("frame_finish", continuation);
        accepted = true;
        return this._preparedState;
      }
      const renderToken = this._frameClaim(continuation, 9, frameBindings);
      if (this._usesDefaultRenderer && !this._persistentRendererPromise) {
        this._persistentRendererPromise = this._createPersistentRenderer({
          width: frameViewport.width,
          height: frameViewport.height,
          deviceScale: frameViewport.deviceScale,
          ...this._persistentRendererOptions,
        }).then((renderer) => {
          this._persistentRenderer = renderer;
          this._animationEventUnsubscribe = renderer.onAnimationEvent(
            (record) => {
              const element =
                (this._eventElementAtIndex ?? this._elementAtIndex)[
                  record.nodeIndex
                ];
              if (!element) {
                throw new RangeError(
                  `No DOM element for animated layout index ${record.nodeIndex}`,
                );
              }
              const matchingAnimation =
                this._animationCancelingThroughEngine?._animationId ===
                    record.animationId
                  ? this._animationCancelingThroughEngine
                  : this._animations.find((animation) =>
                    animation._animationId === record.animationId
                  );
              const transitionTiming = this._transitionTimings.get(element)
                ?.get(
                  record.propertyName,
                );
              const elapsedTime = matchingAnimation
                ? matchingAnimation._elapsedTimeForEvent(record.type)
                : record.type === "transitionend"
                ? (transitionTiming?.duration ?? 0) / 1000
                : Math.max(0, -(transitionTiming?.delay ?? 0)) / 1000;
              const feedback = matchingAnimation?._beginEngineLifecycle(record);
              if (matchingAnimation && !feedback) return;
              try {
                dispatchEvent(
                  element,
                  createEvent(record.type, {
                    bubbles: true,
                    propertyName: record.propertyName,
                    animationName: matchingAnimation?._cssAnimationName ?? "",
                    elapsedTime,
                    pseudoElement: "",
                  }),
                );
              } finally {
                if (feedback) {
                  matchingAnimation._completeEngineLifecycle(feedback);
                }
              }
              if (
                record.type === "transitionend" ||
                record.type === "transitioncancel"
              ) {
                const timings = this._transitionTimings.get(element);
                if (timings?.delete(record.propertyName)) {
                  const records = this._transitionRecords.get(element);
                  records?.delete(record.propertyName);
                  if (records?.size === 0) {
                    this._transitionRecords.delete(element);
                  }
                  if (this._activeTransitionCount > 0) {
                    this._activeTransitionCount--;
                  }
                }
              }
            },
          );
          return renderer;
        });
      }
      let rendered;
      this._stageCounters.currentStage = "raster";
      rasterStartedAt = renderSurfaceNow();
      if (this._persistentRendererPromise) {
        const renderer = await this._persistentRendererPromise;
        rendererReadyAt = renderSurfaceNow();
        await renderer.resize(
          frameViewport.width,
          frameViewport.height,
          frameViewport.deviceScale,
        );
        rendererResizedAt = renderSurfaceNow();
        if (renderer.setVisibleRectangle) {
          await renderer.setVisibleRectangle(this._visibleRectangle);
        }
        visibleRectangleSetAt = renderSurfaceNow();
        // Texture delivery (zero-copy presentation): the renderer returns
        // the live GPU texture image plus device, exactly what
        // createCanvasPresenter.present consumes. Only the webgpu backend
        // can produce it - the webgl2 backend has no GPU texture image to
        // hand over, so presentation there explicitly falls back to pixel
        // frames (the delivery carries pixels and no textureImage). A
        // pixel capture (renderNow({ pixelReadback: true })) reads back
        // this one frame without presenting it; the finally block
        // schedules a presentation frame so the presenter catches up.
        const textureDelivery = this._presentFrame !== null &&
          !pixelReadback &&
          renderer.graphicsBackend !== "webgl2";
        rendered = textureDelivery
          ? await renderer.renderTexture(scene, renderOptions)
          : await renderer.render(scene, renderOptions);
        rasterFinishedAt = renderSurfaceNow();
        if (this._presentFrame !== null && !pixelReadback) {
          this._stageCounters.currentStage = "present";
          pendingPresentation = () => this._presentFrame(rendered);
        }
      } else {
        rendered = await this._renderPixels(
          scene,
          frameViewport.deviceScale,
          {
            ...renderOptions,
            ...(this._visibleRectangle
              ? { visibleRectangle: this._visibleRectangle }
              : {}),
          },
        );
      }
      rasterFinishedAt ??= renderSurfaceNow();
      if (this._shutdown) {
        return null;
      }
      this._frameResume(continuation, renderToken, 0, -1, frameBindings);
      const publicationToken = this._frameClaim(
        continuation,
        10,
        frameBindings,
      );
      for (const transition of rendered.startedTransitions ?? []) {
        const element = this._eventElementAtIndex[transition.nodeIndex];
        if (!element) continue;
        let timings = this._transitionTimings.get(element);
        if (!timings) {
          timings = new Map();
          this._transitionTimings.set(element, timings);
        }
        const wasActive = timings.has(transition.propertyName);
        const timing = {
          duration: transition.duration,
          delay: transition.delay,
          easing: transition.easing,
          startTimeMilliseconds: transition.startTime,
        };
        timings.set(transition.propertyName, timing);
        let records = this._transitionRecords.get(element);
        if (!records) {
          records = new Map();
          this._transitionRecords.set(element, records);
        }
        records.set(transition.propertyName, timing);
        if (!wasActive) this._activeTransitionCount++;
      }
      for (const animation of this._animations) {
        for (const elapsedTime of animation._iterationEventsAtCurrentTime()) {
          dispatchEvent(
            animation._element,
            createEvent("animationiteration", {
              bubbles: true,
              animationName: animation._cssAnimationName ?? "",
              elapsedTime,
              pseudoElement: "",
            }),
          );
        }
      }
      // Effective scroll state owner: the engine's clamped offsets from
      // THIS render. Requested state re-syncs to effective at publication,
      // so an idle target's requested offsets always equal its effective
      // offsets and the next input step accumulates on truth.
      //
      // A caller-supplied renderer reports no boxes; scroll sync and the
      // snapshot then need one JS layout pass for current geometry.
      if (!rendered.boxes?.length && boxes.length === 0) {
        boxes = await this._layoutTreeBoxes({
          width: frameViewport.width,
          height: frameViewport.height,
          nodes: serialized.nodes,
          imageSources: serialized.imageSources,
        });
      }
      const effectiveBoxes = rendered.boxes?.length ? rendered.boxes : boxes;

      const dirtyRectangles = !authoritativeDirtyTiles &&
          rendered.dirtyRects?.length
        ? rendered.dirtyRects.map((rectangle) =>
          Object.freeze({
            x: rectangle.x,
            y: rectangle.y,
            width: rectangle.width ?? rectangle.w,
            height: rectangle.height ?? rectangle.h,
          })
        )
        : requestedDirtyRectangles.map((rectangle) => Object.freeze(rectangle));
      // Pixel bookkeeping follows the rendered result, not the mode:
      // texture deliveries have no pixels (every frame delivers), while
      // the WebGL 2 presentation fallback and pixel captures carry pixels
      // and diff like plain pixel frames.
      const pixelsChanged = rendered.pixels
        ? pixelsDifferInRectangles(
          this._lastPixels,
          rendered.pixels,
          rendered.width,
          dirtyRectangles,
        )
        : true;
      const elementAtIndex = new Array(serialized.nodes.length).fill(null);
      for (
        const [element, index] of serialized.indexOf
      ) elementAtIndex[index] = element;
      // ONE geometry family: the engine's returned boxes (physical layout
      // divided by device scale) are the paint-truth records for scroll
      // facts, scrollbar descriptors, snap, anchoring, and the interaction
      // snapshot. A caller-supplied renderer that reports no boxes keeps
      // the JS layout boxes for this frame instead.
      // The renderer's boxes carry the core's native snapshot of the rows
      // they were read from; the sliced copy keeps it so the presented
      // geometry build joins that snapshot instead of uploading every box
      // again. A host adjustment below (preserved scroll metrics) changes
      // the values and drops it.
      let boxSnapshot = null;
      if (rendered.boxes?.length) {
        // The pre-render layout pass (scroll anchoring, observers) left
        // its own snapshot on `boxes`; the renderer's replaces it.
        if (
          boxes !== rendered.boxes &&
          boxes[BOX_SNAPSHOT] !== rendered.boxes[BOX_SNAPSHOT]
        ) releaseBoxSnapshot(boxes);
        boxes = rendered.boxes.slice(0, serialized.nodes.length);
        const attached = rendered.boxes[BOX_SNAPSHOT];
        if (attached !== undefined && attached.count === boxes.length) {
          boxSnapshot = attached;
        }
        if (
          this._preservedScrollMetrics !== null &&
          this._preservedScrollMetrics.length === boxes.length &&
          this._animations.length === 0 &&
          this._cssAnimations.size === 0 &&
          this._pseudoContentAnimations.size === 0 &&
          this._activeTransitionCount === 0
        ) {
          boxes = boxes.map((box, index) => ({
            ...box,
            ...this._preservedScrollMetrics[index],
          }));
          boxSnapshot = null;
        }
      }
      let presentedBoxes = boxes;
      if (presentedBoxes.length === 0) {
        // A caller-supplied renderer that reports no boxes still presents a
        // frame; the snapshot needs geometry, so run the layout pass here.
        presentedBoxes = await this._layoutTreeBoxes({
          width: frameViewport.width,
          height: frameViewport.height,
          nodes: serialized.nodes,
          imageSources: serialized.imageSources,
        });
      }
      const laidOutHere = presentedBoxes !== boxes;
      presentedBoxes = presentedBoxes
        .slice(0, serialized.nodes.length)
        .map((box, index) => Object.freeze({ ...boxes[index], ...box }));
      if (
        boxSnapshot !== null && !laidOutHere &&
        boxSnapshot.count === presentedBoxes.length
      ) {
        presentedBoxes[BOX_SNAPSHOT] = boxSnapshot;
      }
      Object.freeze(presentedBoxes);
      const textGeometryByElement = new Map();
      const textGeometryByNode = new Map();
      // A retained scene with unchanged text keeps the presented frame's
      // glyph and caret geometry; only the scroll translation is refreshed.
      // Those entries are frozen and already complete, so the paint
      // artifact's text operations (present whenever the surface captures
      // paint artifacts) must not be accumulated onto them again.
      const reusedTextGeometry = (reuseTextGeometry ||
          (this._textSelectionEnabled &&
            rendered.performance?.preparation?.retained))
        ? this._presentedFrame?.textGeometryByNode ?? null
        : null;
      if (reusedTextGeometry !== null) {
        const reusedNodes = [...reusedTextGeometry.keys()];
        const shifts = contentShifts(reusedNodes);
        for (let index = 0; index < reusedNodes.length; index++) {
          const node = reusedNodes[index];
          const geometry = reusedTextGeometry.get(node);
          const shiftX = shifts === null ? 0 : shifts[index * 4];
          const shiftY = shifts === null ? 0 : shifts[index * 4 + 1];
          textGeometryByNode.set(node, {
            caretStops: geometry.caretStops,
            glyphs: geometry.glyphs,
            anchors: geometry.anchors,
            translationX: (geometry.translationX ?? 0) - shiftX,
            translationY: (geometry.translationY ?? 0) - shiftY,
          });
        }
      }
      const textOperations = reusedTextGeometry === null
        ? rendered.textGeometryArtifact?.operations ??
          rendered.paintArtifact?.operations ?? []
        : [];
      // A text node whose row was not lowered anew (same text, same
      // record) keeps the previous frame's glyph and caret geometry: those
      // objects are functions of the shaped run and the line boxes only.
      // The command stream paints in unscrolled coordinates (the raster
      // applies the scroll table), so the geometry stays valid while the
      // node's painted line rectangles keep their size, and a node whose
      // lines all moved by the same delta - the line above it was removed,
      // a paragraph was inserted before it - keeps them with that delta as
      // its translation. `anchors` carries the rectangles the glyph
      // coordinates were captured against, so the delta is measured from
      // the capture and never accumulates. This unscrolled line displacement
      // is combined with the absolute scroll shift of the published frame.
      const previousTextGeometry = textOperations.length > 0
        ? this._presentedFrame?.textGeometryByNode ?? null
        : null;
      const loweredRows = serialized.loweredRows === undefined
        ? null
        : new Set(serialized.loweredRows);
      const keptTextGeometry = new Set();
      // One eager pass: the operations of each text owner, in paint order.
      // Reading operation.glyphs builds a frozen object per glyph, so the
      // grouping uses the eager glyphCount and only a rebuild pays for it.
      const operationsByOwner = new Map();
      for (const operation of textOperations) {
        if (operation.kind !== "text" || operation.glyphCount === 0) continue;
        const sourceNode = serialized.nodes[operation.nodeIndex];
        const generated = sourceNode?.generatedOwnerIndex !== undefined;
        const owner = elementAtIndex[
          sourceNode?.generatedOwnerIndex ??
            operation.nodeIndex
        ];
        const textControl = owner?.localName === "input" ||
          owner?.localName === "textarea";
        const documentText = !generated && owner?.nodeType === 3 &&
          (owner === this._root || this._root.contains(owner));
        if (!textControl && !documentText) continue;
        const entry = operationsByOwner.get(owner);
        if (entry === undefined) {
          operationsByOwner.set(owner, {
            operations: [operation],
            keepable: !generated && owner.nodeType === 3 &&
              loweredRows !== null && !loweredRows.has(operation.nodeIndex),
          });
          continue;
        }
        entry.operations.push(operation);
        entry.keepable = entry.keepable && !generated &&
          !loweredRows.has(operation.nodeIndex);
      }
      // Captured line coordinates are unscrolled. Their successor snapshot
      // publishes THIS frame, so include committed offsets and the captured
      // pending deltas once; reused geometry already carries the former.
      const owners = [...operationsByOwner.keys()];
      const ownerShifts = contentShifts(owners);
      for (let ownerIndex = 0; ownerIndex < owners.length; ownerIndex++) {
        const owner = owners[ownerIndex];
        const { operations, keepable } = operationsByOwner.get(owner);
        const shiftX = ownerShifts === null
          ? 0
          : ownerShifts[ownerIndex * 4] + ownerShifts[ownerIndex * 4 + 2];
        const shiftY = ownerShifts === null
          ? 0
          : ownerShifts[ownerIndex * 4 + 1] + ownerShifts[ownerIndex * 4 + 3];
        const previous = keepable && previousTextGeometry !== null
          ? previousTextGeometry.get(owner)
          : undefined;
        const kept = previous === undefined
          ? null
          : keptTextGeometryFor(previous, operations);
        if (kept !== null) {
          textGeometryByNode.set(
            owner,
            shiftX === 0 && shiftY === 0 ? kept : Object.freeze({
              ...kept,
              translationX: (kept.translationX ?? 0) - shiftX,
              translationY: (kept.translationY ?? 0) - shiftY,
            }),
          );
          keptTextGeometry.add(owner);
          continue;
        }
        const anchors = new Float64Array(operations.length * 4);
        const geometry = {
          caretStops: [],
          glyphs: [],
          anchors,
          translationX: -shiftX,
          translationY: -shiftY,
        };
        textGeometryByNode.set(owner, geometry);
        for (let index = 0; index < operations.length; index++) {
          const operation = operations[index];
          const rectangle = operation.logicalRectangle;
          anchors[index * 4] = rectangle.x;
          anchors[index * 4 + 1] = rectangle.y;
          anchors[index * 4 + 2] = rectangle.width;
          anchors[index * 4 + 3] = rectangle.height;
          const top = rectangle.y;
          const bottom = top + rectangle.height;
          for (const glyph of operation.glyphs) {
            geometry.glyphs.push(Object.freeze({
              sourceStart: glyph.sourceStart,
              sourceEnd: glyph.sourceEnd,
              x: glyph.x,
              width: glyph.width,
              top,
              bottom,
            }));
            geometry.caretStops.push(
              Object.freeze({
                sourceOffset: glyph.sourceStart,
                x: glyph.x,
                top,
                bottom,
                affinity: "downstream",
              }),
              Object.freeze({
                sourceOffset: glyph.sourceEnd,
                x: glyph.x + glyph.width,
                top,
                bottom,
                affinity: "upstream",
              }),
            );
          }
        }
      }
      for (const [node, geometry] of textGeometryByNode) {
        if (keptTextGeometry.has(node)) continue;
        const uniqueStops = uniqueCaretStops(node, geometry.caretStops);
        const baseGeometry = {
          caretStops: Object.freeze(uniqueStops),
          glyphs: Object.freeze(geometry.glyphs),
          anchors: geometry.anchors,
          translationX: geometry.translationX ?? 0,
          translationY: geometry.translationY ?? 0,
        };
        if (node.nodeType === 3) {
          textGeometryByNode.set(node, Object.freeze(baseGeometry));
          continue;
        }
        const selectionStart = node.selectionStart ?? node.value.length;
        const selectionEnd = node.selectionEnd ?? selectionStart;
        const controlSelectionRects = selectionRectanglesForText(
          node,
          baseGeometry,
          selectionStart,
          selectionEnd,
        );
        const controlGeometry = Object.freeze({
          ...baseGeometry,
          selectionStart,
          selectionEnd,
          selectionRectangles: controlSelectionRects,
        });
        textGeometryByNode.set(node, controlGeometry);
        textGeometryByElement.set(node, controlGeometry);
      }
      const preparedState = Object.freeze({
        scene: Object.freeze({
          width: scene.width,
          height: scene.height,
          nodes: Object.freeze(scene.nodes),
        }),
        serialized,
        boxes: Object.freeze(boxes),
      });
      const acceptState = (geometryHandle) => {
        const completedScrollTargets = this._acceptScrollFeedback(
          serialized,
          effectiveBoxes,
          capturedScrollRequests,
        );
        this._scrollbars = scrollbars;
        this._documentSelectionRects = documentSelectionRects;
        this._indexOfElement = serialized.indexOf;
        this._elementAtIndex = elementAtIndex;
        this._refreshScrollAnchors(serialized, boxes, geometryHandle);
        this._lastBoxes = boxes;
        this._preparedState = preparedState;
        return completedScrollTargets;
      };
      if (!forceDelivery && !pixelsChanged) {
        this._frameResume(continuation, publicationToken, 0, -1, frameBindings);
        core.status("frame_finish", continuation);
        accepted = true;
        for (const target of acceptState()) {
          dispatchEvent(target, createEvent("scroll"));
          this._pendingScrollEndTargets.add(target);
        }
        if (resizeObserverLoopError) {
          throw new Error(
            "ResizeObserver loop completed with undelivered notifications",
          );
        }
        return null;
      }

      // A texture delivery publishes no CPU pixels: rendered.pixels is
      // absent and the retained _lastPixels (a prior on-demand capture)
      // describes an older frame, never this one.
      let retainedPixels = this._lastPixels;
      let pixels = rendered.pixels ? retainedPixels : null;
      if (pixelsChanged && rendered.pixels) {
        if (snapshotPixels || retainedPixels === null) {
          retainedPixels = rendered.pixels.slice();
        } else {
          for (const rectangle of dirtyRectangles) {
            const left = Math.max(0, rectangle.x);
            const top = Math.max(0, rectangle.y);
            const right = Math.min(
              rendered.width,
              rectangle.x + rectangle.width,
            );
            const bottom = Math.min(
              rendered.height,
              rectangle.y + rectangle.height,
            );
            for (let row = top; row < bottom; row++) {
              const start = (row * rendered.width + left) * 4;
              retainedPixels.set(
                rendered.pixels.subarray(start, start + (right - left) * 4),
                start,
              );
            }
          }
        }
        pixels = snapshotPixels ? retainedPixels : rendered.pixels;
      }
      if (this._shutdown) return null;
      const successor = buildInteractionSnapshot({
        sourceRevisions,
        publication: serialized.publication,
        root: this._root,
        viewport: frameViewport,
        viewportIndex: serialized.viewportIndex ?? 0,
        revision: this._frameSequence + 1,
        boxes: presentedBoxes,
        scrollbars,
        timeMilliseconds,
        textGeometryByElement,
        textGeometryByNode,
      });
      let successorPublished = false;
      releaseUnpublishedSuccessor = () => {
        if (!successorPublished) successor.geometry.release();
      };
      core.status("frame_publish", continuation, successor.geometryHandle);
      this._frameResume(continuation, publicationToken, 0, -1, frameBindings);
      const framePreparedAt = renderSurfaceNow();
      // PNG bytes are encoded lazily: nothing pays for the encode unless a
      // consumer reads frame.png, and only a retained snapshot (never the
      // renderer's live buffer) is stable enough to encode later. The
      // accessor is non-enumerable so spreading a frame copies its fields
      // without forcing the encode.
      const encodePng = pixels !== null && pixels === retainedPixels
        ? this._encodePixels
        : null;
      let png = encodePng === null ? null : undefined;
      const frame = Object.freeze(Object.defineProperty(
        {
          pixels,
          rowStride: rendered.rowStride,
          channelLayout: rendered.channelLayout,
          sampleType: rendered.sampleType,
          bitsPerSample: rendered.bitsPerSample,
          colorEncoding: rendered.colorEncoding,
          alphaMode: rendered.alphaMode,
          metadata: rendered.metadata,
          width: rendered.width,
          height: rendered.height,
          deviceScale: frameViewport.deviceScale,
          graphicsBackend: rendered.graphicsBackend,
          graphicsBackendInfo: rendered.graphicsBackendInfo,
          dirtyRectangles,
          readbackByteLength: rendered.readbackByteLength,
          frameSequence: this._frameSequence + 1,
          scrollbars: Object.freeze(
            scrollbars.map((scrollbar) => Object.freeze({ ...scrollbar })),
          ),
          timeMilliseconds,
          renderTimings: Object.freeze({
            preparationMilliseconds: rasterStartedAt - renderStartedAt,
            rendererWaitMilliseconds: rendererReadyAt === null
              ? 0
              : rendererReadyAt - rasterStartedAt,
            resizeMilliseconds: rendererResizedAt === null
              ? 0
              : rendererResizedAt - rendererReadyAt,
            visibleRectangleMilliseconds: visibleRectangleSetAt === null
              ? 0
              : visibleRectangleSetAt - rendererResizedAt,
            rasterMilliseconds: rasterFinishedAt -
              (visibleRectangleSetAt ?? rasterStartedAt),
            postprocessMilliseconds: framePreparedAt - rasterFinishedAt,
          }),
          ...(this._capturePaintArtifact
            ? {
              inspection: Object.freeze({
                sceneNodes: Object.freeze(serialized.nodes),
                elementAtIndex: Object.freeze(elementAtIndex),
                layoutBoxes: Object.freeze(
                  rendered.boxes
                    .slice(0, serialized.nodes.length)
                    .map((box) => Object.freeze({ ...box })),
                ),
                paintArtifact: rendered.paintArtifact,
              }),
            }
            : {}),
        },
        "png",
        {
          get() {
            if (png === undefined) {
              png = encodePng(pixels, rendered.width, rendered.height);
            }
            return png;
          },
        },
      ));
      let completedScrollTargets = [];
      const publish = () => {
        // Native frame state is released when superseded, not when the
        // collector notices: a geometry snapshot and a publication are
        // megabytes each on a text-bearing page, and WebAssembly memory
        // exerts no pressure on the JavaScript heap.
        const superseded = this._presentedFrame;
        const supersededSerialized = this._preparedState?.serialized ?? null;
        this._lastPixels = retainedPixels;
        this._lastDeliveredFrame = frame;
        this._lastRendered = rendered;
        this._presentedFrame = successor;
        successorPublished = true;
        core.status(
          "scroll_presented",
          this._scrollOwner,
          successor.geometryHandle,
        );
        completedScrollTargets = acceptState(successor.geometryHandle);
        if (superseded !== null && superseded !== successor) {
          superseded.geometry.release();
          const supersededSnapshot = superseded._inputBoxes?.[BOX_SNAPSHOT];
          if (
            supersededSnapshot !== undefined &&
            supersededSnapshot !== successor._inputBoxes[BOX_SNAPSHOT] &&
            supersededSnapshot !== boxes[BOX_SNAPSHOT]
          ) {
            releaseBoxSnapshot(superseded._inputBoxes);
          }
        }
        if (
          supersededSerialized !== null &&
          supersededSerialized.publication !== serialized.publication
        ) {
          supersededSerialized.release();
          if (supersededSerialized.nodes !== serialized.nodes) {
            core.releaseSceneResources(supersededSerialized.nodes);
          }
        }
        this._frameSequence = frame.frameSequence;
        this._stageCounters.deliveredFrames++;
      };
      const notify = () => {
        for (const target of completedScrollTargets) {
          dispatchEvent(target, createEvent("scroll"));
          this._pendingScrollEndTargets.add(target);
        }
        this._notifyFrameListeners(frame, resizeObserverLoopError);
      };
      if (this._frameTransaction) {
        this._stagedFrame = {
          handle: continuation,
          revision: BigInt(frame.frameSequence),
          snapshot: successor,
          frame,
          publish,
          notify,
          present: pendingPresentation,
          rollback,
          scrollCapture: capturedScrollRequests,
          dispose: () => {
            capturedScrollRequests.release();
            core.status("frame_dispose", continuation);
            releaseUnpublishedSuccessor();
          },
        };
        accepted = true;
      } else {
        core.status("frame_commit", continuation, BigInt(frame.frameSequence));
        accepted = true;
        publish();
        this._presentingFrame = true;
        try {
          await pendingPresentation?.();
        } finally {
          this._presentingFrame = false;
        }
        notify();
      }
      return frame;
    } finally {
      if (!accepted) rollback();
      if (!accepted) releaseUnpublishedSuccessor?.();
      if (ownsContinuation && !this._stagedFrame) {
        core.status("frame_dispose", continuation);
      }
      if (capturedScrollRequests !== this._stagedFrame?.scrollCapture) {
        capturedScrollRequests?.release();
      }
      this._eventElementAtIndex = null;
      this._stageCounters.currentStage = "idle";
      this._rendering = false;
      if (this._snapCheckOwed && !this._dirty) {
        this._snapCheckOwed = false;
        this._snapCheckPending = this._snapCheckPending ||
          this._snappedTargets.size > 0 || this._snapContainers().length > 0;
      }
      const idleWaiters = this._idleWaiters.splice(0);
      for (const resolve of idleWaiters) resolve();
      if (this._hasActiveAnimationWork() || this._scrollMomentum) {
        this._dirty = true;
      }
      if (pixelReadback && this._presentFrame !== null) {
        // The capture bypassed presentation delivery; schedule one
        // presentation frame so the presenter shows the captured state.
        // The engine is clean after the capture, so that frame reuses the
        // retained texture (webgpu) or re-delivers pixels (webgl2).
        this._dirty = true;
      }
      this._schedule();
    }
  }
  inspectMotion() {
    if (this._shutdown) throw new Error("render surface is shut down");
    return createMotionModel(this).inspection;
  }

  prepareNow({ deliverObservers = true } = {}) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (this._frameTransaction) return Promise.resolve(this._preparedState);
    return this._render(
      this._currentTime,
      true,
      false,
      false,
      deliverObservers,
    );
  }

  async *captureFrames({
    frameBudget,
    durationMilliseconds,
  } = {}) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (this._running || this._frameRequest !== null) {
      throw new Error("captureFrames() requires a stopped render surface");
    }
    if (this._capturingFrames) {
      throw new Error("captureFrames() is already active");
    }
    if (!Number.isInteger(frameBudget) || frameBudget <= 0) {
      throw new RangeError("frameBudget must be a positive integer");
    }
    const model = createMotionModel(this);
    if (model.inspection.classification === "external") {
      throw new Error(
        "captureFrames() requires a progress schedule for an external timeline",
      );
    }
    if (model.inspection.classification === "static") return;
    const captureDuration = durationMilliseconds ??
      model.inspection.finiteDurationMilliseconds;
    if (!Number.isFinite(captureDuration) || captureDuration <= 0) {
      throw new RangeError(
        "durationMilliseconds must bound an unbounded animation",
      );
    }
    const startTime = this.currentTime;
    const endTime = startTime + captureDuration;
    if (!model.exports.schedule_prepare(startTime, endTime, frameBudget)) {
      throw new Error(
        `Cannot prepare frame schedule: WebAssembly error ${model.exports.motion_error()}`,
      );
    }
    for (const effect of model.scheduleEffects) {
      if (!effect.progressing || effect.external) continue;
      if (!model.exports.schedule_add_effect(effect.effectIndex)) {
        throw new Error(
          `Cannot add effect schedule: WebAssembly error ${model.exports.motion_error()}`,
        );
      }
      for (const keyframe of effect.keyframes) {
        if (
          !model.exports.schedule_add_keyframe(
            effect.effectIndex,
            keyframe.offset,
            effect.discrete ? 1 : 0,
          )
        ) {
          throw new Error(
            `Cannot add keyframe schedule: WebAssembly error ${model.exports.motion_error()}`,
          );
        }
      }
    }
    if (!model.exports.schedule_finalize()) {
      const requiredMinimum = model.exports.schedule_count();
      throw new RangeError(
        `frameBudget ${frameBudget} is below the ${requiredMinimum} mandatory samples`,
      );
    }

    this._capturingFrames = true;
    try {
      const sampleCount = model.exports.schedule_count();
      for (let sequence = 0; sequence + 1 < sampleCount; sequence++) {
        const timeMilliseconds = model.exports.schedule_time(sequence);
        const nextTimeMilliseconds = model.exports.schedule_time(sequence + 1);
        const frame = await this._renderOpportunity(
          timeMilliseconds,
          true,
          false,
        );
        yield Object.freeze({
          sequence,
          timeMilliseconds,
          durationMilliseconds: nextTimeMilliseconds - timeMilliseconds,
          width: frame?.width ?? Math.trunc(
            (this._visibleRectangle?.width ?? this.viewport.width) *
              this.viewport.deviceScale,
          ),
          height: frame?.height ?? Math.trunc(
            (this._visibleRectangle?.height ?? this.viewport.height) *
              this.viewport.deviceScale,
          ),
          pixels: frame?.pixels ?? this._lastPixels,
          dirtyRectangles: frame?.dirtyRectangles ?? Object.freeze([]),
          pixelStorage: "borrowed",
          readbackByteLength: frame?.readbackByteLength ?? 0,
        });
      }
      await this._renderOpportunity(endTime, true, false);
    } finally {
      this._capturingFrames = false;
    }
  }

  whenIdle() {
    if (!this._rendering) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  renderNow({ pixelReadback = false, _transaction = null } = {}) {
    if (this._shutdown) throw new Error("render surface is shut down");
    return this._renderOpportunity(
      this._now(),
      true,
      true,
      pixelReadback,
      _transaction,
    );
  }

  renderForPresentation(timeMilliseconds = this._now()) {
    if (this._shutdown) throw new Error("render surface is shut down");
    return this._renderOpportunity(timeMilliseconds, true, false);
  }

  tick(timeMilliseconds) {
    if (this._shutdown) throw new Error("render surface is shut down");
    return this._renderOpportunity(timeMilliseconds, false);
  }

  start() {
    if (this._shutdown) throw new Error("render surface is shut down");
    this._running = true;
    this._schedule();
  }

  stop() {
    if (this._shutdown) return;
    this._running = false;
    if (this._frameRequest !== null) {
      this._cancelFrame(this._frameRequest);
      this._frameRequest = null;
    }
  }

  replaceRoot(nextRoot) {
    if (this._shutdown) throw new Error("render surface is shut down");
    nextRoot = resolveSurfaceRoot(nextRoot, "replaceRoot");
    if (nextRoot.parentElement) {
      throw new Error("replaceRoot: next root must be detached");
    }
    if (nextRoot._renderSurface && nextRoot._renderSurface !== this) {
      throw new Error("replaceRoot: next root belongs to another live surface");
    }
    const nextRegistry = nextRoot._renderSurfaces ??= new Map();
    const nextOccupant = nextRegistry.get(this._environmentKey);
    if (nextOccupant && nextOccupant !== this) {
      throw new Error(
        `replaceRoot: next root already has a live render surface for ` +
          `environment ${this._environmentKey}`,
      );
    }
    if (this._persistentRenderer && this._indexOfElement.size > 0) {
      this._persistentRenderer.remapAnimations(new Map());
      this._animations.length = 0;
      this._animationsAwaitingTimeline.clear();
    }
    const previousRegistry = this._root._renderSurfaces;
    const wasPrimary = this._root._renderSurface === this;
    this._disconnectSubtree(this._root);
    previousRegistry?.delete(this._environmentKey);
    if (wasPrimary) {
      previousRegistry?.values().next().value?._connectSubtree(this._root);
    }
    this._frameCore.status("frame_surface_dispose", this._frameOwner);
    this._frameCore = nextRoot._domCore;
    this._frameOwner = this._frameCore.status(
      "frame_surface_create",
      nextRoot._coreHandle,
    );
    this._frameBindings = createFrameBindings(this._frameCore);
    this._root = nextRoot;
    nextRegistry.set(this._environmentKey, this);
    this._connectSubtree(nextRoot);
    this.viewport.root = nextRoot;
    this._indexOfElement = new Map();
    this._elementAtIndex = [];
    this._presentedFrame = null;
    this._lastDeliveredFrame = null;
    this._lastRendered = null;
    this._documentSelectionRects = [];
    this._selectionChanged = false;
    this._preservedScrollMetrics = null;
    this._scrollAnchors.clear();
    this._anchoringSuppressionProperties.clear();
    this._positionSuppressionNodes.clear();
    this._pendingSnapOrigins.clear();
    this._snappedTargets.clear();
    this._snapCheckPending = false;
    this._snapCheckOwed = true;
    this._smoothScrolls.clear();
    this._forceFullInvalidation = true;
    this._dirty = true;
    this._schedule();
  }

  async shutdown() {
    if (this._shutdown) return;
    this.stop();
    this._shutdown = true;
    if (!this._presentingFrame) await this.whenIdle();
    this._scrollAnchors.clear();
    this._anchoringSuppressionProperties.clear();
    this._positionSuppressionNodes.clear();
    this._animationEventUnsubscribe?.();
    for (const animation of this._animations) animation._engineHandle.cancel();
    this._animations.length = 0;
    this._animationsAwaitingTimeline.clear();
    const surfaceRegistry = this._root._renderSurfaces;
    const wasPrimary = this._root._renderSurface === this;
    this._disconnectSubtree(this._root);
    surfaceRegistry?.delete(this._environmentKey);
    if (wasPrimary) {
      // Promote any remaining surface over this root to primary: it claims
      // the node _renderSurface slots the shutdown just released.
      surfaceRegistry?.values().next().value?._connectSubtree(this._root);
    }
    const ownerDocument = this._root.ownerDocument;
    if (ownerDocument?._componentRenderSurface === this) {
      ownerDocument._componentRenderSurface =
        surfaceRegistry?.values().next().value ?? null;
    }
    const animationFrameCheckpoint = this._animationFrameCore.status(
      "animation_frame_surface_dispose",
      this._animationFrameOwner,
    );
    if (animationFrameCheckpoint) {
      this._releaseDocumentAnimationFrameCheckpoint(animationFrameCheckpoint);
    }
    this._frameCore.status("frame_surface_dispose", this._frameOwner);
    this.viewport._surface = null;
    this.viewport.root = null;
    this._activeTransitionCount = 0;
    this._frameListeners.length = 0;
    this._indexOfElement = new Map();
    this._lastPixels = null;
    this._lastDeliveredFrame = null;
    this._lastRendered = null;
    this._lastBoxes = [];
    this._presentedFrame = null;
    this._mutatedNodes.clear();
    this._forcedGenerationNodes.clear();
    this._selectionChanged = false;
    this._transformOnlyMutations.clear();
    this._hasNonTransformMutation = false;
    this._pendingSnapOrigins.clear();
    this._snappedTargets.clear();
    this._snapCheckPending = false;
    this._forceStateDelivery = false;
    this._pendingScrollSources.clear();
    this._pendingScrollEndTargets.clear();
    this._smoothScrolls.clear();
    this._scrollGeometry?.imported.release();
    this._scrollGeometry = null;
    this._root._domCore.status("scroll_owner_release", this._scrollOwner);
    this._scrollOwner = 0n;
    if (this._persistentRendererPromise) {
      await (await this._persistentRendererPromise).shutdown();
    }
    this._releaseSyncLayout();
    this._frameCore.releaseSceneResources(
      this._preparedState?.serialized?.nodes,
    );
    this._preparedState?.serialized?.release?.();
    this._preparedState = null;
    this._scrollbars = [];
    for (const declaration of this._pendingAnimationDeclarations) {
      declaration.release?.();
    }
    this._pendingAnimationDeclarations.length = 0;
  }
}
