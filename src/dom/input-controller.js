import { createInputBindings } from "./dom-bindings.generated.js";
import { createEvent, dispatchEvent as dispatchSandomEvent } from "./events.js";
import { scrollByChained } from "./scroll-interaction.js";
import { scrollScrollbar } from "./scroll-core.js";

const measurementSymbol = Symbol.for("sandom.domCore.measurement");
const encoder = new TextEncoder();
const EVENTS = [null, "pointerout", "pointerleave", "pointerover", "pointerenter", "mouseout", "mouseleave", "mouseover", "mouseenter", "pointerdown", "mousedown", "pointermove", "mousemove", "pointerup", "mouseup", "pointercancel", "lostpointercapture", "gotpointercapture", "wheel", "keydown", "keyup", "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "change"];
const INPUT_TYPES = [null, "deleteContentBackward", "deleteContentForward", "insertLineBreak", "insertText", "insertCompositionText", "insertReplacementText"];
const SOURCES = [null, "property", "scroll", "scrollTo", "scrollBy", "wheel", "keyboard", "pointer", "snap", "anchor", "scrollIntoView", "resize", "scrollbar", "momentum"];
const SELECTION_DIRECTIONS = ["none", "forward", "backward"];
const stateFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ core, handle }) => core.status("input_state_release", handle))
  : null;

function invoke(core, operation, ...args) {
  const result = core.exports[operation](...args);
  if (core.exports.abi_error_kind()) {
    const code = core.exports.input_error_code();
    if (code === 1 || code === 2) {
      const id = core.exports.input_error_pointer_id();
      throw new Error(`Pointer ${id} is ${code === 2 ? "already" : "not"} active`);
    }
    if (code === 3) throw new Error("A text composition is already active");
    if (code === 4) throw new Error("Composition update requires an active composition");
    if (code === 5) throw new Error("Composition end requires an active composition");
    if (code === 6 || code === 7) throw new Error(`No ${code === 7 ? "vertical" : "horizontal"} scrollbar exists for the element`);
    if (code === 8) throw new Error("Text composition requires an enabled focused text control");
    core.throwIfError();
  }
  return result;
}

function protocolEnum(core, domain, value) {
  return typeof value === "string"
    ? core.status("input_schema_enum", domain, ...core.input(value))
    : 0;
}

function encodeRecords(core, root, records) {
  const encoded = records.map((record) => {
    const text = record.key ?? record.text ?? record.value ?? "";
    const code = record.code ?? "";
    return { record, kind: protocolEnum(core, 0, record.kind), text: encoder.encode(typeof text === "string" ? text : ""), code: encoder.encode(typeof code === "string" ? code : ""), textLength: typeof text === "string" ? text.length : 0, pointerType: protocolEnum(core, 1, record.pointerType), action: protocolEnum(core, 2, record.action) };
  });
  const length = records.length * 160 + encoded.reduce((sum, item) => sum + item.text.byteLength + item.code.byteLength, 0);
  const pointer = core.exports.abi_allocate(length);
  const bytes = core.refreshBytes();
  bytes.fill(0, pointer, pointer + length);
  const view = new DataView(bytes.buffer);
  let cursor = records.length * 160;
  for (let index = 0; index < encoded.length; index++) {
    const item = encoded[index];
    const record = item.record;
    const base = pointer + index * 160;
    view.setUint32(base, item.kind, true);
    view.setUint32(base + 4, item.pointerType, true);
    view.setUint32(base + 8, (record.isPrimary ? 1 : 0) | (record.shiftKey ? 2 : 0) | (record.altKey ? 4 : 0) | (record.ctrlKey ? 8 : 0) | (record.metaKey ? 16 : 0) | (record.repeat ? 32 : 0) | (record.cancelled ? 64 : 0), true);
    for (const [offset, value] of [[16, record.pointerId], [24, record.x], [32, record.y], [40, record.deltaX], [48, record.deltaY], [56, record.timeMilliseconds], [64, record.pressure], [72, record.button], [80, record.buttons], [112, record.selectionStart], [120, record.selectionEnd]]) {
      view.setFloat64(base + offset, value ?? 0, true);
    }
    view.setBigUint64(base + 88, record.target?._coreHandle ?? 0n, true);
    view.setUint32(base + 96, cursor, true);
    view.setUint32(base + 100, item.text.byteLength, true);
    bytes.set(item.text, pointer + cursor);
    cursor += item.text.byteLength;
    view.setUint32(base + 104, cursor, true);
    view.setUint32(base + 108, item.code.byteLength, true);
    bytes.set(item.code, pointer + cursor);
    cursor += item.code.byteLength;
    view.setUint32(base + 128, item.textLength, true);
    view.setUint32(base + 132, item.action || record.deltaMode || record.location || 0, true);
    view.setBigUint64(base + 136, root._coreHandle, true);
  }
  const measurement = globalThis[measurementSymbol];
  if (measurement) measurement.record({ category: "lifecycle", operation: "input_batch_begin", direction: "host-to-core", bytes: length, allocations: encoded.length * 2, allocationBytes: length - records.length * 160 });
  return [pointer, length];
}

