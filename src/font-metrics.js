import { readBinaryFile } from "./host.js";

const FONT_METRICS_WASM =
  "@sandom/font-metrics/font-metrics.wasm";

export const FONT_METRICS_PACKAGE_VERSION = "0.1.0";
const FONT_METRIC_GROUPS = 3;

// Isolated workers seed the bytes through the reviewed module graph; other
// hosts resolve the package through the library import map.
const wasmBytes = globalThis[Symbol.for("sandom.fontMetricsBytes")] ??
  await readBinaryFile(new URL(import.meta.resolve(FONT_METRICS_WASM)));
const wasmModule = new WebAssembly.Module(wasmBytes);
const metricsByBytes = new WeakMap();

function operationError(wasm) {
  const code = wasm.font_metrics_error_code();
  const field = wasm.font_metrics_error_field() >>> 0;
  const names = [
    "success",
    "memory span",
    "face index",
    "missing table",
    "font data",
    "metric groups",
    "allocation",
  ];
  const detail = names[code] ?? `error ${code}`;
  const error = new Error(
    `@sandom/font-metrics: ${detail} (font-metrics error ${code}, field ${field})`,
  );
  error.fontMetricsCode = code;
  error.fontMetricsField = field;
  return error;
}

function readResult(wasm, pointer) {
  const view = new DataView(wasm.memory.buffer);
  return Object.freeze({
    upem: view.getUint32(pointer + 4, true),
    ascender: view.getInt32(pointer + 8, true),
    descender: view.getInt32(pointer + 12, true),
    lineGap: view.getInt32(pointer + 16, true),
    underlinePosition: view.getInt32(pointer + 20, true),
    underlineThickness: view.getInt32(pointer + 24, true),
    strikeoutPosition: view.getInt32(pointer + 28, true),
    strikeoutThickness: view.getInt32(pointer + 32, true),
    zeroAdvanceRatio: view.getFloat64(pointer + 40, true),
  });
}

/**
 * Reads scalar metrics from one sfnt or collection face. The package instance
 * is call-local because its standalone allocator is intentionally monotonic;
 * immutable results are cached by byte identity and face.
 */
export function readFontMetrics(
  bytes,
  { faceIndex = 0 } = {},
) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Font metric input must be a Uint8Array");
  }
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex > 0xffff_ffff) {
    throw new RangeError("Font face index must be an unsigned 32-bit integer");
  }
  let cachedByFace = metricsByBytes.get(bytes);
  const cached = cachedByFace?.get(faceIndex);
  if (cached) return cached;

  const wasm = new WebAssembly.Instance(wasmModule, {}).exports;
  if (
    wasm.font_metrics_abi_version() !== 1 ||
    wasm.font_metrics_abi_version_global.value !== 1
  ) {
    throw new Error("@sandom/font-metrics ABI version 1 is required");
  }
  const font = wasm.font_metrics_alloc(bytes.byteLength);
  if (font === 0) throw operationError(wasm);
  const result = wasm.font_metrics_alloc(wasm.font_metrics_result_size.value);
  if (result === 0) throw operationError(wasm);
  new Uint8Array(wasm.memory.buffer, font, bytes.byteLength).set(bytes);
  const status = wasm.font_metrics_read(
    font,
    bytes.byteLength,
    faceIndex,
    FONT_METRIC_GROUPS,
    result,
  );
  if (status !== 0) throw operationError(wasm);

  const metrics = readResult(wasm, result);
  if (!cachedByFace) {
    cachedByFace = new Map();
    metricsByBytes.set(bytes, cachedByFace);
  }
  cachedByFace.set(faceIndex, metrics);
  return metrics;
}
