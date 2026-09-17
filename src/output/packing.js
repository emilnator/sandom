// Generic sample packing through @sandom/color. Container framing stays local.
import { colorRuntime } from "../wasm/color-runtime.js";

const SAMPLE_TYPES = Object.freeze({
  uint8: Uint8Array,
  uint16: Uint16Array,
  float16: Uint16Array,
  float32: Float32Array,
});

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff) {
    throw new RangeError("color packing requires positive signed-32-bit dimensions");
  }
}

function floatSamples(pixels) {
  if (!(pixels instanceof Float32Array)) throw new TypeError("color packing requires Float32Array samples");
}

function packedBuffer(source, byteLength, Constructor, operation, parameters) {
  const runtime = colorRuntime();
  let input = 0;
  let output = 0;
  try {
    input = runtime.copyIn(source);
    output = runtime.alloc(byteLength);
    runtime.check(runtime.exports[operation](input, ...parameters, output, byteLength));
    return runtime.copyOut(output, byteLength, Constructor);
  } finally {
    runtime.free(output);
    runtime.free(input);
  }
}

export function float32ToFloat16Bits(value) {
  return colorRuntime().exports.color_float_to_half(value);
}

export function float16BitsToFloat32(bits) {
  return colorRuntime().exports.color_half_to_float(bits);
}

export function packSignal(pixels, bits = 8, channels = 4) {
  floatSamples(pixels);
  if (bits !== 8 && bits !== 10 && bits !== 12 && bits !== 16) {
    throw new RangeError("color signal packing requires 8, 10, 12, or 16 bits");
  }
  if (channels !== 3 && channels !== 4) throw new RangeError("color signal packing requires 3 or 4 channels");
  if (channels === 3 && pixels.length % 4 !== 0) throw new RangeError("RGB packing requires complete RGBA pixels");
  const count = channels === 4 ? pixels.length : pixels.length / 4 * 3;
  return packedBuffer(pixels, count * (bits === 8 ? 1 : 2), Uint8Array,
    "color_pack_signal", [pixels.length, bits, channels]);
}

export function packHalf(pixels) {
  floatSamples(pixels);
  return packedBuffer(pixels, pixels.length * 2, Uint16Array, "color_pack_half", [pixels.length]);
}

export function unpackHalf(words) {
  if (!(words instanceof Uint16Array)) throw new TypeError("half unpacking requires Uint16Array words");
  return packedBuffer(words, words.length * 4, Float32Array, "color_unpack_half", [words.length]);
}

export function expandImageSamples(descriptor) {
  const { pixels, width, height, rowStride, sampleType, channelLayout } = descriptor;
  dimensions(width, height);
  const ArrayConstructor = SAMPLE_TYPES[sampleType];
  const runtime = colorRuntime();
  const sample = runtime.abi.enums.sample[sampleType];
  const layout = runtime.abi.enums.layout[channelLayout];
  if (!Object.hasOwn(SAMPLE_TYPES, sampleType) || sample === undefined || layout === undefined) {
    throw new RangeError("unknown color sample type or channel layout");
  }
  if (!(pixels instanceof ArrayConstructor)) throw new TypeError("color sample type does not match its typed array");
  if (!Number.isInteger(rowStride) || rowStride < 0 || rowStride > 0xffffffff) {
    throw new RangeError("color row stride must be an unsigned-32-bit byte count");
  }
  return packedBuffer(pixels, width * height * 4 * ArrayConstructor.BYTES_PER_ELEMENT,
    ArrayConstructor, "color_expand_samples", [pixels.byteLength, width, height, rowStride, sample, layout]);
}

export function packBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("color byte packing requires Uint8Array");
  const runtime = colorRuntime();
  const byteLength = runtime.exports.color_packing_size(bytes.byteLength, 1, 1);
  if (byteLength !== bytes.byteLength) throw new RangeError("color byte packing size rejected");
  return packedBuffer(bytes, byteLength, Uint8Array, "color_pack_image", [bytes.byteLength]);
}
