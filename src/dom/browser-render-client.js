import {
  BROWSER_RENDER_ERROR_KIND,
  BROWSER_RENDER_PROTOCOL_VERSION,
  BROWSER_RENDER_READY_KIND,
  BROWSER_RENDER_REQUEST_KIND,
  BROWSER_RENDER_RESULT_KIND,
} from "./browser-render-worker-protocol.js";

export async function renderInBrowserWorker(input, options = {}) {
  const WorkerConstructor = options.Worker ?? globalThis.Worker;
  if (typeof WorkerConstructor !== "function") {
    throw new Error("renderInBrowserWorker requires Worker support");
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
    throw new TypeError("Browser render input requires a file name");
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Browser render input requires Uint8Array bytes");
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
        "Browser render resource requires a URL or file name",
      );
    }
    if (!(resourceBytes instanceof Uint8Array)) {
      throw new TypeError("Browser render resource requires Uint8Array bytes");
    }
    resources.push({
      url,
      bytes: resourceBytes,
      contentType: resource.contentType ?? resource.type,
    });
  }

  const worker = new WorkerConstructor(
    options.workerURL ?? new URL("./browser-render-worker.js", import.meta.url),
    { type: "module", name: "sandom-render" },
  );
  const identifier = crypto.randomUUID();
  try {
    return await new Promise((resolve, reject) => {
      let ready = false;
      const abort = () => {
        reject(
          options.signal?.reason ?? new DOMException(
            "The browser render was canceled",
            "AbortError",
          ),
        );
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      worker.onerror = (event) => {
        options.signal?.removeEventListener("abort", abort);
        reject(
          event.error ??
            new Error(event.message || "Browser render worker failed"),
        );
      };
      worker.onmessage = (event) => {
        const message = event.data;
        if (message?.kind === BROWSER_RENDER_READY_KIND) {
          if (message.version !== BROWSER_RENDER_PROTOCOL_VERSION) {
            reject(
              new RangeError(
                `Unsupported browser render worker version ${
                  JSON.stringify(message.version)
                }`,
              ),
            );
            return;
          }
          if (ready) {
            reject(
              new Error("Browser render worker became ready more than once"),
            );
            return;
          }
          ready = true;
          worker.postMessage({
            kind: BROWSER_RENDER_REQUEST_KIND,
            version: BROWSER_RENDER_PROTOCOL_VERSION,
            identifier,
            input: { name, bytes, preprocessor },
            resources,
            request: options.request ?? {},
          });
          return;
        }
        if (message?.identifier !== identifier) return;
        options.signal?.removeEventListener("abort", abort);
        if (message.kind === BROWSER_RENDER_RESULT_KIND) {
          resolve(message);
          return;
        }
        if (message.kind === BROWSER_RENDER_ERROR_KIND) {
          const error = new Error(
            message.error?.message ?? "Browser render failed",
          );
          error.name = message.error?.name ?? "Error";
          error.stack = message.error?.stack ?? error.stack;
          error.details = message.error?.details ?? null;
          reject(error);
          return;
        }
        reject(
          new TypeError(
            `Unknown browser render worker response ${
              JSON.stringify(message?.kind)
            }`,
          ),
        );
      };
    });
  } finally {
    worker.terminate();
  }
}
