import { readFontMetrics } from "./font-metrics.js";
import { decodeFontCoverage } from "./font-coverage.js";

import { hasFileSystem, readBinaryFile } from "./host.js";
import { sharedDomCore } from "./dom-wasm/core.js";

const fontCatalogFinalizer = new FinalizationRegistry((lifetime) => {
  lifetime.unsubscribe?.();
  // The owner can point back to its default registry. Holding it strongly
  // here would keep both the registry and its entire WASM memory alive.
  const core = lifetime.coreReference.deref();
  if (!core) return;
  for (const resource of lifetime.resources.values()) core.status("resource_release", resource);
  core.status("font_catalog_release", lifetime.handle);
});

export const DEFAULT_FONT_FAMILY = "sans-serif";
export const DEFAULT_FONT_SIZE = 14;
// Hosted faces are immutable process resources. Every registry in one module
// realm must resolve a hosted family key to the same selected face record.
const hostedFontFamilies = new Map();
const hostedFaceRequests = new WeakMap();
const registrySources = new WeakMap();

function subscribeFontSource(registry, synchronizeReference) {
  const unsubscribe = registry.subscribe(() => {
    const synchronize = synchronizeReference.deref();
    if (synchronize) synchronize();
    else unsubscribe();
  });
  return unsubscribe;
}

function normalizedFamilyName(value, lower, core) {
  return core.string(
    "font_family_normalize", ...core.input(String(value)), lower ? 1 : 0,
  ) ?? "";
}

const SFNT_COLLECTION_TAG = 0x74746366; // 'ttcf'
const FVAR_TABLE_TAG = 0x66766172; // 'fvar'
const variationAxesByBytes = new WeakMap();

// The variation axes face $faceIndex of sfnt bytes declares in its fvar
// table, by tag: { minimum, default, maximum } in design coordinates. A
// static face has none. The renderer registers a face without a 'wdth' or
// 'slnt' axis as-is at every stretch and slope, so a static file never
// takes one engine font instance per requested value. Bytes too short for
// their own table directory throw.
export function fontVariationAxes(bytes, faceIndex = 0) {
  let byFace = variationAxesByBytes.get(bytes);
  if (byFace === undefined) {
    byFace = new Map();
    variationAxesByBytes.set(bytes, byFace);
  }
  let axes = byFace.get(faceIndex);
  if (axes !== undefined) return axes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = view.getUint32(0) === SFNT_COLLECTION_TAG
    ? view.getUint32(12 + faceIndex * 4)
    : 0;
  const tableCount = view.getUint16(directory + 4);
  axes = new Map();
  for (let table = 0; table < tableCount; table++) {
    const record = directory + 12 + table * 16;
    if (view.getUint32(record) !== FVAR_TABLE_TAG) continue;
    const fvar = view.getUint32(record + 8);
    const axesOffset = view.getUint16(fvar + 4);
    const axisCount = view.getUint16(fvar + 8);
    const axisSize = view.getUint16(fvar + 10);
    for (let axis = 0; axis < axisCount; axis++) {
      const axisRecord = fvar + axesOffset + axis * axisSize;
      axes.set(
        String.fromCharCode(...bytes.subarray(axisRecord, axisRecord + 4)),
        Object.freeze({
          minimum: view.getInt32(axisRecord + 4) / 65536,
          default: view.getInt32(axisRecord + 8) / 65536,
          maximum: view.getInt32(axisRecord + 12) / 65536,
        }),
      );
    }
    break;
  }
  byFace.set(faceIndex, axes);
  return axes;
}

// The font-style slope of italic and of an oblique without an angle, in
// degrees: Chrome matches both as this oblique angle.
export const ITALIC_SLOPE = 14;

const ANGLE_DEGREES_PER_UNIT = Object.freeze({ deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 });

// An @font-face font-style descriptor (CSS Fonts 4, 4.4) as a slope range
// in degrees: auto (matched as normal; a 'slnt' axis instances at the
// requested angle), normal [0, 0], italic and oblique [14, 14], oblique
// with one angle, or oblique with two (a decreasing range swaps its ends).
// Angles take deg, grad, rad or turn, lie in [-90deg, 90deg], and truncate
// to a quarter degree, the precision Chrome keeps. Returns
// { slopeMinimum, slopeMaximum, slopeAuto }, or null for any other text.
export function fontFaceStyleDescriptor(text) {
  const tokens = String(text ?? "").trim().toLowerCase().split(/\s+/);
  if (tokens.length === 1) {
    if (tokens[0] === "auto") return { slopeMinimum: 0, slopeMaximum: 0, slopeAuto: true };
    if (tokens[0] === "normal") return { slopeMinimum: 0, slopeMaximum: 0, slopeAuto: false };
    if (tokens[0] === "italic" || tokens[0] === "oblique") {
      return { slopeMinimum: ITALIC_SLOPE, slopeMaximum: ITALIC_SLOPE, slopeAuto: false };
    }
    return null;
  }
  if (tokens[0] !== "oblique" || tokens.length > 3) return null;
  const angles = tokens.slice(1).map((token) => {
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)$/.exec(token);
    if (match === null) return NaN;
    const degrees = Number(match[1]) * ANGLE_DEGREES_PER_UNIT[match[2]];
    return degrees >= -90 && degrees <= 90 ? Math.trunc(degrees * 4) / 4 + 0 : NaN;
  });
  if (!angles.every((angle) => Number.isFinite(angle))) return null;
  return {
    slopeMinimum: Math.min(...angles),
    slopeMaximum: Math.max(...angles),
    slopeAuto: false,
  };
}

// The 'slnt' coordinate of a CSS font-style slope: OpenType turns positive
// slnt values counter-clockwise, CSS turns positive oblique angles
// clockwise.
export function slantCoordinate(slope) {
  return slope === 0 ? 0 : -slope;
}

// Actual bytes and shaping objects stay in the host; catalog values and
// matching live in the core. A registry ID namespaces shared resource keys.
let nextRegistryID = 1;

