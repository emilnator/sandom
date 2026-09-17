// Device viewer worker.
//
// Sibling of browser-preview-worker.js with a different presentation: the
// sandom document renders through the same prepared-input and render-surface
// path, but instead of blitting the frame to the canvas, the frame's live
// GPU texture is sampled by the device scene (see device-scene.js) on the
// same GPUDevice — zero copies. The worker owns its own animation loop so
// the device keeps rotating between sandom frames.
//
// The worker is persistent. One shared persistent scene renderer (one
// runtime, one GPUDevice, one shader compilation) outlives every document
// and device change:
//
// - set-input replaces only the document session; the active scene keeps
//   spinning and shows the previous frame until the new document's first
//   frame arrives.
// - set-model swaps to a per-device scene cached on the shared GPUDevice;
//   model geometry parses once and pipelines compile once per device.
//
// Only stop (or worker termination) releases the renderer and the scenes.

import { startPreparedRenderSurface } from "../render-animation.js";
import { createSceneRendererForCurrentModule, releaseRenderContexts } from "../../scene-renderer.js";
import {
  prepareBrowserRenderInput,
  serializeBrowserWorkerError,
} from "../browser-render-worker-runtime.js";
import { parseDeviceGLB } from "./device-model.js";
import { createDeviceScene } from "./device-scene.js";
import { DocumentSession } from "../document-session.js";
import { enqueueInputRecord } from "../interaction.js";
import {
  DEVICE_VIEWER_APPLIED_KIND,
  DEVICE_VIEWER_CURSOR_KIND,
  DEVICE_VIEWER_ERROR_KIND,
  DEVICE_VIEWER_POINTER_KIND,
  DEVICE_VIEWER_PROTOCOL_VERSION,
  DEVICE_VIEWER_READY_KIND,
  DEVICE_VIEWER_RESIZE_KIND,
  DEVICE_VIEWER_SET_INPUT_KIND,
  DEVICE_VIEWER_SET_MODEL_KIND,
  DEVICE_VIEWER_START_KIND,
  DEVICE_VIEWER_STOP_KIND,
} from "./device-viewer-worker-protocol.js";

let canvas = null;
let session = null;
let preparedInput = null;
let activeScene = null;
let animationFrame = null;
let currentModel = null;
let currentViewport = null;
const primitiveCache = new Map();
const sceneCache = new Map();
// Last known yaw per model key, so a scene rebuilt after a GPUDevice
// replacement resumes at the orientation it was showing.
const sceneYaw = new Map();
// Document interaction (design/interaction.md): a DocumentSession wraps
// the presented document; pointer input that hits the screen plane
// dispatches through it in Real mode.
let interaction = null;
// Pixels per CSS pixel of the presenting canvas; orbit drag speed is
// calibrated in CSS pixels.
let pixelScale = 1;
// Physical pointers currently orbiting the device (missed the screen on
// pointer-down) and pointers bound to the document (hit the screen).
const orbitPointers = new Map();
const documentPointers = new Set();
// Pointers currently hovering the screen, to emit pointer-leave once.
const hoverPointers = new Set();
let pendingInputRecords = [];
let inputDispatchScheduled = false;

// One shared persistent renderer for the worker's lifetime. The render
// surface owns its renderer and shuts it down with the surface, so each
// surface receives a wrapper whose shutdown is a no-op; the worker's own
// teardown performs the real shutdown.
let sharedRendererPromise = null;
function sharedPersistentRenderer(options) {
  if (sharedRendererPromise === null) {
    sharedRendererPromise = createSceneRendererForCurrentModule(options)
      .then((renderer) => ({
        renderer,
        wrapper: Object.freeze({ ...renderer, shutdown: async () => {} }),
      }));
  }
  return sharedRendererPromise.then((shared) => shared.wrapper);
}

function renderLoop(timeMilliseconds) {
  animationFrame = null;
  if (activeScene === null) return;
  activeScene.render(timeMilliseconds);
  animationFrame = requestAnimationFrame(renderLoop);
}

