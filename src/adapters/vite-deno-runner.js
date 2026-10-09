import {
  createNodeImportMeta,
  ESModulesEvaluator,
  ModuleRunner,
} from "vite/module-runner";
import {
  COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
  COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
  createComponentAdapterRealmDecoder,
  encodeComponentAdapterRealmMessage,
  serializeComponentAdapterError,
} from "./component-adapter-realm-protocol.js";
import {
  componentAdapterFrameRecord,
  componentAdapterInspectionRecord,
} from "./component-adapter-frame.js";

let outputChain = Promise.resolve();
function send(message, binary = new Map()) {
  const chunks = encodeComponentAdapterRealmMessage(message, binary);
  outputChain = outputChain.then(async () => {
    for (const chunk of chunks) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        offset += await Deno.stdout.write(chunk.subarray(offset));
      }
    }
  });
  return outputChain;
}
function sendTerminal(message, binary = new Map()) {
  for (const chunk of encodeComponentAdapterRealmMessage(message, binary)) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      offset += Deno.stdout.writeSync(chunk.subarray(offset));
    }
  }
}

let nextInvocationIdentifier = 1;
const pendingInvocations = new Map();
const transport = Object.freeze({
  invoke(payload) {
    const invocationIdentifier = nextInvocationIdentifier++;
    return new Promise((resolve) => {
      pendingInvocations.set(invocationIdentifier, resolve);
      send({
        kind: COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
        version: COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
        type: "vite-invoke",
        invocationIdentifier,
        payload,
      });
    });
  },
});
const moduleRunner = new ModuleRunner({
  transport,
  createImportMeta: createNodeImportMeta,
  hmr: false,
}, new ESModulesEvaluator());

let initializedAssets = null;
let preparedInput = null;
let runtime = null;
let session = null;
let mountedContext = null;
let moduleRunnerClosed = false;
let realmCloseRequested = false;


function requiredBinary(binary, name) {
  const bytes = binary.get(name);
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`Missing binary field ${JSON.stringify(name)}`);
  }
  return bytes;
}

async function disposeViteSession() {
  if (session === null) throw new Error("No component session exists");
  const resources = session.resources;
  const diagnostics = session.diagnostics;
  const startedAt = performance.now();
  await session.dispose({ restoreAmbientGlobals: false });
  const durationMilliseconds = performance.now() - startedAt;
  const componentUnmounted = mountedContext.container.childNodes.length === 0;
  const result = {
    resources,
    diagnostics,
    lifecycle: session.lifecycle,
    disposal: {
      sessionDisposed: true,
      componentUnmounted,
      disposedRenderError: "terminal realm destruction",
      globalsRestoredExactly: false,
      realmDestroyedWithoutGlobalRestoration: true,
      restorationDifferences: [],
      durationMilliseconds,
    },
  };
  session = null;
  mountedContext = null;
  return result;
}


