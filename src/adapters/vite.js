import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createComponentAdapterResult,
  validateComponentAdapterResult,
} from "./component-adapter-result.js";
import {
  COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
  COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
  createComponentAdapterRealmDecoder,
  createComponentAdapterRealmRequest,
  deserializeComponentAdapterError,
  encodeComponentAdapterRealmMessage,
  serializeComponentAdapterError,
} from "./component-adapter-realm-protocol.js";
import { resolveDenoExecutable } from "./deno-executable.js";

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

export const VITE_COMPONENT_ADAPTER_VERSION = "1";
export const VITE_COMPONENT_ADAPTER_PEER_RANGE = ">=8.2.0 <9";

const adapterDirectory = new URL("./", import.meta.url);
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
  "server",
  "vite",
  "environmentName",
  "entry",
  "stylesheet",
  "revision",
  "resources",
  "runtimeAssets",
  "width",
  "height",
  "deviceScale",
  "documentURL",
  "graphicsBackend",
  "environment",
  "denoExecutable",
  "commandTimeoutMilliseconds",
]);
const allowedRenderOptions = new Set(["interaction", "revision"]);

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

export function validateViteTerminalResponse(candidate) {
  const value = object(candidate, "Vite terminal response");
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !["realmCloseRequested", "moduleRunnerClosed", "finalEvidence"].includes(key)
    ) {
      throw new TypeError(`Vite terminal response has unknown field ${String(key)}`);
    }
  }
  if (
    value.realmCloseRequested !== true || value.moduleRunnerClosed !== true
  ) {
    throw new TypeError(
      "Vite terminal response must close the realm and Module Runner",
    );
  }
  const evidence = object(value.finalEvidence, "Vite terminal evidence");
  for (const key of Reflect.ownKeys(evidence)) {
    if (!["resources", "diagnostics", "lifecycle", "disposal"].includes(key)) {
      throw new TypeError(`Vite terminal evidence has unknown field ${String(key)}`);
    }
  }
  if (
    !Array.isArray(evidence.resources) ||
    !Array.isArray(evidence.diagnostics) ||
    !Array.isArray(evidence.lifecycle)
  ) {
    throw new TypeError(
      "Vite terminal evidence must contain resource, diagnostic, and lifecycle arrays",
    );
  }
  const disposal = object(evidence.disposal, "Vite terminal disposal");
  if (
    disposal.sessionDisposed !== true ||
    disposal.componentUnmounted !== true ||
    disposal.globalsRestoredExactly !== false ||
    disposal.realmDestroyedWithoutGlobalRestoration !== true
  ) {
    throw new TypeError(
      "Vite terminal disposal must destroy a cleaned component realm without global restoration",
    );
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeModuleExport(value, name) {
  object(value, name);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !["module", "export"].includes(key)) {
      throw new TypeError(`${name} has unknown field ${String(key)}`);
    }
  }
  return Object.freeze({
    module: nonemptyString(value.module, `${name}.module`),
    export: nonemptyString(value.export, `${name}.export`),
  });
}

function normalizeResource(value, index) {
  object(value, `resources[${index}]`);
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !["module", "export", "kind", "contentType"].includes(key)
    ) {
      throw new TypeError(`resources[${index}] has unknown field ${String(key)}`);
    }
  }
  return Object.freeze({
    module: nonemptyString(value.module, `resources[${index}].module`),
    export: nonemptyString(value.export, `resources[${index}].export`),
    kind: nonemptyString(value.kind, `resources[${index}].kind`),
    contentType: value.contentType === undefined
      ? null
      : nonemptyString(value.contentType, `resources[${index}].contentType`),
  });
}

