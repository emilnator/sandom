import { resolveDenoExecutable } from "./deno-executable.js";
import { DOMParser } from "../dom/node.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import {
  createComponentAdapterResult,
  validateComponentAdapterResult,
  validateComponentAdapterAutofocusRecord,
} from "./component-adapter-result.js";
import {
  createComponentAdapterRealmDecoder,
  createComponentAdapterRealmRequest,
  deserializeComponentAdapterError,
  encodeComponentAdapterRealmMessage,
} from "./component-adapter-realm-protocol.js";

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

export const COMPILED_APPLICATION_ADAPTER_VERSION = "1";

const packageRoot = new URL("../../", import.meta.url);
const defaultRuntimeAssets = Object.freeze({
  harfbuzz: new URL("../../vendor/hb.wasm", import.meta.url),
  msdfgen: new URL("../../vendor/msdfgen.wasm", import.meta.url),
  codecs: Object.freeze({
    png: new URL("../../vendor/png-codec.wasm", import.meta.url),
    jpeg: new URL("../../vendor/jpeg.wasm", import.meta.url),
    webp: new URL("../../vendor/webp.wasm", import.meta.url),
    jpegXl: new URL("../../vendor/jpeg-xl.wasm", import.meta.url),
  }),
});
const allowedAdapterOptions = new Set([
  "documentURL",
  "createRealm",
  "fetch",
  "additionalResourceURLs",
  "dynamicScriptURLs",
  "selectScript",
  "selectRevision",
  "readiness",
  "capabilities",
  "runtimeAssets",
  "width",
  "height",
  "deviceScale",
  "graphicsBackend",
  "environment",
  "commandTimeoutMilliseconds",
  "denoExecutable",
  "adapter",
  "compiler",
  "observeInstalledRealm",
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

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
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

function closedIdentity(value, name, fallback) {
  const candidate = value ?? fallback;
  object(candidate, name);
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== "string" || !["name", "version"].includes(key)) {
      throw new TypeError(`${name} has unknown field ${String(key)}`);
    }
  }
  return Object.freeze({
    name: nonemptyString(candidate.name, `${name}.name`),
    version: nonemptyString(candidate.version, `${name}.version`),
  });
}

