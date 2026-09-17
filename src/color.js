import { colorRuntime } from "./wasm/color-runtime.js";

// Color contract constants and validators.
//
// Normative source: docs/specifications/color-and-image-data.md.
// Runtime code uses only the identifiers named there. Every validator throws
// with one precise reason; nothing is inferred from file extensions,
// typed-array classes, or displays.

export const PRIMARIES = Object.freeze([
  'srgb',
  'display-p3',
  'rec2020',
  'a98-rgb',
  'prophoto-rgb',
  'xyz-d50',
  'xyz-d65',
]);

export const TRANSFER_FUNCTIONS = Object.freeze([
  'srgb',
  'linear',
  'gamma',
  'pq',
  'hlg',
  'rec2020',
  'prophoto-rgb',
  'icc',
]);

export const WHITE_POINTS = Object.freeze(['d50', 'd65']);

export const RENDER_MODES = Object.freeze(['standard', 'high-dynamic-range']);
export const DEFAULT_RENDER_MODE = 'standard';

export const RENDER_PRECISIONS = Object.freeze(['rgba16float', 'rgba8unorm']);
export const DEFAULT_RENDER_PRECISION = 'rgba16float';

// Reference white for the working encodings and all CSS colors, in candelas
// per square metre. A working channel value of 1 equals this luminance in
// linear terms.
export const REFERENCE_WHITE_LUMINANCE = 203;

// Standard mode's working encoding: extended sign-mirrored encoded sRGB,
// so blending and resampling match Blink exactly.
export const STANDARD_WORKING_COLOR_ENCODING = Object.freeze({
  primaries: 'srgb',
  transferFunction: 'srgb',
  transferFunctionParameters: null,
  whitePoint: 'd65',
  referenceWhiteLuminance: REFERENCE_WHITE_LUMINANCE,
  profile: null,
});

// High-dynamic-range mode's working encoding: linear Rec. 2020.
export const WORKING_COLOR_ENCODING = Object.freeze({
  primaries: 'rec2020',
  transferFunction: 'linear',
  transferFunctionParameters: null,
  whitePoint: 'd65',
  referenceWhiteLuminance: REFERENCE_WHITE_LUMINANCE,
  profile: null,
});

export function validateRenderMode(renderMode) {
  if (!RENDER_MODES.includes(renderMode)) {
    throw new Error(`Unknown render mode "${renderMode}"`);
  }
  return renderMode;
}

// Closed operation set for tools/probe-color-capabilities.js results.
export const PROBE_OPERATIONS = Object.freeze([
  'rgba16float-render-attachment',
  'rgba16float-source-over-blend',
  'rgba16float-filtered-sample',
  'rgba16float-buffer-copy',
  'half-float-readback-above-one',
  'canvas-srgb',
  'canvas-display-p3',
  'canvas-rgba16float',
  'canvas-tone-mapping-standard',
  'canvas-tone-mapping-extended',
]);

export function validateColorEncoding(encoding) {
  if (encoding === null || typeof encoding !== 'object') {
    throw new Error('ColorEncoding must be an object');
  }
  const {
    primaries,
    transferFunction,
    transferFunctionParameters,
    whitePoint,
    referenceWhiteLuminance,
    profile,
  } = encoding;
  if (!PRIMARIES.includes(primaries)) {
    throw new Error(`ColorEncoding: unknown primaries "${primaries}"`);
  }
  if (!TRANSFER_FUNCTIONS.includes(transferFunction)) {
    throw new Error(`ColorEncoding: unknown transfer function "${transferFunction}"`);
  }
  if (transferFunction === 'gamma') {
    if (
      typeof transferFunctionParameters !== 'number' ||
      !Number.isFinite(transferFunctionParameters) ||
      transferFunctionParameters <= 0
    ) {
      throw new Error(
        'ColorEncoding: the gamma transfer function requires one positive finite exponent',
      );
    }
  } else if (transferFunctionParameters !== null) {
    throw new Error(
      `ColorEncoding: transferFunctionParameters must be null for "${transferFunction}"`,
    );
  }
  if (!WHITE_POINTS.includes(whitePoint)) {
    throw new Error(`ColorEncoding: unknown white point "${whitePoint}"`);
  }
  if (
    typeof referenceWhiteLuminance !== 'number' ||
    !Number.isFinite(referenceWhiteLuminance) ||
    referenceWhiteLuminance <= 0
  ) {
    throw new Error('ColorEncoding: referenceWhiteLuminance must be a positive finite number');
  }
  if (transferFunction === 'icc') {
    if (!(profile instanceof Uint8Array) || profile.length === 0) {
      throw new Error(
        'ColorEncoding: an icc transfer function requires the original profile bytes',
      );
    }
  } else if (profile !== null) {
    throw new Error(`ColorEncoding: profile must be null for "${transferFunction}"`);
  }
  return encoding;
}

