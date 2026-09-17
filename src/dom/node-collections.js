import {
  createPartTokenListBinding,
  createClassTokenListBinding,
  createDatasetTrapsBinding,
} from "./dom-bindings.generated.js";

const utf16Apply = Reflect.apply;
const utf16CharCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
const utf16FromCharCode = String.fromCharCode;

// UTF16LE is deliberately not TextEncoder/TextDecoder: Set equality and dataset
// property transport must distinguish every lone surrogate from U+FFFD.
function tokenInput(core, value) {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const unit = utf16CharCodeAt(value, index);
    bytes[index * 2] = unit;
    bytes[index * 2 + 1] = unit >>> 8;
  }
  return core.byteInput(bytes);
}

function tokenOutput(core) {
  const pointer = core.exports.abi_output_pointer();
  const length = core.exports.abi_output_length();
  const bytes = new Uint8Array(core.memory.buffer, pointer, length);
  let text = "";
  for (let offset = 0; offset < length; offset += 8192) {
    const count = Math.min(4096, (length - offset) / 2);
    const units = new Uint16Array(count);
    for (let index = 0; index < count; index += 1) {
      const at = offset + index * 2;
      units[index] = bytes[at] | bytes[at + 1] << 8;
    }
    // Reflect.apply reads array-like indices without an iterator or spread.
    // Primitive concatenation avoids any authored Array.prototype.join hook.
    text += utf16Apply(utf16FromCharCode, undefined, units);
  }
  return text;
}

const tokenCacheFinalizer = new FinalizationRegistry(({ core, cache }) => {
  core.status("token_binding_release", cache.handle);
});

const intrinsicTrim = String.prototype.trim;
const intrinsicSplit = String.prototype.split;