async function sha256(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function responseError(response, url) {
  return new Error(
    `Compiled application public resource ${url} returned ${response.status} ${response.statusText}`,
  );
}

function executableScriptRecord(script, documentURL, index) {
  const type = script.getAttribute("type")?.trim().toLowerCase() ?? "";
  const executable = !script.hasAttribute("nomodule") &&
    ["", "text/javascript", "application/javascript"].includes(type);
  const sourceAttribute = script.getAttribute("src");
  return Object.freeze({
    index,
    type,
    executable,
    skipReason: executable
      ? null
      : script.hasAttribute("nomodule")
      ? "nomodule"
      : `non-JavaScript type ${type}`,
    url: sourceAttribute ? new URL(sourceAttribute, documentURL).href : null,
    inlineSource: sourceAttribute ? null : script.textContent,
  });
}

function elementResourceURLs(document, documentURL) {
  const urls = [];
  for (const element of document.querySelectorAll(
    "link[href],img[src],source[src],video[poster]",
  )) {
    const attribute = element.hasAttribute("href")
      ? "href"
      : element.hasAttribute("src")
      ? "src"
      : "poster";
    urls.push(new URL(element.getAttribute(attribute), documentURL).href);
  }
  for (const element of document.querySelectorAll("img[srcset],source[srcset]")) {
    for (const candidate of element.getAttribute("srcset").split(",")) {
      const url = candidate.trim().split(/\s+/, 1)[0];
      if (url) urls.push(new URL(url, documentURL).href);
    }
  }
  for (const style of document.querySelectorAll("style")) {
    urls.push(...stylesheetResourceURLs(style.textContent, documentURL));
  }
  for (const element of document.querySelectorAll("[style]")) {
    urls.push(...stylesheetResourceURLs(element.getAttribute("style"), documentURL));
  }
  return urls;
}

// Each url() and @import URL of a stylesheet, found and decoded by the
// core's CSS tokenizer.
function stylesheetResourceURLs(source, stylesheetURL) {
  const urls = [];
  for (const { url: candidate } of sharedDomCore.cssURLs(source)) {
    if (!candidate || candidate.startsWith("data:") || candidate.startsWith("#")) {
      continue;
    }
    try {
      urls.push(new URL(candidate, stylesheetURL).href);
    } catch (error) {
      throw new TypeError(
        `Stylesheet ${stylesheetURL} contains an invalid resource URL ${JSON.stringify(candidate)}`,
        { cause: error },
      );
    }
  }
  return urls;
}

function resourceKind(url, contentType, scriptURLs) {
  if (scriptURLs.has(url)) return "script";
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (mediaType === "text/css" || new URL(url).pathname.endsWith(".css")) {
    return "stylesheet";
  }
  if (mediaType.startsWith("font/") || /\.(?:woff2?|ttf|otf)$/i.test(new URL(url).pathname)) {
    return "font";
  }
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/json") return "manifest";
  return "resource";
}

async function fetchPublicResource(fetchImplementation, requestedURL, scriptURLs) {
  const response = await fetchImplementation(requestedURL, {
    headers: { Accept: "*/*" },
    redirect: "follow",
  });
  if (!response.ok) throw responseError(response, requestedURL);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const finalURL = response.url || requestedURL;
  const contentType = response.headers.get("content-type");
  return Object.freeze({
    bytes,
    requestedFinalURL: requestedURL,
    finalURL,
    contentType,
    byteLength: bytes.byteLength,
    digest: await sha256(bytes),
    kind: resourceKind(finalURL, contentType, scriptURLs),
  });
}

export async function acquireCompiledApplicationDocument(candidate) {
  const options = object(candidate, "compiled application document acquisition options");
  const allowed = new Set([
    "documentURL",
    "fetch",
    "additionalResourceURLs",
    "dynamicScriptURLs",
    "selectScript",
    "selectRevision",
  ]);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`Unknown document acquisition option ${String(key)}`);
    }
  }
  const documentURL = new URL(options.documentURL).href;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("fetch must be a function");
  }
  const additionalResourceURLs = stringArray(
    options.additionalResourceURLs ?? [],
    "additionalResourceURLs",
  ).map((url) => new URL(url, documentURL).href);
  const dynamicScriptURLs = stringArray(
    options.dynamicScriptURLs ?? [],
    "dynamicScriptURLs",
  ).map((url) => new URL(url, documentURL).href);
  const selectScript = options.selectScript ?? (() => true);
  if (typeof selectScript !== "function") {
    throw new TypeError("selectScript must be a function");
  }
  if (options.selectRevision !== undefined && typeof options.selectRevision !== "function") {
    throw new TypeError("selectRevision must be a function");
  }

  const startedAt = performance.now();
  const response = await fetchImplementation(documentURL, {
    headers: { Accept: "text/html" },
    redirect: "follow",
    cache: "no-store",
  });
  if (!response.ok) throw responseError(response, documentURL);
  const finalDocumentURL = response.url || documentURL;
  const documentHTML = await response.text();
  const documentFetchMilliseconds = performance.now() - startedAt;
  const document = new DOMParser().parseFromString(documentHTML, "text/html");
  const baseScripts = [...document.querySelectorAll("script")].map(
    (script, index) => executableScriptRecord(script, finalDocumentURL, index),
  );
  const scripts = baseScripts.map((script) => {
    const selection = selectScript(script);
    if (typeof selection !== "boolean") {
      throw new TypeError(`selectScript must return a boolean for script ${script.index}`);
    }
    return Object.freeze({ ...script, selected: script.executable && selection });
  });
  const selectedScriptURLs = new Set(
    scripts.filter((script) => script.selected && script.url !== null).map((script) => script.url),
  );
  const allowedDynamicURLs = new Set([...selectedScriptURLs, ...dynamicScriptURLs]);
  const resourceURLs = new Set([
    ...elementResourceURLs(document, finalDocumentURL),
    ...selectedScriptURLs,
    ...additionalResourceURLs,
    ...dynamicScriptURLs,
  ]);
  const resourcesByIdentity = new Map();
  const uniqueResources = [];
  const pending = [...resourceURLs];
  const preloadStartedAt = performance.now();
  while (pending.length > 0) {
    const requestedURL = pending.shift();
    if (resourcesByIdentity.has(requestedURL)) continue;
    const resource = await fetchPublicResource(
      fetchImplementation,
      requestedURL,
      allowedDynamicURLs,
    );
    resourcesByIdentity.set(requestedURL, resource);
    resourcesByIdentity.set(resource.finalURL, resource);
    uniqueResources.push(resource);
    if (resource.kind === "stylesheet") {
      const source = new TextDecoder().decode(resource.bytes);
      for (const nestedURL of stylesheetResourceURLs(source, resource.finalURL)) {
        if (!resourcesByIdentity.has(nestedURL)) pending.push(nestedURL);
      }
    }
  }
  for (const script of scripts) {
    if (script.selected && script.url !== null && !resourcesByIdentity.has(script.url)) {
      throw new Error(`Selected public script ${script.url} is absent from the preload map`);
    }
  }
  for (const url of allowedDynamicURLs) {
    if (!resourcesByIdentity.has(url)) {
      throw new Error(`Allowlisted dynamic script ${url} is absent from the preload map`);
    }
  }
  const documentBytes = new TextEncoder().encode(documentHTML);
  const documentDigest = await sha256(documentBytes);
  const revisionIdentity = options.selectRevision === undefined
    ? documentDigest
    : await options.selectRevision(Object.freeze({
      document,
      documentHTML,
      documentURL: finalDocumentURL,
      documentDigest,
    }));
  nonemptyString(revisionIdentity, "selected revision identity");
  return Object.freeze({
    documentURL: finalDocumentURL,
    documentHTML,
    documentByteLength: documentBytes.byteLength,
    documentDigest,
    documentFetchMilliseconds,
    resourcePreloadMilliseconds: performance.now() - preloadStartedAt,
    revisionIdentity,
    scripts: Object.freeze(scripts),
    dynamicScriptURLs: Object.freeze([...allowedDynamicURLs]),
    resources: Object.freeze(uniqueResources),
  });
}