export function validateRenderPrecision(renderPrecision) {
  if (!RENDER_PRECISIONS.includes(renderPrecision)) {
    throw new Error(`Unknown render precision "${renderPrecision}"`);
  }
  return renderPrecision;
}

export function validateTaggedColor(taggedColor) {
  if (taggedColor === null || typeof taggedColor !== 'object') {
    throw new Error('TaggedColor must be an object');
  }
  const { components, missingComponents, alpha, alphaIsMissing, colorEncoding, alphaMode } =
    taggedColor;
  if (!Array.isArray(components) || components.length !== 3) {
    throw new Error('TaggedColor: components must be an array of three entries');
  }
  if (!Number.isInteger(missingComponents) || missingComponents < 0 || missingComponents > 0b111) {
    throw new Error('TaggedColor: missingComponents must be a three-bit mask');
  }
  for (let index = 0; index < 3; index += 1) {
    const component = components[index];
    const maskBit = (missingComponents >> index) & 1;
    if (component === null) {
      if (maskBit !== 1) {
        throw new Error(
          `TaggedColor: component ${index} is null but its missingComponents bit is clear`,
        );
      }
    } else if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new Error(`TaggedColor: component ${index} must be a finite number or null`);
    } else if (maskBit !== 0) {
      throw new Error(
        `TaggedColor: component ${index} is present but its missingComponents bit is set`,
      );
    }
  }
  if (alpha !== null && (typeof alpha !== 'number' || !Number.isFinite(alpha))) {
    throw new Error('TaggedColor: alpha must be a finite number or null');
  }
  if (alphaIsMissing !== (alpha === null)) {
    throw new Error('TaggedColor: alphaIsMissing must be true exactly when alpha is null');
  }
  if (alphaMode !== 'straight') {
    throw new Error('TaggedColor: alphaMode must be "straight" at the parse boundary');
  }
  validateColorEncoding(colorEncoding);
  return taggedColor;
}

// ---------------------------------------------------------------------------
// Conversion math.
//
// Every matrix below is derived at module load from primary chromaticities
// (SMPTE RP 177 method), never hand-typed. All calculations use double
// precision. test/color_conversion_test.js proves each transform against
// authoritative vectors.
// ---------------------------------------------------------------------------

function multiplyMatrixVector(matrix, vector) {
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
  ];
}

function multiplyMatrices(a, b) {
  const result = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      result[row][column] =
        a[row][0] * b[0][column] + a[row][1] * b[1][column] + a[row][2] * b[2][column];
    }
  }
  return result;
}

function invertMatrix(m) {
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const cofactorA = e * i - f * h;
  const cofactorB = f * g - d * i;
  const cofactorC = d * h - e * g;
  const determinant = a * cofactorA + b * cofactorB + c * cofactorC;
  if (determinant === 0) throw new Error('Matrix is not invertible');
  const s = 1 / determinant;
  return [
    [cofactorA * s, (c * h - b * i) * s, (b * f - c * e) * s],
    [cofactorB * s, (a * i - c * g) * s, (c * d - a * f) * s],
    [cofactorC * s, (b * g - a * h) * s, (a * e - b * d) * s],
  ];
}

