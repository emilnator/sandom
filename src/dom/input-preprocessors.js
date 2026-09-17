import { importFreshModule, readBinaryFile } from "../host.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import {
  acquireAmbientGlobalOwnership,
  installComponentGlobals,
} from "./component-globals.js";
import { parseHTMLDocument } from "./html.js";
import { exceedsInputBound } from "./interaction.js";
import { SDDocument } from "./node.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const stringTrim = String.prototype.trim;
const stringLastIndexOf = String.prototype.lastIndexOf;
const stringSlice = String.prototype.slice;
const stringCharCodeAt = String.prototype.charCodeAt;

function preprocessorText(operation, text, ...parameters) {
  return sharedDomCore.status(
    operation,
    ...sharedDomCore.input(text),
    ...parameters,
  );
}

// Method lookup, receiver conversion, and non-intrinsic calls are observable.
// Native offsets are UTF-16; materialize from the original string so lone
// surrogates and slices through surrogate pairs are not replaced by UTF-8.
function preprocessorTrim(value) {
  const method = value.trim;
  if (method !== stringTrim) return Reflect.apply(method, value, []);
  const text = `${value}`;
  const range = preprocessorText("input_preprocessor_trim", text);
  return Reflect.apply(stringSlice, text, [
    Number(range & 0xffff_ffffn),
    Number(range >> 32n),
  ]);
}
function preprocessorLastIndex(value, character, delimiter) {
  const method = value.lastIndexOf;
  if (method !== stringLastIndexOf) {
    return Reflect.apply(method, value, [character]);
  }
  return preprocessorText(
    "input_preprocessor_last_index",
    `${value}`,
    delimiter,
  );
}

function preprocessorSlice(value, start) {
  const method = value.slice;
  if (method !== stringSlice) return Reflect.apply(method, value, [start]);
  const text = `${value}`;
  const offset = preprocessorText("input_preprocessor_slice_start", text, +start);
  return Reflect.apply(stringSlice, text, [offset]);
}

function preprocessorHasExtension(period, slash) {
  // Shared relational transport preserves custom-result ToPrimitive ordering;
  // normalized string, Number, and BigInt comparisons all execute natively.
  if (typeof period !== "number" || typeof slash !== "number") {
    return exceedsInputBound(period, slash);
  }
  return sharedDomCore.status("input_preprocessor_has_extension", period, slash);
}

function preprocessorEmpty(value) {
  return typeof value === "string" &&
    preprocessorText("input_preprocessor_empty", value);
}

function preprocessorUniqueCount(values) {
  // The map result may have a custom iterator yielding arbitrary values.
  // Only opaque object/symbol identities stay here; native compares strings,
  // numbers (SameValueZero), bigint text, and the normalized identity tokens.
  const identities = new Map();
  const records = [];
  let bytes = 0;
  for (const value of values) {
    let tag;
    let payload;
    switch (typeof value) {
      case "string":
      case "bigint": {
        tag = typeof value === "string" ? 1 : 3;
        const text = typeof value === "string" ? value : `${value}`;
        payload = new Uint8Array(text.length * 2);
        const view = new DataView(payload.buffer);
        for (let index = 0; index < text.length; index++) {
          view.setUint16(index * 2, Reflect.apply(stringCharCodeAt, text, [index]), true);
        }
        break;
      }
      case "number":
        tag = 2;
        payload = new Uint8Array(8);
        new DataView(payload.buffer).setFloat64(0, value, true);
        break;
      case "undefined":
        tag = 5;
        payload = new Uint8Array(0);
        break;
      case "boolean":
        tag = value ? 7 : 8;
        payload = new Uint8Array(0);
        break;
      default:
        if (value === null) {
          tag = 6;
          payload = new Uint8Array(0);
          break;
        }
        tag = 4;
        if (!identities.has(value)) identities.set(value, identities.size);
        payload = new Uint8Array(4);
        new DataView(payload.buffer).setUint32(0, identities.get(value), true);
    }
    records.push([tag, payload]);
    bytes += 8 + payload.byteLength;
  }
  const block = new Uint8Array(bytes);
  const view = new DataView(block.buffer);
  let offset = 0;
  for (const [tag, payload] of records) {
    view.setUint32(offset, tag, true);
    view.setUint32(offset + 4, payload.byteLength, true);
    block.set(payload, offset + 8);
    offset += 8 + payload.byteLength;
  }
  return sharedDomCore.status(
    "input_preprocessor_unique_count",
    ...sharedDomCore.byteInput(block),
    records.length,
  );
}