function validateViewport(viewport) {
  const { width, height, deviceScale = 1 } = viewport ?? {};
  if (
    !Number.isInteger(width) || width <= 0 ||
    !Number.isInteger(height) || height <= 0 ||
    !(Number.isFinite(deviceScale) && deviceScale > 0)
  ) {
    throw new RangeError("Device viewer document viewport is invalid");
  }
  return { width, height, deviceScale };
}

function modelPrimitives(model) {
  if (typeof model?.key !== "string" || model.key.length === 0) {
    throw new TypeError("Device viewer model requires a key");
  }
  let primitives = primitiveCache.get(model.key);
  if (primitives === undefined) {
    if (!(model.glb instanceof Uint8Array)) {
      throw new TypeError(
        `Device viewer model ${JSON.stringify(model.key)} requires GLB bytes`,
      );
    }
    primitives = parseDeviceGLB(model.glb);
    primitiveCache.set(model.key, primitives);
  }
  return primitives;
}

async function releaseSession() {
  if (interaction !== null) {
    const releasing = interaction;
    interaction = null;
    await releasing.session.dispose();
  }
  documentPointers.clear();
  hoverPointers.clear();
  pendingInputRecords = [];
  if (session !== null) {
    const releasing = session;
    session = null;
    await releasing.release();
  }
  if (preparedInput !== null) {
    const releasing = preparedInput;
    preparedInput = null;
    await releasing.release();
  }
}

// Replace the document session (and, when the model changed, the active
// scene). When the document viewport is unchanged (a source edit), the
// shared renderer's GPUDevice survives and the previous scene keeps
// rendering the previous frame until the new document presents — fully
// live. When the viewport changes (a device switch), the renderer
// DESTROYS its GPUDevice and creates a new one (scene-renderer resize),
// so the loop pauses first and every cached scene whose device died is
// rebuilt on the next presented frame, preserving its yaw.
async function applySession(message) {
  const viewport = validateViewport(message.viewport);
  const model = message.model ?? currentModel;
  if (model === null) {
    throw new TypeError("Device viewer has no model");
  }
  const primitives = modelPrimitives(model);
  const screen = model.screen;
  if (
    screen === null || typeof screen !== "object" ||
    !Array.isArray(screen.center)
  ) {
    throw new TypeError("Device viewer requires the screen record");
  }
  const viewportChanges = currentViewport === null ||
    currentViewport.width !== viewport.width ||
    currentViewport.height !== viewport.height ||
    currentViewport.deviceScale !== viewport.deviceScale;
  if (viewportChanges) {
    // The renderer is about to destroy its GPUDevice: nothing may keep
    // submitting work on it.
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    activeScene = null;
  }
  await releaseSession();
  const nextPreparedInput = await prepareBrowserRenderInput(message);
  const pose = model.pose === "grounded" ? "grounded" : "standing";
  try {
    session = await startPreparedRenderSurface(nextPreparedInput, {
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      deviceScale: viewport.deviceScale,
      encodePixels: null,
      createPersistentRenderer: sharedPersistentRenderer,
      presentFrame(rendered) {
        let scene = sceneCache.get(model.key);
        if (scene !== undefined && scene.device !== rendered.device) {
          // The renderer replaced its GPUDevice; the cached scene's
          // resources died with the old one. Rebuild at the same yaw.
          const yaw = scene.currentYaw();
          scene.destroy();
          sceneCache.delete(model.key);
          if (activeScene === scene) activeScene = null;
          scene = undefined;
          sceneYaw.set(model.key, yaw);
        }
        if (scene === undefined) {
          scene = createDeviceScene({
            device: rendered.device,
            canvas,
            primitives,
            screen,
            pose,
            initialYaw: sceneYaw.get(model.key) ?? undefined,
          });
          sceneCache.set(model.key, scene);
        }
        if (activeScene !== scene) {
          activeScene = scene;
          scene.activate();
        }
        scene.setScreenTexture(rendered.textureImage);
        if (animationFrame === null) {
          animationFrame = requestAnimationFrame(renderLoop);
        }
      },
    });
  } catch (error) {
    await nextPreparedInput.release();
    throw error;
  }
  // From here releaseSession owns the cleanup of both.
  preparedInput = nextPreparedInput;
  // Real-mode interaction over the presented document: the session's
  // target adapts the LIVE surface (the desktop document worker's
  // pattern), so dispatched input mutates the same frames the device
  // screen samples.
  const documentSession = new DocumentSession({
    document: nextPreparedInput.document,
    release: async () => {},
  });
  const surface = session.surface;
  const target = documentSession.attachTarget({
    interactionMode: "real",
    environment: {
      width: viewport.width,
      height: viewport.height,
      deviceScale: viewport.deviceScale,
    },
    createSurface: () => ({
      root: nextPreparedInput.document.documentElement,
      viewport: surface.viewport,
      _shutdown: false,
      get presentedFrame() {
        return surface.presentedFrame;
      },
      get scrollbars() {
        return surface.scrollbars;
      },
      renderNow: () => surface.renderNow(),
      start() {},
      shutdown() {
        return Promise.resolve();
      },
    }),
  });
  await documentSession.render(target);
  interaction = { session: documentSession, target };
  currentModel = { key: model.key, screen, pose };
  currentViewport = viewport;
}