function whitePointToXyz([x, y]) {
  return [x / y, 1, (1 - x - y) / y];
}

const WHITE_POINT_CHROMATICITIES = Object.freeze({
  d50: [0.3457, 0.3585],
  d65: [0.3127, 0.329],
});

export const XYZ_WHITE_D50 = Object.freeze(whitePointToXyz(WHITE_POINT_CHROMATICITIES.d50));
export const XYZ_WHITE_D65 = Object.freeze(whitePointToXyz(WHITE_POINT_CHROMATICITIES.d65));

// CSS Color 4 primary chromaticities. xyz-d50 and xyz-d65 are identity
// spaces handled without a matrix.
const PRIMARY_CHROMATICITIES = Object.freeze({
  srgb: { red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06], whitePoint: 'd65' },
  'display-p3': { red: [0.68, 0.32], green: [0.265, 0.69], blue: [0.15, 0.06], whitePoint: 'd65' },
  rec2020: { red: [0.708, 0.292], green: [0.17, 0.797], blue: [0.131, 0.046], whitePoint: 'd65' },
  'a98-rgb': { red: [0.64, 0.33], green: [0.21, 0.71], blue: [0.15, 0.06], whitePoint: 'd65' },
  'prophoto-rgb': {
    red: [0.734699, 0.265301],
    green: [0.159597, 0.840403],
    blue: [0.036598, 0.000105],
    whitePoint: 'd50',
  },
});

// SMPTE RP 177: columns are primary XYZ vectors scaled so that rgb(1,1,1)
// maps exactly onto the white point.
function deriveRgbToXyzMatrix(chromaticities) {
  const red = whitePointToXyz(chromaticities.red);
  const green = whitePointToXyz(chromaticities.green);
  const blue = whitePointToXyz(chromaticities.blue);
  const primariesMatrix = [
    [red[0], green[0], blue[0]],
    [red[1], green[1], blue[1]],
    [red[2], green[2], blue[2]],
  ];
  const white = whitePointToXyz(WHITE_POINT_CHROMATICITIES[chromaticities.whitePoint]);
  const scales = multiplyMatrixVector(invertMatrix(primariesMatrix), white);
  return [
    [primariesMatrix[0][0] * scales[0], primariesMatrix[0][1] * scales[1], primariesMatrix[0][2] * scales[2]],
    [primariesMatrix[1][0] * scales[0], primariesMatrix[1][1] * scales[1], primariesMatrix[1][2] * scales[2]],
    [primariesMatrix[2][0] * scales[0], primariesMatrix[2][1] * scales[1], primariesMatrix[2][2] * scales[2]],
  ];
}

const RGB_TO_XYZ = {};
const XYZ_TO_RGB = {};
for (const [name, chromaticities] of Object.entries(PRIMARY_CHROMATICITIES)) {
  RGB_TO_XYZ[name] = deriveRgbToXyzMatrix(chromaticities);
  XYZ_TO_RGB[name] = invertMatrix(RGB_TO_XYZ[name]);
}

// Linear Bradford chromatic adaptation.
const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const BRADFORD_INVERSE = invertMatrix(BRADFORD);

function deriveAdaptationMatrix(sourceWhite, destinationWhite) {
  const sourceCone = multiplyMatrixVector(BRADFORD, sourceWhite);
  const destinationCone = multiplyMatrixVector(BRADFORD, destinationWhite);
  const scale = [
    [destinationCone[0] / sourceCone[0], 0, 0],
    [0, destinationCone[1] / sourceCone[1], 0],
    [0, 0, destinationCone[2] / sourceCone[2]],
  ];
  return multiplyMatrices(BRADFORD_INVERSE, multiplyMatrices(scale, BRADFORD));
}

const ADAPT_D50_TO_D65 = deriveAdaptationMatrix(XYZ_WHITE_D50, XYZ_WHITE_D65);
const ADAPT_D65_TO_D50 = deriveAdaptationMatrix(XYZ_WHITE_D65, XYZ_WHITE_D50);