function createHTMLStructure(document) {
  const html = document.createElement("html");
  const head = document.createElement("head");
  const body = document.createElement("body");
  document.appendChild(html);
  html.append(head, body);
}

function descriptorsForAmbientWindow(window) {
  return Reflect.ownKeys(window)
    .filter((name) => name !== "globalThis")
    .map((name) => [
      name,
      Object.getOwnPropertyDescriptor(window, name),
    ]);
}

async function executeModuleWithComponentGlobals(input, window) {
  const releaseOwnership = await acquireAmbientGlobalOwnership(
    "file-preparation",
  );
  const ambientGlobal = globalThis;

  const ambientDescriptors = descriptorsForAmbientWindow(window);
  const priorDescriptors = new Map();
  const installedNames = [];
  let evaluationError = null;
  const restorationErrors = [];
  let moduleExports;
  try {
    for (const [name, descriptor] of ambientDescriptors) {
      priorDescriptors.set(
        name,
        Object.getOwnPropertyDescriptor(ambientGlobal, name),
      );
      Object.defineProperty(ambientGlobal, name, descriptor);
      installedNames.push(name);
    }
    moduleExports = await importFreshModule(input.url, input.bytes);
  } catch (error) {
    evaluationError = error;
  } finally {
    for (let index = installedNames.length - 1; index >= 0; index--) {
      const name = installedNames[index];
      try {
        const priorDescriptor = priorDescriptors.get(name);
        if (priorDescriptor) {
          Object.defineProperty(ambientGlobal, name, priorDescriptor);
        } else if (!delete ambientGlobal[name]) {
          restorationErrors.push(
            new TypeError(`Cannot restore absent global ${String(name)}`),
          );
        }
      } catch (error) {
        restorationErrors.push(error);
      }
    }
    releaseOwnership();
  }
  if (restorationErrors.length > 0) {
    throw new AggregateError(
      evaluationError
        ? [evaluationError, ...restorationErrors]
        : restorationErrors,
      "Failed to restore ambient JavaScript globals",
    );
  }
  if (evaluationError) throw evaluationError;
  return moduleExports;
}

export async function evaluateComponentModule(input, document) {
  if (!(document instanceof SDDocument)) {
    throw new TypeError("evaluateComponentModule requires a SandomDocument");
  }

  let moduleURL;
  let moduleBytes;
  if (input instanceof URL || typeof input === "string") {
    moduleURL = input instanceof URL ? new URL(input.href) : new URL(input);
    moduleBytes = await readBinaryFile(moduleURL);
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    moduleURL = input.url instanceof URL
      ? new URL(input.url.href)
      : new URL(input.url);
    moduleBytes = input.bytes === undefined
      ? await readBinaryFile(moduleURL)
      : input.bytes;
  } else {
    throw new TypeError(
      "input must be a URL, absolute URL string, or { url, bytes } object",
    );
  }
  if (!(moduleBytes instanceof Uint8Array)) {
    throw new TypeError("input.bytes must be a Uint8Array");
  }

  const window = document.defaultView ?? installComponentGlobals({}, document);
  if (
    window.document !== document ||
    window.customElements !== document.customElements
  ) {
    throw new TypeError(
      "SandomDocument defaultView must belong to the evaluated document",
    );
  }
  return await executeModuleWithComponentGlobals(
    Object.freeze({ url: moduleURL, bytes: moduleBytes }),
    window,
  );
}

export const htmlPreprocessor = Object.freeze({
  name: "html",
  extensions: Object.freeze([".html", ".htm"]),
  async prepare({ input, document, executeModule, resolveResource }) {
    parseHTMLDocument(textDecoder.decode(input.bytes), () => document);
    const moduleScripts = document.querySelectorAll('script[type="module"]');
    for (let index = 0; index < moduleScripts.length; index += 1) {
      const script = moduleScripts[index];
      const source = script.getAttribute("src");
      if (source !== null) {
        const resource = await resolveResource({
          requestedURL: source,
          baseURL: input.url,
          kind: "module",
        });
        await executeModule({
          url: new URL(resource.finalURL),
          bytes: resource.bytes,
        });
        continue;
      }
      const moduleURL = new URL(input.url);
      moduleURL.pathname += `.inline-${index + 1}.js`;
      moduleURL.hash = `inline-module-${index + 1}`;
      await executeModule({
        url: moduleURL,
        bytes: textEncoder.encode(script.textContent),
      });
    }
  },
});

export const javascriptPreprocessor = Object.freeze({
  name: "javascript",
  extensions: Object.freeze([".js", ".mjs"]),
  async prepare({ input, document, executeModule }) {
    createHTMLStructure(document);
    await executeModule(input);
  },
});

