// Gradient interpolation-space preparation (wide-color plan, package 4).
//
// CSS Color 4 interpolates gradients in an author-selected space with an
// author-selected hue method. The split of labor:
//
// - THIS module (CPU, once per gradient per frame): converts each stop's
//   authored color (extended sign-mirrored encoded sRGB, straight alpha -
//   parseColor's output) into the interpolation space, resolves missing
//   components pairwise (css-color-4 section 12.2 - expanding stops into
//   per-segment endpoints only when a mask is actually present), and
//   applies the hue-method fixup sequentially (section 12.4).
// - The gradient SHADER (per pixel): interpolates between the prepared
//   stops premultiplied (hue channels excluded, section 12.3) and converts
//   the interpolated result into the rendering mode's working encoding
//   before composition (see gradientColorToWorking in src/rasterize.js).
//
// Conversion math uses src/color.js: the same reference module
// sourceConversionPlan (src/image-data.js) already builds production
// matrices from. Stops quantize into 32-bit-float GPU buffers, so
// last-ulp host variance in the double-precision math is invisible.

import {
  convertLabToLch,
  convertLabToXyzD50,
  convertLchToLab,
  convertLinearRgbToXyz,
  convertOklabToXyzD65,
  convertXyzD50ToLab,
  convertXyzD50ToXyzD65,
  convertXyzD65ToOklab,
  convertXyzD65ToXyzD50,
  convertXyzToLinearRgb,
  decodeSrgbTransfer,
  encodeSrgbTransfer,
} from "./color.js";
import { GRADIENT_HUE_NAMES, GRADIENT_SPACE_NAMES } from "./wasm/layout.js";

// Wire ids (see GRADIENT_SPACE_NAMES): hue channel index per space, or -1.
// hsl/hwb carry hue as component 0; lch/oklch as component 2.
const HUE_CHANNEL_BY_SPACE = [-1, -1, -1, -1, -1, 0, 0, 2, 2];
const LCH_SPACES = new Set([
  GRADIENT_SPACE_NAMES.lch,
  GRADIENT_SPACE_NAMES.oklch,
]);

export function gradientHueChannel(spaceId) {
  return HUE_CHANNEL_BY_SPACE[spaceId] ?? -1;
}