function normalizeOptions(candidate) {
  const options = object(candidate, "Vite component adapter options");
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowedAdapterOptions.has(key)) {
      throw new TypeError(`Unknown Vite component adapter option ${String(key)}`);
    }
  }
  if ((options.server === undefined) === (options.vite === undefined)) {
    throw new TypeError("Supply exactly one of server or vite creation options");
  }
  if (options.server !== undefined) object(options.server, "server");
  if (options.vite !== undefined) object(options.vite, "vite creation options");
  const stylesheet = nonemptyString(options.stylesheet, "stylesheet");
  const stylesheetURL = new URL(stylesheet, "https://sandom.invalid/");
  if (!stylesheetURL.searchParams.has("inline")) {
    throw new TypeError("Vite stylesheet must use the documented ?inline query");
  }
  const resources = options.resources ?? [];
  if (!Array.isArray(resources)) throw new TypeError("resources must be an array");
  const environment = options.environment ?? {};
  object(environment, "environment");
  if (
    Object.values(environment).some((value) => typeof value === "function")
  ) {
    throw new TypeError("Vite realm environment values must be structured-clone data");
  }
  if (
    options.graphicsBackend !== undefined &&
    !["auto", "webgpu", "webgl2"].includes(options.graphicsBackend)
  ) {
    throw new RangeError(
      `Unknown graphicsBackend ${JSON.stringify(options.graphicsBackend)}`,
    );
  }
  return Object.freeze({
    server: options.server ?? null,
    vite: options.vite ?? null,
    environmentName: nonemptyString(
      options.environmentName ?? "sandom",
      "environmentName",
    ),
    entry: nonemptyString(options.entry, "entry"),
    stylesheet,
    revision: normalizeModuleExport(options.revision, "revision"),
    resources: Object.freeze(resources.map(normalizeResource)),
    runtimeAssets: options.runtimeAssets ?? defaultRuntimeAssets,
    width: positiveNumber(options.width ?? 560, "width"),
    height: positiveNumber(options.height ?? 364, "height"),
    deviceScale: positiveNumber(options.deviceScale ?? 1, "deviceScale"),
    documentURL: options.documentURL === undefined
      ? null
      : new URL(options.documentURL).href,
    graphicsBackend: options.graphicsBackend ?? "auto",
    environment,
    denoExecutable: nonemptyString(options.denoExecutable ?? "deno", "denoExecutable"),
    commandTimeoutMilliseconds: positiveNumber(
      options.commandTimeoutMilliseconds ?? 120000,
      "commandTimeoutMilliseconds",
    ),
  });
}

export function validateVitePeerVersion(version) {
  nonemptyString(version, "Vite version");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new TypeError(`Malformed Vite version ${JSON.stringify(version)}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const supported = major === 8 && (minor > 2 || (minor === 2 && patch >= 0));
  if (!supported) {
    throw new RangeError(
      `Vite ${version} does not satisfy optional peer range ${VITE_COMPONENT_ADAPTER_PEER_RANGE}`,
    );
  }
  return version;
}

async function bytesFromAsset(value, name) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const url = value instanceof URL ? value : new URL(nonemptyString(value, name));
  if (url.protocol === "file:") return new Uint8Array(await readFile(url));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${name} ${url.href} returned HTTP ${response.status}`);
  }
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
    if (
      typeof key !== "string" || !["png", "jpeg", "webp", "jpegXl"].includes(key)
    ) {
      throw new TypeError(`Unknown runtimeAssets.codecs field ${String(key)}`);
    }
  }
  const [harfbuzz, msdfgen, codecEntries] = await Promise.all([
    bytesFromAsset(runtimeAssets.harfbuzz, "runtimeAssets.harfbuzz"),
    bytesFromAsset(runtimeAssets.msdfgen, "runtimeAssets.msdfgen"),
    Promise.all(
      Object.entries(codecs).map(async ([name, value]) => [
        name,
        await bytesFromAsset(value, `runtimeAssets.codecs.${name}`),
      ]),
    ),
  ]);
  return Object.freeze({
    harfbuzz,
    msdfgen,
    codecs: new Map(codecEntries),
  });
}

function inferredDocumentURL(server) {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error(
      "Vite did not expose a development address; supply documentURL for a caller server",
    );
  }
  return `http://127.0.0.1:${address.port}/`;
}

function relativeInvalidationPath(root, filePath) {
  const relative = path.relative(root, path.resolve(filePath));
  return relative.startsWith("..") ? path.resolve(filePath) : relative.split(path.sep).join("/");
}

