// sandom/gpu on a WebGPU-native host (browser, Deno): nothing to mount.
// This module only verifies the capability and fails loudly when it is
// absent, so a missing GPU surfaces here instead of deep inside the
// rasterizer.

if (!globalThis.navigator?.gpu) {
  throw new Error(
    "sandom/gpu: this host has no navigator.gpu. On Node install the " +
      "'webgpu' package; on Bun install 'bun-webgpu'. Both are optional " +
      "peer dependencies of sandom and are mounted by this same " +
      "'sandom/gpu' import through conditional exports.",
  );
}
