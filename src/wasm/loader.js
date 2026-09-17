// WASM engine loader.
//
// ONE WebAssembly.Memory shared by the renderer core and HarfBuzz
// (design/memory-map.md). The engine's fixed layout owns pages 0–803 and
// never grows; vendor/hb.wasm is linked with IMPORTED_MEMORY, GLOBAL_BASE at
// that boundary and -sMALLOC=none, so its static data and stack occupy
// pages 804–863 and every HarfBuzz allocation comes from the DOM core's
// allocator; the DOM core owns pages 864 upward and is the ONLY grower.
// Renderer-core calls HarfBuzz through its native function table, and
// HarfBuzz calls the DOM allocator directly: pointers are plain offsets
// into the one shared memory.
//
// Growth detaches every ArrayBuffer view over the shared memory. The one
// refresh rule: the DOM core reports growth synchronously after the
// growing call (src/dom-wasm/core.js observeMemoryGrowth); every module
// holding a long-lived view registers one listener (this loader's own
// bytes/u32/f32, src/scene-renderer.js, src/session.js, src/animations.js).

import { RENDERER_CORE_HB_IMPORTS } from './renderer-core-binary.js';
import { readBinaryFile } from '../host.js';
import { createTextPreparationRuntime } from '../text-preparation.js';
import { createAllocatorCore, observeMemoryGrowth } from '../dom-wasm/core.js';
import {
  ACTUAL_INITIAL_PAGES,
  HB_INITIAL_PAGES,
  verifyLayout,
} from './layout.js';

// The HarfBuzz static-data base baked into vendor/hb.wasm at link time
// (-sGLOBAL_BASE). MUST equal the layout reservation boundary; the
// assertion in loadEngine rejects a drifted rebuild before either module
// initializer runs.
export const HB_BASE_BYTES = ACTUAL_INITIAL_PAGES * 65536;

// The engine's fail-loud nets are `unreachable`, which carries no message:
// a caller saw only `RuntimeError: unreachable` and had to disassemble the
// wasm offsets to learn which guard fired (that is how
// plans/bugs/BUG-exclusion-level-capacity-trap.md and
// BUG-element-from-point-traps-on-live-document.md were filed — same
// signature, no name). The engine writes $trapSite plus, for a capacity
// net, the observed value and the budget it exceeded; the layout entry
// points read them back out here and rethrow a named error. Keep in step
// with $trapSite's own doc comment in engine.wat.
const TRAP_SITE_NAMES = new Map([
  [1, "corrective relayout re-derived a different gap"],
  [2, "vertical-fit retry budget (first loop)"],
  [3, "vertical-fit retry budget (separated-stage loop)"],
  [4, "BFC level stack exhausted and ungrowable"],
  [5, "exclusions per BFC level exhausted"],
  [6, "no next float edge below the probe"],
  [7, "shelf index past the rebuilt shelf list"],
  [8, "no next shelf edge below the probe"],
  [9, "glyph buffer exhausted"],
  [10, "inline-state scratch exhausted"],
  [11, "flex items past this level's record budget"],
  [12, "flex scratch ungrowable"],
]);

function attributeEngineTraps(exports) {
  const attributed = { ...exports };
  for (const name of ["layout", "emit_commands"]) {
    const call = exports[name];
    attributed[name] = function () {
      try {
        return call.apply(null, arguments);
      } catch (error) {
        if (!(error instanceof WebAssembly.RuntimeError)) throw error;
        const site = exports.trap_site();
        if (site === 0) throw error;
        const observed = exports.trap_value();
        const limit = exports.trap_limit();
        throw new Error(
          `sandom engine trap in ${name}: ${
            TRAP_SITE_NAMES.get(site) ?? "unnamed guard"
          } (trap site ${site}${
            limit === 0 ? "" : `, observed ${observed}, budget ${limit}`
          })`,
          { cause: error },
        );
      }
    };
  }
  return Object.freeze(attributed);
}

// hb.wasm is a full Emscripten build without an allocator, so it needs the
// handful of runtime imports Emscripten always generates (proc_exit,
// timers, abort) plus the C allocator, which the DOM core exports.
export function makeHbImports(memory, allocator) {
  const timers = {};
  return {
    wasi_snapshot_preview1: {
      proc_exit: (code) => { throw new Error(`hb.wasm proc_exit(${code})`); },
    },
    env: {
      memory,
      malloc: allocator.abi_malloc,
      free: allocator.abi_free,
      calloc: allocator.abi_calloc,
      realloc: allocator.abi_realloc,
      _abort_js: () => { throw new Error('hb.wasm aborted'); },
      _emscripten_runtime_keepalive_clear: () => {},
      _setitimer_js: (which, timeoutMs) => {
        if (timers[which]) { clearTimeout(timers[which]); delete timers[which]; }
        if (!timeoutMs) return 0;
        timers[which] = setTimeout(() => { delete timers[which]; }, timeoutMs);
        return 0;
      },
    },
  };
}