async function stopEverything() {
  if (animationFrame !== null) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
  activeScene = null;
  await releaseSession();
  for (const scene of sceneCache.values()) scene.destroy();
  sceneCache.clear();
  primitiveCache.clear();
  sceneYaw.clear();
  currentModel = null;
  currentViewport = null;
  if (sharedRendererPromise !== null) {
    const shared = await sharedRendererPromise;
    sharedRendererPromise = null;
    await shared.renderer.shutdown();
    await releaseRenderContexts();
  }
}

// ---------------------------------------------------------------------
// Pointer forwarding: the element streams raw canvas-pixel pointer facts;
// the scene raycasts them onto the screen plane. A pointer-down that hits
// the screen binds that pointer to the document (hover, press, drag); a
// miss binds it to the orbit drag. Wheel over the screen scrolls the
// document. Records dispatch through the DocumentSession in coalesced
// batches, following the interactive renderer element.

const DRAG_RADIANS_PER_CSS_PIXEL = 0.008;

function viewportPoint(screenPoint) {
  return {
    x: screenPoint.x * currentViewport.width,
    y: screenPoint.y * currentViewport.height,
  };
}

function pointerRecord(kind, message, point) {
  return {
    kind,
    pointerId: message.pointerId,
    pointerType: message.pointerType || "mouse",
    isPrimary: message.isPrimary,
    button: message.button,
    buttons: message.buttons,
    x: point.x,
    y: point.y,
    pressure: message.pressure,
    altKey: message.altKey,
    controlKey: message.controlKey,
    metaKey: message.metaKey,
    shiftKey: message.shiftKey,
    timeMilliseconds: message.timeMilliseconds,
  };
}

function scheduleInputDispatch() {
  if (inputDispatchScheduled) return;
  inputDispatchScheduled = true;
  queueMicrotask(async () => {
    const records = pendingInputRecords;
    pendingInputRecords = [];
    if (records.length === 0 || interaction === null) {
      inputDispatchScheduled = false;
      return;
    }
    const { session: documentSession, target } = interaction;
    try {
      const status = documentSession.targetStatus(target);
      const placement = status.placements[0];
      const result = await documentSession.dispatchInputBatch({
        target,
        placement: placement.identifier,
        expectedPresentationRevision: status.presentationRevision,
        expectedInteractionRevision: placement.interactionRevision,
        records,
      });
      self.postMessage({
        kind: DEVICE_VIEWER_CURSOR_KIND,
        version: DEVICE_VIEWER_PROTOCOL_VERSION,
        identifier: null,
        cursor: result.cursor,
      });
    } finally {
      inputDispatchScheduled = false;
      if (pendingInputRecords.length > 0) scheduleInputDispatch();
    }
  });
}