function reconstructFrame(value, binary) {
  const expectedBinaryNames = new Set([
    "pixels",
    ...(value.pngPresent ? ["png"] : []),
  ]);
  for (const name of binary.keys()) {
    if (!expectedBinaryNames.delete(name)) {
      throw new TypeError(`The Vite realm returned unknown frame bytes ${name}`);
    }
  }
  if (expectedBinaryNames.size !== 0) {
    throw new TypeError(
      `The Vite realm omitted frame bytes ${[...expectedBinaryNames].join(", ")}`,
    );
  }
  const pixelBytes = binary.get("pixels");
  if (!(pixelBytes instanceof Uint8Array)) {
    throw new TypeError("The Vite realm returned a frame without pixel bytes");
  }
  const pixelConstructors = {
    Float32Array,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
  };
  const PixelArray = pixelConstructors[value.pixelsType];
  if (typeof PixelArray !== "function") {
    throw new TypeError(
      `The Vite realm returned unsupported pixel type ${JSON.stringify(value.pixelsType)}`,
    );
  }
  const pixels = PixelArray === Uint8Array
    ? pixelBytes
    : new PixelArray(pixelBytes.slice().buffer);
  const png = value.pngPresent ? binary.get("png") : null;
  if (value.pngPresent && !(png instanceof Uint8Array)) {
    throw new TypeError("The Vite realm returned a frame without declared PNG bytes");
  }
  const {
    pixelsPresent,
    pixelsType,
    pngPresent,
    durationMilliseconds,
    ...fields
  } = value;
  if (pixelsPresent !== true) {
    throw new TypeError("The Vite realm returned malformed frame metadata");
  }
  return {
    frame: Object.freeze({ ...fields, pixels, png }),
    durationMilliseconds,
  };
}