// The registry fallback families of `fallbackFamilies` (plans/
// PLAN-font-fallback.md): `coverage`, a coverage index
// (src/font-coverage.js, tools/generate-font-coverage.js), and `faces`, an
// object with one entry for each family the index names:
// `{ url, load({ url, weight, style }) }`. `load` returns a promise of the
// face's bytes (a Uint8Array, or `{ bytes, finalURL, faceIndex }`) for a
// CSS weight and a style ("normal" or "italic"). The renderer asks for a
// face only when a text cluster that no authored face covers needs it.
// Each face load is a font resource: pending, then loaded or failed. The
// state is shared with each registry made from this one (sourceRegistry),
// so a face loads once.
function createFallbackFamilies(fallbackFamilies) {
  if (fallbackFamilies === null) return null;
  if (typeof fallbackFamilies !== "object" || !(fallbackFamilies.coverage instanceof Uint8Array) ||
    typeof fallbackFamilies.faces !== "object" || fallbackFamilies.faces === null) {
    throw new TypeError(
      "fallbackFamilies must be { coverage: Uint8Array, faces: { [family]: { url, load } } } or null",
    );
  }
  const coverage = decodeFontCoverage(fallbackFamilies.coverage);
  const faces = coverage.families.map((family) => {
    const entry = Object.hasOwn(fallbackFamilies.faces, family) ? fallbackFamilies.faces[family] : undefined;
    if (typeof entry?.url !== "string" || typeof entry?.load !== "function") {
      throw new Error(
        `The font coverage index names the fallback family "${family}", and fallbackFamilies.faces has no ` +
          `{ url, load } entry for it`,
      );
    }
    return entry;
  });
  const loads = new Map();
  return Object.freeze({
    coverage,
    // The face of fallback family `family` (its index in the coverage
    // index) at a CSS weight and style: a promise of
    // { family, bytes, faceIndex, finalURL }. A failed load rejects with
    // the family, the URL, and the cause.
    load(family, weight, style) {
      const key = `${family}\n${weight}\n${style}`;
      let resource = loads.get(key);
      if (resource === undefined) {
        const name = coverage.families[family];
        const { url, load } = faces[family];
        resource = { state: "pending", url, promise: null };
        resource.promise = Promise.resolve().then(() => load({ url, weight, style })).then((response) => {
          const bytes = response instanceof Uint8Array ? response : response?.bytes;
          if (!(bytes instanceof Uint8Array)) {
            throw new TypeError(`load returned ${Object.prototype.toString.call(response)}, not font bytes`);
          }
          readFontMetrics(bytes, { faceIndex: Number(response?.faceIndex ?? 0) });
          Object.assign(resource, { state: "loaded" });
          return {
            family: name, bytes, faceIndex: Number(response?.faceIndex ?? 0),
            finalURL: response?.finalURL ?? url,
          };
        }).catch((cause) => {
          Object.assign(resource, { state: "failed", error: cause });
          throw new Error(
            `The fallback font family "${name}" (weight ${weight}, ${style}) failed to load from ${url}: ` +
              `${cause?.message ?? cause}`,
            { cause },
          );
        });
        loads.set(key, resource);
      }
      return resource.promise;
    },
    // The state of each face load: [{ family, weight, style, url, state }].
    get resources() {
      return [...loads].map(([key, { url, state }]) => {
        const [family, weight, style] = key.split("\n");
        return { family: coverage.families[Number(family)], weight: Number(weight), style, url, state };
      });
    },
  });
}

// The fallback families of each bundled font set (system-fonts.js), shared
// by every registry that uses the set, so that a face loads once in a realm.
const bundledFallbackFamilies = new WeakMap();

function fallbackFamiliesOfBundledFonts(bundledSystemFonts) {
  const option = bundledSystemFonts?.fallbackFamilies ?? null;
  if (option === null) return null;
  let fallback = bundledFallbackFamilies.get(option);
  if (fallback === undefined) {
    fallback = createFallbackFamilies(option);
    bundledFallbackFamilies.set(option, fallback);
  }
  return fallback;
}