export async function loadHb(memory, allocator, harfbuzzBytes) {
  const wasmBytes = harfbuzzBytes ??
    globalThis[Symbol.for('sandom.hbBytes')] ??
    await readBinaryFile(new URL('../../vendor/hb.wasm', import.meta.url));

  const module = await WebAssembly.compile(
    wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes),
  );
  const imports = WebAssembly.Module.imports(module);
  const memoryImports = imports.filter((entry) => entry.kind === 'memory');
  if (memoryImports.length !== 1) {
    throw new Error(
      `vendor/hb.wasm must import exactly one memory (found ${memoryImports.length}) — rebuild it with -sIMPORTED_MEMORY (vendor/README-hb-wasm.md)`,
    );
  }
  if (imports.some((entry) => entry.name === 'emscripten_resize_heap')) {
    throw new Error(
      'vendor/hb.wasm carries its own heap — rebuild it with -sMALLOC=none (vendor/README-hb-wasm.md)',
    );
  }
  const instance = new WebAssembly.Instance(module, makeHbImports(memory, allocator));
  instance.exports.__wasm_call_ctors();
  return instance;
}

// Initialization is owned by the memory, just like the native engine state.
// Retain a failed initialization too: repeating HarfBuzz constructors or
// engine init on partially initialized live memory would corrupt its state.
const engineLoads = new WeakMap();

// The DOM and engine exports belong to the same instance. HarfBuzz is linked
// once to that instance's raw allocator and called through its native table.
export async function loadEngine({ harfbuzzBytes, core = createAllocatorCore() } = {}) {
  const resource = harfbuzzBytes ?? globalThis[Symbol.for('sandom.hbBytes')] ?? null;
  const previous = engineLoads.get(core.memory);
  if (previous) {
    if (previous.core !== core || previous.resource !== resource) {
      throw new TypeError('Renderer core already has an engine with different core or HarfBuzz resources');
    }
    return await previous.promise;
  }
  const promise = initializeEngine(core, resource);
  engineLoads.set(core.memory, { core, resource, promise });
  return await promise;
}

async function initializeEngine(core, harfbuzzBytes) {
  const memory = core.memory;
  if (memory.buffer.byteLength < HB_INITIAL_PAGES * 65536) {
    throw new Error(`shared memory has ${memory.buffer.byteLength} bytes; HarfBuzz needs ${HB_INITIAL_PAGES} pages`);
  }
  // Direct WAT-to-WAT allocator binding: the raw exports, not the
  // growth-observing wrappers. Growth from these paths is observed at the
  // engine or core export the host called into.
  const allocator = core.rawExports;
  const hb = await loadHb(memory, allocator, harfbuzzBytes);

  // Boundary assertion: the allocator serving HarfBuzz must hand out
  // addresses above the layout reservation and HarfBuzz's static pages.
  const probePtr = allocator.abi_malloc(16);
  allocator.abi_free(probePtr);
  if (probePtr < HB_INITIAL_PAGES * 65536) {
    throw new Error(
      `DOM allocator heap starts at ${probePtr}, inside the engine or HarfBuzz reservation (< ${HB_INITIAL_PAGES * 65536}) — design/memory-map.md`,
    );
  }

  for (let index = 0; index < RENDERER_CORE_HB_IMPORTS.length; index++) {
    allocator.renderer_hb_table.set(index, hb.exports[RENDERER_CORE_HB_IMPORTS[index]]);
  }
  const observed = observeMemoryGrowth(memory, allocator, () => core.notifyGrowth());
  const measurement = globalThis[Symbol.for("sandom.domCore.measurement")];
  const exports = attributeEngineTraps(
    measurement ? measurement.wrapExports(observed, "engine") : observed,
  );

  exports.init();
  verifyLayout(exports);

  const engine = {
    memory,
    exports,
    bytes: new Uint8Array(memory.buffer),
    u32: new Uint32Array(memory.buffer),
    f32: new Float32Array(memory.buffer),
    hb,
    allocator,
    // The memory's allocator authority; the DOM core itself for the default
    // runtime, so the core can snapshot this engine's buffers in place.
    core,
    // The one refresh rule: register a listener that re-derives every
    // long-lived view over the shared memory. Fired synchronously after
    // the core or engine call that grew it returns.
    onMemoryGrowth(listener) { core.onMemoryGrowth(listener); },
  };
  core.onMemoryGrowth(() => {
    engine.bytes = new Uint8Array(memory.buffer);
    engine.u32 = new Uint32Array(memory.buffer);
    engine.f32 = new Float32Array(memory.buffer);
  });
  engine.textPreparation = createTextPreparationRuntime(engine);
  return engine;
}
