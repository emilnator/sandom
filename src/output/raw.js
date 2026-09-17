// SRAW v1 is Sandom's rebuildable reflection format. @sandom/color supplies
// binary16 conversion only; this module owns framing and validation.
import { WORKING_COLOR_ENCODING } from "../color.js";
import { transformImageForOutput } from "./color-transform.js";
import { packHalf, unpackHalf } from "./packing.js";

const HEADER_SIZE = 48;
const MAGIC = 0x57415253;
const MAX_COLOR_BYTES = 268435424;

function rawError(message, field) {
  const error = new Error(message);
  error.domain = "sraw";
  error.field = field;
  return error;
}

export function encodeRaw(descriptor, request) {
  if (request?.format !== "raw") {
    throw new Error('encodeRaw requires a validated OutputRequest with format "raw"');
  }
  const { pixels } = transformImageForOutput(descriptor, request);
  const payload = packHalf(pixels);
  const output = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, descriptor.width, true);
  view.setUint32(8, descriptor.height, true);
  view.setUint32(12, 1, true);
  view.setUint16(16, HEADER_SIZE, true);
  view.setUint16(18, 1, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint16(24, 1, true);
  view.setUint16(26, 1, true);
  view.setUint32(28, descriptor.width * 8, true);
  view.setUint32(32, payload.byteLength, true);
  view.setFloat32(36, 203, true);
  output.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), HEADER_SIZE);
  return output;
}

export function decodeRaw(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("raw input requires Uint8Array bytes");
  if (bytes.byteLength < HEADER_SIZE) {
    throw rawError(`raw input is ${bytes.byteLength} bytes, shorter than the 48-byte version 1 header`, 48);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw rawError("Not a SRAW file", 0);
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  if (width === 0 || height === 0) {
    throw rawError(`raw input declares a ${width}x${height} image; both dimensions must be positive`, width === 0 ? 4 : 8);
  }
  const version = view.getUint32(12, true);
  if (version !== 1) {
    throw rawError(`raw input declares format version ${version}; this runtime accepts only version 1. No migration tool exists - render the source scene again with the current runtime.`, 12);
  }
  if (view.getUint16(16, true) !== HEADER_SIZE) {
    throw rawError(`raw version 1 header size must be 48, got ${view.getUint16(16, true)}`, 16);
  }
  const enumNames = { 18: "pixel format", 20: "primaries", 22: "transfer function", 24: "white point", 26: "alpha mode" };
  for (const [offsetText, name] of Object.entries(enumNames)) {
    const offset = Number(offsetText);
    const value = view.getUint16(offset, true);
    if (value !== 1) throw rawError(`raw version 1 ${name} field must be 1, got ${value}`, offset);
  }
  const expectedStride = width * 8;
  if (!Number.isSafeInteger(expectedStride) || expectedStride > 0xffffffff || view.getUint32(28, true) !== expectedStride) {
    throw rawError(`raw version 1 row stride must be ${expectedStride}, got ${view.getUint32(28, true)}`, 28);
  }
  const expectedPayload = expectedStride * height;
  if (!Number.isSafeInteger(expectedPayload) || expectedPayload > 0xffffffff || view.getUint32(32, true) !== expectedPayload) {
    throw rawError(`raw version 1 payload size must be ${expectedPayload}, got ${view.getUint32(32, true)}`, 32);
  }
  if (expectedPayload * 2 > MAX_COLOR_BYTES) {
    throw rawError("raw version 1 decoded pixels exceed the color memory ceiling", 32);
  }
  if (view.getFloat32(36, true) !== 203) {
    throw rawError(`raw version 1 reference-white luminance must be 203, got ${view.getFloat32(36, true)}`, 36);
  }
  if (view.getUint32(40, true) !== 0 || view.getUint32(44, true) !== 0) {
    throw rawError("raw version 1 flags and reserved fields must be zero", view.getUint32(40, true) !== 0 ? 40 : 44);
  }
  const expectedLength = HEADER_SIZE + expectedPayload;
  if (bytes.byteLength !== expectedLength) {
    throw rawError(`raw input is ${bytes.byteLength} bytes; the header describes exactly ${expectedLength} with no trailing bytes`, 48);
  }
  const payload = bytes.slice(HEADER_SIZE);
  const pixels = unpackHalf(new Uint16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2));
  return {
    pixels,
    width,
    height,
    rowStride: width * 16,
    channelLayout: "rgba",
    sampleType: "float32",
    bitsPerSample: 16,
    alphaMode: "premultiplied",
    colorEncoding: WORKING_COLOR_ENCODING,
    metadata: {},
  };
}
