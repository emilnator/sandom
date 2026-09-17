// Display facts for the stylized devices in models/devices/.
//
// Geometry facts (screen plane, extents, corner radius) live in each
// device's generated device.json — written by the CAD script from the same
// constants that build the body, so they cannot drift. This catalog owns
// the display-configuration side: logical viewport, device scale, and the
// declared color gamut of the class the device stylizes.
//
// The renderer currently presents in sRGB; a display-p3 declaration is
// recorded here and clamped by the actual render path.

export const DEVICE_CATALOG = Object.freeze({
  handset: Object.freeze({
    label: "Handset",
    directory: "handset",
    viewport: Object.freeze({ width: 393, height: 852, deviceScale: 3 }),
    colorGamut: "display-p3",
  }),
  tablet: Object.freeze({
    label: "Tablet",
    directory: "tablet",
    viewport: Object.freeze({ width: 834, height: 1210, deviceScale: 2 }),
    colorGamut: "display-p3",
  }),
  laptop: Object.freeze({
    label: "Laptop",
    directory: "laptop",
    viewport: Object.freeze({ width: 1512, height: 982, deviceScale: 2 }),
    colorGamut: "display-p3",
  }),
});

// Shading parameters by GLB node name. The CAD export bakes base color
// only; metalness and roughness are assigned here from the part vocabulary
// the device scripts use in their node names.
const MATERIAL_RULES = [
  { pattern: /glass|lens|camera/, metallic: 0.0, roughness: 0.09 },
  { pattern: /keyboard/, metallic: 0.0, roughness: 0.65 },
  { pattern: /trackpad/, metallic: 0.35, roughness: 0.2 },
];

const DEFAULT_MATERIAL = { metallic: 0.9, roughness: 0.38 };

export function materialForNode(nodeName) {
  for (const rule of MATERIAL_RULES) {
    if (rule.pattern.test(nodeName)) {
      return { metallic: rule.metallic, roughness: rule.roughness };
    }
  }
  return DEFAULT_MATERIAL;
}
