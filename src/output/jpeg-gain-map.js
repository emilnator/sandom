import { decodeJPEG } from "../jpeg.js";
import {
  adaptiveImageMetadata,
  GAIN_MAP_CALCULATION_COLOR_ENCODING,
  measureAdaptiveImageError,
  reconstructAdaptiveImage,
  validateAdaptiveImageRecord,
} from "./gain-map.js";
import {
  inspectWithWasm,
  packageWithWasm,
} from "./gain-map-wasm.js";
import { encodeJpegRgba } from "./jpeg-encoder.js";

function quantizeBaseImage(image) {
  const pixels = new Uint8ClampedArray(image.width * image.height * 4);
  for (let pixelIndex = 0; pixelIndex < image.width * image.height; pixelIndex++) {
    for (let channel = 0; channel < 3; channel++) {
      pixels[pixelIndex * 4 + channel] = Math.round(Math.max(0, Math.min(1, image.pixels[pixelIndex * 4 + channel])) * 255);
    }
    pixels[pixelIndex * 4 + 3] = 255;
  }
  return pixels;
}

function quantizeGainMap(image) {
  const pixels = new Uint8ClampedArray(image.width * image.height * 4);
  for (let pixelIndex = 0; pixelIndex < image.width * image.height; pixelIndex++) {
    for (let channel = 0; channel < 3; channel++) {
      pixels[pixelIndex * 4 + channel] = Math.round(Math.max(0, Math.min(1, image.pixels[pixelIndex * 3 + channel])) * 255);
    }
    pixels[pixelIndex * 4 + 3] = 255;
  }
  return pixels;
}

function decodedGainMapDescriptor(decoded) {
  const pixels = new Float32Array(decoded.width * decoded.height * 3);
  for (let pixelIndex = 0; pixelIndex < decoded.width * decoded.height; pixelIndex++) {
    pixels[pixelIndex * 3] = decoded.pixels[pixelIndex * 4] / 255;
    pixels[pixelIndex * 3 + 1] = decoded.pixels[pixelIndex * 4 + 1] / 255;
    pixels[pixelIndex * 3 + 2] = decoded.pixels[pixelIndex * 4 + 2] / 255;
  }
  return Object.freeze({
    width: decoded.width,
    height: decoded.height,
    rowStride: decoded.width * 12,
    pixels,
    channelLayout: "rgb",
    sampleType: "float32",
    bitsPerSample: 32,
    colorEncoding: GAIN_MAP_CALCULATION_COLOR_ENCODING,
    alphaMode: "opaque",
    metadata: {},
  });
}

export function inspectGainMapJpeg(bytes) {
  return inspectWithWasm(bytes);
}

export async function encodeGainMapJpegPackage(record) {
  validateAdaptiveImageRecord(record);
  const metadata = adaptiveImageMetadata(record);
  const baseJpeg = await encodeJpegRgba({
    width: record.baseImage.width,
    height: record.baseImage.height,
    pixels: quantizeBaseImage(record.baseImage),
  }, { quality: record.generationOptions.baseQuality });
  const gainMapJpeg = await encodeJpegRgba({
    width: record.gainMapImage.width,
    height: record.gainMapImage.height,
    pixels: quantizeGainMap(record.gainMapImage),
  }, { quality: record.generationOptions.gainMapQuality });
  const bytes = packageWithWasm(baseJpeg, gainMapJpeg, metadata);
  const inspection = inspectGainMapJpeg(bytes);
  const packageMetadata = inspection.metadata;
  const [decodedBase, decodedGainMap] = await Promise.all([
    decodeJPEG(baseJpeg),
    decodeJPEG(gainMapJpeg),
  ]);
  const decodedGainMapImage = decodedGainMapDescriptor(decodedGainMap);
  const reconstructionErrors = record.generationOptions.verificationBoosts.map((displayBoost) => {
    const expected = reconstructAdaptiveImage({
      baseImage: record.baseImage,
      gainMapImage: record.gainMapImage,
      metadata: packageMetadata,
      displayBoost,
    });
    const reconstructed = reconstructAdaptiveImage({
      baseImage: decodedBase,
      gainMapImage: decodedGainMapImage,
      metadata: packageMetadata,
      displayBoost,
    });
    return Object.freeze({ displayBoost, ...measureAdaptiveImageError(expected, reconstructed) });
  });
  return Object.freeze({
    bytes,
    facts: Object.freeze({
      mediaType: "image/jpeg",
      compatibilityProfile: inspection.compatibilityProfile,
      selectedMetadataSource: inspection.selectedMetadataSource,
      baseDimensions: Object.freeze({ width: record.baseImage.width, height: record.baseImage.height }),
      gainMapDimensions: Object.freeze({ width: record.gainMapImage.width, height: record.gainMapImage.height }),
      baseQuality: record.generationOptions.baseQuality,
      gainMapQuality: record.generationOptions.gainMapQuality,
      channelCount: 3,
      metadata: inspection.metadata,
      reconstructionTestDisplayBoosts: record.generationOptions.verificationBoosts,
      reconstructionErrors: Object.freeze(reconstructionErrors),
    }),
  });
}

export async function decodeGainMapJpeg(bytes, { decodeJpeg = decodeJPEG } = {}) {
  const inspection = inspectGainMapJpeg(bytes);
  if (!inspection.isGainMap) throw new Error("JPEG gain map decoder: file is an ordinary JPEG");
  const baseBytes = bytes.subarray(inspection.primaryImage.offset, inspection.primaryImage.offset + inspection.primaryImage.byteLength);
  const gainBytes = bytes.subarray(inspection.gainMapImage.offset, inspection.gainMapImage.offset + inspection.gainMapImage.byteLength);
  const [baseImage, decodedGainMap] = await Promise.all([decodeJpeg(baseBytes), decodeJpeg(gainBytes)]);
  const gainMapImage = decodedGainMapDescriptor(decodedGainMap);
  if (gainMapImage.width > baseImage.width || gainMapImage.height > baseImage.height) {
    throw new Error("JPEG gain map decoder: gain map dimensions exceed the base image");
  }
  return Object.freeze({ ...inspection, baseImage, gainMapImage });
}

export async function reconstructGainMapJpeg(bytes, displayBoost, options = {}) {
  const decoded = await decodeGainMapJpeg(bytes, options);
  return reconstructAdaptiveImage({
    baseImage: decoded.baseImage,
    gainMapImage: decoded.gainMapImage,
    metadata: decoded.metadata,
    displayBoost,
  });
}