export const jsxPreprocessor = Object.freeze({
  name: "jsx",
  extensions: Object.freeze([".jsx"]),
  async prepare({ input, document, executeModule }) {
    createHTMLStructure(document);
    await executeModule(input);
  },
});

export const builtInPreprocessors = Object.freeze([
  htmlPreprocessor,
  javascriptPreprocessor,
  jsxPreprocessor,
]);

function validatePreprocessor(candidate, source) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${source} preprocessor must be an object`);
  }
  if (typeof candidate.name !== "string" || preprocessorEmpty(preprocessorTrim(candidate.name))) {
    throw new TypeError(
      `${source} preprocessor name must be a non-empty string`,
    );
  }
  if (candidate.name !== preprocessorTrim(candidate.name)) {
    throw new TypeError(
      `${source} preprocessor name must not contain outer whitespace`,
    );
  }
  if (
    !Array.isArray(candidate.extensions) || candidate.extensions.length === 0
  ) {
    throw new TypeError(
      `${source} preprocessor extensions must be a non-empty array`,
    );
  }
  const extensions = candidate.extensions.map((extension) => {
    if (
      typeof extension !== "string" ||
      !preprocessorText("input_preprocessor_extension_valid", extension)
    ) {
      throw new TypeError(
        `${source} preprocessor extension ${
          JSON.stringify(extension)
        } must be exact lower-case text that starts with a period`,
      );
    }
    return extension;
  });
  if (preprocessorUniqueCount(extensions) !== extensions.length) {
    throw new TypeError(`${source} preprocessor has a duplicate extension`);
  }
  if (typeof candidate.prepare !== "function") {
    throw new TypeError(`${source} preprocessor prepare must be a function`);
  }
  return Object.freeze({
    name: candidate.name,
    extensions: Object.freeze(extensions),
    prepare: candidate.prepare,
  });
}

export function createPreprocessorRegistry(additionalPreprocessors = []) {
  if (!Array.isArray(additionalPreprocessors)) {
    throw new TypeError("preprocessors must be an array");
  }
  const preprocessors = [
    ...builtInPreprocessors.map((preprocessor) =>
      validatePreprocessor(preprocessor, "Built-in")
    ),
    ...additionalPreprocessors.map((preprocessor, index) =>
      validatePreprocessor(preprocessor, `Caller-supplied index ${index}`)
    ),
  ];
  const byName = new Map();
  const byExtension = new Map();
  for (const preprocessor of preprocessors) {
    if (byName.has(preprocessor.name)) {
      throw new TypeError(
        `Duplicate preprocessor name ${JSON.stringify(preprocessor.name)}`,
      );
    }
    byName.set(preprocessor.name, preprocessor);
    for (const extension of preprocessor.extensions) {
      const previous = byExtension.get(extension);
      if (previous) {
        throw new TypeError(
          `Duplicate preprocessor extension ${JSON.stringify(extension)} for ${
            JSON.stringify(previous.name)
          } and ${JSON.stringify(preprocessor.name)}`,
        );
      }
      byExtension.set(extension, preprocessor);
    }
  }
  return Object.freeze({
    byName,
    byExtension,
    preprocessors: Object.freeze(preprocessors),
  });
}

export function selectPreprocessor(registry, inputURL, explicitName) {
  if (explicitName !== undefined && explicitName !== null) {
    if (typeof explicitName !== "string" || preprocessorEmpty(explicitName)) {
      throw new TypeError("preprocessor must be a non-empty string");
    }
    const selected = registry.byName.get(explicitName);
    if (selected) return selected;
    throw new RangeError(
      `Unsupported preprocessor ${
        JSON.stringify(explicitName)
      } for ${inputURL.href}; available preprocessors: ${
        registry.preprocessors.map(({ name }) => name).join(", ")
      }`,
    );
  }
  const slashIndex = preprocessorLastIndex(inputURL.pathname, "/", 47);
  const periodIndex = preprocessorLastIndex(inputURL.pathname, ".", 46);
  const extension = preprocessorHasExtension(periodIndex, slashIndex)
    ? preprocessorSlice(inputURL.pathname, periodIndex)
    : "";
  const selected = registry.byExtension.get(extension);
  if (selected) return selected;
  throw new RangeError(
    `Unsupported input ${inputURL.href}; available preprocessors: ${
      registry.preprocessors.map(({ name }) => name).join(", ")
    }`,
  );
}

export function createInputWindow(document) {
  return installComponentGlobals({}, document);
}

export function createModuleExecutor(window) {
  return (input) => executeModuleWithComponentGlobals(input, window);
}
