import { readBinaryFile } from "../host.js";
import { installComponentGlobals } from "./component-globals.js";
import { SDDocument } from "./node.js";

export class InvalidResourceResponseError extends TypeError {}

const textEncoder = new TextEncoder();

async function digest(bytes) {
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  return `sha256:${
    Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    )
  }`;
}

function normalizeStylesheets(stylesheets, documentURL) {
  if (!Array.isArray(stylesheets)) {
    throw new TypeError("stylesheets must be an array");
  }
  const sourcesByURL = new Map();
  return Object.freeze(stylesheets.map((stylesheet) => {
    if (
      !stylesheet || typeof stylesheet !== "object" ||
      Array.isArray(stylesheet)
    ) {
      throw new TypeError("Each stylesheet must be a { url, source } object");
    }
    const keys = Reflect.ownKeys(stylesheet);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.some((key) => !["url", "source"].includes(key)) ||
      !keys.includes("url") || !keys.includes("source")
    ) {
      throw new TypeError("Each stylesheet must contain only url and source");
    }
    if (typeof stylesheet.source !== "string") {
      throw new TypeError("stylesheet.source must be a string");
    }
    const url = new URL(stylesheet.url, documentURL).href;
    const previousSource = sourcesByURL.get(url);
    if (previousSource !== undefined && previousSource !== stylesheet.source) {
      throw new Error(`Conflicting generated stylesheet sources for ${url}`);
    }
    sourcesByURL.set(url, stylesheet.source);
    return Object.freeze({ url, source: stylesheet.source });
  }));
}