export function convertXyzD50ToXyzD65(xyz) {
  return multiplyMatrixVector(ADAPT_D50_TO_D65, xyz);
}

export function convertXyzD65ToXyzD50(xyz) {
  return multiplyMatrixVector(ADAPT_D65_TO_D50, xyz);
}

// Convert linear-light RGB in a named primary set into XYZ at that set's own
// white point, and back.
export function convertLinearRgbToXyz(primaries, rgb) {
  const matrix = RGB_TO_XYZ[primaries];
  if (matrix === undefined) throw new Error(`No RGB matrix for primaries "${primaries}"`);
  return multiplyMatrixVector(matrix, rgb);
}

export function convertXyzToLinearRgb(primaries, xyz) {
  const matrix = XYZ_TO_RGB[primaries];
  if (matrix === undefined) throw new Error(`No RGB matrix for primaries "${primaries}"`);
  return multiplyMatrixVector(matrix, xyz);
}

// XYZ at D65 into working linear Rec. 2020, and back.
export function convertXyzD65ToWorking(xyz) {
  return convertXyzToLinearRgb('rec2020', xyz);
}

export function convertWorkingToXyzD65(rgb) {
  return convertLinearRgbToXyz('rec2020', rgb);
}

// Linear-light RGB in any supported primary set into working color.
export function convertLinearRgbToWorking(primaries, rgb) {
  if (primaries === 'rec2020') return [rgb[0], rgb[1], rgb[2]];
  if (primaries === 'xyz-d65') return convertXyzD65ToWorking(rgb);
  if (primaries === 'xyz-d50') return convertXyzD65ToWorking(convertXyzD50ToXyzD65(rgb));
  const chromaticities = PRIMARY_CHROMATICITIES[primaries];
  if (chromaticities === undefined) throw new Error(`No RGB matrix for primaries "${primaries}"`);
  let xyz = convertLinearRgbToXyz(primaries, rgb);
  if (chromaticities.whitePoint === 'd50') xyz = convertXyzD50ToXyzD65(xyz);
  return convertXyzD65ToWorking(xyz);
}

// One 3x3 matrix from a source primary set into a linear-light destination
// primary set. Bradford-adapt a D50 source white to D65. Compose the matrix by
// pushing basis vectors through the exact per-vector converters above, so no
// second matrix pipeline exists.
export function linearRgbToWorkingMatrix(sourcePrimaries, destinationPrimaries) {
  if (!Object.hasOwn(PRIMARY_CHROMATICITIES, destinationPrimaries)) {
    throw new Error(
      `linearRgbToWorkingMatrix: unsupported destination "${destinationPrimaries}"`,
    );
  }
  const columns = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((basis) => {
    if (sourcePrimaries === destinationPrimaries) return basis;
    let xyz;
    if (sourcePrimaries === 'xyz-d65') {
      xyz = basis;
    } else if (sourcePrimaries === 'xyz-d50') {
      xyz = convertXyzD50ToXyzD65(basis);
    } else {
      const chromaticities = PRIMARY_CHROMATICITIES[sourcePrimaries];
      if (chromaticities === undefined) {
        throw new Error(`No RGB matrix for primaries "${sourcePrimaries}"`);
      }
      xyz = convertLinearRgbToXyz(sourcePrimaries, basis);
      if (chromaticities.whitePoint === 'd50') xyz = convertXyzD50ToXyzD65(xyz);
    }
    return convertXyzToLinearRgb(destinationPrimaries, xyz);
  });
  return [
    [columns[0][0], columns[1][0], columns[2][0]],
    [columns[0][1], columns[1][1], columns[2][1]],
    [columns[0][2], columns[1][2], columns[2][2]],
  ];
}

// ---------------------------------------------------------------------------
// Transfer functions. CSS Color 4 extends each curve point-symmetrically for
// negative values, so wide-gamut components survive encode and decode.
// ---------------------------------------------------------------------------

export function decodeSrgbTransfer(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  if (magnitude <= 0.04045) return (sign * magnitude) / 12.92;
  return sign * ((magnitude + 0.055) / 1.055) ** 2.4;
}

