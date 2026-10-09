// The bundled fonts: the sandom-fonts library set
// (plans/PLAN-fallback-font-coverage.md). The set holds faces for the CSS
// generic families, used when a document declares no @font-face for them and
// the host supplies no system font resolver:
//
//   sans-serif, system-ui, ui-sans-serif  -> Inter (variable weight axis)
//   monospace, ui-monospace                -> IBM Plex Mono (static faces)
//   serif, ui-serif                        -> Crimson Text (static faces)
//   cursive                                -> Dancing Script (variable weight axis)
//   fantasy                                -> Lobster (one face)
//
// and the Noto fallback families with their coverage index
// (src/font-coverage.js), which paint each script that no authored face
// covers.
//
// The fonts are opt-in, and importing Sandom reads none of them. A host
// enables them before the first render with `await installBundledSystemFonts()`,
// which enables them for the default font registry, or passes
// `await loadBundledSystemFonts()` to `createFontRegistry({ bundledSystemFonts })`.
// The font registry resolves generic faces synchronously during shaping, so
// both functions read the generic faces (about 2.4 MB), the set manifest, and
// the coverage index before they return. A fallback face loads only when a
// text cluster needs it. A generic family that a registry resolved before
// installation keeps its resolution. A host with its own generic faces passes
// `await loadFontSetFallbackFamilies()` as the `fallbackFamilies` option of
// createFontRegistry or createSceneRendererRuntime instead, or enables them
// for the default font registry with `await installFontSetFallbackFamilies()`.
//
// Where the set is read. src/font-set.js pins one published set
// (tools/pin-font-set.js). The location is the URL that the import map of the
// host gives to FONT_SET_SPECIFIER: in Sandom development, deno.json maps it to
// the sandom-fonts checkout next to Sandom; a certified run maps it to the
// published set. Without a mapping, the location is the published set. The npm
// package has no import map, so its build writes the published set as the
// specifier (deployment/build-npm.js). Every file is checked against the
// SHA-256 of the pin before use.
//
// The provenance and licence of each file are in docs/legal/fonts.md.

import { FONT_SET } from "./font-set.js";
import { readBinaryFile } from "./host.js";

export const BUNDLED_SYSTEM_FONTS_SYMBOL = Symbol.for("sandom.bundledSystemFonts");
export const FONT_SET_FALLBACK_FAMILIES_SYMBOL = Symbol.for("sandom.fontSetFallbackFamilies");
export const FONT_SET_SPECIFIER = "https://cdn.urania-libs.com/set/4ac082ad6cf25238/sandom-fonts/";

