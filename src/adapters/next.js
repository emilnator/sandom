import {
  COMPILED_APPLICATION_ADAPTER_VERSION,
  createCompiledApplicationAdapter,
  createComponentAdapterResult,
} from "./compiled-application.js";

export {
  COMPONENT_ADAPTER_RESULT_KIND,
  COMPONENT_ADAPTER_RESULT_VERSION,
  createComponentAdapterResult,
  validateComponentAdapterResult,
} from "./component-adapter-result.js";
export {
  COMPONENT_ADAPTER_REALM_OPERATIONS,
  COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
  COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
} from "./component-adapter-realm-protocol.js";
export {
  COMPILED_APPLICATION_ADAPTER_VERSION,
  acquireCompiledApplicationDocument,
  createCompiledApplicationAdapter,
  createDenoCompiledApplicationRealm,
} from "./compiled-application.js";

export const NEXT_COMPONENT_ADAPTER_VERSION = "1";
export const NEXT_COMPONENT_ADAPTER_PEER_RANGE = ">=16.3.1 <17";

const allowedOptions = new Set([
  "documentURL",
  "serverEnvironmentURL",
  "createRealm",
  "fetch",
  "additionalResourceURLs",
  "dynamicScriptURLs",
  "readinessAttribute",
  "revisionAttribute",
  "revisionSelector",
  "runtimeAssets",
  "width",
  "height",
  "deviceScale",
  "graphicsBackend",
  "environment",
  "commandTimeoutMilliseconds",
  "denoExecutable",
]);
const allowedRenderOptions = new Set([
  "interaction",
  "revision",
  "invalidationPaths",
  "compilation",
]);

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function nonemptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
  return value;
}

function attributeName(value, name) {
  nonemptyString(value, name);
  if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(value)) {
    throw new TypeError(`${name} must be an HTML attribute name`);
  }
  return value;
}

function stringArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  for (const [index, item] of value.entries()) {
    nonemptyString(item, `${name}[${index}]`);
  }
  return Object.freeze([...value]);
}