async function bytesFromAsset(value, name) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const url = value instanceof URL ? value : new URL(nonemptyString(value, name));
  if (url.protocol === "file:") {
    if (globalThis.Deno?.readFile) return await Deno.readFile(url);
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name} ${url.href} returned HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function prepareRuntimeAssets(runtimeAssets) {
  object(runtimeAssets, "runtimeAssets");
  for (const key of Reflect.ownKeys(runtimeAssets)) {
    if (
      typeof key !== "string" ||
      !["harfbuzz", "msdfgen", "codecs"].includes(key)
    ) {
      throw new TypeError(`Unknown runtimeAssets field ${String(key)}`);
    }
  }
  const codecs = runtimeAssets.codecs ?? {};
  object(codecs, "runtimeAssets.codecs");
  for (const key of Reflect.ownKeys(codecs)) {
    if (typeof key !== "string" || !["png", "jpeg", "webp", "jpegXl"].includes(key)) {
      throw new TypeError(`Unknown runtimeAssets.codecs field ${String(key)}`);
    }
  }
  const [harfbuzz, msdfgen, codecEntries] = await Promise.all([
    bytesFromAsset(runtimeAssets.harfbuzz, "runtimeAssets.harfbuzz"),
    bytesFromAsset(runtimeAssets.msdfgen, "runtimeAssets.msdfgen"),
    Promise.all(Object.entries(codecs).map(async ([name, value]) => [
      name,
      await bytesFromAsset(value, `runtimeAssets.codecs.${name}`),
    ])),
  ]);
  return Object.freeze({
    harfbuzz,
    msdfgen,
    codecs: new Map(codecEntries),
  });
}

function normalizeReadiness(candidate) {
  const readiness = object(candidate, "readiness");
  for (const key of Reflect.ownKeys(readiness)) {
    if (typeof key !== "string" || !["selector", "attribute", "timeoutMilliseconds"].includes(key)) {
      throw new TypeError(`Unknown readiness field ${String(key)}`);
    }
  }
  return Object.freeze({
    selector: nonemptyString(readiness.selector, "readiness.selector"),
    attribute: nonemptyString(readiness.attribute, "readiness.attribute"),
    timeoutMilliseconds: positiveNumber(
      readiness.timeoutMilliseconds ?? 10000,
      "readiness.timeoutMilliseconds",
    ),
  });
}

function normalizeCapabilities(candidate) {
  const capabilities = object(candidate ?? {}, "capabilities");
  for (const key of Reflect.ownKeys(capabilities)) {
    if (key !== "webSocket") {
      throw new TypeError(`Unknown compiled application capability ${String(key)}`);
    }
  }
  if (capabilities.webSocket !== undefined && typeof capabilities.webSocket !== "boolean") {
    throw new TypeError("capabilities.webSocket must be a boolean");
  }
  return Object.freeze({ webSocket: capabilities.webSocket ?? false });
}