async function executeRequest(operation, value, binary) {
  if (operation === "initialize-assets") {
    if (initializedAssets !== null) {
      throw new Error("Runtime assets are already initialized");
    }
    if (
      !value || typeof value !== "object" || !Array.isArray(value.codecs)
    ) {
      throw new TypeError("initialize-assets requires a codecs array");
    }
    const codecs = {};
    for (const name of value.codecs) {
      if (!["png", "jpeg", "webp", "jpegXl"].includes(name)) {
        throw new TypeError(`Unknown runtime codec ${JSON.stringify(name)}`);
      }
      codecs[name] = requiredBinary(binary, `codec:${name}`);
    }
    initializedAssets = Object.freeze({
      assets: Object.freeze({
        harfbuzz: requiredBinary(binary, "harfbuzz"),
        msdfgen: requiredBinary(binary, "msdfgen"),
        codecs: Object.freeze(codecs),
      }),
    });
    return { value: { initialized: true }, binary: new Map() };
  }

  if (operation === "import-prepared-input") {
    if (preparedInput !== null) {
      throw new Error("Prepared input is already imported");
    }
    const startedAt = performance.now();
    const stylesheetModule = await moduleRunner.import(value.stylesheet);
    const stylesheetText = stylesheetModule.default;
    if (typeof stylesheetText !== "string") {
      throw new TypeError(
        `Vite stylesheet ${JSON.stringify(value.stylesheet)} did not export text`,
      );
    }
    const revisionModule = await moduleRunner.import(value.revision.module);
    const revisionIdentity = revisionModule[value.revision.export];
    if (typeof revisionIdentity !== "string" || revisionIdentity.length === 0) {
      throw new TypeError(
        `Vite revision export ${JSON.stringify(value.revision.export)} must be a nonempty string`,
      );
    }
    const resourceIdentities = [];
    for (const resource of value.resources) {
      const resourceModule = await moduleRunner.import(resource.module);
      const requestedURL = resourceModule[resource.export];
      if (typeof requestedURL !== "string" || requestedURL.length === 0) {
        throw new TypeError(
          `Vite resource export ${JSON.stringify(resource.export)} must be a nonempty string`,
        );
      }
      resourceIdentities.push({ ...resource, requestedURL });
    }
    preparedInput = Object.freeze({
      entry: value.entry,
      stylesheet: value.stylesheet,
      stylesheetText,
      revisionIdentity,
      resourceIdentities: Object.freeze(resourceIdentities),
    });
    return {
      value: {
        compilerDurationMilliseconds: performance.now() - startedAt,
        stylesheetText,
        revisionIdentity,
        resourceIdentities,
      },
      binary: new Map(),
    };
  }

  if (operation === "create-session") {
    if (initializedAssets === null || preparedInput === null) {
      throw new Error("Runtime assets and prepared input must exist before session creation");
    }
    if (session !== null) throw new Error("A component session already exists");
    const preloadedResources = new Map();
    for (const [index, resource] of value.resources.entries()) {
      const preparedResource = {
        ...resource,
        bytes: requiredBinary(binary, `resource:${index}`),
      };
      preloadedResources.set(resource.requestedFinalURL, preparedResource);
      preloadedResources.set(resource.finalURL, preparedResource);
    }
    const runtimeStartedAt = performance.now();
    const { createSandomRuntime } = await import("../runtime.js");
    runtime = await createSandomRuntime(initializedAssets);
    const runtimeDurationMilliseconds = performance.now() - runtimeStartedAt;
    let compiledMount = null;
    const sessionStartedAt = performance.now();
    session = await runtime.renderComponent({
      width: value.width,
      height: value.height,
      deviceScale: value.deviceScale,
      url: value.documentURL,
      graphicsBackend: value.graphicsBackend,
      environment: value.environment,
      stylesheets: [{
        url: new URL(value.stylesheetURL, value.documentURL),
        source: preparedInput.stylesheetText,
      }],
      async resolveResource({ kind, finalURL }) {
        const resource = preloadedResources.get(finalURL);
        if (!resource) {
          throw new Error(`The Vite adapter did not preload ${kind} ${finalURL}`);
        }
        return {
          bytes: resource.bytes,
          finalURL: resource.finalURL,
          contentType: resource.contentType,
          ownership: "caller",
        };
      },
      async mount(context) {
        mountedContext = context;
        compiledMount = await moduleRunner.import(preparedInput.entry);
        if (typeof compiledMount.mount !== "function") {
          throw new TypeError(
            `Vite entry ${JSON.stringify(preparedInput.entry)} does not export mount`,
          );
        }
        return await compiledMount.mount(context);
      },
    });
    return {
      value: {
        runtimeDurationMilliseconds,
        sessionDurationMilliseconds: performance.now() - sessionStartedAt,
      },
      binary: new Map(),
    };
  }

  if (operation === "render") {
    if (session === null) throw new Error("No component session exists");
    const startedAt = performance.now();
    const frame = componentAdapterFrameRecord(
      await session.render({ pixels: true }),
    );
    frame.value.durationMilliseconds = performance.now() - startedAt;
    return frame;
  }

  if (operation === "inspect") {
    if (session === null) throw new Error("No component session exists");
    const startedAt = performance.now();
    const currentInspection = componentAdapterInspectionRecord(
      await session.inspect(),
    );
    return {
      value: {
        durationMilliseconds: performance.now() - startedAt,
        inspection: currentInspection,
      },
      binary: new Map(),
    };
  }

  if (operation === "dispatch") {
    if (session === null) throw new Error("No component session exists");
    const startedAt = performance.now();
    let waitTarget = null;
    let waitListener = null;
    let timeout = null;
    let settlement = null;
    if (value.waitFor !== null) {
      waitTarget = mountedContext.document.querySelector(value.waitFor.selector);
      if (!waitTarget) {
        throw new Error(
          `Interaction settlement selector ${JSON.stringify(value.waitFor.selector)} matched no element`,
        );
      }
      settlement = new Promise((resolve, reject) => {
        waitListener = resolve;
        waitTarget.addEventListener(value.waitFor.event, waitListener, {
          once: true,
        });
        timeout = setTimeout(() => reject(new Error(
          `Interaction did not dispatch ${JSON.stringify(value.waitFor.event)} in ${value.waitFor.timeoutMilliseconds} milliseconds`,
        )), value.waitFor.timeoutMilliseconds);
      });
    }
    try {
      // The dispatched frame is a texture frame; the protocol ships pixel
      // bytes, so read the settled document back once for the record.
      await session.dispatch(value.records, { ready: settlement ?? undefined });
      const frame = componentAdapterFrameRecord(
        await session.render({ pixels: true }),
      );
      frame.value.durationMilliseconds = performance.now() - startedAt;
      return frame;
    } finally {
      clearTimeout(timeout);
      if (waitTarget !== null && waitListener !== null) {
        waitTarget.removeEventListener(value.waitFor.event, waitListener);
      }
    }
  }


  throw new RangeError(`Unknown realm operation ${JSON.stringify(operation)}`);
}

