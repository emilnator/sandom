import { serializeComponentAdapterError } from "./component-adapter-realm-protocol.js";

const maximumObjectDepth = 4;
const maximumProperties = 64;
const failedConsoleMethods = new Set(["assert", "error"]);

function numberRecord(value) {
  if (Number.isNaN(value)) return Object.freeze({ type: "number", value: "NaN" });
  if (value === Infinity) return Object.freeze({ type: "number", value: "Infinity" });
  if (value === -Infinity) return Object.freeze({ type: "number", value: "-Infinity" });
  if (Object.is(value, -0)) return Object.freeze({ type: "number", value: "-0" });
  return Object.freeze({ type: "number", value });
}

function consoleArgumentRecord(value, seen = new Map(), depth = 0) {
  if (value === null) return Object.freeze({ type: "null" });
  if (value === undefined) return Object.freeze({ type: "undefined" });
  if (typeof value === "string" || typeof value === "boolean") {
    return Object.freeze({ type: typeof value, value });
  }
  if (typeof value === "number") return numberRecord(value);
  if (typeof value === "bigint") {
    return Object.freeze({ type: "bigint", value: value.toString() });
  }
  if (typeof value === "symbol") {
    return Object.freeze({ type: "symbol", value: String(value) });
  }
  if (typeof value === "function") {
    return Object.freeze({ type: "function", name: value.name || null });
  }
  if (value instanceof Error) {
    return Object.freeze({
      type: "error",
      value: serializeComponentAdapterError(value),
    });
  }
  const priorReference = seen.get(value);
  if (priorReference !== undefined) {
    return Object.freeze({ type: "reference", reference: priorReference });
  }
  const reference = seen.size + 1;
  seen.set(value, reference);
  const prototype = Object.getPrototypeOf(value);
  const constructor = prototype === null
    ? null
    : Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  const constructorName = typeof constructor === "function" && constructor.name
    ? constructor.name
    : null;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const values = Array.from(value.subarray(0, maximumProperties));
    return Object.freeze({
      type: "typed-array",
      constructor: value.constructor.name,
      reference,
      length: value.length,
      values: Object.freeze(values),
      truncated: value.length > values.length,
    });
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    const values = Array.from(bytes.subarray(0, maximumProperties));
    return Object.freeze({
      type: "array-buffer",
      reference,
      byteLength: value.byteLength,
      values: Object.freeze(values),
      truncated: bytes.length > values.length,
    });
  }
  if (depth >= maximumObjectDepth) {
    return Object.freeze({
      type: Array.isArray(value) ? "array" : "object",
      constructor: constructorName,
      reference,
      truncated: true,
      properties: Object.freeze([]),
    });
  }
  const keys = Reflect.ownKeys(value).sort((left, right) =>
    String(left).localeCompare(String(right))
  );
  const selectedKeys = keys.slice(0, maximumProperties);
  const properties = selectedKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const name = typeof key === "symbol" ? String(key) : key;
    if ("value" in descriptor) {
      return Object.freeze({
        name,
        kind: "value",
        value: consoleArgumentRecord(descriptor.value, seen, depth + 1),
      });
    }
    return Object.freeze({
      name,
      kind: "accessor",
      getter: descriptor.get?.name || null,
      setter: descriptor.set?.name || null,
    });
  });
  return Object.freeze({
    type: Array.isArray(value) ? "array" : "object",
    constructor: constructorName,
    reference,
    truncated: keys.length > selectedKeys.length,
    properties: Object.freeze(properties),
  });
}

export function installCompiledApplicationConsole(realm = globalThis) {
  if (!realm || (typeof realm !== "object" && typeof realm !== "function")) {
    throw new TypeError("Console realm must be an object");
  }
  const originalDescriptor = Object.getOwnPropertyDescriptor(realm, "console");
  if (originalDescriptor === undefined) {
    throw new Error("The compiled-application realm has no console descriptor");
  }
  const originalConsole = realm.console;
  if (!originalConsole || typeof originalConsole !== "object") {
    throw new TypeError("The compiled-application realm console must be an object");
  }
  if (!("value" in originalDescriptor) && originalDescriptor.configurable !== true) {
    throw new Error("The compiled-application realm console accessor is not configurable");
  }
  const diagnostics = [];
  const methods = new Map();
  const capturedConsole = new Proxy(originalConsole, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      let method = methods.get(property);
      if (method !== undefined) return method;
      const methodName = typeof property === "symbol" ? String(property) : property;
      method = (...arguments_) => {
        if (methodName === "assert" && arguments_[0]) return;
        diagnostics.push(Object.freeze({
          kind: "console",
          method: methodName,
          arguments: Object.freeze(arguments_.map((argument) => {
            try {
              return consoleArgumentRecord(argument);
            } catch (error) {
              return Object.freeze({
                type: "serialization-error",
                value: serializeComponentAdapterError(error),
              });
            }
          })),
          failed: failedConsoleMethods.has(methodName),
        }));
      };
      methods.set(property, method);
      return method;
    },
  });
  Object.defineProperty(realm, "console", "value" in originalDescriptor
    ? { ...originalDescriptor, value: capturedConsole }
    : {
      configurable: true,
      enumerable: originalDescriptor.enumerable,
      writable: true,
      value: capturedConsole,
    });
  let disposed = false;
  return Object.freeze({
    get diagnostics() {
      return Object.freeze([...diagnostics]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      Object.defineProperty(realm, "console", originalDescriptor);
    },
  });
}