// `bundledSystemFonts` is the result of `loadBundledSystemFonts()` from
// system-fonts.js, or null. With it, a generic family that the system font
// resolver does not resolve uses the bundled face, and the fallback
// families of the bundled font set are the registry fallback families when
// neither `fallbackFamilies` nor the source registry names others.
// `fallbackFamilies`: see createFallbackFamilies.
export function createFontRegistry({
  resolveSystemFontFamily = null,
  bundledSystemFonts = null,
  fallbackFamilies = null,
  core = sharedDomCore,
  sourceRegistry = null,
} = {}) {
  const source = sourceRegistry === null ? null : registrySources.get(sourceRegistry);
  if (sourceRegistry !== null && !source) throw new TypeError("Unknown source font registry");
  resolveSystemFontFamily ??= source?.resolveSystemFontFamily ?? null;
  bundledSystemFonts ??= source?.bundledSystemFonts ?? null;
  const explicitFallback = fallbackFamilies === null ? null : createFallbackFamilies(fallbackFamilies);
  // Read when the renderer asks, so that a host can install the bundled
  // fonts after the default registry exists.
  const currentFallback = () =>
    explicitFallback ?? source?.fallback() ?? fallbackFamiliesOfBundledFonts(bundledSystemFonts);
  if (
    resolveSystemFontFamily !== null &&
    typeof resolveSystemFontFamily !== "function"
  ) {
    throw new TypeError("resolveSystemFontFamily must be a function or null");
  }
  if (bundledSystemFonts !== null && typeof bundledSystemFonts?.familyFor !== "function") {
    throw new TypeError(`bundledSystemFonts must be the result of loadBundledSystemFonts() or null; it is ${bundledSystemFonts}`);
  }

  const runtimeFontFamilies = new Map();
  const runtimeFamilyKeysByName = new Map();
  const facesByID = new Map();
  const faceIDs = new WeakMap();
  const publishedMetrics = new WeakSet();
  const familyKeys = new WeakMap();
  const listeners = new Set();
  const resources = new Map();
  const faceSources = new Map();
  let engineSourceTransport = null;
  let defaultFamilyKey = null;
  const registryID = nextRegistryID++;
  let nextFaceID = 1;
  let disposed = false;
  const genericFontFamilies = new Map();
  let runtimeFontVersion = 0;
  const fontCatalogHandle = core.status("font_catalog_create");
  const lifetime = {
    coreReference: new WeakRef(core),
    handle: fontCatalogHandle,
    resources,
    unsubscribe: null,
  };
  function changed() {
    defaultFamilyKey = null;
    const revision = core.status("font_catalog_revision", fontCatalogHandle);
    for (const listener of [...listeners]) listener(revision);
  }
  function publishSpecification(key, specification, generic = false) {
    familyKeys.set(specification, key);
    core.status(
      "font_catalog_family", fontCatalogHandle,
      ...core.input(key), ...core.input(specification.cssFamily),
      ...core.input(specification.fallback),
      (specification.variable === true ? 1 : 0) |
        (generic && !specification.resolveFace ? 2 : 0) |
        (specification.resolveFace ? 4 : 0),
    );
    if (Number.isFinite(specification.zeroAdvanceRatio)) {
      core.status(
        "font_catalog_metrics", fontCatalogHandle, ...core.input(key),
        specification.zeroAdvanceRatio, NaN, NaN, NaN, NaN,
      );
      publishedMetrics.add(specification);
    }
  }
  // A face covers the weights weightMinimum to weightMaximum, the stretches
  // stretchMinimum to stretchMaximum and the font-style slopes
  // slopeMinimum to slopeMaximum: one value each for a static face, the
  // @font-face descriptor's range for a variable one. descriptor.unicodeRange
  // is a Uint32Array of {start, end} scalar pairs, or null for U+0-10FFFF.
  // available: 1 for a loaded face; 0 for a face that an @font-face rule
  // with unicode-range declares before its bytes load (declareRuntimeFont),
  // which has no resource and no engine source; -1 removes the face.
  function publishFace(key, face, descriptor, available = 1) {
    let faceID = faceIDs.get(face);
    if (faceID === undefined) {
      faceID = nextFaceID++;
      faceIDs.set(face, faceID);
    }
    facesByID.set(faceID, face);
    const ranges = descriptor.unicodeRange ?? null;
    core.status(
      "font_catalog_face", fontCatalogHandle, ...core.input(key),
      faceID, descriptor.weightMinimum, descriptor.weightMaximum,
      descriptor.stretchMinimum, descriptor.stretchMaximum,
      descriptor.slopeMinimum, descriptor.slopeMaximum, available,
      ...core.byteInput(ranges === null
        ? new Uint8Array(0)
        : new Uint8Array(ranges.buffer, ranges.byteOffset, ranges.byteLength)),
    );
    if (available < 0) facesByID.delete(faceID);
    let resource = resources.get(faceID);
    if (available > 0 && resource === undefined) {
      resource = core.status(
        "resource_register", 3,
        ...core.input(`font:${registryID}:${faceID}`),
      );
      resources.set(faceID, resource);
    }
    if (resource !== undefined) {
      if (available < 0) {
        core.status("resource_release", resource);
        resources.delete(faceID);
      } else {
        core.status("resource_update", resource, 1, 0, 0, 1, 0);
      }
    }
    publishedMetrics.delete(runtimeFontFamilies.get(key) ?? hostedFontFamilies.get(key));
    // The renderer forgets a released face's registration of its engine
    // instance, which other faces with the same bytes may share.
    if (available < 0) {
      const released = faceSources.get(faceID);
      faceSources.delete(faceID);
      if (released) engineSourceTransport?.release(released);
    } else if (resource !== undefined) {
      const source = { family: key, faceID, face, descriptor, resourceHandle: resource,
        variable: (runtimeFontFamilies.get(key) ?? hostedFontFamilies.get(key) ?? genericFontFamilies.get(key))?.variable === true };
      faceSources.set(faceID, source);
      engineSourceTransport?.register(source);
    }
  }
  const publishFamily = (name, key, layer) => {
    core.status(
      "font_catalog_set",
      fontCatalogHandle,
      ...core.input(name),
      ...core.input(key),
      layer,
    );
  };

  // weight: one CSS weight, or the [minimum, maximum] range of a variable
  // face's font-weight descriptor. A range face instances the file's 'wght'
  // axis at the requested weight clamped into its range.
  // stretch: "auto" (an absent or auto font-stretch descriptor), one CSS
  // stretch percentage, or a [minimum, maximum] range. Face matching takes
  // "auto" as 100%; a file with a 'wdth' axis instances it at the requested
  // stretch ("auto"), the one value, or the requested stretch clamped into
  // the range (CSS Fonts 4, 4.4 and 5.2).
  // style: an @font-face font-style descriptor (fontFaceStyleDescriptor):
  // auto, normal, italic, oblique, or oblique with one or two angles. Face
  // matching takes auto as normal; a file with a 'slnt' axis instances it
  // at the requested oblique angle (auto) or the angle clamped into the
  // face's slope range.
  // unicodeRange: the {start, end} scalar pairs of an @font-face
  // unicode-range descriptor (DomCore.fontUnicodeRanges), or null for
  // U+0-10FFFF. The face applies only to the scalars of its range
  // (plans/PLAN-font-unicode-range.md).
  function registerRuntimeFont(
    cssFamily,
    bytes,
    { weight = 400, stretch = "auto", style = "normal", unicodeRange = null, finalURL = null, owner = null } = {},
  ) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Runtime font bytes must be a Uint8Array");
    }
    const descriptor = runtimeFaceDescriptor(cssFamily, { weight, stretch, style, unicodeRange });
    // Publishing a face registers it in the engine, which parses the
    // file's table directory (variation axes) and its metric tables. Parse
    // both before anything is published: bytes that are not a font throw
    // here and leave no family, face or catalog entry behind. Both parses
    // are cached by byte identity, so the engine registration reuses them.
    fontVariationAxes(bytes);
    readFontMetrics(bytes);
    return publishRuntimeFace(descriptor, {
      bytes,
      version: ++runtimeFontVersion,
      finalURL,
      owner,
    }, 1);
  }

  // Declares the face of an @font-face rule with a unicode-range
  // descriptor before its bytes load (decision 3 of
  // plans/PLAN-font-unicode-range.md). The face joins the font stack of
  // its family as an unloaded range face. When the text needs it, the
  // renderer calls loadDeclaredFace, which calls `load`; `load` registers
  // the bytes with registerRuntimeFont and the same owner, and returns a
  // promise that settles after that registration or with the load error.
  function declareRuntimeFont(
    cssFamily,
    { weight = 400, stretch = "auto", style = "normal", unicodeRange, owner, load } = {},
  ) {
    if (!(unicodeRange instanceof Uint32Array)) {
      throw new TypeError(`A declared runtime font needs its unicode-range pairs as a Uint32Array; got ${unicodeRange}`);
    }
    if (typeof load !== "function") {
      throw new TypeError(`A declared runtime font needs a load function; got ${load}`);
    }
    const descriptor = runtimeFaceDescriptor(cssFamily, { weight, stretch, style, unicodeRange });
    return publishRuntimeFace(descriptor, {
      bytes: null,
      version: ++runtimeFontVersion,
      finalURL: null,
      owner,
      load,
    }, 0);
  }

  // The checked descriptors of a runtime face (registerRuntimeFont).
  function runtimeFaceDescriptor(cssFamily, { weight, stretch, style, unicodeRange }) {
    const name = normalizedFamilyName(cssFamily, false, core);
    if (!name) throw new TypeError("Font family must not be empty");
    const [weightMinimum, weightMaximum] = Array.isArray(weight)
      ? weight.map(Number)
      : [Number(weight), Number(weight)];
    if (!Number.isFinite(weightMinimum) || !Number.isFinite(weightMaximum) || weightMinimum > weightMaximum) {
      throw new RangeError(`Runtime font weight must be a number or an increasing [minimum, maximum] pair; got ${weight}`);
    }
    const stretchAuto = stretch === "auto";
    const [stretchMinimum, stretchMaximum] = stretchAuto
      ? [100, 100]
      : Array.isArray(stretch)
      ? stretch.map(Number)
      : [Number(stretch), Number(stretch)];
    if (!(stretchMinimum >= 0) || !Number.isFinite(stretchMaximum) || stretchMinimum > stretchMaximum) {
      throw new RangeError(`Runtime font stretch must be "auto", a non-negative percentage or an increasing [minimum, maximum] pair; got ${stretch}`);
    }
    const slope = fontFaceStyleDescriptor(style);
    if (slope === null) {
      throw new RangeError(`Runtime font style must be an @font-face font-style descriptor (auto, normal, italic, oblique, or oblique with one or two angles from -90deg to 90deg); got ${style}`);
    }
    if (unicodeRange !== null && !(unicodeRange instanceof Uint32Array && unicodeRange.length % 2 === 0)) {
      throw new TypeError(`Runtime font unicodeRange must be null or a Uint32Array of {start, end} pairs; got ${unicodeRange}`);
    }
    return {
      name,
      weightMinimum,
      weightMaximum,
      stretchMinimum,
      stretchMaximum,
      stretchAuto,
      ...slope,
      style: String(style),
      unicodeRange,
    };
  }

  // Publishes a runtime face of `descriptor` (runtimeFaceDescriptor) with
  // `fields`; the face of the same owner is updated in place, so that a
  // declared face keeps its catalog ID, and its place among the faces of
  // the family, when it loads.
  function publishRuntimeFace({ name, ...descriptor }, fields, available) {
    const normalizedName = normalizedFamilyName(name, true, core);
    let key = runtimeFamilyKeysByName.get(normalizedName);
    let specification = key === undefined ? null : runtimeFontFamilies.get(key);
    if (!specification) {
      key = `runtime:${normalizedName}`;
      specification = {
        cssFamily: name,
        fallback: "sans-serif",
        faces: [],
      };
      runtimeFontFamilies.set(key, specification);
      publishSpecification(key, specification);
      runtimeFamilyKeysByName.set(normalizedName, key);
    }
    const existing = specification.faces.find((face) => face.owner === fields.owner);
    const face = { ...descriptor, ...fields };
    const registered = existing ?? face;
    if (existing) Object.assign(existing, face);
    else specification.faces.push(face);
    delete specification.zeroAdvanceRatio;
    publishFace(key, registered, face, available);
    publishFamily(name, key, 1);
    changed();
    return key;
  }

  // Loads the declared face `faceID` of this registry's catalog (an
  // unloaded range face that a shaped text needs): the promise of its
  // `load` (declareRuntimeFont).
  function loadDeclaredFace(faceID) {
    const face = facesByID.get(faceID);
    if (typeof face?.load !== "function") {
      throw new Error(
        `The renderer requested the declared font face ${faceID}, and the font registry has no declared face with that ID; ` +
          "declare it with declareRuntimeFont",
      );
    }
    return face.load();
  }

  function unregisterRuntimeFont(familyKey, owner) {
    const specification = runtimeFontFamilies.get(familyKey);
    if (!specification) return;
    specification.faces = specification.faces.filter((face) => {
      if (face.owner !== owner) return true;
      runtimeFontVersion++;
      publishFace(familyKey, face, face, -1);
      return false;
    });
    delete specification.zeroAdvanceRatio;
    if (specification.faces.length !== 0) {
      changed();
      return;
    }
    runtimeFontFamilies.delete(familyKey);
    runtimeFamilyKeysByName.delete(normalizedFamilyName(specification.cssFamily, true, core));
    publishFamily(specification.cssFamily, "", 1);
    core.status("font_catalog_remove", fontCatalogHandle, ...core.input(familyKey));
    changed();
  }

  async function loadFont(
    cssFamily,
    source,
    { weight = 400, stretch = "auto", style = "normal" } = {},
  ) {
    const name = normalizedFamilyName(cssFamily, false, core);
    if (!name) throw new TypeError("Font family must not be empty");
    let bytes;
    let finalURL = null;
    if (source instanceof Uint8Array) {
      bytes = source;
    } else if (source instanceof ArrayBuffer) {
      bytes = new Uint8Array(source);
    } else {
      let sourceURL;
      if (source instanceof URL) {
        sourceURL = source;
      } else if (typeof source === "string") {
        try {
          sourceURL = new URL(source);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          if (!hasFileSystem) {
            sourceURL = new URL(
              source,
              globalThis.location?.href ?? import.meta.url,
            );
          }
        }
      } else {
        throw new TypeError(
          "Font source must be a URL, path, Uint8Array, or ArrayBuffer",
        );
      }
      if (hasFileSystem && (!sourceURL || sourceURL.protocol === "file:")) {
        bytes = await readBinaryFile(sourceURL ?? source);
        finalURL = sourceURL?.href ?? String(source);
      } else {
        const response = await fetch(sourceURL);
        if (!response.ok) {
          throw new Error(
            `Font request failed with HTTP ${response.status}: ${sourceURL}`,
          );
        }
        bytes = new Uint8Array(await response.arrayBuffer());
        finalURL = response.url || sourceURL.href;
      }
    }
    const owner = {};
    const family = registerRuntimeFont(name, bytes, {
      weight,
      stretch,
      style,
      finalURL,
      owner,
    });
    return Object.freeze({
      family,
      unload() {
        unregisterRuntimeFont(family, owner);
      },
    });
  }

  function runtimeFontFamily(key) {
    return runtimeFontFamilies.get(key) ?? null;
  }

  function familySpec(familyKey) {
    let specification = runtimeFontFamilies.get(familyKey) ??
      hostedFontFamilies.get(familyKey) ??
      genericFontFamilies.get(familyKey);
    let key = String(familyKey);
    if (key.startsWith("generic:")) {
      const [localKey] = fontStackKeysForCssValue(
        key.slice("generic:".length),
      );
      specification = runtimeFontFamilies.get(localKey) ??
        hostedFontFamilies.get(localKey) ??
        genericFontFamilies.get(localKey);
      if (specification) key = localKey;
    }
    if (!specification && key.startsWith("host:")) {
      const familyEnd = key.indexOf(":", "host:".length);
      if (familyEnd === -1) {
        throw new Error(`invalid hosted fontFamily key: ${familyKey}`);
      }
      const cssFamily = decodeURIComponent(
        key.slice("host:".length, familyEnd),
      );
      const [localKey] = fontStackKeysForCssValue(cssFamily);
      specification = runtimeFontFamilies.get(localKey) ??
        hostedFontFamilies.get(localKey) ??
        genericFontFamilies.get(localKey);
      if (specification) key = localKey;
    }
    if (!specification) {
      // A bare, unprefixed key is an authored family name (scene specs and
      // the oracle harnesses address families by name). Resolve it the same
      // way fontStackKeysForCssValue resolves one entry: registered name
      // lookup first, then the system font resolver.
      const [namedKey] = fontStackKeysForCssValue(key);
      specification = runtimeFontFamilies.get(namedKey) ??
        hostedFontFamilies.get(namedKey) ??
        genericFontFamilies.get(namedKey);
      key = namedKey;
    }
    if (!specification) throw new Error(`unknown fontFamily key: ${familyKey}`);
    if (!familyKeys.has(specification)) publishSpecification(key, specification);
    return specification;
  }

  function registerResolvedHostFamily(authoredName, resolved) {
    if (resolved === null || resolved === undefined) return null;
    if (typeof resolved !== "object") {
      throw new TypeError(
        "A system font family resolver must return an object or null",
      );
    }
    if (typeof resolved.resolveFace !== "function") {
      throw new TypeError(
        "A resolved system font family must provide resolveFace",
      );
    }
    const identity = String(resolved.familyIdentity ?? "").trim();
    const cssFamily = normalizedFamilyName(resolved.cssFamily ?? authoredName, false, core);
    if (!identity || !cssFamily) {
      throw new TypeError(
        "A resolved system font family needs identity and CSS family values",
      );
    }
    const key = `host:${encodeURIComponent(cssFamily)}:${identity}`;
    if (!hostedFontFamilies.has(key)) {
      hostedFontFamilies.set(key, {
        cssFamily,
        fallback: resolved.fallback ?? "sans-serif",
        zeroAdvanceRatio: resolved.zeroAdvanceRatio,
        // Variable families instance the 'wght' axis at registration;
        // static families register their weight's file as-is.
        variable: resolved.variable === true,
        resolveFace: resolved.resolveFace,
        faces: new Map(),
      });
    }
    publishSpecification(key, hostedFontFamilies.get(key));
    publishFamily(authoredName, key, 0);
    publishFamily(cssFamily, key, 0);
    changed();
    return key;
  }

  function fontFamilyCssValue(familyKey) {
    const specification = familySpec(familyKey);
    return core.string(
      "font_catalog_css", fontCatalogHandle,
      ...core.input(familyKeys.get(specification)),
    ) ?? "";
  }

  // The authored stack of a CSS font-family value: the key of each
  // available family in authored order. Key 0 is the primary family. A
  // value without an available family throws.
  function fontStackKeysForCssValue(cssValue, { isUnavailable = null } = {}) {
    const source = String(cssValue);
    const query = core.status(
      "font_query_begin",
      fontCatalogHandle,
      ...core.input(source),
      isUnavailable === null ? 0 : 1,
    );
    try {
      for (;;) {
        const request = core.status("font_query_next", query);
        if (request === 0) break;
        const name = core.outputString() ?? "";
        const token = core.status("font_query_token", query);
        if (request === 1) {
          const unavailable = isUnavailable(name);
          core.status(
            "font_query_resume",
            query,
            token,
            unavailable ? 1 : 0,
            ...core.input(""),
          );
        } else {
          // The host's system resolver answers first; bundled system fonts
          // are installed under their own names too.
          const resolved = (resolveSystemFontFamily === null ? null : resolveSystemFontFamily(name)) ??
            bundledSystemFonts?.familyNamed?.(name) ?? null;
          const key = resolved === null ? null : registerResolvedHostFamily(name, resolved);
          core.status(
            "font_query_resume",
            query,
            token,
            0,
            ...core.input(key ?? ""),
          );
        }
      }
      const count = core.status("font_query_result_count", query);
      if (count === 0) {
        throw new Error(
          core.string(
            "font_query_error",
            query,
            ...core.input(String(cssValue)),
          ) ?? "",
        );
      }
      const keys = new Array(count);
      for (let index = 0; index < count; index++) {
        const key = core.string("font_query_result_at", query, index) ?? "";
        if (key.startsWith("generic:") && !genericFontFamilies.has(key)) {
          const name = key.slice("generic:".length);
          // With bundled system fonts, a generic family with a bundled font
          // resolves its faces from the bundled files; otherwise the generic
          // family has no faces.
          const bundled = bundledSystemFonts?.familyFor(name) ?? null;
          genericFontFamilies.set(
            key,
            bundled === null
              ? { cssFamily: name, fallback: name, faces: new Map() }
              : { ...bundled, cssFamily: name, faces: new Map() },
          );
          publishSpecification(key, genericFontFamilies.get(key), true);
        }
        keys[index] = key;
      }
      return keys;
    } finally {
      core.status("font_query_dispose", query);
    }
  }

  // stretch: the requested CSS font-stretch percentage. It selects among a
  // runtime family's faces and sets variationWidth, the 'wdth' coordinate
  // the face instances at when its file has that axis (the renderer
  // registers a file without one as-is). A host resolver's face instances
  // 'wdth' at the requested stretch, as a runtime face with an auto
  // descriptor does.
  // slope: the requested font-style slope in degrees (0 normal, 14 italic
  // and a plain oblique, else the oblique angle; the core's face table
  // states it). It selects among a runtime family's faces and sets
  // variationSlant, the 'slnt' coordinate the face instances at when its
  // file has that axis: the negated slope clamped into the face's slope
  // range, or unclamped for an auto descriptor and a host resolver's face.
  // italicFace states whether the face slants its own glyphs; Chrome
  // synthesizes a slant for a slope of 14deg or more on any other face.
  function importHostFontSource(familyKey, weight, style) {
    const specification = hostedFontFamilies.get(familyKey) ?? genericFontFamilies.get(familyKey);
    if (!specification?.resolveFace) {
      throw new Error(`Native font source request has no system provider for ${familyKey}`);
    }
    const face = hostFontFace(specification, Number(weight), style);
    return face;
  }

  function hostFontFace(specification, requestedWeight, hostStyle) {
    let weights = specification.faces.get(requestedWeight);
    let face = weights?.get(hostStyle);
    if (!face) {
      const resolved = specification.resolveFace(requestedWeight, hostStyle);
      if (!resolved || !(resolved.bytes instanceof Uint8Array)) {
        throw new Error(`System font family "${specification.cssFamily}" did not resolve a usable face`);
      }
      // Parse the table directory and metric tables before the face is
      // cached or published, as registerRuntimeFont does: bytes that are not
      // a font throw here and leave no catalog row, resource or engine
      // source behind. Both parses are cached by byte identity.
      fontVariationAxes(resolved.bytes);
      readFontMetrics(resolved.bytes);
      face = {
        bytes: resolved.bytes, faceIndex: Number(resolved.faceIndex ?? 0),
        italicFace: resolved.style === "italic", version: resolved.faceIdentity ?? resolved.finalURL ?? null,
        finalURL: resolved.finalURL ?? null,
      };
      if (!weights) specification.faces.set(requestedWeight, weights = new Map());
      weights.set(hostStyle, face);
      hostedFaceRequests.set(face, { weight: requestedWeight, style: hostStyle });
    }
    const requested = hostedFaceRequests.get(face);
    if (!faceIDs.has(face)) {
      publishFace(familyKeys.get(specification), face, {
        weightMinimum: requested.weight, weightMaximum: requested.weight,
        stretchMinimum: 100, stretchMaximum: 100, stretchAuto: true,
        slopeMinimum: requested.style === "normal" ? 0 : ITALIC_SLOPE,
        slopeMaximum: requested.style === "normal" ? 0 : ITALIC_SLOPE,
        slopeAuto: true,
      });
      changed();
    }
    return face;
  }

  function fontFileFor(familyKey, weight, style = "normal", stretch = 100, slope = style === "normal" ? 0 : ITALIC_SLOPE) {
    const specification = familySpec(familyKey);
    if (specification.resolveFace) {
      // A platform font request asks for an upright face at a slope of 0deg
      // or less, as Chrome's does.
      const hostStyle = style === "oblique" && !(slope > 0) ? "normal" : String(style);
      const face = hostFontFace(specification, Number(weight), hostStyle);
      // The host resolver returns the physical face for this exact request.
      // Retain that imported identity; a later host request must not replace
      // the already cached result (including coercion-time reentrant calls).
      const catalogID = faceIDs.get(face);
      return {
        ...face,
        catalogID,
        resourceHandle: resources.get(catalogID),
        variationWidth: Number(stretch),
        variationSlant: slantCoordinate(Number(slope)),
      };
    }
    if (specification.faces instanceof Map) {
      const cause = resolveSystemFontFamily === null
        ? "has no system font resolver"
        : "is not currently available from its system font resolver";
      throw new Error(
        `Generic font family "${specification.cssFamily}" ${cause}; declare @font-face with a resolvable font URL`,
      );
    }
    const faceID = core.status(
      "font_catalog_select_face", fontCatalogHandle,
      ...core.input(familyKeys.get(specification)),
      Number(weight), Number(stretch), Number(slope),
    );
    const face = facesByID.get(faceID);
    if (!face) {
      throw new Error(`runtime font family "${familyKey}" has no loaded faces`);
    }
    const faceIndex = Number(face.faceIndex ?? 0);
    return {
      bytes: face.bytes,
      faceIndex,
      // An auto descriptor matches as normal, but a file whose 'slnt' axis
      // reaches right-leaning angles slants its own glyphs.
      italicFace: face.slopeMaximum !== 0 ||
        (face.slopeAuto && (fontVariationAxes(face.bytes, faceIndex).get("slnt")?.minimum ?? 0) < 0),
      version: face.version,
      finalURL: face.finalURL,
      catalogID: faceID,
      resourceHandle: resources.get(faceID),
      // A range face instances its 'wght' axis; a static face registers as-is.
      variationWeight: face.weightMaximum > face.weightMinimum
        ? Math.min(Math.max(Number(weight), face.weightMinimum), face.weightMaximum)
        : 0,
      variationWidth: face.stretchAuto
        ? Number(stretch)
        : Math.min(Math.max(Number(stretch), face.stretchMinimum), face.stretchMaximum),
      variationSlant: slantCoordinate(face.slopeAuto
        ? Number(slope)
        : Math.min(Math.max(Number(slope), face.slopeMinimum), face.slopeMaximum)),
    };
  }

  function fontWeightInCssUnits(value = 4) {
    return core.exports.font_weight_css(Number(value));
  }

  function fontWeightInSceneUnits(value = 4) {
    return core.exports.font_weight_scene(Number(value));
  }

  // Whether register_font should instance the 'wght' axis (variable) or
  // register the file as-is (static: weight comes from the file itself).
  function isVariableFamily(familyKey) {
    const specification = familySpec(familyKey);
    return (core.status(
      "font_catalog_family_flags", fontCatalogHandle,
      ...core.input(familyKeys.get(specification)),
    ) & 1) !== 0;
  }

  // CSS Values and Units, "ch": when it is impossible or impractical to
  // determine the measure of the "0" glyph, it must be assumed to be
  // 0.5em wide. An unknown family, a family the resolver cannot supply,
  // or a face without measurable metrics therefore resolves ch against
  // this ratio instead of throwing — a throw here classified a VALID
  // ch declaration as an invalid value, and the cascade swallow policy
  // then silently dropped the whole declaration (found through
  // sandscript.run: `padding: "40px 4ch"` on an element with an
  // unresolvable default family vanished without an error).
  function zeroAdvanceRatioFor(familyKey) {
    let specification;
    try {
      specification = familySpec(familyKey);
    } catch {
      return core.status(
        "font_catalog_metric", fontCatalogHandle, ...core.input(""), 0,
      );
    }
    const key = familyKeys.get(specification);
    if (!publishedMetrics.has(specification)) {
      let metrics;
      let face;
      try {
        if (!Number.isFinite(specification.zeroAdvanceRatio)) {
          face = fontFileFor(key, 400, "normal");
          metrics = readFontMetrics(face.bytes, { faceIndex: face.faceIndex });
        }
      } catch {
        // Invalid/unavailable bytes are diagnosed by the actual loader or
        // shaping caller. Unknown metrics stay NaN; the core supplies ch.
      }
      specification.zeroAdvanceRatio = metrics?.zeroAdvanceRatio ?? specification.zeroAdvanceRatio ?? NaN;
      core.status(
        "font_catalog_metrics", fontCatalogHandle, ...core.input(key),
        specification.zeroAdvanceRatio, metrics?.ascender ?? NaN,
        metrics?.descender ?? NaN, metrics?.lineGap ?? NaN, metrics?.upem ?? NaN,
      );
      if (face && metrics) {
        const metricsChanged = core.status(
          "font_catalog_face_metrics", fontCatalogHandle, ...core.input(key), face.catalogID,
          metrics.zeroAdvanceRatio, metrics.ascender, metrics.descender, metrics.lineGap, metrics.upem,
        );
        if (metricsChanged && face.resourceHandle) {
          core.status("resource_metrics_changed", face.resourceHandle);
        }
      }
      publishedMetrics.add(specification);
      changed();
    }
    return core.status(
      "font_catalog_metric", fontCatalogHandle, ...core.input(key), 0,
    );
  }

  function familiesInNodes(nodes) {
    const keys = new Set();
    for (const node of nodes) {
      if (node.display === "text") {
        keys.add(
          node.fontFamily ?? fontStackKeysForCssValue(DEFAULT_FONT_FAMILY)[0],
        );
      }
    }
    return [...keys];
  }

  const registry = Object.freeze({
    core,
    fontCatalogHandle,
    // The registry fallback families (createFallbackFamilies), or null.
    get fallbackFamilies() {
      return currentFallback();
    },
    get revision() {
      return core.status("font_catalog_revision", fontCatalogHandle);
    },
    bindDocument(document) {
      if (document._domCore !== core) throw new TypeError("Font registry belongs to another renderer core");
      core.status("font_catalog_bind_document", fontCatalogHandle, document._coreHandle);
    },
    unbindDocument(document) {
      if (document._domCore !== core) throw new TypeError("Font registry belongs to another renderer core");
      if (disposed) return;
      core.status("font_catalog_unbind_document", fontCatalogHandle, document._coreHandle);
    },
    subscribe(listener, options = null) {
      if (options?.weak === true) {
        return subscribeFontSource(registry, new WeakRef(listener));
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachEngineSourceTransport(transport) {
      if (engineSourceTransport !== null) throw new Error("Font catalog already has a renderer source owner");
      engineSourceTransport = transport;
      for (const source of faceSources.values()) transport.register(source);
    },
    prepareNativeFontPublication(root) {
      if (engineSourceTransport === null) return;
      registry.bindDocument(root.nodeType === 9 ? root : root.ownerDocument);
      defaultFamilyKey ??= fontStackKeysForCssValue(DEFAULT_FONT_FAMILY)[0];
      engineSourceTransport.prepare(root, defaultFamilyKey, importHostFontSource);
    },
    replayEngineSources() {
      for (const source of faceSources.values()) engineSourceTransport.register(source);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.unsubscribe?.();
      lifetime.unsubscribe = null;
      registrySources.get(registry).synchronize = null;
      listeners.clear();
      engineSourceTransport = null;
      faceSources.clear();
      for (const resource of resources.values()) core.status("resource_release", resource);
      resources.clear();
      core.status("font_catalog_release", fontCatalogHandle);
      fontCatalogFinalizer.unregister(registry);
    },
    registerRuntimeFont,
    declareRuntimeFont,
    loadDeclaredFace,
    unregisterRuntimeFont,
    loadFont,
    runtimeFontFamily,
    fontFamilyCssValue,
    fontStackKeysForCssValue,
    fontFileFor,
    fontWeightInCssUnits,
    fontWeightInSceneUnits,
    isVariableFamily,
    zeroAdvanceRatioFor,
    familiesInNodes,
  });
  fontCatalogFinalizer.register(registry, lifetime, registry);
  registrySources.set(registry, {
    runtimeFontFamilies,
    resolveSystemFontFamily,
    bundledSystemFonts,
    fallback: currentFallback,
    get version() { return runtimeFontVersion; },
  });
  if (source) {
    // A standalone persistent renderer needs its own native catalog/resource
    // handles, while immutable font bytes and authored family keys stay shared.
    const versions = new Map();
    let synchronizedVersion = -1;
    const synchronizeSource = () => {
      if (synchronizedVersion === source.version) return;
      synchronizedVersion = source.version;
      const live = new Set();
      for (const [key, specification] of source.runtimeFontFamilies) {
        for (const face of specification.faces) {
          live.add(face);
          if (versions.get(face)?.version === face.version) continue;
          const descriptors = {
            weight: [face.weightMinimum, face.weightMaximum],
            stretch: face.stretchAuto ? "auto" : [face.stretchMinimum, face.stretchMaximum],
            style: face.style, unicodeRange: face.unicodeRange ?? null, owner: face,
          };
          // A declared face loads through its source registry's load.
          if (face.bytes === null) declareRuntimeFont(specification.cssFamily, { ...descriptors, load: face.load });
          else registerRuntimeFont(specification.cssFamily, face.bytes, { ...descriptors, finalURL: face.finalURL });
          versions.set(face, { key, version: face.version });
        }
      }
      for (const [face, previous] of versions) {
        if (live.has(face)) continue;
        unregisterRuntimeFont(previous.key, face);
        versions.delete(face);
      }
    };
    synchronizeSource();
    // Keep the listener alive with this registry, never with its source.
    registrySources.get(registry).synchronize = synchronizeSource;
    lifetime.unsubscribe = subscribeFontSource(sourceRegistry, new WeakRef(synchronizeSource));
  }
  return registry;
}

// The default module registry consults a host-installed resolver and the
// installed bundled system fonts lazily on every unresolved family, so the
// host (a test harness, a shell, a page) can seed the process before or
// after this module evaluates — the same seeding pattern as sandom.hbBytes.
export const defaultFontRegistry = createFontRegistry({
  resolveSystemFontFamily: (name) => {
    const resolver = globalThis[Symbol.for("sandom.resolveSystemFontFamily")];
    return resolver ? resolver(name) : null;
  },
  bundledSystemFonts: {
    familyFor: (name) => globalThis[Symbol.for("sandom.bundledSystemFonts")]?.familyFor(name) ?? null,
    familyNamed: (name) => globalThis[Symbol.for("sandom.bundledSystemFonts")]?.familyNamed(name) ?? null,
    // The bundled fonts' fallback families, else those that a host with
    // its own generic faces installed (installFontSetFallbackFamilies).
    get fallbackFamilies() {
      return globalThis[Symbol.for("sandom.bundledSystemFonts")]?.fallbackFamilies ??
        globalThis[Symbol.for("sandom.fontSetFallbackFamilies")] ?? null;
    },
  },
});
sharedDomCore.defaultFontRegistry = defaultFontRegistry;

export const registerRuntimeFont = (...arguments_) =>
  defaultFontRegistry.registerRuntimeFont(...arguments_);
export const unregisterRuntimeFont = (...arguments_) =>
  defaultFontRegistry.unregisterRuntimeFont(...arguments_);
export const loadFont = (...arguments_) =>
  defaultFontRegistry.loadFont(...arguments_);
export const runtimeFontFamily = (...arguments_) =>
  defaultFontRegistry.runtimeFontFamily(...arguments_);
export const fontFamilyCssValue = (...arguments_) =>
  defaultFontRegistry.fontFamilyCssValue(...arguments_);
export const fontStackKeysForCssValue = (...arguments_) =>
  defaultFontRegistry.fontStackKeysForCssValue(...arguments_);
export const fontFileFor = (...arguments_) =>
  defaultFontRegistry.fontFileFor(...arguments_);
export const fontWeightInCssUnits = (...arguments_) =>
  defaultFontRegistry.fontWeightInCssUnits(...arguments_);
export const fontWeightInSceneUnits = (...arguments_) =>
  defaultFontRegistry.fontWeightInSceneUnits(...arguments_);
export const isVariableFamily = (...arguments_) =>
  defaultFontRegistry.isVariableFamily(...arguments_);
export const zeroAdvanceRatioFor = (...arguments_) =>
  defaultFontRegistry.zeroAdvanceRatioFor(...arguments_);
export const familiesInNodes = (...arguments_) =>
  defaultFontRegistry.familiesInNodes(...arguments_);