export function validateNextPeerVersion(version) {
  nonemptyString(version, "Next version");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new TypeError(`Malformed Next version ${JSON.stringify(version)}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const supported = major === 16 && (minor > 3 || (minor === 3 && patch >= 1));
  if (!supported) {
    throw new RangeError(
      `Next ${version} does not satisfy optional peer range ${NEXT_COMPONENT_ADAPTER_PEER_RANGE}`,
    );
  }
  return version;
}

async function installedNextVersion() {
  let nextPackage;
  try {
    nextPackage = await import("next/package.json", { with: { type: "json" } });
  } catch (error) {
    throw new Error(
      `The optional Next peer ${NEXT_COMPONENT_ADAPTER_PEER_RANGE} is required by sandom/adapters/next`,
      { cause: error },
    );
  }
  return validateNextPeerVersion(nextPackage.default?.version ?? nextPackage.version);
}

export function validateNextServerEnvironmentSnapshot(candidate) {
  const snapshot = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
  object(snapshot, "Next server environment snapshot");
  for (const key of Reflect.ownKeys(snapshot)) {
    if (
      typeof key !== "string" ||
      !["records", "sandomGlobalsPresent", "processIdentifier"].includes(key)
    ) {
      throw new TypeError(`Unknown Next server environment field ${String(key)}`);
    }
  }
  if (!Array.isArray(snapshot.records)) {
    throw new TypeError("Next server environment records must be an array");
  }
  if (
    !Array.isArray(snapshot.sandomGlobalsPresent) ||
    snapshot.sandomGlobalsPresent.some((name) => typeof name !== "string")
  ) {
    throw new TypeError("Next server Sandom globals must be an array of strings");
  }
  if (
    !(typeof snapshot.processIdentifier === "string" && snapshot.processIdentifier.length > 0) &&
    !Number.isSafeInteger(snapshot.processIdentifier)
  ) {
    throw new TypeError("Next server processIdentifier must be a string or safe integer");
  }
  return Object.freeze({
    records: Object.freeze(snapshot.records.map((record, index) => {
      object(record, `Next server environment records[${index}]`);
      return Object.freeze({ ...record });
    })),
    sandomGlobalsPresent: Object.freeze([...snapshot.sandomGlobalsPresent]),
    processIdentifier: snapshot.processIdentifier,
  });
}
export function assertNextServerEnvironmentUnchanged(
  expectedCandidate,
  observedCandidate,
  phase = "observation",
) {
  const expected = validateNextServerEnvironmentSnapshot(expectedCandidate);
  const observed = validateNextServerEnvironmentSnapshot(observedCandidate);
  if (expected.sandomGlobalsPresent.length !== 0) {
    throw new Error(
      `Next server realm contains Sandom globals before ${phase}: ${expected.sandomGlobalsPresent.join(", ")}`,
    );
  }
  if (observed.sandomGlobalsPresent.length !== 0) {
    throw new Error(
      `Next server realm contains Sandom globals during ${phase}: ${observed.sandomGlobalsPresent.join(", ")}`,
    );
  }
  if (observed.processIdentifier !== expected.processIdentifier) {
    throw new Error(
      `Next development server process changed from ${expected.processIdentifier} to ${observed.processIdentifier} during ${phase}`,
    );
  }
  if (JSON.stringify(observed.records) !== JSON.stringify(expected.records)) {
    throw new Error(`Next server global descriptors changed during ${phase}`);
  }
  return true;
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeOptions(candidate) {
  const options = object(candidate, "Next component adapter options");
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowedOptions.has(key)) {
      throw new TypeError(`Unknown Next component adapter option ${String(key)}`);
    }
  }
  const documentURL = new URL(options.documentURL).href;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") throw new TypeError("fetch must be a function");
  return Object.freeze({
    ...options,
    documentURL,
    serverEnvironmentURL: new URL(
      options.serverEnvironmentURL ?? "/api/server-environment",
      documentURL,
    ).href,
    fetch: fetchImplementation,
    additionalResourceURLs: stringArray(
      options.additionalResourceURLs ?? [],
      "additionalResourceURLs",
    ),
    dynamicScriptURLs: stringArray(options.dynamicScriptURLs ?? [], "dynamicScriptURLs"),
    readinessAttribute: attributeName(
      options.readinessAttribute ?? "data-next-application-ready",
      "readinessAttribute",
    ),
    revisionAttribute: attributeName(
      options.revisionAttribute ?? "data-component-revision",
      "revisionAttribute",
    ),
    revisionSelector: nonemptyString(
      options.revisionSelector ?? "[data-component-revision]",
      "revisionSelector",
    ),
  });
}

function normalizeRenderRequest(candidate) {
  const request = object(candidate ?? {}, "Next adapter render request");
  for (const key of Reflect.ownKeys(request)) {
    if (typeof key !== "string" || !allowedRenderOptions.has(key)) {
      throw new TypeError(`Unknown Next adapter render option ${String(key)}`);
    }
  }
  if (request.revision !== undefined) nonemptyString(request.revision, "revision");
  if (request.compilation !== undefined && typeof request.compilation !== "boolean") {
    throw new TypeError("compilation must be a boolean");
  }
  const invalidationPaths = stringArray(
    request.invalidationPaths ?? [],
    "invalidationPaths",
  );
  return Object.freeze({
    interaction: request.interaction,
    revision: request.revision ?? null,
    invalidationPaths,
    compilation: request.compilation ?? invalidationPaths.length > 0,
  });
}
export function isNextPublicDocumentScript(script, documentURL) {
  object(script, "Next public script record");
  if (script.executable !== true) return false;
  if (script.url === null) return true;
  const scriptURL = new URL(script.url);
  const pageURL = new URL(documentURL);
  return scriptURL.origin === pageURL.origin &&
    scriptURL.pathname.startsWith("/_next/");
}
export function validateNextPublicBootstrap(document) {
  object(document, "Next public document");
  const elements = [...document.querySelectorAll("script#__NEXT_DATA__")];
  if (elements.length !== 1) {
    throw new Error(
      `Next public document must contain exactly one __NEXT_DATA__ script; found ${elements.length}`,
    );
  }
  const element = elements[0];
  if (element.getAttribute("type")?.trim().toLowerCase() !== "application/json") {
    throw new Error("Next __NEXT_DATA__ script must use application/json");
  }
  let value;
  try {
    value = JSON.parse(element.textContent);
  } catch (error) {
    throw new Error("Next __NEXT_DATA__ script contains invalid JSON", { cause: error });
  }
  object(value, "Next __NEXT_DATA__ value");
  return Object.freeze({
    page: nonemptyString(value.page, "Next __NEXT_DATA__.page"),
    buildId: nonemptyString(value.buildId, "Next __NEXT_DATA__.buildId"),
    notFoundSrcPage: value.notFoundSrcPage === undefined
      ? null
      : nonemptyString(
        value.notFoundSrcPage,
        "Next __NEXT_DATA__.notFoundSrcPage",
      ),
  });
}


export function selectNextDocumentRevision(
  document,
  revisionSelector = "[data-component-revision]",
  revisionAttribute = "data-component-revision",
) {
  object(document, "Next public document");
  nonemptyString(revisionSelector, "revisionSelector");
  attributeName(revisionAttribute, "revisionAttribute");
  const values = new Set(
    [...document.querySelectorAll(revisionSelector)].map((element) =>
      element.getAttribute(revisionAttribute)
    ).filter((value) => typeof value === "string" && value.length > 0),
  );
  if (values.size !== 1) {
    throw new Error(
      `Next public document must select exactly one ${revisionAttribute} revision; found ${values.size}`,
    );
  }
  return [...values][0];
}


export async function createNextComponentAdapter(candidate) {
  const options = normalizeOptions(candidate);
  const nextVersion = await installedNextVersion();
  let acceptanceEnvironment = null;
  let environmentBeforeRealm = null;
  let environmentDuringRealm = null;
  let selectedPublicBootstrap = null;
  let rendering = false;
  let disposed = false;

  const readServerEnvironment = async () => {
    const response = await options.fetch(options.serverEnvironmentURL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        `Next server environment endpoint returned ${response.status} ${response.statusText}`,
      );
    }
    const snapshot = validateNextServerEnvironmentSnapshot(await response.text());
    if (snapshot.sandomGlobalsPresent.length !== 0) {
      throw new Error(
        `Next server realm contains Sandom globals: ${snapshot.sandomGlobalsPresent.join(", ")}`,
      );
    }
    return Object.freeze({
      value: snapshot,
      canonical: JSON.stringify(snapshot),
    });
  };

  const assertAcceptanceEnvironment = (observation, phase) => {
    if (acceptanceEnvironment === null) {
      acceptanceEnvironment = observation;
      return;
    }
    assertNextServerEnvironmentUnchanged(
      acceptanceEnvironment.value,
      observation.value,
      phase,
    );
  };

  const compiledAdapter = await createCompiledApplicationAdapter({
    documentURL: options.documentURL,
    ...(options.createRealm ? { createRealm: options.createRealm } : {}),
    fetch: options.fetch,
    additionalResourceURLs: [
      new URL(
        "/_next/static/development/_devMiddlewareManifest.json",
        options.documentURL,
      ).href,
      ...options.additionalResourceURLs,
    ],
    dynamicScriptURLs: options.dynamicScriptURLs,
    selectScript(script) {
      return isNextPublicDocumentScript(script, options.documentURL);
    },
    selectRevision({ document }) {
      selectedPublicBootstrap = validateNextPublicBootstrap(document);
      return selectNextDocumentRevision(
        document,
        options.revisionSelector,
        options.revisionAttribute,
      );
    },
    readiness: {
      selector: "html",
      attribute: options.readinessAttribute,
      timeoutMilliseconds: options.commandTimeoutMilliseconds === undefined
        ? 10000
        : Math.min(options.commandTimeoutMilliseconds, 10000),
    },
    capabilities: { webSocket: true },
    ...(options.runtimeAssets !== undefined ? { runtimeAssets: options.runtimeAssets } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.deviceScale !== undefined ? { deviceScale: options.deviceScale } : {}),
    ...(options.graphicsBackend !== undefined
      ? { graphicsBackend: options.graphicsBackend }
      : {}),
    environment: {
      language: "en",
      languages: ["en"],
      online: true,
      hardwareConcurrency: 1,
      maximumTouchPoints: 0,
      ...(options.environment ?? {}),
    },
    ...(options.commandTimeoutMilliseconds !== undefined
      ? { commandTimeoutMilliseconds: options.commandTimeoutMilliseconds }
      : {}),
    ...(options.denoExecutable !== undefined
      ? { denoExecutable: options.denoExecutable }
      : {}),
    adapter: {
      name: "sandom/adapters/next",
      version: NEXT_COMPONENT_ADAPTER_VERSION,
    },
    compiler: { name: "next", version: nextVersion },
    async observeInstalledRealm() {
      environmentDuringRealm = await readServerEnvironment();
      assertAcceptanceEnvironment(environmentDuringRealm, "realm installation");
      if (environmentDuringRealm.canonical !== environmentBeforeRealm.canonical) {
        throw new Error(
          "Next server global descriptors changed while the compiled-application realm was installed",
        );
      }
    },
  });

  return Object.freeze({
    async render(candidateRequest = {}) {
      if (disposed) throw new Error("The Next component adapter is disposed");
      if (rendering) throw new Error("The Next component adapter already has an active render");
      const request = normalizeRenderRequest(candidateRequest);
      rendering = true;
      try {
        environmentBeforeRealm = await readServerEnvironment();
        assertAcceptanceEnvironment(environmentBeforeRealm, "pre-render observation");
        environmentDuringRealm = null;
        selectedPublicBootstrap = null;
        const result = await compiledAdapter.render({
          ...(request.interaction === undefined ? {} : { interaction: request.interaction }),
          ...(request.revision === null ? {} : { revision: request.revision }),
          invalidationPaths: request.invalidationPaths,
          compilation: request.compilation,
        });
        if (environmentDuringRealm === null) {
          throw new Error("Next adapter did not observe the server while the realm was installed");
        }
        if (selectedPublicBootstrap === null) {
          throw new Error("Next adapter did not validate the public bootstrap state");
        }
        const environmentAfterRealm = await readServerEnvironment();
        assertAcceptanceEnvironment(environmentAfterRealm, "post-render observation");
        if (environmentAfterRealm.canonical !== environmentBeforeRealm.canonical) {
          throw new Error(
            "Next server global descriptors changed after the compiled-application realm exited",
          );
        }
        return createComponentAdapterResult({
          ...result,
          revision: {
            ...result.revision,
            compiledApplicationAdapterVersion: COMPILED_APPLICATION_ADAPTER_VERSION,
            publicBootstrap: selectedPublicBootstrap,
            serverProcessIdentifier: environmentBeforeRealm.value.processIdentifier,
            serverDescriptorRecordCount: environmentBeforeRealm.value.records.length,
            serverDescriptorDigest: await sha256Text(environmentBeforeRealm.canonical),
            serverGlobalsUnchanged: true,
            serverSandomGlobalsPresent: environmentBeforeRealm.value.sandomGlobalsPresent,
          },
        });
      } finally {
        rendering = false;
      }
    },
    async dispose() {
      if (disposed) return;
      if (rendering) throw new Error("Cannot dispose the Next component adapter during a render");
      disposed = true;
      await compiledAdapter.dispose();
    },
  });
}