function readAction(core) {
  const pointer = core.exports.abi_output_pointer();
  const view = new DataView(core.refreshBytes().buffer, pointer, 80);
  // Capture retained action fields before wrapping a node can reenter the core.
  return { action: view.getUint32(0, true), event: view.getUint32(4, true), flags: view.getUint32(8, true), aux: view.getUint32(12, true), target: view.getBigUint64(16, true), related: view.getBigUint64(24, true), a: view.getFloat64(32, true), b: view.getFloat64(40, true), c: view.getFloat64(48, true), d: view.getFloat64(56, true) };
}

function eventFor(action, record, relatedTarget) {
  const fields = { bubbles: Boolean(action.flags & 1), cancelable: Boolean(action.flags & 2), composed: Boolean(action.flags & 4) };
  const modifiers = { shiftKey: record.shiftKey ?? false, altKey: record.altKey ?? false, ctrlKey: record.ctrlKey ?? false, metaKey: record.metaKey ?? false };
  const type = EVENTS[action.event];
  if (action.event <= 17) {
    if (action.aux & 32) {
      fields.pointerId = record.pointerId;
    } else {
      Object.assign(fields, modifiers, { button: action.aux & 1 ? -1 : record.button ?? 0, buttons: action.aux & 2 ? 0 : action.aux & 4 ? 1 : record.buttons ?? 0, clientX: action.aux & 8 ? 0 : record.x ?? 0, clientY: action.aux & 8 ? 0 : record.y ?? 0 });
      if (![5, 6, 7, 8, 10, 12, 14].includes(action.event)) {
        Object.assign(fields, { pointerId: record.pointerId, pointerType: action.aux & 16 ? [null, "mouse", "pen", "touch"][action.c] : record.pointerType, isPrimary: action.aux & 16 ? Boolean(action.d) : record.isPrimary, pressure: record.pressure ?? 0 });
      }
      if (action.event <= 8) fields.relatedTarget = relatedTarget;
    }
  } else if (action.event === 18) {
    Object.assign(fields, modifiers, { clientX: record.x, clientY: record.y, deltaX: record.deltaX, deltaY: record.deltaY, deltaMode: record.deltaMode });
  } else if (action.event === 19 || action.event === 20) {
    Object.assign(fields, modifiers, { key: record.key, code: record.code ?? "", location: record.location ?? 0, repeat: record.repeat ?? false });
  } else if (action.event >= 21 && action.event <= 23) {
    Object.assign(fields, modifiers, { data: action.aux & 512 ? "" : record.text });
  } else if (action.event === 24 || action.event === 25) {
    const inputType = action.aux & 255;
    Object.assign(fields, { inputType: INPUT_TYPES[inputType], data: inputType >= 4 ? record.key ?? record.text ?? record.value : inputType === 3 ? "\n" : null, isComposing: Boolean(action.aux & 256) });
  }
  return createEvent(type, fields);
}

