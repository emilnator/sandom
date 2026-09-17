/**
 * JPEG XL codec - libjxl compiled to WebAssembly (vendor/jpeg-xl.wasm,
 * built by vendor/jpeg-xl-wasm/build.sh from the pinned libjxl v0.11.2).
 *
 * Decode: a single still image at its own native precision - uint8,
 * uint16, or float32 samples - as a working `ImageDescriptor` whose
 * color encoding is the stream's encoded (enum) profile when one exists
 * (sRGB, Display P3, Rec. 2100 PQ or HLG, linear, or a pure gamma
 * curve), else the DATA-target ICC profile bytes. Animation and extra
 * channels beyond one alpha channel are rejected with precise errors;
 * the animation error names the frame count.
 *
 * Encode: `encodeJXL` takes interleaved RGBA samples plus the validated
 * output request contract fields and returns the codestream bytes. The
 * central output transform (src/output/image.js) owns request
 * validation and color conversion; this module only drives the codec.
 */

import { isJXL } from './jpeg-xl-signature.js';
import { validateImageDescriptor } from './image-data.js';
import { readBinaryFile } from './host.js';
import { transformImageForOutput } from './output/color-transform.js';
import { packSignal, packHalf, unpackHalf } from './output/packing.js';

export function createJpegXlCodec({
  jpegXlBytes,
  getJpegXlBytes = null,
} = {}) {
let jxlInstance = null;

async function ensureJxl() {
  if (jxlInstance) return jxlInstance;
  const wasmBytes = getJpegXlBytes
    ? await getJpegXlBytes()
    : jpegXlBytes ??
      await readBinaryFile(new URL('../vendor/jpeg-xl.wasm', import.meta.url));
  // The module is a standalone-WASM reactor: the only imports are the C
  // runtime's minimal WASI surface (never exercised on the paths this
  // shim uses - no files, no stdio) plus emscripten's memory-growth
  // notification. Each stub throws so a silent dependency can never
  // creep in unnoticed.
  const wasiStub = (name) => () => {
    throw new Error(`jpeg-xl.wasm called unexpected WASI import ${name}`);
  };
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: { emscripten_notify_memory_growth: () => {} },
    wasi_snapshot_preview1: {
      proc_exit: wasiStub('proc_exit'),
      fd_close: wasiStub('fd_close'),
      fd_write: wasiStub('fd_write'),
      fd_seek: wasiStub('fd_seek'),
    },
  });
  instance.exports._initialize();
  jxlInstance = instance;
  return instance;
}

// JxlPrimaries / JxlTransferFunction / JxlWhitePoint enum values
// (lib/include/jxl/color_encoding.h, libjxl v0.11.2).
const JXL_PRIMARIES = { 1: 'srgb', 9: 'rec2020', 11: 'display-p3' };
const JXL_TRANSFERS = {
  1: 'rec2020', // BT.709 camera curve - the repository's "rec2020" family
  8: 'linear',
  13: 'srgb',
  16: 'pq',
  18: 'hlg',
};
const JXL_TRANSFER_GAMMA = 65535;
const JXL_WHITE_POINT_D65 = 1;

const DECODE_ERRORS = {
  '1': 'not a JPEG XL stream',
  '2': 'the codestream is corrupt or uses an unsupported feature',
  '5': 'the decoder ran out of memory',
};

const SAMPLE_KINDS = [
  { sampleType: 'uint8', arrayConstructor: Uint8Array, bytesPerSample: 1 },
  { sampleType: 'uint16', arrayConstructor: Uint16Array, bytesPerSample: 2 },
  { sampleType: 'float32', arrayConstructor: Float32Array, bytesPerSample: 4 },
];

/**
 * Decodes JPEG XL bytes into a native-precision `ImageDescriptor`.
 */
