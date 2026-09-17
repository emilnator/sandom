globalThis.window = globalThis;
const { installBrowserRenderWorker } = await import(
  "./browser-render-worker-runtime.js"
);
installBrowserRenderWorker(globalThis);
