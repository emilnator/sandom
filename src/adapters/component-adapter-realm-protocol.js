export const COMPONENT_ADAPTER_REALM_PROTOCOL_KIND =
  "sandom/component-adapter-realm-protocol";
export const COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION = 1;

export const COMPONENT_ADAPTER_REALM_OPERATIONS = Object.freeze([
  "initialize-assets",
  "import-prepared-input",
  "create-session",
  "render",
  "inspect",
  "dispatch",
  "dispose-session",
  "close-module-runner",
  "close-realm",
]);

const operationNames = new Set(COMPONENT_ADAPTER_REALM_OPERATIONS);
const messageTypes = new Set([
  "request",
  "result",
  "error",
  "vite-invoke",
  "vite-invoke-result",
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function positiveIdentifier(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateBinaryFields(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError("binaryFields must be an array");
  }
  const names = new Set();
  return Object.freeze(value.map((candidate, index) => {
    const field = plainObject(candidate, `binaryFields[${index}]`);
    if (Reflect.ownKeys(field).some((key) => !["name", "byteLength"].includes(key))) {
      throw new TypeError(`binaryFields[${index}] has an unknown field`);
    }
    if (typeof field.name !== "string" || field.name.length === 0) {
      throw new TypeError(`binaryFields[${index}].name must be a nonempty string`);
    }
    if (names.has(field.name)) {
      throw new TypeError(`Duplicate binary field ${JSON.stringify(field.name)}`);
    }
    names.add(field.name);
    if (!Number.isSafeInteger(field.byteLength) || field.byteLength < 0) {
      throw new TypeError(
        `binaryFields[${index}].byteLength must be a nonnegative safe integer`,
      );
    }
    return Object.freeze({ name: field.name, byteLength: field.byteLength });
  }));
}

export function serializeComponentAdapterError(error) {
  const seen = new Set();
  const serialize = (candidate) => {
    if (!(candidate instanceof Error)) {
      return Object.freeze({
        name: "Error",
        message: String(candidate),
        stack: null,
      });
    }
    if (seen.has(candidate)) {
      return Object.freeze({
        name: "CircularErrorCause",
        message: "The structured error cause contains a cycle",
        stack: null,
      });
    }
    seen.add(candidate);
    return Object.freeze({
      name: candidate.name,
      message: candidate.message,
      stack: candidate.stack ?? null,
      ...(candidate.cause === undefined
        ? {}
        : { cause: serialize(candidate.cause) }),
      ...(candidate instanceof AggregateError
        ? { errors: Object.freeze(candidate.errors.map(serialize)) }
        : {}),
    });
  };
  return serialize(error);
}

export function deserializeComponentAdapterError(record) {
  plainObject(record, "structured error");
  for (const key of Reflect.ownKeys(record)) {
    if (
      typeof key !== "string" ||
      !["name", "message", "stack", "cause", "errors"].includes(key)
    ) {
      throw new TypeError(`Unknown structured error field ${String(key)}`);
    }
  }
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new TypeError("structured error name must be a nonempty string");
  }
  if (typeof record.message !== "string") {
    throw new TypeError("structured error message must be a string");
  }
  if (record.stack !== null && typeof record.stack !== "string") {
    throw new TypeError("structured error stack must be a string or null");
  }
  const cause = record.cause === undefined
    ? undefined
    : deserializeComponentAdapterError(record.cause);
  let error;
  if (record.errors !== undefined) {
    if (!Array.isArray(record.errors)) {
      throw new TypeError("structured aggregate errors must be an array");
    }
    error = new AggregateError(
      record.errors.map(deserializeComponentAdapterError),
      record.message,
      cause === undefined ? undefined : { cause },
    );
  } else {
    error = new Error(
      record.message,
      cause === undefined ? undefined : { cause },
    );
  }
  error.name = record.name;
  if (record.stack !== null) error.stack = record.stack;
  return error;
}

export function validateComponentAdapterRealmMessage(candidate) {
  const message = plainObject(candidate, "realm message");
  if (message.kind !== COMPONENT_ADAPTER_REALM_PROTOCOL_KIND) {
    throw new TypeError(
      `Unsupported component adapter realm protocol kind ${JSON.stringify(message.kind)}`,
    );
  }
  if (message.version !== COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION) {
    throw new TypeError(
      `Unsupported component adapter realm protocol version ${JSON.stringify(message.version)}`,
    );
  }
  if (!messageTypes.has(message.type)) {
    throw new TypeError(`Unknown component adapter realm message type ${JSON.stringify(message.type)}`);
  }
  if (["request", "result", "error"].includes(message.type)) {
    positiveIdentifier(message.requestIdentifier, "requestIdentifier");
    if (!operationNames.has(message.operation)) {
      throw new TypeError(`Unknown component adapter realm operation ${JSON.stringify(message.operation)}`);
    }
  } else {
    positiveIdentifier(message.invocationIdentifier, "invocationIdentifier");
  }
  if (message.type === "error") deserializeComponentAdapterError(message.error);
  const binaryFields = validateBinaryFields(message.binaryFields);
  return Object.freeze({ ...message, binaryFields });
}

export function createComponentAdapterRealmRequest(
  requestIdentifier,
  operation,
  value = null,
) {
  return validateComponentAdapterRealmMessage({
    kind: COMPONENT_ADAPTER_REALM_PROTOCOL_KIND,
    version: COMPONENT_ADAPTER_REALM_PROTOCOL_VERSION,
    type: "request",
    requestIdentifier,
    operation,
    value,
  });
}

export function encodeComponentAdapterRealmMessage(message, binary = new Map()) {
  const entries = binary instanceof Map ? [...binary.entries()] : Object.entries(binary);
  const binaryFields = entries.map(([name, bytes]) => {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(`Binary field ${JSON.stringify(name)} must be a Uint8Array`);
    }
    return { name, byteLength: bytes.byteLength };
  });
  const validated = validateComponentAdapterRealmMessage({
    ...message,
    ...(binaryFields.length === 0 ? {} : { binaryFields }),
  });
  const header = textEncoder.encode(`${JSON.stringify(validated)}\n`);
  return Object.freeze([header, ...entries.map(([, bytes]) => bytes)]);
}