export function encodeSrgbTransfer(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  if (magnitude <= 0.0031308) return sign * magnitude * 12.92;
  return sign * (1.055 * magnitude ** (1 / 2.4) - 0.055);
}

export function decodeGammaTransfer(value, exponent) {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.abs(value) ** exponent;
}

export function encodeGammaTransfer(value, exponent) {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.abs(value) ** (1 / exponent);
}

// Piecewise Rec. ITU-R BT.2020 transfer function, used by color(rec2020).
const REC2020_ALPHA = 1.09929682680944;
const REC2020_BETA = 0.018053968510807;

export function decodeRec2020Transfer(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  if (magnitude < REC2020_BETA * 4.5) return (sign * magnitude) / 4.5;
  return sign * ((magnitude + REC2020_ALPHA - 1) / REC2020_ALPHA) ** (1 / 0.45);
}

export function encodeRec2020Transfer(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  if (magnitude < REC2020_BETA) return sign * magnitude * 4.5;
  return sign * (REC2020_ALPHA * magnitude ** 0.45 - (REC2020_ALPHA - 1));
}

// Piecewise ROMM transfer function with the 1/512 linear segment, used by
// color(prophoto-rgb).
export function decodeProphotoTransfer(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  if (magnitude <= 16 / 512) return (sign * magnitude) / 16;
  return sign * magnitude ** 1.8;
}

export function encodeProphotoTransfer(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  if (magnitude <= 1 / 512) return sign * magnitude * 16;
  return sign * magnitude ** (1 / 1.8);
}

// Perceptual quantizer, Rec. ITU-R BT.2100. Signals map to absolute
// luminance in candelas per square metre; 10000 is the coding peak.
const PQ_M1 = 1305 / 8192;
const PQ_M2 = 2523 / 32;
const PQ_C1 = 107 / 128;
const PQ_C2 = 2413 / 128;
const PQ_C3 = 2392 / 128;

export function pqSignalToLuminance(signal) {
  const power = Math.max(signal, 0) ** (1 / PQ_M2);
  const numerator = Math.max(power - PQ_C1, 0);
  const denominator = PQ_C2 - PQ_C3 * power;
  return 10000 * (numerator / denominator) ** (1 / PQ_M1);
}

export function luminanceToPqSignal(luminance) {
  const normalized = Math.max(luminance, 0) / 10000;
  const power = normalized ** PQ_M1;
  return ((PQ_C1 + PQ_C2 * power) / (1 + PQ_C3 * power)) ** PQ_M2;
}

// A PQ-coded component into the working scale, where 1 equals the
// 203-candela reference white.
export function decodePqToWorkingScale(signal) {
  return pqSignalToLuminance(signal) / REFERENCE_WHITE_LUMINANCE;
}

export function encodeWorkingScaleToPq(value) {
  return luminanceToPqSignal(value * REFERENCE_WHITE_LUMINANCE);
}

// Hybrid log-gamma, Rec. ITU-R BT.2100, with the nominal 1000-candela
// reference display and system gamma 1.2.
const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);
const HLG_REFERENCE_DISPLAY_PEAK = 1000;
const HLG_SYSTEM_GAMMA = 1.2;

export function hlgSignalToSceneLight(signal) {
  const clamped = Math.max(signal, 0);
  if (clamped <= 0.5) return (clamped * clamped) / 3;
  return (Math.exp((clamped - HLG_C) / HLG_A) + HLG_B) / 12;
}

export function sceneLightToHlgSignal(sceneLight) {
  const clamped = Math.max(sceneLight, 0);
  if (clamped <= 1 / 12) return Math.sqrt(3 * clamped);
  return HLG_A * Math.log(12 * clamped - HLG_B) + HLG_C;
}

