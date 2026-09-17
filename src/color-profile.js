/** ICC compilation and bulk transforms owned by @sandom/color's retained runtime. */
import { colorRuntime } from "./wasm/color-runtime.js";

function checkProfile(runtime, status, profile) {
  try {
    runtime.check(status);
  } catch (error) {
    error.profile = profile.handle;
    if (error.code === runtime.abi.errorCodes["numeric-parameter"] && profile.kind === "lut") {
      const profileError = runtime.abi.profileError;
      const stageChannel = error.field >>> profileError.sampleBits;
      error.stage = stageChannel >>> profileError.channelBits;
      error.channel = stageChannel & profileError.channelMask;
      error.sample = error.field & profileError.sampleMask;
    }
    throw error;
  }
}

function handleOf(profile) {
  if (!Number.isInteger(profile?.handle) || profile.handle <= 0 || profile.handle > 0xffffffff) {
    throw new TypeError("ICC profile must be a compiled native profile");
  }
  return profile.handle;
}

export function parseIccProfile(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("ICC profile bytes must be Uint8Array");
  const runtime = colorRuntime();
  const profileInfo = runtime.abi.records.profileInfo;
  let input = 0;
  let result = 0;
  try {
    input = runtime.copyIn(bytes);
    result = runtime.alloc(profileInfo.size);
    runtime.check(runtime.exports.color_profile_compile(input, bytes.byteLength, result));
    const info = new DataView(runtime.memory.buffer, result, profileInfo.size);
    const fields = profileInfo.fields;
    return Object.freeze({
      kind: info.getUint32(fields.kind, true) === runtime.exports.color_profile_kind_matrix_trc.value ? "matrix-trc" : "lut",
      handle: info.getUint32(fields.handle, true),
      identity: info.getUint32(fields.identity, true),
      revision: info.getUint32(fields.revision, true),
    });
  } finally {
    if (result) runtime.free(result);
    if (input) runtime.free(input);
  }
}

export function releaseIccProfile(profile) {
  const runtime = colorRuntime();
  checkProfile(runtime, runtime.exports.color_profile_release(handleOf(profile)), profile);
}

export function isSrgbLike(profile) {
  const runtime = colorRuntime();
  const profileInfo = runtime.abi.records.profileInfo;
  const result = runtime.alloc(profileInfo.size);
  try {
    checkProfile(runtime, runtime.exports.color_profile_info(handleOf(profile), result), profile);
    return new DataView(runtime.memory.buffer, result, profileInfo.size)
      .getUint32(profileInfo.fields.srgbLike, true) !== 0;
  } finally {
    runtime.free(result);
  }
}

export function transformToXyzD65(profile, devicePixels) {
  if (!(devicePixels instanceof Float64Array) || devicePixels.length % 3 !== 0) {
    throw new TypeError("ICC XYZ transform requires Float64 RGB triples");
  }
  const runtime = colorRuntime();
  const input = runtime.copyIn(devicePixels);
  try {
    checkProfile(runtime, runtime.exports.color_profile_transform_xyz(handleOf(profile), input, devicePixels.length / 3), profile);
    devicePixels.set(runtime.copyOut(input, devicePixels.byteLength, Float64Array));
    return devicePixels;
  } finally {
    runtime.free(input);
  }
}

export function convertToSrgb(pixels, profile) {
  if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length % 4 !== 0) {
    throw new TypeError("ICC sRGB transform requires RGBA8 pixels");
  }
  const runtime = colorRuntime();
  const input = runtime.copyIn(pixels);
  try {
    checkProfile(runtime, runtime.exports.color_profile_convert_srgb(handleOf(profile), input, pixels.length / 4), profile);
    pixels.set(runtime.copyOut(input, pixels.byteLength));
    return pixels;
  } finally {
    runtime.free(input);
  }
}

export function prepareProfileImage(profile, descriptor) {
  const { width, height, rowStride, pixels, sampleType, channelLayout, bitsPerSample, alphaMode } = descriptor;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 ||
      !Number.isSafeInteger(rowStride) || rowStride < 0 || rowStride > 0xffffffff ||
      width > 0xffffffff || height > 0xffffffff || !Number.isSafeInteger(width * height * 16) ||
      width * height * 16 > 268435424 || !Number.isInteger(bitsPerSample)) {
    throw new RangeError("ICC image dimensions, depth or stride are outside the native ABI");
  }
  if (!ArrayBuffer.isView(pixels) || pixels instanceof DataView) throw new TypeError("ICC image pixels must be a typed array");
  const runtime = colorRuntime();
  const sample = runtime.abi.enums.sample[sampleType];
  const layout = runtime.abi.enums.layout[channelLayout];
  const alpha = runtime.abi.enums.alpha[alphaMode];
  if (sample === undefined || layout === undefined || alpha === undefined) throw new RangeError("ICC image descriptor has an unknown enum value");
  const outputBytes = width * height * 16;
  let input = 0;
  let output = 0;
  try {
    input = runtime.copyIn(pixels);
    output = runtime.alloc(outputBytes);
    checkProfile(runtime, runtime.exports.color_profile_prepare(handleOf(profile), input, pixels.byteLength,
      width, height, rowStride, sample, layout, bitsPerSample, alpha, output, outputBytes), profile);
    return {
      ...descriptor,
      pixels: runtime.copyOut(output, outputBytes, Float32Array),
      rowStride: width * 16,
      sampleType: "float32",
      bitsPerSample: 32,
      channelLayout: "rgba",
      alphaMode: "straight",
      colorEncoding: {
        primaries: "xyz-d65",
        transferFunction: "linear",
        transferFunctionParameters: null,
        whitePoint: "d65",
        referenceWhiteLuminance: 203,
        profile: null,
      },
    };
  } finally {
    if (output) runtime.free(output);
    if (input) runtime.free(input);
  }
}