export function createTokenList(element, attributeName) {
  const core = element._domCore;
  const cache = { handle: 0n, source: null, identities: [] };
  // Finalizer holdings must never retain source/opaque values: either can
  // point back to this public wrapper and otherwise prevent its collection.
  const lifetime = { handle: 0n };
  const release = (handle) => core.status("token_binding_release", handle);
  const claim = (handle) => core.handle("token_binding_claim", handle);
  const readValues = (handle, identities) => {
    const result = [];
    const count = core.status("token_binding_count", handle);
    for (let index = 0; index < count; index += 1) {
      const kind = core.status("token_binding_item", handle, index);
      let value;
      if (kind === 2) {
        const pointer = core.exports.abi_output_pointer();
        const identity = new DataView(core.memory.buffer).getUint32(pointer + 1, true);
        value = identities[identity - 1];
      } else value = tokenOutput(core);
      Object.defineProperty(result, index, {
        value, enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  };
  const normalize = (source) => {
    // These are observable method lookups/calls, not a substitute JS Set.
    // The built-in string algorithms run natively; arbitrary user methods keep
    // their original receivers, arguments, results and exceptions.
    const trim = source.trim;
    let trimmed;
    if (trim === intrinsicTrim) {
      const input = tokenInput(core, `${source}`);
      core.status("token_binding_trim", input[0], input[1]);
      trimmed = tokenOutput(core);
    } else trimmed = Reflect.apply(trim, source, []);
    const split = trimmed.split;
    let separated;
    if (split === intrinsicSplit) {
      const input = tokenInput(core, `${trimmed}`);
      const parts = core.handle("token_binding_split", input[0], input[1]);
      try {
        separated = readValues(parts, []);
      } finally {
        release(parts);
      }
    } else separated = Reflect.apply(split, trimmed, [/\s+/]);
    return separated.filter(Boolean);
  };
  const snapshot = (mutable = false) => {
    const source = element.getAttribute(attributeName) ?? "";
    if (source !== cache.source) {
      // Baseline publishes cachedSource before normalization. If it throws,
      // a repeated identical source observes the prior cached values.
      cache.source = source;
      const normalized = normalize(source);
      const handle = core.handle("token_binding_begin");
      const identities = [];
      const identityMap = new Map();
      try {
        if (normalized !== null && normalized !== undefined) {
        for (const value of normalized) {
          if (typeof value === "string") {
            const invocation = claim(handle);
            const input = tokenInput(core, value);
            core.status("token_binding_apply", handle, invocation, 1,
              input[0], input[1], -1);
          } else {
            let identity = identityMap.get(value);
            if (identity === undefined) {
              // SameValueZero host identity transport canonicalizes -0.
              identities.push(value === 0 ? 0 : value);
              identity = identities.length;
              identityMap.set(value, identity);
            }
            core.status("token_binding_opaque", handle, claim(handle), identity);
          }
        }
        }
        core.status("token_binding_finish", handle, claim(handle), 2);
      } catch (error) {
        release(handle);
        throw error;
      }
      release(cache.handle);
      cache.handle = handle;
      lifetime.handle = handle;
      cache.identities = identities;
    }
    return {
      handle: mutable
        ? cache.handle === 0n
          ? core.handle("token_binding_begin")
          : core.handle("token_binding_clone", cache.handle)
        : core.handle("token_binding_retain", cache.handle),
      identities: cache.identities,
    };
  };
  const apply = (handle, token, mode, force = -1) => {
    const invocation = claim(handle);
    const input = tokenInput(core, String(token));
    return core.status("token_binding_apply", handle, invocation, mode,
      input[0], input[1], force);
  };
  const commit = ({ handle, identities }) => {
    const action = core.status("token_binding_finish", handle, 0n, 0);
    if (action === 1) {
      const remove = element.removeAttribute;
      core.status("token_binding_finish", handle, claim(handle), 1);
      Reflect.apply(remove, element, [attributeName]);
      return;
    }
    // Callee lookup precedes iteration/join, including arbitrary join getters
    // and per-member coercion. Retained native snapshot survives all reentry.
    const set = element.setAttribute;
    const values = readValues(handle, identities);
    const join = values.join;
    const value = Reflect.apply(join, values, [" "]);
    core.status("token_binding_finish", handle, claim(handle), 1);
    Reflect.apply(set, element, [attributeName, value]);
  };
  const values = () => {
    const current = snapshot();
    try {
      return readValues(current.handle, current.identities);
    } finally {
      release(current.handle);
    }
  };
  const runtime = {
    length() {
      const current = snapshot();
      try {
        return core.status("token_binding_count", current.handle);
      } finally {
        release(current.handle);
      }
    },
    item(index) { return values()[Number(index)] ?? null; },
    contains(token) {
      const current = snapshot();
      try {
        const input = tokenInput(core, String(token));
        return core.status("token_binding_apply", current.handle, 0n, 0,
          input[0], input[1], -1) === 1;
      } finally {
        release(current.handle);
      }
    },
    add(tokens) {
      const current = snapshot(true);
      try {
        for (const token of tokens) apply(current.handle, token, 1);
        commit(current);
      } finally { release(current.handle); }
    },
    remove(tokens) {
      const current = snapshot(true);
      try {
        for (const token of tokens) apply(current.handle, token, 2);
        commit(current);
      } finally { release(current.handle); }
    },
    toggle(token, force) {
      const normalized = String(token);
      const current = snapshot(true);
      try {
        const invocation = claim(current.handle);
        const input = tokenInput(core, normalized);
        const result = core.status("token_binding_apply", current.handle,
          invocation, 3, input[0], input[1],
          force === undefined ? -1 : Boolean(force) ? 1 : 0) === 1;
        commit(current);
        return result;
      } finally { release(current.handle); }
    },
    replace(oldToken, newToken) {
      const current = snapshot(true);
      try {
        if (apply(current.handle, oldToken, 2) === 0) return false;
        apply(current.handle, newToken, 1);
        commit(current);
        return true;
      } finally { release(current.handle); }
    },
    getValue: () => element.getAttribute(attributeName) ?? "",
    setValue: (value) => element.setAttribute(attributeName, value),
    iterator: () => new Set(values())[Symbol.iterator](),
  };
  const result = createPartTokenListBinding(runtime);
  tokenCacheFinalizer.register(result, { core, cache: lifetime });
  return result;
}

export function createClassTokenList(element, capabilities) {
  const core = element._domCore;
  const handle = element._coreHandle;
  const { withCustomElementReactions, customElementAttributeChanged } = capabilities;
  const apply = (operation) => withCustomElementReactions(() => {
    const oldValue = element.getAttribute("class");
    const result = operation();
    const changed = core.status("token_binding_class_changed") === 1;
    core.callbackRecords();
    if (changed) {
      element._notifyMutation("class", undefined, {
        type: "attributes", target: element, attributeName: "class",
        attributeNamespace: null, oldValue,
      });
      customElementAttributeChanged(
        element, "class", oldValue, element.getAttribute("class"),
      );
    }
    return result;
  }, core);
  return createClassTokenListBinding({
    core,
    handle,
    length: () => core.classCount(handle),
    item: (index) => core.classItem(handle, Number(index)),
    contains: (token) => core.classContains(handle, String(token)),
    add(tokens) {
      for (const token of tokens) {
        apply(() => core.classAdd(handle, String(token)));
      }
    },
    remove(tokens) {
      for (const token of tokens) {
        apply(() => core.classRemove(handle, String(token)));
      }
    },
    toggle(token, force) {
      const normalizedForce = force === undefined ? -1 : Boolean(force) ? 1 : 0;
      return apply(() => core.classToggle(handle, String(token), normalizedForce));
    },
    replace: (oldToken, newToken) =>
      apply(() => core.classReplace(handle, String(oldToken), String(newToken))),
    getValue: () => element.getAttribute("class") ?? "",
    setValue: (value) => element.setAttribute("class", value),
  });
}

export function createDataset(element) {
  const core = element._domCore;
  const name = (property) => {
    const input = tokenInput(core, String(property));
    core.status("dataset_binding_name", input[0], input[1]);
    return tokenOutput(core);
  };
  // The baseline has no ownKeys/has/getOwnPropertyDescriptor trap. Enumeration
  // therefore concerns only the ordinary target, never the data-* attributes.
  return new Proxy({}, createDatasetTrapsBinding({
    get: (_, property) => element.getAttribute(name(property)) ?? undefined,
    set(_, property, value) {
      element.setAttribute(name(property), value);
      return true;
    },
    deleteProperty(_, property) {
      element.removeAttribute(name(property));
      return true;
    },
  }));
}