// HLG-coded RGB into working color scale. The opto-optical transform applies
// the system gamma to scene luminance and scales all three channels.
export function decodeHlgRgbToWorkingScale(rgbSignal) {
  const scene = rgbSignal.map(hlgSignalToSceneLight);
  const sceneLuminance = 0.2627 * scene[0] + 0.678 * scene[1] + 0.0593 * scene[2];
  const gain =
    sceneLuminance <= 0
      ? 0
      : (HLG_REFERENCE_DISPLAY_PEAK * sceneLuminance ** (HLG_SYSTEM_GAMMA - 1)) /
        REFERENCE_WHITE_LUMINANCE;
  return [scene[0] * gain, scene[1] * gain, scene[2] * gain];
}

// Working color scale into HLG-coded RGB: the exact inverse of
// decodeHlgRgbToWorkingScale. The inverse opto-optical transform recovers
// scene light from display light through the system gamma, then the
// inverse opto-electronic transform codes each channel.
export function encodeWorkingScaleToHlgRgb(rgbWorking) {
  const displayLuminance =
    0.2627 * rgbWorking[0] + 0.678 * rgbWorking[1] + 0.0593 * rgbWorking[2];
  if (displayLuminance <= 0) return [0, 0, 0];
  // decode: display = scene * gain, gain = peak * Ys^(gamma-1) / white,
  // so Yd = peak/white * Ys^gamma and Ys = (Yd * white / peak)^(1/gamma).
  const sceneLuminance =
    ((displayLuminance * REFERENCE_WHITE_LUMINANCE) / HLG_REFERENCE_DISPLAY_PEAK) **
    (1 / HLG_SYSTEM_GAMMA);
  const gain =
    (HLG_REFERENCE_DISPLAY_PEAK * sceneLuminance ** (HLG_SYSTEM_GAMMA - 1)) /
    REFERENCE_WHITE_LUMINANCE;
  return rgbWorking.map((channel) => sceneLightToHlgSignal(channel / gain));
}

// ---------------------------------------------------------------------------
// Lab, LCH, OKLab, OKLCh.
// ---------------------------------------------------------------------------

const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

export function convertLabToXyzD50([lightness, aAxis, bAxis]) {
  const fy = (lightness + 16) / 116;
  const fx = fy + aAxis / 500;
  const fz = fy - bAxis / 200;
  const fInverse = (f) => {
    const cubed = f * f * f;
    return cubed > LAB_EPSILON ? cubed : (116 * f - 16) / LAB_KAPPA;
  };
  return [
    fInverse(fx) * XYZ_WHITE_D50[0],
    lightness > LAB_KAPPA * LAB_EPSILON ? fy * fy * fy : lightness / LAB_KAPPA,
    fInverse(fz) * XYZ_WHITE_D50[2],
  ];
}

export function convertXyzD50ToLab([x, y, z]) {
  const f = (t) => (t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116);
  const fx = f(x / XYZ_WHITE_D50[0]);
  const fy = f(y / XYZ_WHITE_D50[1]);
  const fz = f(z / XYZ_WHITE_D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function convertLchToLab([lightness, chroma, hueDegrees]) {
  const hueRadians = (hueDegrees * Math.PI) / 180;
  return [lightness, chroma * Math.cos(hueRadians), chroma * Math.sin(hueRadians)];
}

export function convertLabToLch([lightness, aAxis, bAxis]) {
  const chroma = Math.hypot(aAxis, bAxis);
  let hueDegrees = (Math.atan2(bAxis, aAxis) * 180) / Math.PI;
  if (hueDegrees < 0) hueDegrees += 360;
  return [lightness, chroma, hueDegrees];
}

// OKLab matrices from CSS Color 4 (Björn Ottosson's derivation).
const XYZ_D65_TO_OKLAB_LMS = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2643395317878472, 0.6338517070092908],
];
const OKLAB_LMS_TO_XYZ_D65 = invertMatrix(XYZ_D65_TO_OKLAB_LMS);
const OKLAB_LMS_TO_LAB = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.4285922420485799, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const OKLAB_LAB_TO_LMS = invertMatrix(OKLAB_LMS_TO_LAB);

export function convertXyzD65ToOklab(xyz) {
  const lms = multiplyMatrixVector(XYZ_D65_TO_OKLAB_LMS, xyz);
  const nonlinear = lms.map(Math.cbrt);
  return multiplyMatrixVector(OKLAB_LMS_TO_LAB, nonlinear);
}

