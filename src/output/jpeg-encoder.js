import { readBinaryFile } from "../host.js";
import encodeMozJpeg, { init as initializeMozJpeg } from "../../vendor/jsquash-jpeg/encode.js";

let encoderInitialization = null;

async function initializeEncoder() {
  if (encoderInitialization === null) {
    encoderInitialization = (async () => {
      const bytes = await readBinaryFile(
        new URL("../../vendor/jsquash-jpeg/mozjpeg_enc.wasm", import.meta.url),
      );
      const module = await WebAssembly.compile(bytes);
      await initializeMozJpeg(module);
    })();
  }
  await encoderInitialization;
}

export const JPEG_ENCODER_OPTIONS = Object.freeze({
  quality: Object.freeze({ minimum: 0, maximum: 100 }),
});

export async function encodeJpegRgba(image, options) {
  if (image === null || typeof image !== "object") {
    throw new Error("JPEG encoder: image must be an object");
  }
  if (!Number.isInteger(image.width) || image.width <= 0 ||
    !Number.isInteger(image.height) || image.height <= 0) {
    throw new Error("JPEG encoder: width and height must be positive integers");
  }
  if (!(image.pixels instanceof Uint8Array || image.pixels instanceof Uint8ClampedArray) ||
    image.pixels.length !== image.width * image.height * 4) {
    throw new Error("JPEG encoder: pixels must be a tightly packed RGBA8 array");
  }
  if (options === null || typeof options !== "object" ||
    Object.keys(options).some((key) => key !== "quality")) {
    throw new Error("JPEG encoder: options accept only quality");
  }
  const quality = options.quality;
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
    throw new Error("JPEG encoder: quality must be an integer from 0 through 100");
  }
  await initializeEncoder();
  const buffer = await encodeMozJpeg({
    width: image.width,
    height: image.height,
    data: image.pixels,
  }, {
    quality,
    baseline: true,
    progressive: false,
    arithmetic: false,
    optimize_coding: true,
    smoothing: 0,
    color_space: 3,
    quant_table: 3,
    trellis_multipass: false,
    trellis_opt_zero: false,
    trellis_opt_table: false,
    trellis_loops: 1,
    auto_subsample: true,
    chroma_subsample: 2,
    separate_chroma_quality: false,
    chroma_quality: quality,
  });
  return new Uint8Array(buffer);
}