function normalizeOptions(candidate) {
  const options = object(candidate, "compiled application adapter options");
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowedAdapterOptions.has(key)) {
      throw new TypeError(`Unknown compiled application adapter option ${String(key)}`);
    }
  }
  const createRealm = options.createRealm ?? createDenoCompiledApplicationRealm;
  if (typeof createRealm !== "function") throw new TypeError("createRealm must be a function");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") throw new TypeError("fetch must be a function");
  if (options.selectScript !== undefined && typeof options.selectScript !== "function") {
    throw new TypeError("selectScript must be a function");
  }
  if (options.selectRevision !== undefined && typeof options.selectRevision !== "function") {
    throw new TypeError("selectRevision must be a function");
  }
  if (
    options.observeInstalledRealm !== undefined &&
    typeof options.observeInstalledRealm !== "function"
  ) {
    throw new TypeError("observeInstalledRealm must be a function");
  }
  const environment = options.environment ?? {};
  object(environment, "environment");
  if (Object.values(environment).some((value) => typeof value === "function")) {
    throw new TypeError("Compiled application environment values must be structured-clone data");
  }
  if (
    options.graphicsBackend !== undefined &&
    !["auto", "webgpu", "webgl2"].includes(options.graphicsBackend)
  ) {
    throw new RangeError(`Unknown graphicsBackend ${JSON.stringify(options.graphicsBackend)}`);
  }
  return Object.freeze({
    documentURL: new URL(options.documentURL).href,
    createRealm,
    fetch: fetchImplementation,
    additionalResourceURLs: stringArray(
      options.additionalResourceURLs ?? [],
      "additionalResourceURLs",
    ),
    dynamicScriptURLs: stringArray(options.dynamicScriptURLs ?? [], "dynamicScriptURLs"),
    selectScript: options.selectScript,
    selectRevision: options.selectRevision,
    readiness: normalizeReadiness(options.readiness),
    capabilities: normalizeCapabilities(options.capabilities),
    runtimeAssets: options.runtimeAssets ?? defaultRuntimeAssets,
    width: positiveNumber(options.width ?? 960, "width"),
    height: positiveNumber(options.height ?? 576, "height"),
    deviceScale: positiveNumber(options.deviceScale ?? 1, "deviceScale"),
    graphicsBackend: options.graphicsBackend ?? "auto",
    environment,
    commandTimeoutMilliseconds: positiveNumber(
      options.commandTimeoutMilliseconds ?? 120000,
      "commandTimeoutMilliseconds",
    ),
    denoExecutable: nonemptyString(options.denoExecutable ?? "deno", "denoExecutable"),
    adapter: closedIdentity(options.adapter, "adapter", {
      name: "sandom/adapters/compiled-application",
      version: COMPILED_APPLICATION_ADAPTER_VERSION,
    }),
    compiler: closedIdentity(options.compiler, "compiler", {
      name: "public-document",
      version: "1",
    }),
    observeInstalledRealm: options.observeInstalledRealm ?? null,
  });
}

function normalizeInteraction(candidate) {
  if (candidate === undefined) return null;
  const interaction = object(candidate, "interaction");
  for (const key of Reflect.ownKeys(interaction)) {
    if (typeof key !== "string" || !["records", "target", "waitFor"].includes(key)) {
      throw new TypeError(`Unknown interaction field ${String(key)}`);
    }
  }
  if ((interaction.records === undefined) === (interaction.target === undefined)) {
    throw new TypeError("Supply exactly one of interaction.records or interaction.target");
  }
  let records = null;
  let target = null;
  if (interaction.records !== undefined) {
    if (!Array.isArray(interaction.records)) {
      throw new TypeError("interaction.records must be an input-record array");
    }
    records = interaction.records;
  } else {
    const candidateTarget = object(interaction.target, "interaction.target");
    for (const key of Reflect.ownKeys(candidateTarget)) {
      if (key !== "selector") {
        throw new TypeError(`Unknown interaction.target field ${String(key)}`);
      }
    }
    target = Object.freeze({
      selector: nonemptyString(candidateTarget.selector, "interaction.target.selector"),
    });
  }
  let waitFor = null;
  if (interaction.waitFor !== undefined) {
    const candidateWait = object(interaction.waitFor, "interaction.waitFor");
    for (const key of Reflect.ownKeys(candidateWait)) {
      if (typeof key !== "string" || !["selector", "event", "timeoutMilliseconds"].includes(key)) {
        throw new TypeError(`Unknown interaction.waitFor field ${String(key)}`);
      }
    }
    waitFor = Object.freeze({
      selector: nonemptyString(candidateWait.selector, "interaction.waitFor.selector"),
      event: nonemptyString(candidateWait.event, "interaction.waitFor.event"),
      timeoutMilliseconds: positiveNumber(
        candidateWait.timeoutMilliseconds ?? 5000,
        "interaction.waitFor.timeoutMilliseconds",
      ),
    });
  }
  return Object.freeze({ records, target, waitFor });
}

function normalizeRenderRequest(candidate) {
  const request = object(candidate ?? {}, "compiled application render request");
  for (const key of Reflect.ownKeys(request)) {
    if (typeof key !== "string" || !allowedRenderOptions.has(key)) {
      throw new TypeError(`Unknown compiled application render option ${String(key)}`);
    }
  }
  if (request.revision !== undefined) nonemptyString(request.revision, "revision");
  if (request.compilation !== undefined && typeof request.compilation !== "boolean") {
    throw new TypeError("compilation must be a boolean");
  }
  return Object.freeze({
    interaction: normalizeInteraction(request.interaction),
    revision: request.revision ?? null,
    invalidationPaths: stringArray(request.invalidationPaths ?? [], "invalidationPaths"),
    compilation: request.compilation ?? false,
  });
}