export function createComponentAdapterRealmDecoder(onMessage) {
  if (typeof onMessage !== "function") {
    throw new TypeError("onMessage must be a function");
  }
  const chunks = [];
  let firstChunkOffset = 0;
  let available = 0;
  let header = null;
  let requiredBinaryBytes = 0;

  const consume = (byteLength) => {
    if (byteLength > available) return null;
    if (byteLength === 0) return new Uint8Array();
    const first = chunks[0];
    if (first.byteLength - firstChunkOffset >= byteLength) {
      const value = first.subarray(firstChunkOffset, firstChunkOffset + byteLength);
      firstChunkOffset += byteLength;
      available -= byteLength;
      if (firstChunkOffset === first.byteLength) {
        chunks.shift();
        firstChunkOffset = 0;
      }
      return value;
    }
    const value = new Uint8Array(byteLength);
    let destinationOffset = 0;
    while (destinationOffset < byteLength) {
      const chunk = chunks[0];
      const count = Math.min(
        byteLength - destinationOffset,
        chunk.byteLength - firstChunkOffset,
      );
      value.set(
        chunk.subarray(firstChunkOffset, firstChunkOffset + count),
        destinationOffset,
      );
      destinationOffset += count;
      firstChunkOffset += count;
      available -= count;
      if (firstChunkOffset === chunk.byteLength) {
        chunks.shift();
        firstChunkOffset = 0;
      }
    }
    return value;
  };

  const newlineOffset = () => {
    let offset = 0;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const start = chunkIndex === 0 ? firstChunkOffset : 0;
      for (let index = start; index < chunk.byteLength; index += 1) {
        if (chunk[index] === 10) return offset + index - start;
      }
      offset += chunk.byteLength - start;
      if (offset > 1024 * 1024) {
        throw new RangeError("Component adapter realm message header exceeds one mebibyte");
      }
    }
    return -1;
  };

  const drain = () => {
    while (true) {
      if (header === null) {
        const lineLength = newlineOffset();
        if (lineLength < 0) return;
        const line = consume(lineLength);
        consume(1);
        header = validateComponentAdapterRealmMessage(
          JSON.parse(textDecoder.decode(line)),
        );
        requiredBinaryBytes = header.binaryFields.reduce(
          (total, field) => total + field.byteLength,
          0,
        );
      }
      if (available < requiredBinaryBytes) return;
      const binary = new Map();
      for (const field of header.binaryFields) {
        binary.set(field.name, consume(field.byteLength));
      }
      const message = header;
      header = null;
      requiredBinaryBytes = 0;
      onMessage(message, binary);
    }
  };

  return Object.freeze({
    push(chunk) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("Realm protocol input must be a Uint8Array");
      }
      if (chunk.byteLength === 0) return;
      chunks.push(chunk);
      available += chunk.byteLength;
      drain();
    },
    finish() {
      drain();
      if (header !== null || available !== 0) {
        throw new Error("Component adapter realm protocol ended with an incomplete message");
      }
    },
  });
}