async function closeRealmAndExit(message, binary) {
  try {
    if (binary.size !== 0) {
      throw new TypeError("close-realm does not accept binary fields");
    }
    const finalEvidence = session === null
      ? null
      : await disposeViteSession();
    if (!moduleRunnerClosed) {
      await moduleRunner.close();
      moduleRunnerClosed = moduleRunner.isClosed();
    }
    if (!moduleRunnerClosed) throw new Error("Vite Module Runner did not close");
    if (pendingInvocations.size !== 0) {
      throw new Error("Vite invocations remain pending during realm close");
    }
    realmCloseRequested = true;
    sendTerminal({
      kind: COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
      version: COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
      type: "result",
      requestIdentifier: message.requestIdentifier,
      operation: message.operation,
      value: {
        realmCloseRequested: true,
        moduleRunnerClosed: true,
        finalEvidence,
      },
    });
    Deno.exit(0);
  } catch (error) {
    await send({
      kind: COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
      version: COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
      type: "error",
      requestIdentifier: message.requestIdentifier,
      operation: message.operation,
      error: serializeComponentAdapterError(error),
    });
  }
}

let requestChain = Promise.resolve();
const decoder = createComponentAdapterRealmDecoder((message, binary) => {
  if (message.type === "vite-invoke-result") {
    const resolve = pendingInvocations.get(message.invocationIdentifier);
    if (!resolve) {
      throw new Error(`Unknown Vite invocation result ${message.invocationIdentifier}`);
    }
    pendingInvocations.delete(message.invocationIdentifier);
    resolve(message.response);
    return;
  }
  if (message.type !== "request") {
    throw new Error(`Unexpected parent message type ${JSON.stringify(message.type)}`);
  }
  if (message.operation === "close-realm") {
    requestChain = requestChain.then(() => closeRealmAndExit(message, binary));
    return;
  }
  requestChain = requestChain.then(async () => {
    try {
      const result = await executeRequest(message.operation, message.value, binary);
      await send({
        kind: COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
        version: COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
        type: "result",
        requestIdentifier: message.requestIdentifier,
        operation: message.operation,
        value: result.value,
      }, result.binary);
    } catch (error) {
      await send({
        kind: COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
        version: COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
        type: "error",
        requestIdentifier: message.requestIdentifier,
        operation: message.operation,
        error: serializeComponentAdapterError(error),
      });
    }
  });
});

for await (const chunk of Deno.stdin.readable) decoder.push(chunk);
decoder.finish();
await requestChain;
await outputChain;
if (!realmCloseRequested) {
  throw new Error("The parent closed input before the close-realm request completed");
}