function reconstructFrame(value, binary) {
  const expectedBinaryNames = new Set(["pixels"]);
  for (const name of binary.keys()) {
    if (!expectedBinaryNames.delete(name)) {
      throw new TypeError(`The compiled-application realm returned unknown frame bytes ${name}`);
    }
  }
  if (expectedBinaryNames.size !== 0) {
    throw new TypeError(
      `The compiled-application realm omitted frame bytes ${[...expectedBinaryNames].join(", ")}`,
    );
  }
  const pixelBytes = binary.get("pixels");
  if (!(pixelBytes instanceof Uint8Array)) {
    throw new TypeError("The compiled-application realm returned a frame without pixel bytes");
  }
  const pixelConstructors = { Float32Array, Uint8Array, Uint8ClampedArray, Uint16Array };
  const PixelArray = pixelConstructors[value.pixelsType];
  if (typeof PixelArray !== "function") {
    throw new TypeError(
      `The compiled-application realm returned unsupported pixel type ${JSON.stringify(value.pixelsType)}`,
    );
  }
  const pixels = PixelArray === Uint8Array
    ? pixelBytes
    : new PixelArray(pixelBytes.slice().buffer);
  const {
    pixelsPresent,
    pixelsType,
    durationMilliseconds,
    ...fields
  } = value;
  if (pixelsPresent !== true) {
    throw new TypeError("The compiled-application realm returned malformed frame metadata");
  }
  return {
    frame: Object.freeze({ ...fields, pixels }),
    durationMilliseconds,
  };
}

function validateRealm(realm) {
  object(realm, "isolated realm");
  for (const name of ["command", "closeInputAndWait", "terminate"]) {
    if (typeof realm[name] !== "function") {
      throw new TypeError(`isolated realm.${name} must be a function`);
    }
  }
  return realm;
}

function assertExactExit(exit, context) {
  object(exit, `${context} exit`);
  if (exit.standardError !== "" || exit.code !== 0 || exit.signal !== null) {
    throw new Error(
      `${context} exited with code ${exit.code}, signal ${exit.signal}, stderr ${JSON.stringify(exit.standardError)}`,
    );
  }
  return exit;
}

export async function createDenoCompiledApplicationRealm(candidate = {}) {
  const options = object(candidate, "Deno compiled-application realm options");
  const allowed = new Set([
    "documentURL",
    "commandTimeoutMilliseconds",
    "denoExecutable",
  ]);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`Unknown Deno realm option ${String(key)}`);
    }
  }
  const documentURL = new URL(options.documentURL).href;
  const commandTimeoutMilliseconds = positiveNumber(
    options.commandTimeoutMilliseconds ?? 120000,
    "commandTimeoutMilliseconds",
  );
  const denoExecutable = await resolveDenoExecutable(
    options.denoExecutable ?? "deno",
  );
  const { fileURLToPath } = await import("node:url");
  const runnerURL = new URL("./compiled-application-deno-runner.js", import.meta.url);
  const networkURL = new URL(documentURL);
  const networkAuthority = networkURL.port
    ? `${networkURL.hostname}:${networkURL.port}`
    : networkURL.hostname;
  const commandArguments = [
    "run",
    "--unstable-webgpu",
    `--allow-read=${fileURLToPath(packageRoot)}`,
    `--allow-net=${networkAuthority}`,
    fileURLToPath(runnerURL),
  ];
  let processTransport;
  if (typeof globalThis.Deno?.Command === "function") {
    const child = new Deno.Command(denoExecutable, {
      args: commandArguments,
      cwd: fileURLToPath(packageRoot),
      clearEnv: true,
      env: {},
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const input = child.stdin.getWriter();
    processTransport = Object.freeze({
      stdout: child.stdout,
      stderr: child.stderr,
      status: child.status.then(({ code, signal }) => ({ code, signal })),
      write(bytes) {
        return input.write(bytes);
      },
      closeInput() {
        return input.close();
      },
      terminate() {
        child.kill("SIGTERM");
      },
    });
  } else {
    const { spawn } = await import("node:child_process");
    const child = spawn(denoExecutable, commandArguments, {
      cwd: fileURLToPath(packageRoot),
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    processTransport = Object.freeze({
      stdout: child.stdout,
      stderr: child.stderr,
      status: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      write(bytes) {
        return new Promise((resolve, reject) => {
          child.stdin.write(bytes, (error) => error ? reject(error) : resolve());
        });
      },
      closeInput() {
        child.stdin.end();
        return Promise.resolve();
      },
      terminate() {
        child.kill("SIGTERM");
      },
    });
  }
  let nextRequestIdentifier = 1;
  const pending = new Map();
  let standardError = "";
  let failed = null;
  let closed = false;
  let inputClosed = false;
  let resolveExit;
  let rejectExit;
  const exit = new Promise((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  const fail = (error) => {
    if (failed !== null) return;
    failed = error instanceof Error ? error : new Error(String(error));
    rejectPending(failed);
    rejectExit(failed);
  };
  const send = async (message, binary = new Map()) => {
    if (failed) throw failed;
    for (const chunk of encodeComponentAdapterRealmMessage(message, binary)) {
      await processTransport.write(chunk);
    }
  };
  const decoder = createComponentAdapterRealmDecoder((message, binary) => {
    const request = pending.get(message.requestIdentifier);
    if (!request) {
      throw new Error(
        `The compiled-application realm returned unknown request ${message.requestIdentifier}`,
      );
    }
    pending.delete(message.requestIdentifier);
    clearTimeout(request.timeout);
    if (message.operation !== request.operation) {
      request.reject(new Error(
        `The compiled-application realm returned ${message.operation} for ${request.operation}`,
      ));
    } else if (message.type === "error") {
      request.reject(deserializeComponentAdapterError(message.error));
    } else if (message.type !== "result") {
      request.reject(new Error(
        `Unexpected compiled-application realm response type ${message.type}`,
      ));
    } else {
      request.resolve({ value: message.value, binary });
    }
  });
  const standardErrorDecoder = new TextDecoder();
  const standardOutputFinished = (async () => {
    for await (const chunk of processTransport.stdout) decoder.push(chunk);
  })().catch(fail);
  const standardErrorFinished = (async () => {
    for await (const chunk of processTransport.stderr) {
      standardError += standardErrorDecoder.decode(chunk, { stream: true });
    }
    standardError += standardErrorDecoder.decode();
  })().catch(fail);
  processTransport.status.then(async ({ code, signal }) => {
    closed = true;
    await Promise.all([standardOutputFinished, standardErrorFinished]);
    if (failed !== null) return;
    try {
      decoder.finish();
    } catch (error) {
      fail(error);
      return;
    }
    if (pending.size > 0) {
      const operations = [...pending.values()].map((request) => request.operation);
      rejectPending(new Error(
        `The compiled-application realm exited before completing ${
          operations.join(", ")
        }; code ${code}, signal ${signal}, stderr ${standardError}`,
      ));
    }
    resolveExit({ code, signal, standardError });
  }).catch(fail);

  return Object.freeze({
    command(operation, value = null, binary = new Map()) {
      if (closed || inputClosed) {
        return Promise.reject(new Error("The compiled-application realm is closed"));
      }
      const requestIdentifier = nextRequestIdentifier++;
      const request = createComponentAdapterRealmRequest(requestIdentifier, operation, value);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestIdentifier);
          reject(new Error(
            `The compiled-application realm did not complete ${operation} in ${commandTimeoutMilliseconds} milliseconds`,
          ));
        }, commandTimeoutMilliseconds);
        pending.set(requestIdentifier, { operation, resolve, reject, timeout });
        send(request, binary).catch((error) => {
          clearTimeout(timeout);
          pending.delete(requestIdentifier);
          reject(error);
        });
      });
    },
    async waitForExit() {
      return await exit;
    },
    async closeInputAndWait() {
      if (!inputClosed) {
        inputClosed = true;
        await processTransport.closeInput();
      }
      return await exit;
    },
    async terminate() {
      if (!closed) processTransport.terminate();
      return await exit;
    },
  });
}

