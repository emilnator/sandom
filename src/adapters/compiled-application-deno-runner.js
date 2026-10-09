import {
  DOMParser,
  processDocumentAutofocus,
} from "../dom/node.js";
import {
  installCompiledApplicationAsyncOwnership,
} from "./compiled-application-async-ownership.js";
import { installCompiledApplicationConsole } from "./compiled-application-console.js";
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

const SelectedRealmWebSocket = globalThis.WebSocket;
let outputChain = Promise.resolve();
let requestChain = Promise.resolve();
let initializedAssets = null;
let runtime = null;
let session = null;
let mountedContext = null;
let priorGlobalDescriptors = null;
let scriptAdapter = null;
let consoleAdapter = null;
let asyncOwnership = null;
let asyncDisposalEvidence = null;
let terminalDisposalRequested = false;
let sessionEvidence = null;
let runnerClosed = false;
let realmCloseRequested = false;

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

function requiredBinary(binary, name) {
  const bytes = binary.get(name);
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`Missing binary field ${JSON.stringify(name)}`);
  }
  return bytes;
}

function snapshotGlobalDescriptors() {
  return new Map(Reflect.ownKeys(globalThis).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
}

function descriptorsEqual(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    Object.is(left.value, right.value) &&
    left.get === right.get &&
    left.set === right.set;
}

function globalDescriptorDifferences(expected) {
  const differences = [];
  const names = new Set([...expected.keys(), ...Reflect.ownKeys(globalThis)]);
  for (const name of names) {
    if (!descriptorsEqual(
      expected.get(name),
      Object.getOwnPropertyDescriptor(globalThis, name),
    )) {
      differences.push(typeof name === "symbol" ? name.toString() : name);
    }
  }
  return differences.sort();
}


function requiredResource(resources, requestedURL, capability) {
  const normalizedURL = new URL(requestedURL).href;
  const resource = resources.get(normalizedURL);
  if (!resource) {
    throw new DOMException(
      `${capability} requested ${normalizedURL}; the URL is outside the finite preload map`,
      "NotSupportedError",
    );
  }
  return resource;
}

function classicScriptType(script) {
  if (script.hasAttribute("nomodule")) return false;
  const type = script.getAttribute("type")?.trim().toLowerCase() ?? "";
  return ["", "text/javascript", "application/javascript"].includes(type);
}

function installClassicScriptAdapter(document, resources, dynamicScriptURLs) {
  const dynamicAllowlist = new Set(dynamicScriptURLs.map((url) => new URL(url).href));
  const headAppendDescriptor = Object.getOwnPropertyDescriptor(document.head, "appendChild");
  const bodyAppendDescriptor = Object.getOwnPropertyDescriptor(document.body, "appendChild");
  const currentScriptDescriptor = Object.getOwnPropertyDescriptor(document, "currentScript");
  const originalHeadAppendChild = document.head.appendChild;
  const originalBodyAppendChild = document.body.appendChild;
  const evaluations = [];
  let currentScript = null;
  Object.defineProperty(document, "currentScript", {
    configurable: true,
    enumerable: true,
    get: () => currentScript,
  });

  const evaluate = (script, source, sourceURL, executionKind) => {
    currentScript = script;
    try {
      (0, eval)(`${source}\n//# sourceURL=${sourceURL ?? "compiled-application-inline-script.js"}`);
    } catch (error) {
      evaluations.push(Object.freeze({
        executionKind,
        sourceURL,
        sourceLength: source.length,
        currentScriptInstalled: true,
        sourceAttribute: script.getAttribute("src"),
        sourceProperty: script.src ?? null,
        connectedBeforeLoad: script.isConnected,
        loadHandlerPresent: typeof script.onload === "function",
        errorHandlerPresent: typeof script.onerror === "function",
        loadDispatched: false,
        connectedAfterLoad: script.isConnected,
        outcome: "evaluation-rejected",
      }));
      throw error;
    } finally {
      currentScript = null;
    }
    const record = {
      executionKind,
      sourceURL,
      sourceLength: source.length,
      currentScriptInstalled: true,
      sourceAttribute: script.getAttribute("src"),
      sourceProperty: script.src ?? null,
      connectedBeforeLoad: script.isConnected,
      loadHandlerPresent: typeof script.onload === "function",
      errorHandlerPresent: typeof script.onerror === "function",
    };
    try {
      const loadAccepted = script.dispatchEvent(new Event("load"));
      evaluations.push(Object.freeze({
        ...record,
        loadDispatched: true,
        loadAccepted,
        connectedAfterLoad: script.isConnected,
        outcome: "fulfilled",
      }));
    } catch (error) {
      evaluations.push(Object.freeze({
        ...record,
        loadDispatched: true,
        connectedAfterLoad: script.isConnected,
        outcome: "load-rejected",
      }));
      throw error;
    }
  };

  const appendWithExplicitScriptExecution = (original, owner, node) => {
    const appended = original.call(owner, node);
    if (node?.localName !== "script") return appended;
    const sourceAttribute = node.getAttribute("src");
    if (!sourceAttribute) return appended;
    const requestedURL = new URL(sourceAttribute, document.URL).href;
    if (!dynamicAllowlist.has(requestedURL)) {
      throw new DOMException(
        `The classic-script adapter rejected unlisted dynamic script ${requestedURL}`,
        "NotSupportedError",
      );
    }
    if (!classicScriptType(node)) {
      throw new DOMException(
        `The classic-script adapter cannot execute dynamic script type ${JSON.stringify(node.getAttribute("type") ?? "")}`,
        "NotSupportedError",
      );
    }
    const resource = requiredResource(
      resources,
      requestedURL,
      "The classic-script adapter",
    );
    evaluate(
      node,
      new TextDecoder().decode(resource.bytes),
      resource.finalURL,
      "appended preloaded public URL",
    );
    return appended;
  };

  document.head.appendChild = function appendChild(node) {
    return appendWithExplicitScriptExecution(
      originalHeadAppendChild,
      document.head,
      node,
    );
  };
  document.body.appendChild = function appendChild(node) {
    return appendWithExplicitScriptExecution(
      originalBodyAppendChild,
      document.body,
      node,
    );
  };

  return Object.freeze({
    execute(script, source, sourceURL, executionKind) {
      evaluate(script, source, sourceURL, executionKind);
    },
    get evaluations() {
      return Object.freeze([...evaluations]);
    },
    dispose() {
      if (headAppendDescriptor === undefined) {
        delete document.head.appendChild;
      } else {
        Object.defineProperty(document.head, "appendChild", headAppendDescriptor);
      }
      if (bodyAppendDescriptor === undefined) {
        delete document.body.appendChild;
      } else {
        Object.defineProperty(document.body, "appendChild", bodyAppendDescriptor);
      }
      if (currentScriptDescriptor === undefined) {
        delete document.currentScript;
      } else {
        Object.defineProperty(document, "currentScript", currentScriptDescriptor);
      }
    },
  });
}

function explicitReady(document, readiness) {
  const selected = () => document.querySelector(readiness.selector);
  const ready = () => selected()?.getAttribute(readiness.attribute) === readiness.value;
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(
        `Compiled application did not signal readiness ${readiness.selector} ${readiness.attribute}=${JSON.stringify(readiness.value)}`,
      ));
    }, readiness.timeoutMilliseconds);
    const observer = new MutationObserver(() => {
      if (!ready()) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  });
}

