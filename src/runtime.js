import { prepareSandomRuntimeOptions } from "./runtime-assets.js";

let rendererModulePromise = null;

function restoreDescriptor(name, descriptor) {
  if (descriptor === undefined) delete globalThis[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

async function loadRendererModule(prepared) {
  if (rendererModulePromise) return await rendererModulePromise;
  if (!prepared.explicitAssets) {
    rendererModulePromise = import("./scene-renderer.js");
    return await rendererModulePromise;
  }

  const harfbuzzSymbol = Symbol.for("sandom.hbBytes");
  const msdfgenSymbol = Symbol.for("sandom.msdfgenBytes");
  const previousHarfbuzz = Object.getOwnPropertyDescriptor(
    globalThis,
    harfbuzzSymbol,
  );
  const previousMsdfgen = Object.getOwnPropertyDescriptor(
    globalThis,
    msdfgenSymbol,
  );
  Object.defineProperty(globalThis, harfbuzzSymbol, {
    configurable: true,
    value: prepared.harfbuzzBytes,
    writable: true,
  });
  Object.defineProperty(globalThis, msdfgenSymbol, {
    configurable: true,
    value: prepared.msdfgenBytes,
    writable: true,
  });
  rendererModulePromise = import("./scene-renderer.js");
  try {
    return await rendererModulePromise;
  } finally {
    restoreDescriptor(harfbuzzSymbol, previousHarfbuzz);
    restoreDescriptor(msdfgenSymbol, previousMsdfgen);
  }
}

export async function createSandomRuntime(options = {}) {
  const prepared = await prepareSandomRuntimeOptions(options);
  const rendererModule = await loadRendererModule(prepared);
  return await rendererModule.__createSandomRuntimeFromPrepared(prepared);
}
