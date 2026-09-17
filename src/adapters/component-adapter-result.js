export const COMPONENT_ADAPTER_RESULT_KIND = "sandom/component-adapter-result";
export const COMPONENT_ADAPTER_RESULT_VERSION = 1;

const topLevelFields = new Set([
  "kind",
  "version",
  "adapter",
  "compiler",
  "revision",
  "invalidation",
  "compilerTimings",
  "realmTimings",
  "styles",
  "resources",
  "initialFrame",
  "interactionFrame",
  "inspection",
  "diagnostics",
  "lifecycle",
  "disposal",
  "realmExit",
]);

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function string(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
  return value;
}

function finite(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative finite number`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value;
}

export function validateComponentAdapterAutofocusRecord(candidate) {
  if (candidate === null) return null;
  const value = object(candidate, "autofocus");
  for (const key of Reflect.ownKeys(value)) {
    if (!["localName", "id", "name"].includes(key)) {
      throw new TypeError(`autofocus contains unknown field ${String(key)}`);
    }
  }
  string(value.localName, "autofocus.localName");
  if (typeof value.id !== "string") {
    throw new TypeError("autofocus.id must be a string");
  }
  if (value.name !== null && typeof value.name !== "string") {
    throw new TypeError("autofocus.name must be a string or null");
  }
  return value;
}

function frame(value, name) {
  object(value, name);
  if (!ArrayBuffer.isView(value.pixels) || value.pixels instanceof DataView) {
    throw new TypeError(`${name}.pixels must be a typed array`);
  }
  if (value.png !== null && !(value.png instanceof Uint8Array)) {
    throw new TypeError(`${name}.png must be a Uint8Array or null`);
  }
  finite(value.width, `${name}.width`);
  finite(value.height, `${name}.height`);
  finite(value.deviceScale, `${name}.deviceScale`);
  if (!Number.isSafeInteger(value.frameSequence) || value.frameSequence < 1) {
    throw new TypeError(`${name}.frameSequence must be a positive safe integer`);
  }
  if (!Array.isArray(value.dirtyRectangles)) {
    throw new TypeError(`${name}.dirtyRectangles must be an array`);
  }
}

function timingRecord(value, name) {
  object(value, name);
  for (const [field, duration] of Object.entries(value)) {
    if (duration !== null) finite(duration, `${name}.${field}`);
  }
}

function inspection(value) {
  object(value, "inspection");
  for (const field of ["sceneNodes", "layoutBoxes", "elements"]) {
    if (!Array.isArray(value[field])) {
      throw new TypeError(`inspection.${field} must be an array`);
    }
  }
  object(value.paintArtifact, "inspection.paintArtifact");
}

function resource(value, index) {
  object(value, `resources[${index}]`);
  string(value.requestedFinalURL, `resources[${index}].requestedFinalURL`);
  string(value.finalURL, `resources[${index}].finalURL`);
  if (value.contentType !== null && typeof value.contentType !== "string") {
    throw new TypeError(`resources[${index}].contentType must be a string or null`);
  }
  finite(value.byteLength, `resources[${index}].byteLength`);
  digest(value.digest, `resources[${index}].digest`);
  string(value.kind, `resources[${index}].kind`);
}

function freezeRecord(value, seen = new Set()) {
  if (
    value === null || typeof value !== "object" || ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer || seen.has(value)
  ) return value;
  seen.add(value);
  for (const nested of Object.values(value)) freezeRecord(nested, seen);
  return Object.freeze(value);
}

export function validateComponentAdapterResult(candidate) {
  const result = object(candidate, "component adapter result");
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== "string" || !topLevelFields.has(key)) {
      throw new TypeError(`Unknown component adapter result field ${String(key)}`);
    }
  }
  for (const field of topLevelFields) {
    if (!Object.hasOwn(result, field)) {
      throw new TypeError(`Component adapter result is missing ${field}`);
    }
  }
  if (result.kind !== COMPONENT_ADAPTER_RESULT_KIND) {
    throw new TypeError(
      `Unsupported component adapter result kind ${JSON.stringify(result.kind)}`,
    );
  }
  if (result.version !== COMPONENT_ADAPTER_RESULT_VERSION) {
    throw new TypeError(
      `Unsupported component adapter result version ${JSON.stringify(result.version)}`,
    );
  }

  object(result.adapter, "adapter");
  string(result.adapter.name, "adapter.name");
  string(result.adapter.version, "adapter.version");
  object(result.compiler, "compiler");
  string(result.compiler.name, "compiler.name");
  string(result.compiler.version, "compiler.version");

  object(result.revision, "revision");
  string(result.revision.module, "revision.module");
  digest(result.revision.moduleDigest, "revision.moduleDigest");
  string(result.revision.identity, "revision.identity");
  string(result.revision.entry, "revision.entry");
  digest(result.revision.entryDigest, "revision.entryDigest");
  digest(result.revision.stylesheetDigest, "revision.stylesheetDigest");
  if (Object.hasOwn(result.revision, "autofocus")) {
    validateComponentAdapterAutofocusRecord(result.revision.autofocus);
  }

  object(result.invalidation, "invalidation");
  stringArray(result.invalidation.paths, "invalidation.paths");
  if (
    result.invalidation.previousRevision !== null &&
    typeof result.invalidation.previousRevision !== "string"
  ) {
    throw new TypeError("invalidation.previousRevision must be a string or null");
  }

  timingRecord(result.compilerTimings, "compilerTimings");
  timingRecord(result.realmTimings, "realmTimings");

  if (!Array.isArray(result.styles)) {
    throw new TypeError("styles must be an array");
  }
  for (const [index, style] of result.styles.entries()) {
    object(style, `styles[${index}]`);
    string(style.requestedFinalURL, `styles[${index}].requestedFinalURL`);
    string(style.finalURL, `styles[${index}].finalURL`);
    if (style.contentType !== "text/css") {
      throw new TypeError(`styles[${index}].contentType must be text/css`);
    }
    finite(style.byteLength, `styles[${index}].byteLength`);
    digest(style.digest, `styles[${index}].digest`);
    string(style.source, `styles[${index}].source`);
  }

  if (!Array.isArray(result.resources)) {
    throw new TypeError("resources must be an array");
  }
  result.resources.forEach(resource);
  frame(result.initialFrame, "initialFrame");
  if (result.interactionFrame !== null) {
    frame(result.interactionFrame, "interactionFrame");
  }
  inspection(result.inspection);
  if (!Array.isArray(result.diagnostics)) {
    throw new TypeError("diagnostics must be an array");
  }
  if (!Array.isArray(result.lifecycle)) {
    throw new TypeError("lifecycle must be an array");
  }
  object(result.disposal, "disposal");
  const globalsRestored = result.disposal.globalsRestoredExactly === true &&
    result.disposal.realmDestroyedWithoutGlobalRestoration !== true;
  const realmDestroyed = result.disposal.globalsRestoredExactly === false &&
    result.disposal.realmDestroyedWithoutGlobalRestoration === true;
  if (
    result.disposal.sessionDisposed !== true ||
    result.disposal.componentUnmounted !== true ||
    result.disposal.moduleRunnerClosed !== true ||
    (!globalsRestored && !realmDestroyed)
  ) {
    throw new TypeError(
      "disposal must record complete session cleanup and either global restoration or terminal realm destruction",
    );
  }
  object(result.realmExit, "realmExit");
  if (result.realmExit.code !== 0) {
    throw new TypeError("realmExit.code must be zero");
  }
  if (result.realmExit.signal !== null) {
    throw new TypeError("realmExit.signal must be null");
  }
  if (result.realmExit.standardError !== "") {
    throw new TypeError("realmExit.standardError must be empty");
  }
  if (result.realmExit.exact !== true) {
    throw new TypeError("realmExit.exact must be true");
  }

  return freezeRecord(result);
}

export function createComponentAdapterResult(fields) {
  return validateComponentAdapterResult({
    kind: COMPONENT_ADAPTER_RESULT_KIND,
    version: COMPONENT_ADAPTER_RESULT_VERSION,
    ...fields,
  });
}