export function convertOklabToXyzD65(oklab) {
  const nonlinear = multiplyMatrixVector(OKLAB_LAB_TO_LMS, oklab);
  const lms = nonlinear.map((value) => value * value * value);
  return multiplyMatrixVector(OKLAB_LMS_TO_XYZ_D65, lms);
}

export const convertOklchToOklab = convertLchToLab;
export const convertOklabToOklch = convertLabToLch;

export function deltaEOk(oklabA, oklabB) {
  return Math.hypot(oklabA[0] - oklabB[0], oklabA[1] - oklabB[1], oklabA[2] - oklabB[2]);
}

// Shader matrices are copied from @sandom/color's WAT-owned table. Index order
// is the package kernel contract; Sandom does not keep a second value table.
export const KERNEL_MATRIX_INDEX = Object.freeze({
  srgbToXyz: 0,
  xyzToSrgb: 1,
  displayP3ToXyz: 2,
  xyzToDisplayP3: 3,
  rec2020ToXyz: 4,
  xyzToRec2020: 5,
  a98RgbToXyz: 6,
  xyzToA98Rgb: 7,
  prophotoRgbToXyz: 8,
  xyzToProphotoRgb: 9,
  adaptD50ToD65: 10,
  adaptD65ToD50: 11,
  xyzD65ToOklabLms: 12,
  oklabLmsToXyzD65: 13,
  oklabLmsToLab: 14,
  oklabLabToLms: 15,
});

function readKernelMatrices() {
  const runtime = colorRuntime();
  const pointer = runtime.alloc(72);
  try {
    return Object.freeze(Object.values(KERNEL_MATRIX_INDEX).map((index) => {
      if (runtime.exports.color_matrix_read(index, pointer, 72) !== 1) {
        throw new Error(`@sandom/color rejected matrix index ${index}`);
      }
      const values = runtime.copyOut(pointer, 72, Float64Array);
      return Object.freeze([
        Object.freeze(Array.from(values.subarray(0, 3))),
        Object.freeze(Array.from(values.subarray(3, 6))),
        Object.freeze(Array.from(values.subarray(6, 9))),
      ]);
    }));
  } finally {
    runtime.free(pointer);
  }
}

export const KERNEL_MATRICES = readKernelMatrices();

// ---------------------------------------------------------------------------
// Tone map: Rec. ITU-R BT.2390 EETF, identifier "bt2390".
//
// The map runs on the largest channel in the PQ domain and scales all three
// channels by one gain, so hue survives the luminance reduction. Inputs and
// outputs use the working scale, where 1 equals 203 candelas per square
// metre.
// ---------------------------------------------------------------------------

export function toneMapBt2390(rgb, sourcePeakLuminance, targetPeakLuminance) {
  const sourcePeakSignal = luminanceToPqSignal(sourcePeakLuminance);
  const targetPeakSignal = luminanceToPqSignal(targetPeakLuminance);
  const maxChannel = Math.max(rgb[0], rgb[1], rgb[2]);
  if (maxChannel <= 0) return [0, 0, 0];
  const normalized =
    luminanceToPqSignal(maxChannel * REFERENCE_WHITE_LUMINANCE) / sourcePeakSignal;
  const maxNormalized = targetPeakSignal / sourcePeakSignal;
  const kneeStart = 1.5 * maxNormalized - 0.5;
  let mapped;
  if (normalized < kneeStart) {
    mapped = normalized;
  } else {
    const t = (normalized - kneeStart) / (1 - kneeStart);
    const t2 = t * t;
    const t3 = t2 * t;
    mapped =
      (2 * t3 - 3 * t2 + 1) * kneeStart +
      (t3 - 2 * t2 + t) * (1 - kneeStart) +
      (-2 * t3 + 3 * t2) * maxNormalized;
  }
  const mappedLuminance = pqSignalToLuminance(mapped * sourcePeakSignal);
  const gain = mappedLuminance / REFERENCE_WHITE_LUMINANCE / maxChannel;
  return [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain];
}