export function createInputController(document, layoutOptions) {
  const states = new WeakMap();
  function stateFor(node) {
    const owner = node.nodeType === 9 ? node : node.ownerDocument;
    let state = states.get(owner);
    if (!state) {
      const core = owner._domCore;
      state = { core, handle: invoke(core, "input_state_create", owner._coreHandle), root: node };
      states.set(owner, state);
      stateFinalizer?.register(state, { core, handle: state.handle });
    }
    return state;
  }
  function snapshotFor(root, required = true) {
    const snapshot = root._renderSurface?.presentedFrame ?? null;
    if (!snapshot && required) throw new Error("Host input requires a presented frame: attach a render surface and deliver one frame before dispatching input.");
    return snapshot;
  }
  function runOwned(state, root, snapshot, batch, records, hooks = {}) {
    const core = state.core;
    const results = new Array(records.length);
    const viewportResults = new Set();
    let scrollbarChanged = false;
    try {
      for (;;) {
        const actionCode = invoke(core, "input_batch_next", batch);
        if (!actionCode) break;
        const action = readAction(core);
        const index = invoke(core, "input_batch_record", batch);
        const token = invoke(core, "input_batch_token", batch);
        const record = records[index];
        let outcome = 0;
        try {
          const surface = root._renderSurface;
          const target = action.aux & 64 && action.action === 1
            ? surface?.viewport
            : core.wrapperFor(action.target);
          switch (action.action) {
            case 1: {
              if (action.aux & 64) viewportResults.add(index);
              const event = eventFor(action, record, core.wrapperFor(action.related));
              dispatchSandomEvent(target, event);
              outcome = event.defaultPrevented ? 1 : 0;
              break;
            }
            case 2:
              if (action.aux === 1) target._hovered = Boolean(action.a);
              else target._active = Boolean(action.a);
              if (action.flags & 1) target._notifyMutation("state", action.aux === 1 ? "hover" : "active");
              break;
            case 3: target.focus(); break;
            case 4: target.click(); break;
            case 5: target.setSelectionRange(action.a, action.b, SELECTION_DIRECTIONS[action.c]); break;
            case 6: {
              const selection = (root.nodeType === 9 ? root : root.ownerDocument).getSelection();
              const mode = action.aux === 3
                ? invoke(core, "input_pointer_selection_mode", selection._handle, action.target)
                : action.aux;
              if (mode === 2) selection.removeAllRanges();
              else if (mode === 1) selection.extend(target, action.a);
              else selection.setBaseAndExtent(target, action.a, target, action.a);
              break;
            }
            case 7:
              if (action.target === 0n) viewportResults.add(index);
              scrollByChained(surface, snapshot, target ?? surface?.viewport, action.a, action.b, SOURCES[action.aux]);
              break;
            case 8:
              if (action.target === 0n) viewportResults.add(index);
              surface?._beginScrollInteraction(target ?? surface.viewport);
              break;
            case 9: surface?._endScrollInteraction(); break;
            case 10:
              if (action.target === 0n) viewportResults.add(index);
              surface?._startScrollMomentum(target ?? surface.viewport, action.a, action.b, action.c);
              break;
            case 11:
              if (action.target === 0n) viewportResults.add(index);
              scrollScrollbar(surface, target ?? surface.viewport, action.aux & 1, action.a, action.aux >= 2, action.b, action.c, action.d);
              scrollbarChanged = true;
              break;
            case 12: {
              const value = core.string("input_batch_edit_value", batch);
              if (action.aux & 2048) target._setUserEditedValue(value, action.a, action.b);
              else {
                const type = action.aux & 255;
                const data = type >= 4 ? record.key ?? record.text ?? record.value : type === 3 ? "\n" : "";
                target._setUserEditedValue(value.slice(0, action.a) + data + value.slice(action.b), action.c);
              }
              break;
            }
            case 14: target._notifyMutation("state", action.aux === 1 ? "selected" : "checked"); break;
            case 15: hooks.beforeRecord?.(record, index); break;
            case 16: {
              const result = record.kind === "pointer-leave" ? null : target ?? (viewportResults.has(index) ? surface?.viewport : null);
              results[index] = result;
              hooks.afterRecord?.(record, index, result);
              break;
            }
            case 17:
              target._pointerController = pointerController;
              target._layoutOptions = layoutOptions;
              break;
            default: throw new Error(`Unknown native input action ${action.action}`);
          }
        } catch (error) {
          try { invoke(core, "input_batch_resume", batch, token, 2); } catch { /* Preserve the original listener/host exception. */ }
          throw error;
        }
        invoke(core, "input_batch_resume", batch, token, outcome);
      }
      return { results, scrollbarChanged };
    } finally {
      core.status("input_batch_release", batch);
    }
  }
  function dispatchBatch(root, records, hooks = {}) {
    const state = stateFor(root);
    state.root = root;
    const requiresSnapshot = records.some((record) => record.kind.startsWith("pointer-") || record.kind === "wheel");
    const snapshot = snapshotFor(root, requiresSnapshot);
    const [pointer, length] = encodeRecords(state.core, root, records);
    const batch = invoke(state.core, "input_batch_begin", state.handle, snapshot?.geometryHandle ?? 0n, pointer, length, records.length);
    return runOwned(state, root, snapshot, batch, records, hooks).results;
  }
  const pointerController = {
    capture(element, pointerId) {
      const state = stateFor(element);
      const batch = invoke(state.core, "input_pointer_capture_begin", state.handle, element._coreHandle, pointerId, 0);
      runOwned(state, state.root, snapshotFor(state.root, false), batch, [{ kind: "pointer-capture", pointerId }]);
    },
    release(element, pointerId) {
      const state = stateFor(element);
      const batch = invoke(state.core, "input_pointer_capture_begin", state.handle, element._coreHandle, pointerId, 1);
      runOwned(state, state.root, snapshotFor(state.root, false), batch, [{ kind: "pointer-release", pointerId }]);
    },
    has(element, pointerId) {
      const state = stateFor(element);
      return invoke(state.core, "input_pointer_has_capture", state.handle, element._coreHandle, pointerId) !== 0;
    },
  };
  function one(root, record) { return dispatchBatch(root, [record])[0]; }
  const runtime = {
    pointerController,
    dispatchInputRecords: dispatchBatch,
    resolveCursor(root, x, y) {
      const snapshot = snapshotFor(root);
      return snapshot.geometryCore.string("input_pointer_cursor", snapshot.geometryHandle, x, y);
    },
    wheel(root, x, y, deltaX, deltaY, deltaMode = 0, { shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "wheel", x, y, deltaX, deltaY, deltaMode, shiftKey, altKey, ctrlKey, metaKey });
    },
    keydown(root, key, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root, code = "", location = 0, repeat = false, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "key-down", target, key, code, location, repeat, shiftKey, altKey, ctrlKey, metaKey });
    },
    keyup(root, key, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root, code = "", location = 0, repeat = false, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "key-up", target, key, code, location, repeat, shiftKey, altKey, ctrlKey, metaKey });
    },
    compositionStart(root, text = "", { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "composition-start", target, text, shiftKey, altKey, ctrlKey, metaKey });
    },
    compositionUpdate(root, text, { shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "composition-update", text, shiftKey, altKey, ctrlKey, metaKey });
    },
    compositionEnd(root, text, { cancelled = false, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "composition-end", text, cancelled, shiftKey, altKey, ctrlKey, metaKey });
    },
    accessibilityAction(root, target, action) { return one(root, { ...action, kind: "accessibility-action", target }); },
    pointerDown(root, x, y, { pointerId = 1, pointerType = "touch", isPrimary = true, button = 0, buttons = 1, pressure = 0.5, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, timeMilliseconds = performance.now() } = {}) {
      return one(root, { kind: "pointer-down", x, y, pointerId, pointerType, isPrimary, button, buttons, pressure, shiftKey, altKey, ctrlKey, metaKey, timeMilliseconds });
    },
    pointerMove(root, x, y, { pointerId = 1, pointerType = "touch", isPrimary = true, buttons = 1, pressure = 0.5, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, timeMilliseconds = performance.now() } = {}) {
      return one(root, { kind: "pointer-move", x, y, pointerId, pointerType, isPrimary, button: -1, buttons, pressure, shiftKey, altKey, ctrlKey, metaKey, timeMilliseconds });
    },
    pointerUp(root, x, y, { pointerId = 1, pointerType = "touch", isPrimary = true, button = 0, pressure = 0, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, timeMilliseconds = performance.now() } = {}) {
      return one(root, { kind: "pointer-up", x, y, pointerId, pointerType, isPrimary, button, buttons: 0, pressure, shiftKey, altKey, ctrlKey, metaKey, timeMilliseconds });
    },
    pointerCancel(root, pointerId = 1) { return one(root, { kind: "pointer-cancel", pointerId }); },
    pointerLeave(root, pointerId = 1) { return one(root, { kind: "pointer-leave", pointerId }); },
    scrollbarKeydown(root, element, orientation, key) {
      const state = stateFor(root);
      const snapshot = snapshotFor(root);
      const code = state.core.status("input_key_code", ...state.core.input(key));
      const batch = invoke(state.core, "input_pointer_scrollbar_key_begin", state.handle, snapshot.geometryHandle, element?._coreHandle ?? 0n, orientation === "vertical" ? 1 : 0, code);
      return runOwned(state, root, snapshot, batch, [{ kind: "scrollbar-key", key }]).scrollbarChanged;
    },
  };
  return { ...runtime, ...createInputBindings(runtime) };
}
