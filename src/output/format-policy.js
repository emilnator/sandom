// Codec/container capability policy belongs to Sandom, not @sandom/color.
const SRGB = Object.freeze([["srgb", "srgb"]]);
const RGB_STILL = Object.freeze([...SRGB, ["display-p3", "srgb"], ["rec2020", "pq"], ["rec2020", "hlg"]]);
const STRAIGHT_ALPHA = Object.freeze(["opaque", "straight"]);
const PREMULTIPLIED_ALPHA = Object.freeze(["premultiplied"]);

export const FORMAT_CAPABILITIES = Object.freeze({
  png: Object.freeze({ bitDepths: Object.freeze([8, 16]), encodings: RGB_STILL, alphaModes: STRAIGHT_ALPHA, defaultAlphaMode: "straight", defaultEncoding: "srgb", defaultBitDepth: 8, highDynamicRange: true, requiresMastering: true }),
  "jpeg-xl": Object.freeze({ bitDepths: Object.freeze([8, 10, 12, 16, "float16", "float32"]), encodings: RGB_STILL, alphaModes: STRAIGHT_ALPHA, defaultAlphaMode: "straight", defaultEncoding: "srgb", defaultBitDepth: 8, highDynamicRange: true, requiresMastering: true }),
  "jpeg-gain-map": Object.freeze({ bitDepths: Object.freeze([8]), encodings: SRGB, alphaModes: STRAIGHT_ALPHA, defaultAlphaMode: "straight", defaultEncoding: "srgb", defaultBitDepth: 8, highDynamicRange: true, requiresMastering: false }),
  raw: Object.freeze({ bitDepths: Object.freeze(["float16"]), encodings: Object.freeze([["rec2020", "linear"]]), alphaModes: PREMULTIPLIED_ALPHA, defaultAlphaMode: "premultiplied", defaultEncoding: "linear-rec2020", defaultBitDepth: "float16", highDynamicRange: true, requiresMastering: true }),
  bmp: Object.freeze({ bitDepths: Object.freeze([8]), encodings: SRGB, alphaModes: STRAIGHT_ALPHA, defaultAlphaMode: "straight", defaultEncoding: "srgb", defaultBitDepth: 8, highDynamicRange: false, requiresMastering: true }),
  ppm: Object.freeze({ bitDepths: Object.freeze([8]), encodings: SRGB, alphaModes: STRAIGHT_ALPHA, defaultAlphaMode: "straight", defaultEncoding: "srgb", defaultBitDepth: 8, highDynamicRange: false, requiresMastering: true }),
  "webp-animation": Object.freeze({ bitDepths: Object.freeze([8]), encodings: SRGB, alphaModes: STRAIGHT_ALPHA, defaultAlphaMode: "straight", defaultEncoding: "srgb", defaultBitDepth: 8, highDynamicRange: false, requiresMastering: true }),
  video: Object.freeze({ bitDepths: Object.freeze([8, 10]), encodings: Object.freeze([["srgb", "rec2020"], ["rec2020", "pq"], ["rec2020", "hlg"]]), alphaModes: STRAIGHT_ALPHA, defaultAlphaMode: "straight", defaultEncoding: "bt709", defaultBitDepth: 8, highDynamicRange: true, requiresMastering: true }),
  canvas: Object.freeze({ bitDepths: Object.freeze([8, "float16"]), encodings: Object.freeze([["srgb", "srgb"], ["display-p3", "srgb"]]), alphaModes: PREMULTIPLIED_ALPHA, defaultAlphaMode: "premultiplied", defaultEncoding: "srgb", defaultBitDepth: 8, highDynamicRange: true, requiresMastering: false }),
});