// Encoded sRGB -> HSL with s and l in 0..1, h in degrees (0..360).
// Channels clamp into 0..1 first: HSL/HWB are only defined over the sRGB
// cube (css-color-4 defines no extended HSL), matching Chrome, which
// clamps before converting for `in hsl` interpolation.
function srgbToHsl([red, green, blue]) {
  const r = Math.min(1, Math.max(0, red));
  const g = Math.min(1, Math.max(0, green));
  const b = Math.min(1, Math.max(0, blue));
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let saturation = 0;
  if (delta !== 0) {
    saturation = lightness === 0 || lightness === 1
      ? 0
      : (max - lightness) / Math.min(lightness, 1 - lightness);
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [hue, saturation, lightness];
}

function srgbToHwb(rgb) {
  const [hue] = srgbToHsl(rgb);
  const r = Math.min(1, Math.max(0, rgb[0]));
  const g = Math.min(1, Math.max(0, rgb[1]));
  const b = Math.min(1, Math.max(0, rgb[2]));
  return [hue, Math.min(r, g, b), 1 - Math.max(r, g, b)];
}

// HSL -> encoded sRGB (css-color-4 reference algorithm), h degrees,
// s/l in 0..1. Shared by the WGSL mirror in src/rasterize.js - keep the
// two in lockstep.
export function hslToSrgb([hue, saturation, lightness]) {
  const h = ((hue % 360) + 360) % 360;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export function hwbToSrgb([hue, whiteness, blackness]) {
  if (whiteness + blackness >= 1) {
    const gray = whiteness / (whiteness + blackness);
    return [gray, gray, gray];
  }
  return hslToSrgb([hue, 1, 0.5]).map((channel) =>
    channel * (1 - whiteness - blackness) + whiteness
  );
}

// Encoded extended sRGB rgb -> the interpolation space's components.
function srgbToSpace(rgb, spaceId) {
  switch (spaceId) {
    case GRADIENT_SPACE_NAMES.srgb:
      return [rgb[0], rgb[1], rgb[2]];
    case GRADIENT_SPACE_NAMES["srgb-linear"]:
      return rgb.map(decodeSrgbTransfer);
    case GRADIENT_SPACE_NAMES.hsl:
      return srgbToHsl(rgb);
    case GRADIENT_SPACE_NAMES.hwb:
      return srgbToHwb(rgb);
    default: {
      const xyz = convertLinearRgbToXyz("srgb", rgb.map(decodeSrgbTransfer));
      switch (spaceId) {
        case GRADIENT_SPACE_NAMES.lab:
          return convertXyzD50ToLab(convertXyzD65ToXyzD50(xyz));
        case GRADIENT_SPACE_NAMES.oklab:
          return convertXyzD65ToOklab(xyz);
        case GRADIENT_SPACE_NAMES["xyz-d65"]:
          return xyz;
        case GRADIENT_SPACE_NAMES.lch:
          return convertLabToLch(convertXyzD50ToLab(convertXyzD65ToXyzD50(xyz)));
        case GRADIENT_SPACE_NAMES.oklch:
          return convertLabToLch(convertXyzD65ToOklab(xyz));
        default:
          throw new Error(`gradient interpolation: unknown space id ${spaceId}`);
      }
    }
  }
}

// The interpolation space's components -> encoded sRGB. Feeds the
// degraded WebGL 2 backend, whose shader interpolates prepared stops in
// sRGB (its documented degradation - it renders correct stop COLORS with
// sRGB segment interiors).
export function spaceToSrgb(components, spaceId) {
  switch (spaceId) {
    case GRADIENT_SPACE_NAMES.srgb:
      return [components[0], components[1], components[2]];
    case GRADIENT_SPACE_NAMES["srgb-linear"]:
      return components.map(encodeSrgbTransfer);
    case GRADIENT_SPACE_NAMES.hsl:
      return hslToSrgb(components);
    case GRADIENT_SPACE_NAMES.hwb:
      return hwbToSrgb(components);
    default: {
      let xyz;
      switch (spaceId) {
        case GRADIENT_SPACE_NAMES.lab:
          xyz = convertXyzD50ToXyzD65(convertLabToXyzD50(components));
          break;
        case GRADIENT_SPACE_NAMES.oklab:
          xyz = convertOklabToXyzD65(components);
          break;
        case GRADIENT_SPACE_NAMES["xyz-d65"]:
          xyz = components;
          break;
        case GRADIENT_SPACE_NAMES.lch:
          xyz = convertXyzD50ToXyzD65(convertLabToXyzD50(convertLchToLab(components)));
          break;
        case GRADIENT_SPACE_NAMES.oklch:
          xyz = convertOklabToXyzD65(convertLchToLab(components));
          break;
        default:
          throw new Error(`gradient interpolation: unknown space id ${spaceId}`);
      }
      return convertXyzToLinearRgb("srgb", xyz).map(encodeSrgbTransfer);
    }
  }
}

// Missing-component mask bits (GRADIENT_STOP_OFFSET_MISSING): bits 0-2
// name the authored sRGB channels, bit 3 the alpha. In a non-sRGB
// interpolation space, sRGB channels have no analogous component
// (css-color-4 section 12.2's analogous-component table), so a missing
// channel converts as zero and arrives non-missing; only sRGB-family
// spaces carry the channel mask through, and alpha carries everywhere.
function spaceMissingMask(missing, spaceId) {
  const alphaBit = missing & 0b1000;
  if (
    spaceId === GRADIENT_SPACE_NAMES.srgb ||
    spaceId === GRADIENT_SPACE_NAMES["srgb-linear"]
  ) {
    return (missing & 0b0111) | alphaBit;
  }
  return alphaBit;
}

// Hue fixup (css-color-4 section 12.4): adjust each stop's hue relative
// to the PREVIOUS adjusted hue so the shader's plain lerp walks the
// selected arc. Sequential accumulation, exactly the spec's algorithm.
function applyHueFixup(stops, hueChannel, hueId) {
  for (const stop of stops) {
    const hue = stop.components[hueChannel];
    stop.components[hueChannel] = ((hue % 360) + 360) % 360;
  }
  for (let i = 1; i < stops.length; i++) {
    const previous = stops[i - 1].components[hueChannel];
    let hue = stops[i].components[hueChannel];
    const delta = hue - previous;
    if (hueId === GRADIENT_HUE_NAMES.shorter) {
      if (delta > 180) hue -= 360;
      else if (delta < -180) hue += 360;
    } else if (hueId === GRADIENT_HUE_NAMES.longer) {
      if (delta > 0 && delta < 180) hue -= 360;
      else if (delta > -180 && delta <= 0) hue += 360;
    } else if (hueId === GRADIENT_HUE_NAMES.increasing) {
      if (delta < 0) hue += 360;
    } else if (delta > 0) {
      // decreasing
      hue -= 360;
    }
    stops[i].components[hueChannel] = hue;
  }
}

// stops: [{ position, color: [r,g,b,a] encoded extended sRGB straight,
// missingComponents }]. Returns prepared stops:
// [{ position, color: [c0,c1,c2,alpha] in the interpolation space,
// srgbColor: [r,g,b,a] encoded sRGB }]. Stop count grows only when a
// missing-component mask forces per-segment endpoint duplication.
export function prepareGradientStops(stops, spaceId, hueId) {
  const hueChannel = gradientHueChannel(spaceId);
  const converted = stops.map((stop) => {
    const missing = spaceMissingMask(stop.missingComponents ?? 0, spaceId);
    const source = stop.color;
    const rgb = [source[0], source[1], source[2]];
    if (!LCH_SPACES.has(spaceId) && spaceId !== GRADIENT_SPACE_NAMES.hsl &&
      spaceId !== GRADIENT_SPACE_NAMES.hwb) {
      // Rectangular spaces: zero-substitute missing channels pre-conversion.
      for (let bit = 0; bit < 3; bit++) {
        if ((stop.missingComponents ?? 0) & (1 << bit)) rgb[bit] = 0;
      }
    }
    return {
      position: stop.position,
      components: srgbToSpace(rgb, spaceId),
      alpha: (stop.missingComponents ?? 0) & 0b1000 ? 0 : source[3],
      missing,
    };
  });

  // Pairwise missing-component substitution (section 12.2): expand into
  // per-segment endpoints only when some mask is present - the common
  // maskless gradient keeps its stop count (and, for the srgb space, its
  // exact float values).
  let resolved = converted;
  if (converted.some((stop) => stop.missing !== 0) && converted.length > 1) {
    resolved = [];
    for (let i = 0; i < converted.length - 1; i++) {
      const a = structuredClone(converted[i]);
      const b = structuredClone(converted[i + 1]);
      for (let channel = 0; channel < 3; channel++) {
        const bit = 1 << channel;
        const aMissing = (a.missing & bit) !== 0;
        const bMissing = (b.missing & bit) !== 0;
        if (aMissing && !bMissing) a.components[channel] = b.components[channel];
        else if (bMissing && !aMissing) {
          b.components[channel] = a.components[channel];
        } else if (aMissing && bMissing) {
          a.components[channel] = 0;
          b.components[channel] = 0;
        }
      }
      const aAlphaMissing = (a.missing & 0b1000) !== 0;
      const bAlphaMissing = (b.missing & 0b1000) !== 0;
      if (aAlphaMissing && !bAlphaMissing) a.alpha = b.alpha;
      else if (bAlphaMissing && !aAlphaMissing) b.alpha = a.alpha;
      resolved.push(a, b);
    }
  }

  if (hueChannel >= 0 && resolved.length > 1) {
    applyHueFixup(resolved, hueChannel, hueId);
  }

  return resolved.map((stop) => {
    const straight = [
      stop.components[0],
      stop.components[1],
      stop.components[2],
      stop.alpha,
    ];
    return {
      position: stop.position,
      color: straight,
      srgbColor: [...spaceToSrgb(stop.components, spaceId), stop.alpha],
    };
  });
}
