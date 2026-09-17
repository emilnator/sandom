globalThis.window = globalThis;
const { installComponentWorker } = await import("./component-worker-runtime.js");
await installComponentWorker();
