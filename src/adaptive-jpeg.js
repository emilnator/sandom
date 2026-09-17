import {
  DEFAULT_ADAPTIVE_CODEC_OPTIONS,
  generateAdaptiveImage,
} from "./output/gain-map.js";
import {
  encodeGainMapJpegPackage,
  inspectGainMapJpeg,
  reconstructGainMapJpeg,
} from "./output/jpeg-gain-map.js";

/**
 * Encodes one opaque float32 RGBA linear Rec. 2020 image as a verified
 * ISO 21496-1 and Ultra HDR compatible JPEG gain-map package.
 */
export async function encodeAdaptiveJpeg(descriptor, codecOptions = {}) {
  const record = generateAdaptiveImage(descriptor, Object.freeze({
    codecOptions,
  }));
  return await encodeGainMapJpegPackage(record);
}

export {
  DEFAULT_ADAPTIVE_CODEC_OPTIONS,
  inspectGainMapJpeg,
  reconstructGainMapJpeg,
};