// ---------------------------------------------------------------------------
// Gamut map: the CSS Color 4 OKLCh chroma-reduction algorithm, identifier
// "css-color-4". Input is working color; output is linear-light RGB inside
// the destination gamut. Channel clipping alone is not a gamut map.
// ---------------------------------------------------------------------------

const GAMUT_MAP_JUST_NOTICEABLE_DIFFERENCE = 0.02;
const GAMUT_MAP_CHROMA_EPSILON = 0.0001;

function workingToDestinationLinearRgb(destinationPrimaries, workingRgb) {
  const xyz = convertWorkingToXyzD65(workingRgb);
  const chromaticities = PRIMARY_CHROMATICITIES[destinationPrimaries];
  if (chromaticities !== undefined && chromaticities.whitePoint === 'd50') {
    return convertXyzToLinearRgb(destinationPrimaries, convertXyzD65ToXyzD50(xyz));
  }
  return convertXyzToLinearRgb(destinationPrimaries, xyz);
}

function oklabToDestinationLinearRgb(destinationPrimaries, oklab) {
  return workingToDestinationLinearRgb(
    destinationPrimaries,
    convertXyzD65ToWorking(convertOklabToXyzD65(oklab)),
  );
}

function destinationLinearRgbToXyzD65(destinationPrimaries, rgb) {
  const xyz = convertLinearRgbToXyz(destinationPrimaries, rgb);
  const chromaticities = PRIMARY_CHROMATICITIES[destinationPrimaries];
  if (chromaticities !== undefined && chromaticities.whitePoint === 'd50') {
    return convertXyzD50ToXyzD65(xyz);
  }
  return xyz;
}

// Membership tolerates float-precision noise: a working value that
// round-trips the primary matrices can land at -1e-16 or 1+1e-16, and
// treating that as out-of-gamut would send an in-gamut color through the
// chroma-reduction search (whose just-noticeable-difference clip can move
// it visibly). The epsilon is far below one sixteen-bit quantization step.
const GAMUT_MEMBERSHIP_EPSILON = 1e-7;

function isInsideGamut(rgb) {
  return rgb.every((channel) =>
    channel >= -GAMUT_MEMBERSHIP_EPSILON && channel <= 1 + GAMUT_MEMBERSHIP_EPSILON
  );
}

function clipToGamut(rgb) {
  return rgb.map((channel) => Math.min(1, Math.max(0, channel)));
}

export function gamutMapCssColor4(workingRgb, destinationPrimaries) {
  const direct = workingToDestinationLinearRgb(destinationPrimaries, workingRgb);
  if (isInsideGamut(direct)) return clipToGamut(direct);
  const oklab = convertXyzD65ToOklab(convertWorkingToXyzD65(workingRgb));
  const [lightness, chroma, hueDegrees] = convertOklabToOklch(oklab);
  if (lightness >= 1) return [1, 1, 1];
  if (lightness <= 0) return [0, 0, 0];
  let lowChroma = 0;
  let highChroma = chroma;
  let current = oklab;
  while (highChroma - lowChroma > GAMUT_MAP_CHROMA_EPSILON) {
    const midChroma = (lowChroma + highChroma) / 2;
    current = convertOklchToOklab([lightness, midChroma, hueDegrees]);
    const candidate = oklabToDestinationLinearRgb(destinationPrimaries, current);
    if (isInsideGamut(candidate)) {
      lowChroma = midChroma;
      continue;
    }
    const clipped = clipToGamut(candidate);
    const clippedOklab = convertXyzD65ToOklab(
      destinationLinearRgbToXyzD65(destinationPrimaries, clipped),
    );
    if (deltaEOk(clippedOklab, current) < GAMUT_MAP_JUST_NOTICEABLE_DIFFERENCE) {
      return clipped;
    }
    highChroma = midChroma;
  }
  return clipToGamut(oklabToDestinationLinearRgb(destinationPrimaries, current));
}