async function decodeJXL(bytes) {
  const wasm = await ensureJxl();
  const e = wasm.exports;

  const inputPtr = e.jxl_alloc_input(bytes.length);
  new Uint8Array(e.memory.buffer, inputPtr, bytes.length).set(bytes);
  const status = e.jxl_decode(bytes.length);
  if (status === 3) {
    const frames = e.jxl_animation_frames();
    throw new Error(
      `decodeJXL: animated JPEG XL is not supported in a still-image decoder (the stream carries ${frames} frames)`,
    );
  }
  if (status === 4) {
    throw new Error(
      'decodeJXL: extra channels beyond one alpha channel are not supported',
    );
  }
  if (status !== 0) {
    throw new Error(
      `decodeJXL failed (${status}): ${DECODE_ERRORS[String(status)] ?? 'unknown decoder status'}`,
    );
  }

  const width = e.jxl_width();
  const height = e.jxl_height();
  const kind = SAMPLE_KINDS[e.jxl_sample_kind()];
  const pixelBytes = e.jxl_pixels_size();
  // Copied out, not viewed in place: the returned pixels outlive
  // jxl_release, and a later call's allocation can grow (and detach)
  // this memory's backing buffer.
  const pixels = new kind.arrayConstructor(
    new kind.arrayConstructor(
      e.memory.buffer,
      e.jxl_pixels_ptr(),
      pixelBytes / kind.bytesPerSample,
    ),
  );
  const iccSize = e.jxl_icc_size();
  const icc = iccSize > 0
    ? new Uint8Array(new Uint8Array(e.memory.buffer, e.jxl_icc_ptr(), iccSize))
    : null;
  const haveEncoded = e.jxl_have_encoded_profile() === 1;
  const encodedPrimaries = e.jxl_encoded_primaries();
  const encodedTransfer = e.jxl_encoded_transfer();
  const encodedWhitePoint = e.jxl_encoded_white_point();
  const encodedGamma = e.jxl_encoded_gamma();
  const alphaPremultiplied = e.jxl_alpha_premultiplied() === 1;
  e.jxl_release();

  const base = {
    transferFunctionParameters: null,
    whitePoint: 'd65',
    referenceWhiteLuminance: 203,
    profile: null,
  };
  let colorEncoding = null;
  if (haveEncoded && encodedWhitePoint === JXL_WHITE_POINT_D65) {
    const primaries = JXL_PRIMARIES[encodedPrimaries];
    if (primaries !== undefined) {
      if (encodedTransfer === JXL_TRANSFER_GAMMA && encodedGamma > 0) {
        colorEncoding = {
          ...base,
          primaries,
          transferFunction: 'gamma',
          transferFunctionParameters: [1 / encodedGamma],
        };
      } else if (JXL_TRANSFERS[encodedTransfer] !== undefined) {
        colorEncoding = {
          ...base,
          primaries,
          transferFunction: JXL_TRANSFERS[encodedTransfer],
        };
      }
    }
  }
  if (colorEncoding === null) {
    if (icc === null) {
      throw new Error(
        'decodeJXL: the stream carries neither a supported encoded color profile nor ICC profile bytes',
      );
    }
    colorEncoding = {
      ...base,
      primaries: 'srgb',
      transferFunction: 'icc',
      profile: icc,
    };
  }

  const metadata = { orientation: 1 };
  if (icc !== null) metadata.iccProfile = icc;
  return validateImageDescriptor({
    width,
    height,
    rowStride: width * 4 * kind.bytesPerSample,
    pixels,
    channelLayout: 'rgba',
    sampleType: kind.sampleType,
    // libjxl scales integer output to the container's full range (a
    // 10-bit-coded image arrives as full-scale uint16), so the
    // descriptor's meaningful precision is the container width, never
    // the coded depth.
    bitsPerSample: kind.bytesPerSample * 8,
    colorEncoding,
    alphaMode: alphaPremultiplied ? 'premultiplied' : 'straight',
    metadata,
  });
}

// Color-space enum shared with the shim (vendor/jpeg-xl-wasm/src/jxl_shim.c).
const ENCODE_COLOR_SPACES = {
  'srgb/srgb': 0,
  'display-p3/srgb': 1,
  'rec2020/pq': 2,
  'rec2020/hlg': 3,
};

/**
 * Encodes interleaved RGBA samples as a JPEG XL codestream.
 *
 * `samples` is a Uint8Array, Uint16Array, or Float32Array of
 * width * height * 4 interleaved RGBA values already in the requested
 * signal encoding. `colorEncoding` names one of the supported
 * primaries/transfer pairs. `bitDepth` is the DECLARED image depth -
 * 8, 10, 12, or 16 integer bits, or "float16"/"float32" - independent
 * of the input sample type (the codec quantizes float input to an
 * integer declaration). `lossless` selects modular lossless coding;
 * otherwise `distance` is the Butteraugli distance (default 1).
 */