function handlePointer(message) {
  if (activeScene === null || currentViewport === null) return;
  // Any pointer activity over the stage holds the idle rotation, so the
  // device stands still while the user reads, hovers, or scrolls it.
  activeScene.orbitBy(0, performance.now());
  const { action, pointerId } = message;
  if (action === "wheel") {
    const hit = activeScene.screenPointFromCanvas(
      message.canvasX,
      message.canvasY,
    );
    if (hit === null || !hit.inside || interaction === null) return;
    const point = viewportPoint(hit);
    pendingInputRecords.push({
      kind: "wheel",
      x: point.x,
      y: point.y,
      deltaX: message.deltaX,
      deltaY: message.deltaY,
      deltaMode: message.deltaMode,
      altKey: message.altKey,
      controlKey: message.controlKey,
      metaKey: message.metaKey,
      shiftKey: message.shiftKey,
    });
    scheduleInputDispatch();
    return;
  }
  if (action === "cancel") {
    orbitPointers.delete(pointerId);
    hoverPointers.delete(pointerId);
    if (documentPointers.delete(pointerId)) {
      pendingInputRecords.push({ kind: "pointer-cancel", pointerId });
      scheduleInputDispatch();
    }
    return;
  }
  const hit = activeScene.screenPointFromCanvas(
    message.canvasX,
    message.canvasY,
  );
  if (action === "down") {
    if (hit !== null && hit.inside && interaction !== null) {
      documentPointers.add(pointerId);
      enqueueInputRecord(
        pendingInputRecords,
        pointerRecord("pointer-down", message, viewportPoint(hit)),
      );
      scheduleInputDispatch();
    } else {
      orbitPointers.set(pointerId, message.canvasX);
    }
    return;
  }
  if (action === "move") {
    if (orbitPointers.has(pointerId)) {
      const lastX = orbitPointers.get(pointerId);
      orbitPointers.set(pointerId, message.canvasX);
      activeScene.orbitBy(
        (message.canvasX - lastX) * DRAG_RADIANS_PER_CSS_PIXEL / pixelScale,
        performance.now(),
      );
      return;
    }
    if (interaction === null) return;
    if (documentPointers.has(pointerId)) {
      // A captured drag keeps streaming even off the plate; the raycast
      // clamps to the screen rectangle.
      if (hit === null) return;
      enqueueInputRecord(
        pendingInputRecords,
        pointerRecord("pointer-move", message, viewportPoint(hit)),
      );
      scheduleInputDispatch();
      return;
    }
    // Unpressed hover: forward while over the screen and emit one
    // pointer-leave when the pointer slides off it.
    if (hit !== null && hit.inside) {
      hoverPointers.add(pointerId);
      enqueueInputRecord(
        pendingInputRecords,
        pointerRecord("pointer-move", message, viewportPoint(hit)),
      );
      scheduleInputDispatch();
    } else if (hoverPointers.delete(pointerId)) {
      pendingInputRecords.push({ kind: "pointer-leave", pointerId });
      scheduleInputDispatch();
    }
    return;
  }
  if (action === "up") {
    orbitPointers.delete(pointerId);
    if (documentPointers.delete(pointerId) && interaction !== null) {
      if (hit !== null) {
        enqueueInputRecord(
          pendingInputRecords,
          pointerRecord("pointer-up", message, viewportPoint(hit)),
        );
      } else {
        // The plane is edge-on or behind: a dropped up would leave the
        // document with a stuck pressed pointer, so cancel the sequence.
        pendingInputRecords.push({ kind: "pointer-cancel", pointerId });
      }
      scheduleInputDispatch();
    }
    return;
  }
  if (action === "leave") {
    if (
      !documentPointers.has(pointerId) && hoverPointers.delete(pointerId)
    ) {
      pendingInputRecords.push({ kind: "pointer-leave", pointerId });
      scheduleInputDispatch();
    }
    return;
  }
  throw new TypeError(`Unknown pointer action ${JSON.stringify(action)}`);
}

