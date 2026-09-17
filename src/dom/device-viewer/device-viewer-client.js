// Main-thread client for the device viewer worker. Owns one persistent
// worker: the returned handle replaces the document (setInput) and the
// device (setModel) in place, without tearing down the worker's shared
// renderer, GPU device, or cached scenes.

import {
  DEVICE_VIEWER_APPLIED_KIND,
  DEVICE_VIEWER_ERROR_KIND,
  DEVICE_VIEWER_CURSOR_KIND,
  DEVICE_VIEWER_POINTER_KIND,
  DEVICE_VIEWER_PROTOCOL_VERSION,
  DEVICE_VIEWER_READY_KIND,
  DEVICE_VIEWER_RESIZE_KIND,
  DEVICE_VIEWER_SET_INPUT_KIND,
  DEVICE_VIEWER_SET_MODEL_KIND,
  DEVICE_VIEWER_START_KIND,
  DEVICE_VIEWER_STOP_KIND,
} from "./device-viewer-worker-protocol.js";

function validateInput(input) {
  if (typeof input?.name !== "string" || !(input.bytes instanceof Uint8Array)) {
    throw new TypeError("Device viewer input requires {name, bytes}");
  }
  return { name: input.name, bytes: input.bytes };
}

export async function startDeviceViewer(canvas, options) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError("startDeviceViewer requires an HTMLCanvasElement");
  }
  const {
    input,
    resources = [],
    viewport,
    surface,
    model,
    Worker: WorkerConstructor = globalThis.Worker,
  } = options;
  validateInput(input);
  if (!(model?.glb instanceof Uint8Array) || !model.screen || !model.key) {
    throw new TypeError(
      "Device viewer requires {key, glb, screen} model data",
    );
  }
  const worker = new WorkerConstructor(
    new URL("./device-viewer-worker.js", import.meta.url),
    { type: "module", name: "sandom-device-viewer" },
  );
  const identifier = crypto.randomUUID();
  const offscreenCanvas = canvas.transferControlToOffscreen();
  let released = false;

  // One pending settlement per in-flight mutating operation, keyed by the
  // operation identifier the worker echoes back.
  const pending = new Map();
  const settle = (message, settlement) => {
    const entry = pending.get(message.operation);
    if (entry === undefined) return false;
    pending.delete(message.operation);
    settlement(entry);
    return true;
  };
  const post = (message) => {
    const operation = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(operation, { resolve, reject });
      worker.postMessage({
        ...message,
        version: DEVICE_VIEWER_PROTOCOL_VERSION,
        identifier,
        operation,
      });
    });
  };

  const ready = new Promise((resolve, reject) => {
    let startOperation = null;
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.kind === DEVICE_VIEWER_ERROR_KIND) {
        const error = new Error(
          message.error?.message ?? "Device viewer failed",
        );
        error.name = message.error?.name ?? "Error";
        if (!settle(message, (entry) => entry.reject(error))) {
          reject(error);
        }
        return;
      }
      if (
        message.kind === DEVICE_VIEWER_READY_KIND &&
        message.identifier === null
      ) {
        // The worker module finished loading: post the start operation.
        // Posting earlier is unsafe: Chromium silently drops messages
        // posted to a module worker while its module graph is still
        // loading (verified 2026-08-19; the specification queues them).
        // Only the canvas transfers, following the browser preview client.
        startOperation = crypto.randomUUID();
        worker.postMessage(
          {
            kind: DEVICE_VIEWER_START_KIND,
            version: DEVICE_VIEWER_PROTOCOL_VERSION,
            identifier,
            operation: startOperation,
            canvas: offscreenCanvas,
            viewport,
            surface,
            input: validateInput(input),
            resources,
            model: {
              key: model.key,
              glb: model.glb,
              screen: model.screen,
              pose: model.pose,
            },
          },
          [offscreenCanvas],
        );
        return;
      }
      if (
        message.kind === DEVICE_VIEWER_READY_KIND &&
        message.operation === startOperation
      ) {
        resolve(message);
        return;
      }
      if (message.kind === DEVICE_VIEWER_APPLIED_KIND) {
        settle(message, (entry) => entry.resolve(message));
      }
    };
    worker.onerror = (event) => {
      reject(
        event.error ?? new Error(
          `Device viewer worker failed: ${event.message ?? "(no message)"} ` +
            `at ${event.filename ?? "?"}:${event.lineno ?? "?"}`,
        ),
      );
    };
  });

  const metadata = await ready;
  const onCursor = options.onCursor ?? null;
  worker.onmessage = (event) => {
    const message = event.data;
    if (message.kind === DEVICE_VIEWER_CURSOR_KIND) {
      onCursor?.(message.cursor);
      return;
    }
    if (message.kind === DEVICE_VIEWER_ERROR_KIND) {
      const error = new Error(
        message.error?.message ?? "Device viewer worker failed",
      );
      if (!settle(message, (entry) => entry.reject(error))) {
        throw error;
      }
      return;
    }
    if (message.kind === DEVICE_VIEWER_APPLIED_KIND) {
      settle(message, (entry) => entry.resolve(message));
    }
  };
  worker.onerror = (event) => {
    throw event.error ?? new Error(
      `Device viewer worker failed: ${event.message ?? "(no message)"}`,
    );
  };

  return Object.freeze({
    metadata,
    // Replace the rendered document; the device keeps rotating and shows
    // the previous frame until the new document's first frame arrives.
    setInput({ input: nextInput, resources: nextResources = [], viewport: nextViewport }) {
      if (released) throw new Error("Device viewer is released");
      return post({
        kind: DEVICE_VIEWER_SET_INPUT_KIND,
        input: validateInput(nextInput),
        resources: nextResources,
        viewport: nextViewport,
      });
    },
    // Swap the device model. GLB bytes are needed only the first time a
    // model key is seen; the worker caches parsed geometry and scenes.
    setModel({ model: nextModel, viewport: nextViewport, input: nextInput, resources: nextResources = [] }) {
      if (released) throw new Error("Device viewer is released");
      if (!nextModel?.key || !nextModel.screen) {
        throw new TypeError("setModel requires {key, screen} model data");
      }
      return post({
        kind: DEVICE_VIEWER_SET_MODEL_KIND,
        model: {
          key: nextModel.key,
          glb: nextModel.glb,
          screen: nextModel.screen,
          pose: nextModel.pose,
        },
        viewport: nextViewport,
        input: validateInput(nextInput),
        resources: nextResources,
      });
    },
    // Fire-and-forget pointer facts in canvas backing pixels; the worker
    // raycasts them onto the device screen and routes them to the
    // document or the orbit drag.
    pointer(record) {
      if (released) return;
      worker.postMessage({
        ...record,
        kind: DEVICE_VIEWER_POINTER_KIND,
        version: DEVICE_VIEWER_PROTOCOL_VERSION,
        identifier,
      });
    },
    resize(width, height, pixelScale) {
      if (released) return;
      worker.postMessage({
        kind: DEVICE_VIEWER_RESIZE_KIND,
        version: DEVICE_VIEWER_PROTOCOL_VERSION,
        identifier,
        surface: { width, height, pixelScale },
      });
    },
    release() {
      if (released) return;
      released = true;
      worker.postMessage({
        kind: DEVICE_VIEWER_STOP_KIND,
        version: DEVICE_VIEWER_PROTOCOL_VERSION,
        identifier,
        operation: crypto.randomUUID(),
      });
      worker.terminate();
    },
  });
}