export async function createCompiledApplicationAdapter(candidate) {
  const options = normalizeOptions(candidate);
  const preparedRuntimeAssets = await prepareRuntimeAssets(
    options.runtimeAssets,
  );
  let disposed = false;
  let rendering = false;
  let previousRevision = null;

  return Object.freeze({
    async render(candidateRequest = {}) {
      if (disposed) throw new Error("The compiled application adapter is disposed");
      if (rendering) {
        throw new Error("The compiled application adapter already has an active render");
      }
      const request = normalizeRenderRequest(candidateRequest);
      rendering = true;
      let realm = null;
      let runnerClosed = false;
      let realmCloseRequested = false;
      let realmExited = false;
      const cleanupErrors = [];
      try {
        const preload = await acquireCompiledApplicationDocument({
          documentURL: options.documentURL,
          fetch: options.fetch,
          additionalResourceURLs: options.additionalResourceURLs,
          dynamicScriptURLs: options.dynamicScriptURLs,
          ...(options.selectScript ? { selectScript: options.selectScript } : {}),
          ...(options.selectRevision ? { selectRevision: options.selectRevision } : {}),
        });
        if (request.revision !== null && request.revision !== preload.revisionIdentity) {
          throw new Error(
            `Compiled application selected stale revision ${JSON.stringify(preload.revisionIdentity)}; expected ${JSON.stringify(request.revision)}`,
          );
        }
        if (
          request.compilation && previousRevision !== null &&
          previousRevision.identity === preload.revisionIdentity
        ) {
          throw new Error(
            `Compilation completed, but the selected revision remained ${JSON.stringify(preload.revisionIdentity)}`,
          );
        }
        const realmStartedAt = performance.now();
        realm = validateRealm(await options.createRealm({
          documentURL: preload.documentURL,
          commandTimeoutMilliseconds: options.commandTimeoutMilliseconds,
          denoExecutable: options.denoExecutable,
        }));
        const assetBinary = new Map([
          ["harfbuzz", preparedRuntimeAssets.harfbuzz],
          ["msdfgen", preparedRuntimeAssets.msdfgen],
          ...[...preparedRuntimeAssets.codecs].map(([name, bytes]) => [
            `codec:${name}`,
            bytes,
          ]),
        ]);
        const initialization = await realm.command("initialize-assets", {
          codecs: [...preparedRuntimeAssets.codecs.keys()],
        }, assetBinary);
        if (initialization.value.initialized !== true) {
          throw new Error("The compiled-application realm did not initialize runtime assets");
        }
        const processStartupMilliseconds = performance.now() - realmStartedAt;
        const resourceBinary = new Map(preload.resources.map((resource, index) => [
          `resource:${index}`,
          resource.bytes,
        ]));
        const creation = await realm.command("create-session", {
          width: options.width,
          height: options.height,
          deviceScale: options.deviceScale,
          documentURL: preload.documentURL,
          documentHTML: preload.documentHTML,
          graphicsBackend: options.graphicsBackend,
          environment: options.environment,
          capabilities: options.capabilities,
          readiness: {
            ...options.readiness,
            value: preload.revisionIdentity,
          },
          scripts: preload.scripts,
          dynamicScriptURLs: preload.dynamicScriptURLs,
          resources: preload.resources.map(({ bytes, ...resource }) => resource),
        }, resourceBinary);
        if (creation.value.applicationReadyValue !== preload.revisionIdentity) {
          throw new Error(
            `Application readiness ${JSON.stringify(creation.value.applicationReadyValue)} does not equal ${JSON.stringify(preload.revisionIdentity)}`,
          );
        }
        if (!Object.hasOwn(creation.value, "autofocus")) {
          throw new TypeError("Compiled realm omitted autofocus evidence");
        }
        const autofocus = validateComponentAdapterAutofocusRecord(
          creation.value.autofocus,
        );
        if (options.observeInstalledRealm !== null) {
          await options.observeInstalledRealm(Object.freeze({
            documentURL: preload.documentURL,
            revision: preload.revisionIdentity,
          }));
        }
        const initialResponse = await realm.command("render");
        const initial = reconstructFrame(initialResponse.value, initialResponse.binary);
        let interaction = null;
        if (request.interaction !== null) {
          const interactionResponse = await realm.command("dispatch", request.interaction);
          interaction = reconstructFrame(interactionResponse.value, interactionResponse.binary);
        }
        const inspected = await realm.command("inspect");
        const exitStartedAt = performance.now();
        const closeResponse = await realm.command("close-realm");
        realmCloseRequested = closeResponse.value.realmCloseRequested === true;
        runnerClosed = closeResponse.value.moduleRunnerClosed === true;
        if (!realmCloseRequested || !runnerClosed) {
          throw new Error("The compiled-application realm did not accept terminal close");
        }
        const disposalResponse = closeResponse.value.finalEvidence;
        if (!disposalResponse) {
          throw new Error("The compiled-application realm omitted terminal disposal evidence");
        }
        const exit = typeof realm.waitForExit === "function"
          ? await realm.waitForExit()
          : await realm.closeInputAndWait();
        realmExited = true;
        assertExactExit(exit, "Compiled-application realm");
        const exitMilliseconds = performance.now() - exitStartedAt;
        const disposal = {
          ...disposalResponse.disposal,
          moduleRunnerClosed: runnerClosed,
          asyncOwnership: disposalResponse.evidence?.asyncDisposal ?? null,
        };
        if (
          disposal.sessionDisposed !== true ||
          disposal.componentUnmounted !== true ||
          disposal.globalsRestoredExactly !== false ||
          disposal.realmDestroyedWithoutGlobalRestoration !== true
        ) {
          throw new Error(
            `Incomplete compiled-application terminal disposal ${JSON.stringify(disposal)}`,
          );
        }
        const selectedSources = [];
        for (const script of preload.scripts) {
          if (!script.selected) continue;
          if (script.url === null) {
            selectedSources.push(new TextEncoder().encode(script.inlineSource));
          } else {
            const resource = preload.resources.find((candidate) =>
              candidate.requestedFinalURL === script.url || candidate.finalURL === script.url
            );
            if (!resource) throw new Error(`Selected script ${script.url} lost its preloaded bytes`);
            selectedSources.push(resource.bytes);
          }
        }
        const selectedSourceLength = selectedSources.reduce(
          (total, bytes) => total + bytes.byteLength,
          0,
        );
        const selectedSourceBytes = new Uint8Array(selectedSourceLength);
        let selectedSourceOffset = 0;
        for (const bytes of selectedSources) {
          selectedSourceBytes.set(bytes, selectedSourceOffset);
          selectedSourceOffset += bytes.byteLength;
        }
        const styleResources = preload.resources.filter((resource) =>
          resource.kind === "stylesheet"
        );
        const stylesheetBytes = new Uint8Array(
          styleResources.reduce((total, resource) => total + resource.bytes.byteLength, 0),
        );
        let stylesheetOffset = 0;
        for (const resource of styleResources) {
          stylesheetBytes.set(resource.bytes, stylesheetOffset);
          stylesheetOffset += resource.bytes.byteLength;
        }
        const entry = preload.scripts.find((script) => script.selected)?.url ??
          `${preload.documentURL}#inline-script`;
        const result = createComponentAdapterResult({
          adapter: options.adapter,
          compiler: options.compiler,
          revision: {
            identity: preload.revisionIdentity,
            module: preload.documentURL,
            moduleDigest: preload.documentDigest,
            entry,
            entryDigest: await sha256(selectedSourceBytes),
            stylesheetDigest: await sha256(stylesheetBytes),
            documentByteLength: preload.documentByteLength,
            scripts: preload.scripts.map(({ inlineSource, ...script }) => ({
              ...script,
              inlineByteLength: inlineSource === null
                ? null
                : new TextEncoder().encode(inlineSource).byteLength,
            })),
            dynamicScriptURLs: preload.dynamicScriptURLs,
            applicationReadyValue: creation.value.applicationReadyValue,
            executedScriptCount: creation.value.executedScriptCount,
            scriptEvaluations: creation.value.scriptEvaluations,
            ordinaryScriptInsertionInert: creation.value.ordinaryScriptInsertionInert,
            styleElementCount: creation.value.styleElementCount,
            styleRuleCount: creation.value.styleRuleCount,
            asyncOwnershipAtReadiness:
              creation.value.asyncOwnershipAtReadiness ?? null,
            autofocus,
            runtimeAssets: {
              harfbuzzByteLength: preparedRuntimeAssets.harfbuzz.byteLength,
              msdfgenByteLength: preparedRuntimeAssets.msdfgen.byteLength,
              codecByteLengths: Object.fromEntries(
                [...preparedRuntimeAssets.codecs].map(([name, bytes]) => [
                  name,
                  bytes.byteLength,
                ]),
              ),
            },
          },
          invalidation: {
            paths: request.invalidationPaths,
            previousRevision: previousRevision?.identity ?? null,
          },
          compilerTimings: {
            documentFetchMilliseconds: preload.documentFetchMilliseconds,
            resourcePreloadMilliseconds: preload.resourcePreloadMilliseconds,
          },
          realmTimings: {
            processStartupMilliseconds,
            runtimeCreationMilliseconds: creation.value.runtimeDurationMilliseconds,
            sessionCreationMilliseconds: creation.value.sessionDurationMilliseconds,
            initialRenderMilliseconds: initial.durationMilliseconds,
            interactionMilliseconds: interaction?.durationMilliseconds ?? null,
            inspectionMilliseconds: inspected.value.durationMilliseconds,
            disposalMilliseconds: disposal.durationMilliseconds,
            exitMilliseconds,
          },
          styles: styleResources.map((resource) => ({
            requestedFinalURL: resource.requestedFinalURL,
            finalURL: resource.finalURL,
            contentType: "text/css",
            byteLength: resource.byteLength,
            digest: resource.digest,
            source: new TextDecoder().decode(resource.bytes),
          })),
          resources: preload.resources.map(({ bytes, ...resource }) => resource),
          initialFrame: initial.frame,
          interactionFrame: interaction?.frame ?? null,
          inspection: inspected.value.inspection,
          diagnostics: disposalResponse.diagnostics,
          lifecycle: disposalResponse.lifecycle,
          disposal,
          realmExit: {
            code: exit.code,
            signal: exit.signal,
            standardError: exit.standardError,
            exact: true,
          },
        });
        validateComponentAdapterResult(result);
        previousRevision = result.revision;
        return result;
      } catch (error) {
        if (realm !== null && !realmExited) {
          if (!realmCloseRequested) {
            try {
              const response = await realm.command("close-realm");
              realmCloseRequested = response.value.realmCloseRequested === true;
              runnerClosed = response.value.moduleRunnerClosed === true;
              if (!realmCloseRequested || !runnerClosed) {
                throw new Error("Realm cleanup did not accept terminal close");
              }
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
          }
          try {
            if (realmCloseRequested) {
              const cleanupExit = typeof realm.waitForExit === "function"
                ? await realm.waitForExit()
                : await realm.closeInputAndWait();
              realmExited = true;
              assertExactExit(cleanupExit, "Compiled-application realm cleanup");
            } else {
              const cleanupExit = await realm.terminate();
              if (cleanupExit.standardError !== "") {
                throw new Error(
                  `Terminated compiled-application realm wrote to standard error: ${cleanupExit.standardError}`,
                );
              }
            }
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Compiled application render and realm cleanup failed",
          );
        }
        throw error;
      } finally {
        rendering = false;
      }
    },
    async dispose() {
      if (disposed) return;
      if (rendering) {
        throw new Error("Cannot dispose the compiled application adapter during a render");
      }
      disposed = true;
    },
  });
}
