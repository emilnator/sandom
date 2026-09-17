import {
  BROWSER_PREVIEW_ERROR_KIND,
  BROWSER_PREVIEW_FRAME_KIND,
  BROWSER_PREVIEW_PROTOCOL_VERSION,
  BROWSER_PREVIEW_READY_KIND,
  BROWSER_PREVIEW_RESIZE_KIND,
  BROWSER_PREVIEW_START_KIND,
  BROWSER_PREVIEW_STOP_KIND,
} from "./browser-preview-worker-protocol.js";

export async function startBrowserPreview(canvas, input, options = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError("startBrowserPreview requires an HTMLCanvasElement");
  }
  if (typeof canvas.transferControlToOffscreen !== "function") {
    throw new Error("Live preview requires transferable canvas support");
  }
  const WorkerConstructor = options.Worker ?? globalThis.Worker;
  if (typeof WorkerConstructor !== "function") {
    throw new Error("Live preview requires Worker support");
  }
  let name;
  let bytes;
  let preprocessor = options.preprocessor;
  if (typeof input === "string") {
    name = options.name ?? "input.html";
    bytes = new TextEncoder().encode(input);
  } else if (typeof Blob !== "undefined" && input instanceof Blob) {
    name = input.name ?? options.name ?? "input.html";
    bytes = new Uint8Array(await input.arrayBuffer());
  } else if (input && typeof input === "object") {
    name = input.name ?? options.name;
    bytes = input.bytes;
    preprocessor = input.preprocessor ?? preprocessor;
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Browser preview input requires a file name");
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Browser preview input requires Uint8Array bytes");
  }
  const resources = [];
  for (const resource of options.resources ?? []) {
    let resourceBytes = resource?.bytes;
    if (
      resourceBytes === undefined && typeof Blob !== "undefined" &&
      resource instanceof Blob
    ) {
      resourceBytes = new Uint8Array(await resource.arrayBuffer());
    }
    const url = resource?.url ?? resource?.webkitRelativePath ?? resource?.name;
    if (typeof url !== "string" || url.length === 0) {
      throw new TypeError(
        "Browser preview resource requires a URL or file name",
      );
    }
    if (!(resourceBytes instanceof Uint8Array)) {
      throw new TypeError("Browser preview resource requires Uint8Array bytes");
    }
    resources.push({
      url,
      bytes: resourceBytes,
      contentType: resource.contentType ?? resource.type,
    });
  }
  const viewport = options.viewport;
  if (
    !Number.isInteger(viewport?.width) || viewport.width <= 0 ||
    !Number.isInteger(viewport?.height) || viewport.height <= 0
  ) {
    throw new RangeError(
      "Browser preview viewport requires positive integer dimensions",
    );
  }
  const worker = new WorkerConstructor(
    options.workerURL ??
      new URL("./browser-preview-worker.js", import.meta.url),
    { type: "module", name: "sandom-preview" },
  );
  const identifier = crypto.randomUUID();
  const offscreenCanvas = canvas.transferControlToOffscreen();
  let released = false;
  let operationReady = false;
  let rejectOperation;
  const ready = new Promise((resolve, reject) => {
    rejectOperation = reject;
    worker.onerror = (event) =>
      reject(
        event.error ??
          new Error(event.message || "Browser preview worker failed"),
      );
    worker.onmessage = (event) => {
      const message = event.data;
      if (message?.version !== BROWSER_PREVIEW_PROTOCOL_VERSION) {
        reject(new RangeError("Unsupported browser preview worker version"));
        return;
      }
      if (message.kind === BROWSER_PREVIEW_ERROR_KIND) {
        const error = new Error(
          message.error?.message ?? "Browser preview failed",
        );
        error.name = message.error?.name ?? "Error";
        error.stack = message.error?.stack ?? error.stack;
        error.details = message.error?.details ?? null;
        reject(error);
        return;
      }
      if (
        message.kind === BROWSER_PREVIEW_READY_KIND &&
        message.identifier === null
      ) {
        worker.postMessage({
          kind: BROWSER_PREVIEW_START_KIND,
          version: BROWSER_PREVIEW_PROTOCOL_VERSION,
          identifier,
          input: { name, bytes, preprocessor },
          resources,
          viewport,
          canvas: offscreenCanvas,
        }, [offscreenCanvas]);
        return;
      }
      if (
        message.kind === BROWSER_PREVIEW_READY_KIND &&
        message.identifier === identifier
      ) {
        operationReady = true;
        resolve(message);
        return;
      }
      if (
        message.kind === BROWSER_PREVIEW_FRAME_KIND &&
        message.identifier === identifier
      ) {
        options.onFrame?.(message);
      }
    };
  });
  options.signal?.addEventListener("abort", () => {
    rejectOperation(options.signal.reason);
    worker.terminate();
  }, { once: true });
  const metadata = await ready;
  return Object.freeze({
    metadata,
    resize(width, height) {
      if (released || !operationReady) {
        throw new Error("Browser preview is not active");
      }
      worker.postMessage({
        kind: BROWSER_PREVIEW_RESIZE_KIND,
        version: BROWSER_PREVIEW_PROTOCOL_VERSION,
        identifier,
        viewport: { width, height },
      });
    },
    release() {
      if (released) return;
      released = true;
      worker.postMessage({
        kind: BROWSER_PREVIEW_STOP_KIND,
        version: BROWSER_PREVIEW_PROTOCOL_VERSION,
        identifier,
      });
      worker.terminate();
    },
  });
}