function createDenoRealm({
  environment,
  root,
  denoExecutable,
  commandTimeoutMilliseconds,
}) {
  const runnerURL = new URL("./vite-deno-runner.js", adapterDirectory);
  const readableRoots = [
    path.resolve(root),
    fileURLToPath(packageRoot),
  ].join(",");
  const child = spawn(denoExecutable, [
    "run",
    "--unstable-webgpu",
    "--allow-env=NODE_ENV",
    `--allow-read=${readableRoots}`,
    fileURLToPath(runnerURL),
  ], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextRequestIdentifier = 1;
  const pending = new Map();
  let standardError = "";
  let failed = null;
  let closed = false;
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
      await new Promise((resolve, reject) => {
        child.stdin.write(chunk, (error) => error ? reject(error) : resolve());
      });
    }
  };

  const decoder = createComponentAdapterRealmDecoder((message, binary) => {
    if (message.type === "vite-invoke") {
      environment.hot.handleInvoke(message.payload).then(
        (response) => send({
          kind: COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
          version: COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
          type: "vite-invoke-result",
          invocationIdentifier: message.invocationIdentifier,
          response,
        }),
        (error) => send({
          kind: COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
          version: COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
          type: "vite-invoke-result",
          invocationIdentifier: message.invocationIdentifier,
          response: { error: serializeComponentAdapterError(error) },
        }),
      ).catch(fail);
      return;
    }
    const request = pending.get(message.requestIdentifier);
    if (!request) {
      throw new Error(
        `The Vite realm returned unknown request ${message.requestIdentifier}`,
      );
    }
    pending.delete(message.requestIdentifier);
    clearTimeout(request.timeout);
    if (message.operation !== request.operation) {
      request.reject(new Error(
        `The Vite realm returned ${message.operation} for ${request.operation}`,
      ));
    } else if (message.type === "error") {
      request.reject(deserializeComponentAdapterError(message.error));
    } else if (message.type !== "result") {
      request.reject(new Error(
        `Unexpected Vite realm response type ${message.type}`,
      ));
    } else {
      request.resolve({ value: message.value, binary });
    }
  });

  child.stdout.on("data", (chunk) => {
    try {
      decoder.push(chunk);
    } catch (error) {
      fail(error);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => standardError += chunk);
  child.on("error", fail);
  child.on("close", (code, signal) => {
    closed = true;
    try {
      decoder.finish();
    } catch (error) {
      fail(error);
      return;
    }
    if (pending.size > 0) {
      const operations = [...pending.values()].map((request) => request.operation);
      rejectPending(new Error(
        `The Vite realm exited before completing ${operations.join(", ")}; ` +
          `code ${code}, signal ${signal}, stderr ${standardError}`,
      ));
    }
    resolveExit({ code, signal, standardError });
  });

  return Object.freeze({
    command(operation, value = null, binary = new Map()) {
      if (closed) return Promise.reject(new Error("The Vite realm is closed"));
      const requestIdentifier = nextRequestIdentifier++;
      const request = createComponentAdapterRealmRequest(
        requestIdentifier,
        operation,
        value,
      );
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestIdentifier);
          reject(new Error(
            `The Vite realm did not complete ${operation} in ${commandTimeoutMilliseconds} milliseconds`,
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
    async closeInputAndWait() {
      child.stdin.end();
      return await exit;
    },
    async terminate() {
      if (!closed) child.kill("SIGTERM");
      return await exit;
    },
  });
}

async function fetchPreparedResources(documentURL, identities) {
  return await Promise.all(identities.map(async (identity) => {
    const requestedFinalURL = new URL(identity.requestedURL, documentURL).href;
    const response = await fetch(requestedFinalURL);
    if (!response.ok) {
      throw new Error(
        `Vite resource ${requestedFinalURL} returned HTTP ${response.status}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const finalURL = response.url || requestedFinalURL;
    const contentType = identity.contentType ??
      response.headers.get("content-type")?.split(";", 1)[0] ?? null;
    return Object.freeze({
      bytes,
      requestedFinalURL,
      finalURL,
      contentType,
      byteLength: bytes.byteLength,
      digest: sha256(bytes),
      kind: identity.kind,
    });
  }));
}

function stylesheetResourceURL(stylesheet, documentURL) {
  const url = new URL(stylesheet, documentURL);
  url.searchParams.delete("inline");
  if ([...url.searchParams].length === 0) url.search = "";
  return url.href;
}

function normalizeRenderRequest(candidate) {
  const request = candidate ?? {};
  object(request, "Vite adapter render request");
  for (const key of Reflect.ownKeys(request)) {
    if (typeof key !== "string" || !allowedRenderOptions.has(key)) {
      throw new TypeError(`Unknown Vite adapter render option ${String(key)}`);
    }
  }
  let interaction = null;
  if (request.interaction !== undefined) {
    object(request.interaction, "interaction");
    for (const key of Reflect.ownKeys(request.interaction)) {
      if (typeof key !== "string" || !["records", "waitFor"].includes(key)) {
        throw new TypeError(`Unknown interaction field ${String(key)}`);
      }
    }
    if (!Array.isArray(request.interaction.records)) {
      throw new TypeError("interaction.records must be an input-record array");
    }
    let waitFor = null;
    if (request.interaction.waitFor !== undefined) {
      const candidateWait = object(request.interaction.waitFor, "interaction.waitFor");
      for (const key of Reflect.ownKeys(candidateWait)) {
        if (
          typeof key !== "string" ||
          !["selector", "event", "timeoutMilliseconds"].includes(key)
        ) {
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
    interaction = Object.freeze({
      records: request.interaction.records,
      waitFor,
    });
  }
  if (request.revision !== undefined) {
    nonemptyString(request.revision, "revision");
  }
  return Object.freeze({
    interaction,
    revision: request.revision ?? null,
  });
}

export async function createViteComponentAdapter(candidate) {
  const options = normalizeOptions(candidate);
  const viteModule = await import("vite");
  const viteVersion = validateVitePeerVersion(viteModule.version);
  const denoExecutable = await resolveDenoExecutable(options.denoExecutable);
  if (typeof viteModule.DevEnvironment !== "function") {
    throw new Error("Installed Vite does not expose the documented DevEnvironment interface");
  }
  let server = options.server;
  let ownsServer = false;
  let serverStartupMilliseconds = null;
  if (server === null) {
    const startupStartedAt = performance.now();
    const configuredEnvironment = options.vite.environments?.[options.environmentName] ?? {};
    server = await viteModule.createServer({
      ...options.vite,
      environments: {
        ...(options.vite.environments ?? {}),
        [options.environmentName]: {
          ...configuredEnvironment,
          consumer: "server",
          dev: {
            ...(configuredEnvironment.dev ?? {}),
            createEnvironment(name, config, context) {
              return new viteModule.DevEnvironment(name, config, context);
            },
          },
        },
      },
    });
    ownsServer = true;
    try {
      await server.listen();
    } catch (error) {
      try {
        await server.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Vite server startup and cleanup failed",
        );
      }
      throw error;
    }
    serverStartupMilliseconds = performance.now() - startupStartedAt;
  }
  const environment = server.environments?.[options.environmentName];
  if (
    !environment || typeof environment.hot?.handleInvoke !== "function" ||
    typeof environment.transformRequest !== "function"
  ) {
    if (ownsServer) await server.close();
    throw new Error(
      `Vite server has no documented DevEnvironment named ${JSON.stringify(options.environmentName)}`,
    );
  }
  let documentURL;
  let root;
  let preparedRuntimeAssets;
  try {
    documentURL = options.documentURL ?? inferredDocumentURL(server);
    root = path.resolve(server.config.root);
    preparedRuntimeAssets = await prepareRuntimeAssets(
      options.runtimeAssets,
    );
  } catch (error) {
    if (ownsServer) {
      try {
        await server.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Vite adapter creation and server cleanup failed",
        );
      }
    }
    throw error;
  }
  const invalidatedPaths = new Set();
  const observeInvalidation = (filePath) => {
    invalidatedPaths.add(relativeInvalidationPath(root, filePath));
  };
  server.watcher.on("change", observeInvalidation);
  server.watcher.on("add", observeInvalidation);
  server.watcher.on("unlink", observeInvalidation);
  let disposed = false;
  let rendering = false;
  let previousRevision = null;

  return Object.freeze({
    async render(candidateRequest = {}) {
      if (disposed) throw new Error("The Vite component adapter is disposed");
      if (rendering) throw new Error("The Vite component adapter already has an active render");
      const request = normalizeRenderRequest(candidateRequest);
      rendering = true;
      const selectedInvalidations = Object.freeze([...invalidatedPaths].sort());
      let entryTransform;
      let revisionTransform;
      let entryTransformMilliseconds;
      let revisionTransformMilliseconds;
      try {
        [entryTransform, revisionTransform] = await Promise.all([
          (async () => {
            const startedAt = performance.now();
            const value = await environment.transformRequest(options.entry);
            entryTransformMilliseconds = performance.now() - startedAt;
            return value;
          })(),
          (async () => {
            const startedAt = performance.now();
            const value = await environment.transformRequest(
              options.revision.module,
            );
            revisionTransformMilliseconds = performance.now() - startedAt;
            return value;
          })(),
        ]);
      } catch (error) {
        rendering = false;
        throw error;
      }
      if (!entryTransform || typeof entryTransform.code !== "string") {
        rendering = false;
        throw new Error(`Vite returned no transform for ${JSON.stringify(options.entry)}`);
      }
      if (!revisionTransform || typeof revisionTransform.code !== "string") {
        rendering = false;
        throw new Error(
          `Vite returned no transform for ${JSON.stringify(options.revision.module)}`,
        );
      }
      const entryDigest = sha256(new TextEncoder().encode(entryTransform.code));
      const revisionModuleDigest = sha256(
        new TextEncoder().encode(revisionTransform.code),
      );
      const realmStartedAt = performance.now();
      let realm;
      try {
        realm = createDenoRealm({
          environment,
          root,
          denoExecutable,
          commandTimeoutMilliseconds: options.commandTimeoutMilliseconds,
        });
      } catch (error) {
        rendering = false;
        throw error;
      }
      const cleanupErrors = [];
      let moduleRunnerClosed = false;
      let realmDestroyed = false;
      try {
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
          throw new Error("The Vite realm did not initialize runtime assets");
        }
        const processStartupMilliseconds = performance.now() - realmStartedAt;
        const preparation = await realm.command("import-prepared-input", {
          entry: options.entry,
          stylesheet: options.stylesheet,
          revision: options.revision,
          resources: options.resources,
        });
        const revisionIdentity = preparation.value.revisionIdentity;
        if (request.revision !== null && request.revision !== revisionIdentity) {
          throw new Error(
            `Vite selected stale revision ${JSON.stringify(revisionIdentity)}; expected ${JSON.stringify(request.revision)}`,
          );
        }
        const stylesheetText = preparation.value.stylesheetText;
        if (typeof stylesheetText !== "string") {
          throw new TypeError("Vite returned non-text processed CSS");
        }
        const stylesheetBytes = new TextEncoder().encode(stylesheetText);
        const stylesheetDigest = sha256(stylesheetBytes);
        if (
          selectedInvalidations.length > 0 && previousRevision !== null &&
          previousRevision.identity === revisionIdentity &&
          previousRevision.moduleDigest === revisionModuleDigest &&
          previousRevision.entryDigest === entryDigest &&
          previousRevision.stylesheetDigest === stylesheetDigest
        ) {
          throw new Error(
            `Vite invalidated ${selectedInvalidations.join(", ")} but selected a stale revision`,
          );
        }
        const preloadedResources = await fetchPreparedResources(
          documentURL,
          preparation.value.resourceIdentities,
        );
        const resourceBinary = new Map(preloadedResources.map((resource, index) => [
          `resource:${index}`,
          resource.bytes,
        ]));
        const creation = await realm.command("create-session", {
          width: options.width,
          height: options.height,
          deviceScale: options.deviceScale,
          documentURL,
          graphicsBackend: options.graphicsBackend,
          environment: options.environment,
          entry: options.entry,
          stylesheetURL: stylesheetResourceURL(options.stylesheet, documentURL),
          resources: preloadedResources.map(({ bytes, ...resource }) => resource),
        }, resourceBinary);
        const initialResponse = await realm.command("render");
        const initial = reconstructFrame(
          initialResponse.value,
          initialResponse.binary,
        );
        let interaction = null;
        if (request.interaction !== null) {
          const response = await realm.command("dispatch", request.interaction);
          interaction = reconstructFrame(response.value, response.binary);
        }
        const inspected = await realm.command("inspect");
        const terminalResponse = await realm.command("close-realm");
        const terminalValue = validateViteTerminalResponse(
          terminalResponse.value,
        );
        moduleRunnerClosed = terminalValue.moduleRunnerClosed;
        const terminalEvidence = terminalValue.finalEvidence;
        const exitStartedAt = performance.now();
        const exit = await realm.closeInputAndWait();
        const exitMilliseconds = performance.now() - exitStartedAt;
        realmDestroyed = true;
        if (exit.standardError !== "") {
          throw new Error(`The Vite Deno realm wrote to standard error: ${exit.standardError}`);
        }
        if (exit.code !== 0 || exit.signal !== null) {
          throw new Error(
            `The Vite Deno realm exited with code ${exit.code} and signal ${exit.signal}`,
          );
        }
        const disposal = {
          ...terminalEvidence.disposal,
          moduleRunnerClosed,
        };
        if (
          disposal.sessionDisposed !== true ||
          disposal.componentUnmounted !== true ||
          disposal.moduleRunnerClosed !== true ||
          (
            disposal.globalsRestoredExactly !== true &&
            disposal.realmDestroyedWithoutGlobalRestoration !== true
          )
        ) {
          throw new Error(`Incomplete Vite realm disposal ${JSON.stringify(disposal)}`);
        }
        const styleURL = stylesheetResourceURL(options.stylesheet, documentURL);
        const result = createComponentAdapterResult({
          adapter: {
            name: "sandom/adapters/vite",
            version: VITE_COMPONENT_ADAPTER_VERSION,
          },
          compiler: { name: "vite", version: viteVersion },
          revision: {
            identity: revisionIdentity,
            module: options.revision.module,
            moduleDigest: revisionModuleDigest,
            entry: options.entry,
            entryDigest,
            stylesheetDigest,
          },
          invalidation: {
            paths: selectedInvalidations,
            previousRevision: previousRevision?.identity ?? null,
          },
          compilerTimings: {
            serverStartupMilliseconds,
            entryTransformMilliseconds,
            revisionTransformMilliseconds,
            moduleImportMilliseconds:
              preparation.value.compilerDurationMilliseconds,
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
          styles: [{
            requestedFinalURL: styleURL,
            finalURL: styleURL,
            contentType: "text/css",
            byteLength: stylesheetBytes.byteLength,
            digest: stylesheetDigest,
            source: stylesheetText,
          }],
          resources: preloadedResources.map(({ bytes, ...resource }) => resource),
          initialFrame: initial.frame,
          interactionFrame: interaction?.frame ?? null,
          inspection: inspected.value.inspection,
          diagnostics: terminalEvidence.diagnostics,
          lifecycle: terminalEvidence.lifecycle,
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
        for (const invalidatedPath of selectedInvalidations) {
          invalidatedPaths.delete(invalidatedPath);
        }
        return result;
      } catch (error) {
        if (!realmDestroyed) {
          try {
            const response = await realm.command("close-realm");
            moduleRunnerClosed = response.value.moduleRunnerClosed === true;
            const cleanupExit = await realm.closeInputAndWait();
            realmDestroyed = true;
            if (
              !moduleRunnerClosed || cleanupExit.standardError !== "" ||
              cleanupExit.code !== 0 || cleanupExit.signal !== null
            ) {
              throw new Error(
                `Vite realm cleanup exited with code ${cleanupExit.code}, signal ${cleanupExit.signal}, stderr ${cleanupExit.standardError}`,
              );
            }
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
            try {
              const cleanupExit = await realm.terminate();
              realmDestroyed = true;
              if (cleanupExit.standardError !== "") {
                throw new Error(
                  `Terminated Vite realm wrote to standard error: ${cleanupExit.standardError}`,
                );
              }
            } catch (terminationError) {
              cleanupErrors.push(terminationError);
            }
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Vite component render and realm cleanup failed",
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
        throw new Error("Cannot dispose the Vite component adapter during a render");
      }
      disposed = true;
      server.watcher.off("change", observeInvalidation);
      server.watcher.off("add", observeInvalidation);
      server.watcher.off("unlink", observeInvalidation);
      if (ownsServer) await server.close();
    },
  });
}