// The location of the font set: the import-map target of
// FONT_SET_SPECIFIER, else the published set of the pin.
export function fontSetLocation() {
  const resolved = import.meta.resolve(FONT_SET_SPECIFIER);
  return resolved === FONT_SET_SPECIFIER ? FONT_SET.url : resolved;
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The bytes of `path` in the set at `location`, checked against the pin.
async function readSetFile(location, path) {
  const expected = FONT_SET.files[path];
  if (expected === undefined) {
    throw new Error(`The pinned font set ${FONT_SET.setHash} has no file ${path}; pin a set that has it (tools/pin-font-set.js)`);
  }
  const url = new URL(path, location);
  const bytes = await readBinaryFile(url);
  const observed = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (observed !== expected) {
    throw new Error(
      `The font set file ${url.href} has SHA-256 ${observed}; the pinned set ${FONT_SET.setHash} ` +
        `(sandom-fonts commit ${FONT_SET.commit}) lists ${expected}. Check out that commit where ` +
        `${FONT_SET_SPECIFIER} is mapped, or pin the set of that checkout (tools/pin-font-set.js).`,
    );
  }
  return { bytes, url };
}

// The face of `faces` closest to the request: the requested style first,
// then the nearest weight. A face weight is a number, or [minimum, maximum]
// for a variable 'wght' axis.
function closestFace(faces, weight, style) {
  const styled = faces.filter((face) => face.style === style);
  const distance = ({ weight: faceWeight }) =>
    Array.isArray(faceWeight)
      ? Math.max(0, faceWeight[0] - weight, weight - faceWeight[1])
      : Math.abs(faceWeight - weight);
  return (styled.length > 0 ? styled : faces).reduce((best, face) => distance(face) < distance(best) ? face : best);
}

// Each read of a set location happens once in a realm.
function once(cache, location, read) {
  const key = String(location);
  let result = cache.get(key);
  if (result === undefined) {
    result = read(new URL(key));
    cache.set(key, result);
  }
  return result;
}

const manifests = new Map();
const fallbackFamilies = new Map();
const bundledFonts = new Map();

function readManifest(location) {
  return once(manifests, location, async (url) =>
    JSON.parse(new TextDecoder().decode((await readSetFile(url, "manifest.json")).bytes)));
}

// Reads the manifest and the coverage index of the font set once, and
// returns the `fallbackFamilies` option of createFontRegistry: the coverage
// index and a loader for each family, which reads a face when the renderer
// asks for it. For a host with its own generic faces. `location` overrides
// the location of the set (fontSetLocation()).
export function loadFontSetFallbackFamilies({ location = fontSetLocation() } = {}) {
  return once(fallbackFamilies, location, async (url) => {
    const manifest = await readManifest(url);
    const coverage = (await readSetFile(url, manifest.output)).bytes;
    const faces = Object.fromEntries(manifest.families.map(({ family, faces: familyFaces }) => [family, {
      url: new URL(familyFaces[0].file, url).href,
      async load({ weight, style }) {
        const { bytes, url: faceURL } = await readSetFile(url, closestFace(familyFaces, weight, style).file);
        return { bytes, finalURL: faceURL.href };
      },
    }]));
    return Object.freeze({ coverage, faces });
  });
}

// Reads the manifest, the coverage index, and every generic face of the font
// set once, and returns `{ familyFor(genericName), familyNamed(familyName),
// fallbackFamilies }`. `familyFor` returns the family specification of a
// bundled generic family, or null for a generic family without a bundled
// font. `fallbackFamilies` is the result of loadFontSetFallbackFamilies.
// `location` overrides the location of the set (fontSetLocation()).
export function loadBundledSystemFonts({ location = fontSetLocation() } = {}) {
  return once(bundledFonts, location, readBundledFonts);
}

async function readBundledFonts(location) {
  const manifest = await readManifest(location);
  const generic = new Map();
  await Promise.all(manifest.generic.map(async (family) => {
    const faces = await Promise.all(family.faces.map(async (face) => {
      const { bytes, url } = await readSetFile(location, face.file);
      return Object.freeze({ ...face, bytes, finalURL: url.href, name: face.file.split("/").at(-1) });
    }));
    generic.set(family.family, { ...family, faces });
  }));
  const specification = ({ family, generic: genericNames, faces }) => ({
    cssFamily: family,
    fallback: genericNames[0],
    variable: faces.some((face) => Array.isArray(face.weight)),
    familyIdentity: `sandom-bundled:${family}`,
    resolveFace(weight, style) {
      const face = closestFace(faces, weight, style === "oblique" ? "italic" : style);
      return {
        bytes: face.bytes,
        faceIndex: 0,
        style: face.style,
        faceIdentity: `sandom-bundled:${face.name}`,
        finalURL: face.finalURL,
      };
    },
  });
  const genericFamilies = [...generic.values()];
  const fallback = await loadFontSetFallbackFamilies({ location });
  return Object.freeze({
    // The bundled family of a generic family name, or null.
    familyFor(genericName) {
      const family = genericFamilies.find((candidate) => candidate.generic.includes(genericName));
      return family === undefined ? null : specification(family);
    },
    // The bundled family whose own name is `familyName` (compared ASCII
    // case-insensitively, as CSS family names are), or null: a bundled
    // font is installed under its name as well as its generic family.
    familyNamed(familyName) {
      const wanted = String(familyName).toLowerCase();
      const family = genericFamilies.find((candidate) => candidate.family.toLowerCase() === wanted);
      return family === undefined ? null : specification(family);
    },
    fallbackFamilies: fallback,
  });
}

// Enables the bundled fonts for the default font registry of this realm.
// Returns once the generic faces and the coverage index are read.
export async function installBundledSystemFonts() {
  globalThis[BUNDLED_SYSTEM_FONTS_SYMBOL] = await loadBundledSystemFonts();
}

// Enables the fallback families of the font set, without its generic
// faces, for the default font registry of this realm. Returns once the
// coverage index is read.
export async function installFontSetFallbackFamilies() {
  globalThis[FONT_SET_FALLBACK_FAMILIES_SYMBOL] = await loadFontSetFallbackFamilies();
}