// Mutating operations run through one ordered chain: a set-input racing a
// set-model otherwise interleaves two session replacements.
let operationChain = Promise.resolve();
function enqueue(operation) {
  const next = operationChain.then(operation);
  operationChain = next.catch(() => {});
  return next;
}

self.onmessage = (event) => {
  const message = event.data;
  const respond = (kind) => {
    self.postMessage({
      kind,
      version: DEVICE_VIEWER_PROTOCOL_VERSION,
      identifier: message.identifier ?? null,
      operation: message.operation ?? null,
      viewport: currentViewport,
    });
  };
  const fail = (error) => {
    self.postMessage({
      kind: DEVICE_VIEWER_ERROR_KIND,
      version: DEVICE_VIEWER_PROTOCOL_VERSION,
      identifier: message?.identifier ?? null,
      operation: message?.operation ?? null,
      error: serializeBrowserWorkerError(error),
    });
  };
  try {
    if (message?.version !== DEVICE_VIEWER_PROTOCOL_VERSION) {
      throw new TypeError(
        `Device viewer protocol version ${DEVICE_VIEWER_PROTOCOL_VERSION} required`,
      );
    }
    if (message.kind === DEVICE_VIEWER_START_KIND) {
      if (!(message.canvas instanceof OffscreenCanvas)) {
        throw new TypeError("Device viewer requires an OffscreenCanvas");
      }
      const surface = message.surface ?? {};
      if (
        !Number.isInteger(surface.width) || surface.width <= 0 ||
        !Number.isInteger(surface.height) || surface.height <= 0
      ) {
        throw new RangeError("Device viewer surface size is invalid");
      }
      canvas = message.canvas;
      canvas.width = surface.width;
      canvas.height = surface.height;
      if (Number.isFinite(surface.pixelScale) && surface.pixelScale > 0) {
        pixelScale = surface.pixelScale;
      }
      enqueue(() => applySession(message))
        .then(() => respond(DEVICE_VIEWER_READY_KIND), fail);
      return;
    }
    if (
      message.kind === DEVICE_VIEWER_SET_INPUT_KIND ||
      message.kind === DEVICE_VIEWER_SET_MODEL_KIND
    ) {
      if (canvas === null) {
        throw new Error("Device viewer has not started");
      }
      enqueue(() => applySession(message))
        .then(() => respond(DEVICE_VIEWER_APPLIED_KIND), fail);
      return;
    }
    if (message.kind === DEVICE_VIEWER_POINTER_KIND) {
      handlePointer(message);
      return;
    }
    if (message.kind === DEVICE_VIEWER_RESIZE_KIND) {
      const { width, height } = message.surface ?? {};
      if (
        !Number.isInteger(width) || width <= 0 ||
        !Number.isInteger(height) || height <= 0
      ) {
        throw new RangeError("Device viewer surface size is invalid");
      }
      if (canvas !== null) {
        canvas.width = width;
        canvas.height = height;
      }
      const scale = message.surface.pixelScale;
      if (Number.isFinite(scale) && scale > 0) {
        pixelScale = scale;
      }
      return;
    }
    if (message.kind === DEVICE_VIEWER_STOP_KIND) {
      enqueue(() => stopEverything())
        .then(() => respond(DEVICE_VIEWER_APPLIED_KIND), fail);
      return;
    }
    throw new TypeError(
      `Unknown device viewer request ${JSON.stringify(message.kind)}`,
    );
  } catch (error) {
    fail(error);
  }
};

self.postMessage({
  kind: DEVICE_VIEWER_READY_KIND,
  version: DEVICE_VIEWER_PROTOCOL_VERSION,
  identifier: null,
  operation: null,
});
