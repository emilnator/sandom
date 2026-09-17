const BROWSER_WORKER_ADDRESS = new URL(
  "./component-worker.js",
  import.meta.url,
);
const DENO_WORKER_ADDRESS = new URL(
  "./component-worker-deno.js",
  import.meta.url,
);

export async function createIsolatedComponentHost({
  html,
  moduleSpecifier,
  viewportWidth = 800,
  viewportHeight = 600,
  /** Embedder-owned faces: [{ family, bytes, weight?, style? }]. Each
   * registers in the worker realm under its authored family name. */
  fonts = [],
} = {}) {
  if (!html || !moduleSpecifier) {
    throw new TypeError(
      "createIsolatedComponentHost requires html and moduleSpecifier",
    );
  }
  const reviewedModuleSpecifier = new URL(
    moduleSpecifier,
    import.meta.url,
  ).href;
  const denoWorkerSource = `
    globalThis[Symbol.for("sandom.componentLoader")] = () =>
      import(${JSON.stringify(reviewedModuleSpecifier)});
    await import(${JSON.stringify(DENO_WORKER_ADDRESS.href)});
  `;
  const workerAddress = typeof Deno === "undefined"
    ? BROWSER_WORKER_ADDRESS
    : `data:text/javascript,${encodeURIComponent(denoWorkerSource)}`;
  const options = { type: "module" };
  if (typeof Deno !== "undefined") {
    options.deno = { permissions: "none" };
  }
  const worker = new Worker(workerAddress, options);
  const pending = new Map();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let nextIdentifier = 1;
  let closed = false;
  worker.onmessage = (event) => {
    if (event.data.operation === "ready") {
      resolveReady();
      return;
    }
    const request = pending.get(event.data.identifier);
    if (!request) return;
    pending.delete(event.data.identifier);
    if (event.data.error) {
      const error = new Error(event.data.error.message);
      error.name = event.data.error.name;
      if (event.data.error.stack) error.stack = event.data.error.stack;
      request.reject(error);
    } else {
      request.resolve(event.data.value);
    }
  };
  worker.onerror = (event) => {
    const error = event.error ?? new Error(event.message);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    rejectReady(error);
  };
  const request = (operation, argumentsValue = {}) => {
    if (closed) throw new DOMException("Component host is shut down", "InvalidStateError");
    const identifier = nextIdentifier++;
    const promise = new Promise((resolve, reject) => {
      pending.set(identifier, { resolve, reject });
    });
    worker.postMessage({ identifier, operation, arguments: argumentsValue });
    return promise;
  };
  await ready;
  const initialResults = await request("initialize", {
    html: String(html),
    moduleSpecifier: reviewedModuleSpecifier,
    fonts,
  });
  return {
    initialResults,
    render: () => request("render", { viewportWidth, viewportHeight }),
    readGlobal: (name) => request("global", { name: String(name) }),
    callGlobal: (name, ...argumentsValue) =>
      request("callGlobal", {
        name: String(name),
        arguments: argumentsValue,
      }),
    async shutdown() {
      if (closed) return;
      await request("shutdown");
      closed = true;
      worker.terminate();
      for (const pendingRequest of pending.values()) {
        pendingRequest.reject(new DOMException("Component host shut down", "AbortError"));
      }
      pending.clear();
    },
  };
}
