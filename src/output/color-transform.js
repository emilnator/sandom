// One host-memory output boundary. Sandom supplies codec/container capability;
// @sandom/color validates and performs the color transform.
import { colorRuntime } from "../wasm/color-runtime.js";
import { FORMAT_CAPABILITIES } from "./format-policy.js";
import { packSignal } from "./packing.js";

function enumValue(runtime, name, value) {
  const result = runtime.abi.enums[name][value];
  if (result === undefined) throw new Error(`color: unknown ${name} ${JSON.stringify(value)}`);
  return result;
}

function setRecord(view, fields, values) {
  for (const [name, value] of Object.entries(values)) {
    const offset = fields[name];
    if (offset === undefined) throw new Error(`color: ABI record has no ${name} field`);
    if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 0xffffffff && !["sourcePeak", "targetPeak", "referenceWhite", "sourceMin"].includes(name)) {
      view.setUint32(offset, value, true);
    } else {
      view.setFloat64(offset, value, true);
    }
  }
}

export function outputPolicyBytes(request) {
  const runtime = colorRuntime();
  const policy = runtime.abi.records.policy;
  const bytes = new Uint8Array(policy.size);
  setRecord(new DataView(bytes.buffer), policy.fields, {
    version: runtime.abi.version,
    primaries: enumValue(runtime, "primaries", request.colorEncoding.primaries),
    transfer: enumValue(runtime, "transfer", request.colorEncoding.transferFunction),
    depth: runtime.abi.depthCodes[request.bitDepth] ?? request.bitDepth,
    alpha: enumValue(runtime, "alpha", request.alphaMode),
    tone: enumValue(runtime, "tone", request.toneMap),
    range: enumValue(runtime, "range", request.dynamicRange ?? ((request.colorEncoding.transferFunction === "pq" || request.colorEncoding.transferFunction === "hlg") ? "high" : "standard")),
    sourcePeak: request.masteringDisplay?.maxLuminance ?? 203,
    targetPeak: request.targetPeakLuminance ?? 203,
    white: enumValue(runtime, "white", request.colorEncoding.whitePoint),
    referenceWhite: request.colorEncoding.referenceWhiteLuminance,
    gamut: enumValue(runtime, "gamut", request.gamutMap),
    masteringPresent: request.masteringDisplay == null ? 0 : 1,
    sourceMin: request.masteringDisplay?.minLuminance ?? 0,
  });
  return bytes;
}

export function outputCapabilityBytes(request) {
  const contract = FORMAT_CAPABILITIES[request.format];
  if (!contract) throw new Error(`color: unknown output format ${JSON.stringify(request.format)}`);
  if (!contract.alphaModes.includes(request.alphaMode)) {
    throw new Error(`color: ${request.format} cannot represent ${request.alphaMode} alpha`);
  }
  const runtime = colorRuntime();
  const capability = runtime.abi.records.capability;
  let depthMask = 0;
  for (const depth of contract.bitDepths) {
    const code = runtime.abi.depthCodes[depth] ?? depth;
    const bit = code === 8 ? 0 : code === 10 ? 1 : code === 12 ? 2 : code === 16 ? 3 : code === runtime.abi.depthCodes.float16 ? 4 : code === runtime.abi.depthCodes.float32 ? 5 : -1;
    if (bit < 0) throw new Error(`color: unsupported capability depth ${depth}`);
    depthMask |= 1 << bit;
  }
  let encodingLow = 0;
  let encodingHigh = 0;
  for (const [primaries, transfer] of contract.encodings) {
    const bit = enumValue(runtime, "primaries", primaries) * 8 + enumValue(runtime, "transfer", transfer);
    if (bit < 32) encodingLow = (encodingLow | (1 << bit)) >>> 0;
    else encodingHigh = (encodingHigh | (1 << (bit - 32))) >>> 0;
  }
  const bytes = new Uint8Array(capability.size);
  setRecord(new DataView(bytes.buffer), capability.fields, {
    version: runtime.abi.version,
    depthMask: depthMask >>> 0,
    encodingLow,
    encodingHigh,
    alpha: enumValue(runtime, "alpha", request.alphaMode),
    flags: contract.requiresMastering ? 1 : 0,
  });
  return bytes;
}

export function validateNativeOutputPolicy(request) {
  const native = colorRuntime();
  const policy = native.copyIn(outputPolicyBytes(request));
  const capability = native.copyIn(outputCapabilityBytes(request));
  try {
    native.check(native.exports.color_validate_policy(policy, capability));
  } finally {
    native.free(capability);
    native.free(policy);
  }
  return request;
}

export function transformImageForOutput(descriptor, request) {
  const { pixels, width, height, colorEncoding } = descriptor;
  if (!(pixels instanceof Float32Array)) throw new Error("output transform requires Float32Array working pixels");
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || width * height > 16777214) throw new Error("output transform dimensions exceed color memory ceiling");
  const native = colorRuntime();
  const working = native.exports.color_working_code(
    enumValue(native, "primaries", colorEncoding.primaries),
    enumValue(native, "transfer", colorEncoding.transferFunction),
  );
  if (working < 0) throw new Error(`output transform: descriptor encoding ${colorEncoding.primaries}/${colorEncoding.transferFunction} is not a working encoding`);
  let input = 0;
  let policy = 0;
  let capability = 0;
  let output = 0;
  try {
    input = native.copyIn(pixels);
    policy = native.copyIn(outputPolicyBytes(request));
    capability = native.copyIn(outputCapabilityBytes(request));
    output = native.alloc(width * height * 16);
    native.check(native.exports.color_transform_output(input, pixels.byteLength, width, height,
      descriptor.rowStride ?? width * 16, working, enumValue(native, "alpha", descriptor.alphaMode),
      policy, capability, output, width * height * 16));
    return { pixels: native.copyOut(output, width * height * 16, Float32Array), width, height };
  } finally {
    native.free(output);
    native.free(capability);
    native.free(policy);
    native.free(input);
  }
}

export function quantizeWorkingPixels(pixels) {
  return pixels instanceof Float32Array ? packSignal(pixels) : pixels;
}
