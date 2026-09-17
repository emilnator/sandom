import { readFontMetrics } from "./font-metrics.js";

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


// Actual bytes and shaping objects stay in the host; catalog values and
// matching live in the core. A registry ID namespaces shared resource keys.
let nextRegistryID = 1;

export function createFontRegistry({
  resolveSystemFontFamily = null,
  core = sharedDomCore,
  sourceRegistry = null,
} = {}) {
  const source = sourceRegistry === null ? null : registrySources.get(sourceRegistry);
  if (sourceRegistry !== null && !source) throw new TypeError("Unknown source font registry");
  resolveSystemFontFamily ??= source?.resolveSystemFontFamily ?? null;
  if (
    resolveSystemFontFamily !== null &&
    typeof resolveSystemFontFamily !== "function"
  ) {
    throw new TypeError("resolveSystemFontFamily must be a function or null");
  }

  const runtimeFontFamilies = new Map();
  const runtimeFamilyKeysByName = new Map();
  const facesByID = new Map();
  const faceIDs = new WeakMap();
  const publishedMetrics = new WeakSet();
  const familyKeys = new WeakMap();
  const listeners = new Set();
  const resources = new Map();
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
    const revision = core.status("font_catalog_revision", fontCatalogHandle);
    for (const listener of [...listeners]) listener(revision);
  }
  function publishSpecification(key, specification, generic = false) {
    familyKeys.set(specification, key);
    core.status(
      "font_catalog_family", fontCatalogHandle,
      ...core.input(key), ...core.input(specification.cssFamily),
      ...core.input(specification.fallback),
      (specification.variable === true ? 1 : 0) | (generic ? 2 : 0),
    );
    if (Number.isFinite(specification.zeroAdvanceRatio)) {
      core.status(
        "font_catalog_metrics", fontCatalogHandle, ...core.input(key),
        specification.zeroAdvanceRatio, NaN, NaN, NaN, NaN,
      );
      publishedMetrics.add(specification);
    }
  }
  function publishFace(key, face, weight, style, available = 1) {
    let faceID = faceIDs.get(face);
    if (faceID === undefined) {
      faceID = nextFaceID++;
      faceIDs.set(face, faceID);
    }
    facesByID.set(faceID, face);
    core.status(
      "font_catalog_face", fontCatalogHandle, ...core.input(key),
      faceID, weight, ...core.input(style), available,
    );
    let resource = resources.get(faceID);
    if (available >= 0 && resource === undefined) {
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
        facesByID.delete(faceID);
      } else {
        core.status("resource_update", resource, available ? 1 : 2, 0, 0, 1, available ? 0 : 1);
      }
    }
    publishedMetrics.delete(runtimeFontFamilies.get(key) ?? hostedFontFamilies.get(key));
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

  function registerRuntimeFont(
    cssFamily,
    bytes,
    { weight = 400, style = "normal", finalURL = null, owner = null } = {},
  ) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Runtime font bytes must be a Uint8Array");
    }
    const name = normalizedFamilyName(cssFamily, false, core);
    if (!name) throw new TypeError("Font family must not be empty");
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
    const existing = specification.faces.find((face) => face.owner === owner);
    const face = {
      bytes,
      weight: Number(weight),
      version: ++runtimeFontVersion,
      style: String(style),
      finalURL,
      owner,
    };
    const registered = existing ?? face;
    if (existing) Object.assign(existing, face);
    else specification.faces.push(face);
    delete specification.zeroAdvanceRatio;
    publishFace(key, registered, face.weight, face.style);
    publishFamily(name, key, 1);
    changed();
    return key;
  }

  function unregisterRuntimeFont(familyKey, owner) {
    const specification = runtimeFontFamilies.get(familyKey);
    if (!specification) return;
    specification.faces = specification.faces.filter((face) => {
      if (face.owner !== owner) return true;
      runtimeFontVersion++;
      publishFace(familyKey, face, face.weight, face.style, -1);
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
    { weight = 400, style = "normal" } = {},
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
      const localKey = fontFamilyKeyForCssValue(
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
      const localKey = fontFamilyKeyForCssValue(cssFamily);
      specification = runtimeFontFamilies.get(localKey) ??
        hostedFontFamilies.get(localKey) ??
        genericFontFamilies.get(localKey);
      if (specification) key = localKey;
    }
    if (!specification) {
      // A bare, unprefixed key is an authored family name (scene specs and
      // the oracle harnesses address families by name). Resolve it the same
      // way fontFamilyKeyForCssValue resolves one entry: registered name
      // lookup first, then the system font resolver.
      const namedKey = fontFamilyKeyForCssValue(key);
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

  function fontFamilyKeyForCssValue(cssValue, { isUnavailable = null } = {}) {
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
          const key = resolveSystemFontFamily === null
            ? null
            : registerResolvedHostFamily(name, resolveSystemFontFamily(name));
          core.status(
            "font_query_resume",
            query,
            token,
            0,
            ...core.input(key ?? ""),
          );
        }
      }
      const key = core.string("font_query_result", query) ?? "";
      if (!key) {
        throw new Error(
          core.string(
            "font_query_error",
            query,
            ...core.input(String(cssValue)),
          ) ?? "",
        );
      }
      if (key.startsWith("generic:") && !genericFontFamilies.has(key)) {
        const name = key.slice("generic:".length);
        genericFontFamilies.set(key, {
          cssFamily: name,
          fallback: name,
          faces: new Map(),
        });
        publishSpecification(key, genericFontFamilies.get(key), true);
      }
      return key;
    } finally {
      core.status("font_query_dispose", query);
    }
  }

  function fontFileFor(familyKey, weight, style = "normal") {
    const specification = familySpec(familyKey);
    if (specification.resolveFace) {
      const cacheKey = `${Number(weight)}:${String(style)}`;
      let face = specification.faces.get(cacheKey);
      if (!face) {
        const requestedWeight = Number(weight);
        const requestedStyle = String(style);
        const resolved = specification.resolveFace(requestedWeight, requestedStyle);
        if (!resolved || !(resolved.bytes instanceof Uint8Array)) {
          throw new Error(
            `System font family "${specification.cssFamily}" did not resolve a usable face`,
          );
        }
        face = {
          bytes: resolved.bytes,
          faceIndex: Number(resolved.faceIndex ?? 0),
          italicFace: resolved.style === "italic",
          version: resolved.faceIdentity ?? cacheKey,
          finalURL: resolved.finalURL ?? null,
        };
        specification.faces.set(cacheKey, face);
        hostedFaceRequests.set(face, { weight: requestedWeight, style: requestedStyle });
      }
      const requested = hostedFaceRequests.get(face);
      if (!faceIDs.has(face)) {
        publishFace(familyKeys.get(specification), face, requested.weight, requested.style);
        changed();
      }
      // The host resolver returns the physical face for this exact request.
      // Retain that imported identity; a later host request must not replace
      // the already cached result (including coercion-time reentrant calls).
      const catalogID = faceIDs.get(face);
      return { ...face, catalogID, resourceHandle: resources.get(catalogID) };
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
      Number(weight), ...(typeof style === "string" ? core.input(style) : [0, -1]),
    );
    const face = facesByID.get(faceID);
    if (!face) {
      throw new Error(`runtime font family "${familyKey}" has no loaded faces`);
    }
    return {
      bytes: face.bytes,
      faceIndex: Number(face.faceIndex ?? 0),
      italicFace: face.style === "italic",
      version: face.version,
      finalURL: face.finalURL,
      catalogID: faceID,
      resourceHandle: resources.get(faceID),
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
          node.fontFamily ?? fontFamilyKeyForCssValue(DEFAULT_FONT_FAMILY),
        );
      }
    }
    return [...keys];
  }

  const registry = Object.freeze({
    core,
    fontCatalogHandle,
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
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.unsubscribe?.();
      lifetime.unsubscribe = null;
      registrySources.get(registry).synchronize = null;
      listeners.clear();
      for (const resource of resources.values()) core.status("resource_release", resource);
      resources.clear();
      core.status("font_catalog_release", fontCatalogHandle);
      fontCatalogFinalizer.unregister(registry);
    },
    registerRuntimeFont,
    unregisterRuntimeFont,
    loadFont,
    runtimeFontFamily,
    fontFamilyCssValue,
    fontFamilyKeyForCssValue,
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
          registerRuntimeFont(specification.cssFamily, face.bytes, {
            weight: face.weight, style: face.style, finalURL: face.finalURL, owner: face,
          });
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

// The default module registry consults a host-installed resolver lazily on
// every unresolved family, so the host (a test harness, a shell, a page)
// can seed the process before or after this module evaluates — the same
// seeding pattern as sandom.hbBytes.
export const defaultFontRegistry = createFontRegistry({
  resolveSystemFontFamily: (name) => {
    const resolver = globalThis[Symbol.for("sandom.resolveSystemFontFamily")];
    return resolver ? resolver(name) : null;
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
export const fontFamilyKeyForCssValue = (...arguments_) =>
  defaultFontRegistry.fontFamilyKeyForCssValue(...arguments_);
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