async function encodeJXL(samples, width, height, {
  colorEncoding,
  bitDepth = 8,
  lossless = false,
  distance = 1,
  effort = 7,
}) {
  const key = `${colorEncoding.primaries}/${colorEncoding.transferFunction}`;
  const colorSpace = ENCODE_COLOR_SPACES[key];
  if (colorSpace === undefined) {
    throw new Error(`encodeJXL: unsupported color encoding ${key}`);
  }
  const depth = bitDepth === 'float16'
    ? { bits: 16, exponentBits: 5 }
    : bitDepth === 'float32'
    ? { bits: 32, exponentBits: 8 }
    : { bits: bitDepth, exponentBits: 0 };
  // The codec's input samples MUST match the declared depth class for
  // lossless coding: integer declarations take integer samples scaled
  // to the declared range, float declarations take float samples. A
  // float32 signal buffer (the central transform's output) converts
  // here - directly to the declared depth, never through eight bits.
  let input = samples;
  let sampleKind = samples instanceof Float32Array
    ? 2
    : samples instanceof Uint16Array
    ? 1
    : 0;
  if (depth.exponentBits === 0 && samples instanceof Float32Array) {
    const packed = packSignal(samples, depth.bits);
    input = depth.bits === 8 ? packed : new Uint16Array(packed.buffer, packed.byteOffset, packed.byteLength / 2);
    sampleKind = depth.bits === 8 ? 0 : 1;
  }
  if (depth.exponentBits === 5 && samples instanceof Float32Array) {
    // A float16 declaration stores binary16 samples: round the float32
    // input to binary16 precision first, so lossless coding is
    // well-defined (libjxl rejects float16-lossless input it cannot
    // represent exactly).
    input = unpackHalf(packHalf(samples));
  }
  const wasm = await ensureJxl();
  const e = wasm.exports;
  const inputPtr = e.jxl_alloc_input(input.byteLength);
  new Uint8Array(e.memory.buffer, inputPtr, input.byteLength).set(
    new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
  );
  const status = e.jxl_encode(
    width,
    height,
    sampleKind,
    depth.bits,
    depth.exponentBits,
    colorSpace,
    lossless ? 1 : 0,
    Math.round(distance * 1000),
    effort,
  );
  if (status !== 0) {
    throw new Error(
      `encodeJXL failed (${status}): ${status === 5 ? 'the encoder ran out of memory' : 'encoder error'}`,
    );
  }
  const output = new Uint8Array(
    new Uint8Array(e.memory.buffer, e.jxl_output_ptr(), e.jxl_output_size()),
  );
  e.jxl_release_output();
  return output;
}

/**
 * Output adapter (wide-color plan, slice 3): a working `ImageDescriptor`
 * through the central transform into a JPEG XL codestream, driven by a
 * VALIDATED `OutputRequest` with format "jpeg-xl" (src/output/image.js
 * owns the closed contract). The transform produces the signal-domain
 * float32 samples; the codec declares the requested bit depth and
 * quantizes internally, so no eight-bit intermediate ever exists.
 */
async function encodeJxlOutput(descriptor, request) {
  if (request?.format !== 'jpeg-xl') {
    throw new Error('encodeJxlOutput requires a validated OutputRequest with format "jpeg-xl"');
  }
  const { width, height } = descriptor;
  const { pixels: signal } = transformImageForOutput(descriptor, request);
  return await encodeJXL(signal, width, height, {
    colorEncoding: request.colorEncoding,
    bitDepth: request.bitDepth,
    lossless: request.codecOptions.lossless ?? false,
    distance: request.codecOptions.distance ?? 1,
  });
}

  return Object.freeze({
    decodeJXL,
    encodeJXL,
    encodeJxlOutput,
    isJXL,
    instanceIdentity() {
      return jxlInstance;
    },
  });
}

const defaultJpegXlCodec = createJpegXlCodec();

export const decodeJXL = (...arguments_) =>
  defaultJpegXlCodec.decodeJXL(...arguments_);
export const encodeJXL = (...arguments_) =>
  defaultJpegXlCodec.encodeJXL(...arguments_);
export const encodeJxlOutput = (...arguments_) =>
  defaultJpegXlCodec.encodeJxlOutput(...arguments_);
export { isJXL };