// Every MathML element's unsupported MathML, as recoverable warnings that
// name the element (plans/layout/PLAN-mathml-layout.md, Acceptance).
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
function mathmlDiagnostics(document) {
  const diagnostics = [];
  for (const element of document.querySelectorAll("*")) {
    if (element.namespaceURI !== MATHML_NAMESPACE) continue;
    for (const { code, message } of element._domCore.mathmlDiagnostics(element._coreHandle)) {
      diagnostics.push(Object.freeze({
        code,
        severity: "warning",
        recoverable: true,
        message,
        owner: Object.freeze({ element: `${element.localName}${element.id ? `#${element.id}` : ""}` }),
      }));
    }
  }
  return diagnostics;
}

export async function createPreparedDocument({
  url = "about:blank",
  resolveResource: callerResolveResource = null,
  windowTarget = {},
  reportException = null,
  core,
  fontRegistry,
} = {}) {
  const documentURL = new URL(url).href;
  if (
    callerResolveResource !== null &&
    typeof callerResolveResource !== "function"
  ) {
    throw new TypeError("resolveResource must be a function or null");
  }
  if (reportException !== null && typeof reportException !== "function") {
    throw new TypeError("reportException must be a function or null");
  }
  const resourcesByURL = new Map();
  const ownedResourceReleases = new Set();
  const generatedStylesheetSources = new Map();
  let cachedResourceRecords = null;
  let released = false;

  const resolveResource = async (
    {
      requestedURL,
      authoredURL = requestedURL,
      baseURL: resourceBaseURL,
      kind,
    },
  ) => {
    if (released) throw new Error("prepared document has been released");
    const baseURL = resourceBaseURL ?? document.baseURI;
    const requestedFinalURL = new URL(requestedURL, baseURL).href;
    let resource = resourcesByURL.get(requestedFinalURL);
    if (resource) return resource;

    const generatedSource = kind === "stylesheet"
      ? generatedStylesheetSources.get(requestedFinalURL)
      : undefined;
    const resolved = generatedSource !== undefined
      ? {
        bytes: textEncoder.encode(generatedSource),
        source: generatedSource,
        finalURL: requestedFinalURL,
        ownership: "caller",
      }
      : callerResolveResource
      ? await callerResolveResource({
        requestedURL: authoredURL,
        baseURL,
        finalURL: requestedFinalURL,
        kind,
      })
      : {
        bytes: await readBinaryFile(new URL(requestedFinalURL)),
        finalURL: requestedFinalURL,
      };
    if (!(resolved?.bytes instanceof Uint8Array)) {
      throw new InvalidResourceResponseError(
        "resolveResource must return Uint8Array bytes",
      );
    }
    if (
      resolved.ownership !== undefined &&
      !["caller", "prepared-input"].includes(resolved.ownership)
    ) {
      throw new TypeError(
        'resolveResource ownership must be "caller" or "prepared-input"',
      );
    }
    if (
      resolved.ownership === "prepared-input" &&
      typeof resolved.release !== "function"
    ) {
      throw new TypeError(
        "prepared-input resource ownership requires a release function",
      );
    }
    const resolvedFinalURL = new URL(
      resolved.finalURL ?? requestedFinalURL,
    ).href;
    resource = Object.freeze({
      bytes: resolved.bytes,
      source: resolved.source ?? (
        kind === "stylesheet"
          ? new TextDecoder().decode(resolved.bytes)
          : undefined
      ),
      requestedFinalURL,
      finalURL: resolvedFinalURL,
      cacheKey: resolvedFinalURL,
      contentType: resolved.contentType ?? null,
      byteLength: resolved.bytes.byteLength,
      digest: await digest(resolved.bytes),
      kind,
    });
    resourcesByURL.set(requestedFinalURL, resource);
    resourcesByURL.set(resolvedFinalURL, resource);
    cachedResourceRecords = null;
    if (resolved.ownership === "prepared-input") {
      ownedResourceReleases.add(resolved.release);
    }
    return resource;
  };

  const document = new SDDocument({
    core,
    fontRegistry,
    url: documentURL,
    resolveStylesheet: resolveResource,
    reportException,
  });
  // Surfaces created directly from this document use the same locator,
  // ownership and cache as stylesheets and prepared-input operations.
  document._resolveResource = resolveResource;
  const window = windowTarget === null
    ? null
    : installComponentGlobals(windowTarget, document);
  const resourceRecords = () => {
    if (cachedResourceRecords) return cachedResourceRecords;
    cachedResourceRecords = Object.freeze(
      [...new Set(resourcesByURL.values())].map((resource) =>
        Object.freeze({
          requestedFinalURL: resource.requestedFinalURL,
          finalURL: resource.finalURL,
          contentType: resource.contentType,
          byteLength: resource.byteLength,
          digest: resource.digest,
          kind: resource.kind,
        })
      ),
    );
    return cachedResourceRecords;
  };

  return Object.freeze({
    document,
    window,
    resolveResource,
    attachStylesheets(stylesheets) {
      if (released) throw new Error("prepared document has been released");
      if (!document.head) {
        throw new Error("Generated stylesheets require a document head");
      }
      const normalized = normalizeStylesheets(stylesheets, documentURL);
      for (const stylesheet of normalized) {
        generatedStylesheetSources.set(stylesheet.url, stylesheet.source);
        const link = document.createElement("link");
        link.setAttribute("rel", "stylesheet");
        link.setAttribute("href", stylesheet.url);
        document.head.appendChild(link);
      }
      return normalized;
    },
    async ready() {
      if (released) throw new Error("prepared document has been released");
      await document._readyForRendering();
    },
    get resources() {
      return resourceRecords();
    },
    get diagnostics() {
      return Object.freeze([
        ...document._styleSystem.resourceDiagnostics,
        ...document._brokenImageDiagnostics.values(),
        ...mathmlDiagnostics(document),
      ]);
    },
    async release() {
      if (released) return;
      released = true;
      const errors = [];
      try {
        document._styleSystem.releaseFonts();
      } catch (error) {
        errors.push(error);
      }
      for (const release of ownedResourceReleases) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      ownedResourceReleases.clear();
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `${errors.length} prepared-document resource release(s) failed`,
        );
      }
    },
  });
}