async function disposeCompiledApplicationSession({
  restoreAmbientGlobals,
  onTerminalDisposed = null,
}) {
  if (session === null) throw new Error("No component session exists");
  const resources = session.resources;
  const diagnostics = session.diagnostics;
  const startedAt = performance.now();
  let sessionDisposalError = null;
  terminalDisposalRequested = !restoreAmbientGlobals;
  try {
    await session.dispose({ restoreAmbientGlobals });
  } catch (error) {
    sessionDisposalError = error;
  }
  const cleanupErrors = [];
  if (!restoreAmbientGlobals) {
    const before = asyncOwnership.evidence;
    try {
      asyncOwnership.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    asyncDisposalEvidence = Object.freeze({
      before,
      after: asyncOwnership.evidence,
      disposed: cleanupErrors.length === 0,
    });
  }
  const consoleDiagnostics = consoleAdapter?.diagnostics ?? [];
  if (restoreAmbientGlobals) {
    try {
      asyncOwnership?.restore();
    } catch (error) {
      cleanupErrors.push(error);
    }
    asyncOwnership = null;
    try {
      consoleAdapter?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    consoleAdapter = null;
  }
  if (sessionDisposalError !== null || cleanupErrors.length > 0) {
    throw new AggregateError(
      [
        ...(sessionDisposalError === null ? [] : [sessionDisposalError]),
        ...cleanupErrors,
      ],
      "Compiled-application session disposal failed",
    );
  }
  const durationMilliseconds = performance.now() - startedAt;
  let disposedRenderError = "terminal realm destruction";
  if (restoreAmbientGlobals) {
    disposedRenderError = null;
    try {
      await session.render();
    } catch (error) {
      disposedRenderError = error instanceof Error ? error.message : String(error);
    }
    if (disposedRenderError === null) {
      throw new Error("A disposed component session accepted another render");
    }
  }
  const restorationDifferences = globalDescriptorDifferences(priorGlobalDescriptors);
  const componentUnmounted = mountedContext.container.childNodes.length === 0;
  const result = {
    resources,
    diagnostics: Object.freeze([...diagnostics, ...consoleDiagnostics]),
    lifecycle: session.lifecycle,
    evidence: Object.freeze({
      ...sessionEvidence,
      asyncDisposal: asyncDisposalEvidence,
    }),
    disposal: {
      sessionDisposed: true,
      componentUnmounted,
      disposedRenderError,
      globalsRestoredExactly: restorationDifferences.length === 0,
      realmDestroyedWithoutGlobalRestoration: !restoreAmbientGlobals,
      restorationDifferences,
      durationMilliseconds,
    },
  };
  session = null;
  mountedContext = null;
  if (onTerminalDisposed !== null) onTerminalDisposed(result);
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
    throw new Error("The compiled-application realm does not accept prepared module input");
  }

  if (operation === "create-session") {
    if (initializedAssets === null) {
      throw new Error("Runtime assets must exist before session creation");
    }
    if (session !== null) throw new Error("A component session already exists");
    const resources = new Map();
    for (const [index, resource] of value.resources.entries()) {
      const preparedResource = Object.freeze({
        ...resource,
        bytes: requiredBinary(binary, `resource:${index}`),
      });
      resources.set(resource.requestedFinalURL, preparedResource);
      resources.set(resource.finalURL, preparedResource);
    }
    if (value.capabilities.webSocket && typeof SelectedRealmWebSocket !== "function") {
      throw new Error("The selected compiled-application realm has no WebSocket capability");
    }
    performance.mark("navigationStart");
    const runtimeStartedAt = performance.now();
    const { createSandomRuntime } = await import("../runtime.js");
    runtime = await createSandomRuntime(initializedAssets);
    const runtimeDurationMilliseconds = performance.now() - runtimeStartedAt;
    priorGlobalDescriptors = snapshotGlobalDescriptors();
    let executedScriptCount = 0;
    let autofocusEvidence = null;
    let ordinaryScriptInsertionInert = false;
    const sessionStartedAt = performance.now();
    const environment = {
      ...value.environment,
      fetch(request) {
        const requestedURL = new URL(
          String(request?.url ?? request),
          value.documentURL,
        ).href;
        const resource = requiredResource(resources, requestedURL, "fetch");
        return Promise.resolve(new Response(resource.bytes.slice(), {
          headers: resource.contentType
            ? { "Content-Type": resource.contentType }
            : undefined,
        }));
      },
      ...(value.capabilities.webSocket
        ? {
          createWebSocket(requestedURL, protocols) {
            const socket = protocols === undefined
              ? new SelectedRealmWebSocket(requestedURL)
              : new SelectedRealmWebSocket(requestedURL, protocols);
            if (asyncOwnership === null) {
              throw new Error("WebSocket was created before async ownership installation");
            }
            return asyncOwnership.trackWebSocket(socket);
          },
        }
        : {}),
    };
    session = await runtime.renderComponent({
      width: value.width,
      height: value.height,
      deviceScale: value.deviceScale,
      url: value.documentURL,
      graphicsBackend: value.graphicsBackend,
      environment,
      resolveResource({ finalURL }) {
        const resource = requiredResource(resources, finalURL, "resolveResource");
        return {
          bytes: resource.bytes,
          finalURL: resource.finalURL,
          contentType: resource.contentType,
          ownership: "caller",
        };
      },
      async mount(context) {
        mountedContext = context;
        const { document } = context;
        const parsed = new DOMParser().parseFromString(value.documentHTML, "text/html");
        for (const name of document.documentElement.getAttributeNames()) {
          document.documentElement.removeAttribute(name);
        }
        for (const name of parsed.documentElement.getAttributeNames()) {
          document.documentElement.setAttribute(name, parsed.documentElement.getAttribute(name));
        }
        document.head.innerHTML = parsed.head.innerHTML;
        document.body.innerHTML = parsed.body.innerHTML;
        const autofocusTarget = processDocumentAutofocus(document);
        autofocusEvidence = autofocusTarget === null
          ? null
          : Object.freeze({
            localName: autofocusTarget.localName,
            id: autofocusTarget.id,
            name: autofocusTarget.getAttribute("name"),
          });
        consoleAdapter = installCompiledApplicationConsole();
        scriptAdapter = installClassicScriptAdapter(
          document,
          resources,
          value.dynamicScriptURLs,
        );
        asyncOwnership = installCompiledApplicationAsyncOwnership();
        const inertScript = document.createElement("script");
        inertScript.textContent =
          `document.documentElement.setAttribute("data-ordinary-script-ran", "")`;
        document.head.appendChild(inertScript);
        ordinaryScriptInsertionInert = !document.documentElement.hasAttribute(
          "data-ordinary-script-ran",
        );
        inertScript.remove();
        if (!ordinaryScriptInsertionInert) {
          throw new Error("Ordinary DOM script insertion executed source");
        }
        const scriptElements = [...document.querySelectorAll("script")];
        if (scriptElements.length !== value.scripts.length) {
          throw new Error(
            `Parsed ${scriptElements.length} scripts, but the adapter recorded ${value.scripts.length}`,
          );
        }
        for (let index = 0; index < value.scripts.length; index += 1) {
          const script = value.scripts[index];
          if (!script.executable || !script.selected) continue;
          const source = script.url
            ? new TextDecoder().decode(
              requiredResource(resources, script.url, "The classic-script adapter").bytes,
            )
            : script.inlineSource;
          scriptAdapter.execute(
            scriptElements[index],
            source,
            script.url,
            script.url ? "public document URL" : "public document inline",
          );
          executedScriptCount += 1;
        }
        const ready = explicitReady(document, value.readiness);
        return {
          ready,
          dispose() {
            scriptAdapter.dispose();
            document.body.replaceChildren();
            if (!terminalDisposalRequested) {
              const before = asyncOwnership.evidence;
              asyncOwnership.dispose();
              asyncDisposalEvidence = Object.freeze({
                before,
                after: asyncOwnership.evidence,
                disposed: true,
              });
            }
          },
        };
      },
    });
    const styleElements = [...mountedContext.document.querySelectorAll("style")];
    sessionEvidence = Object.freeze({
      applicationReadyValue: mountedContext.document.querySelector(value.readiness.selector)
        ?.getAttribute(value.readiness.attribute) ?? null,
      executedScriptCount,
      scriptEvaluations: scriptAdapter.evaluations,
      ordinaryScriptInsertionInert,
      autofocus: autofocusEvidence,
      styleElementCount: styleElements.length,
      styleRuleCount: styleElements.reduce(
        (count, element) => count + (element.sheet?.cssRules?.length ?? 0),
        0,
      ),
      asyncOwnershipAtReadiness: asyncOwnership.evidence,
    });
    return {
      value: {
        runtimeDurationMilliseconds,
        sessionDurationMilliseconds: performance.now() - sessionStartedAt,
        ...sessionEvidence,
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
    return {
      value: {
        durationMilliseconds: performance.now() - startedAt,
        inspection: componentAdapterInspectionRecord(await session.inspect()),
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
        waitTarget.addEventListener(value.waitFor.event, waitListener, { once: true });
        timeout = setTimeout(() => reject(new Error(
          `Interaction did not dispatch ${JSON.stringify(value.waitFor.event)} in ${value.waitFor.timeoutMilliseconds} milliseconds`,
        )), value.waitFor.timeoutMilliseconds);
      });
    }
    try {
      let records = value.records;
      if (value.target !== null) {
        const target = mountedContext.document.querySelector(value.target.selector);
        if (!target) {
          throw new Error(
            `Interaction target selector ${JSON.stringify(value.target.selector)} matched no element`,
          );
        }
        const inspection = await session.inspect();
        const targetIndex = inspection.elementAtIndex.indexOf(target);
        if (targetIndex < 0) {
          throw new Error(
            `Interaction target ${JSON.stringify(value.target.selector)} has no Sandom layout box`,
          );
        }
        const box = inspection.layoutBoxes[targetIndex];
        const x = box.x + box.w / 2;
        const y = box.y + box.h / 2;
        records = [{
          kind: "pointer-down",
          pointerId: 1,
          pointerType: "mouse",
          x,
          y,
        }, {
          kind: "pointer-up",
          pointerId: 1,
          pointerType: "mouse",
          x,
          y,
        }];
      }
      // The dispatched frame is a texture frame; the protocol ships pixel
      // bytes, so read the settled document back once for the record.
      await session.dispatch(records, { ready: settlement ?? undefined });
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

  if (operation === "dispose-session") {
    return {
      value: await disposeCompiledApplicationSession({
        restoreAmbientGlobals: true,
      }),
      binary: new Map(),
    };
  }

  if (operation === "close-module-runner") {
    if (session !== null) {
      throw new Error("Dispose the component session before closing the realm runner");
    }
    runnerClosed = true;
    return { value: { moduleRunnerClosed: true }, binary: new Map() };
  }


  throw new RangeError(`Unknown realm operation ${JSON.stringify(operation)}`);
}
async function closeRealmAndExit(message, binary) {
  try {
    if (binary.size !== 0) {
      throw new TypeError("close-realm does not accept binary fields");
    }
    const finish = (finalEvidence) => {
      runnerClosed = true;
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
    };
    if (session === null) finish(null);
    await disposeCompiledApplicationSession({
      restoreAmbientGlobals: false,
      onTerminalDisposed: finish,
    });
    throw new Error("Terminal realm disposal returned without process destruction");
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

const decoder = createComponentAdapterRealmDecoder((message, binary) => {
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
      const response = {
        kind: COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
        version: COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
        type: "result",
        requestIdentifier: message.requestIdentifier,
        operation: message.operation,
        value: result.value,
      };
      await send(response, result.binary);
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
