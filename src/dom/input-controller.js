import { createInputBindings } from "./dom-bindings.generated.js";
import { createEvent, dispatchEvent as dispatchSandomEvent, SDDataTransfer } from "./events.js";
import { runInputActivation } from "./input-activation.js";
import { scrollByChained } from "./scroll-interaction.js";
import { scrollScrollbar } from "./scroll-core.js";
import { scrollbarAtPoint } from "./presented-frame.js";

const measurementSymbol = Symbol.for("sandom.domCore.measurement");
const encoder = new TextEncoder();
const EVENTS = [null, "pointerout", "pointerleave", "pointerover", "pointerenter", "mouseout", "mouseleave", "mouseover", "mouseenter", "pointerdown", "mousedown", "pointermove", "mousemove", "pointerup", "mouseup", "pointercancel", "lostpointercapture", "gotpointercapture", "wheel", "keydown", "keyup", "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "change", "copy", "cut", "paste"];
const INPUT_TYPES = [null, "deleteContentBackward", "deleteContentForward", "insertLineBreak", "insertText", "insertCompositionText", "insertReplacementText", "insertFromPaste", "insertFromDrop", "deleteByCut"];
const INSERT_TEXT_TYPES = ["insertText", "insertReplacementText", "insertFromPaste", "insertFromDrop"];
const DELETE_SELECTION_TYPES = ["deleteContentBackward", "deleteContentForward", "deleteByCut"];
const SOURCES = [null, "property", "scroll", "scrollTo", "scrollBy", "wheel", "keyboard", "pointer", "snap", "anchor", "scrollIntoView", "resize", "scrollbar", "momentum"];
const SELECTION_DIRECTIONS = ["none", "forward", "backward"];
const stateFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ core, handle }) => core.status("input_state_release", handle))
  : null;
// Text editing follows Chrome on one platform (plans/dom/PLAN-platform-
// editing-behavior.md): its key bindings and its caret motion rules. The
// code is the input state's platform in the DOM core.
const EDITING_PLATFORMS = Object.freeze({ mac: 0, windows: 1, linux: 2 });

// The platform of the host process: macOS for darwin, Windows for windows,
// Linux for every other system.
export function hostEditingPlatform() {
  const system = globalThis.Deno?.build?.os ?? globalThis.process?.platform;
  if (system === "darwin") return "mac";
  if (system === "windows" || system === "win32") return "windows";
  return "linux";
}

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
    if (code === 9) throw new Error("A text edit cannot run during an active text composition: end it with compositionEnd first");
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

function documentOf(root) {
  return root.nodeType === 9 ? root : root.ownerDocument;
}

// The text an edit of this input type inserts; deletes insert nothing.
function insertedText(inputType, record) {
  if (inputType >= 4 && inputType <= 8) return record.key ?? record.text ?? record.value;
  return inputType === 3 ? "\n" : null;
}

function inputTypeCode(operation, inputType, allowed) {
  if (!allowed.includes(inputType)) {
    throw new RangeError(`${operation}: unknown inputType ${String(inputType)}; use one of ${allowed.join(", ")}`);
  }
  return INPUT_TYPES.indexOf(inputType);
}

// Action19 names where copied text comes from; see $inputClipboardDefault.
function clipboardText(action, record, target, root) {
  if (action.aux === 0) {
    return record.clipboardData.types.includes("text/plain") ? record.clipboardData.getData("text/plain") : null;
  }
  if (action.aux === 1) return target.value.slice(action.a, action.b);
  if (action.aux === 2) {
    const text = documentOf(root).getSelection().toString();
    return text === "" ? null : text;
  }
  if (action.aux === 3) return null;
  throw new Error(`Unknown native clipboard text source ${action.aux}`);
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
    Object.assign(fields, { inputType: INPUT_TYPES[inputType], data: insertedText(inputType, record), isComposing: Boolean(action.aux & 256) });
  } else if (action.event >= 27 && action.event <= 29) {
    fields.clipboardData = record.clipboardData;
  }
  return createEvent(type, fields);
}

export function createInputController(layoutOptions, editingPlatform) {
  if (!Object.hasOwn(EDITING_PLATFORMS, editingPlatform)) {
    throw new RangeError(
      `editingPlatform must be "mac", "windows" or "linux", got ${JSON.stringify(editingPlatform)}`,
    );
  }
  const platform = EDITING_PLATFORMS[editingPlatform];
  const states = new WeakMap();
  function stateFor(node) {
    const owner = node.nodeType === 9 ? node : node.ownerDocument;
    let state = states.get(owner);
    if (!state) {
      const core = owner._domCore;
      state = { core, handle: invoke(core, "input_state_create", owner._coreHandle, platform), root: node };
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
    let valueChanged = false;
    let copiedText = null;
    let scrolled = false;
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
              const selection = documentOf(root).getSelection();
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
              scrolled = scrollByChained(surface, snapshot, target ?? surface?.viewport, action.a, action.b, SOURCES[action.aux]).scrolled || scrolled;
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
                const next = value.slice(0, action.a) + (insertedText(action.aux & 255, record) ?? "") + value.slice(action.b);
                if (next !== value) valueChanged = true;
                target._setUserEditedValue(next, action.c);
              }
              break;
            }
            case 14: target._notifyMutation("state", action.aux === 1 ? "selected" : "checked"); break;
            case 15:
              scrolled = false;
              hooks.beforeRecord?.(record, index);
              break;
            case 16: {
              const result = record.kind === "pointer-leave" ? null : target ?? (viewportResults.has(index) ? surface?.viewport : null);
              results[index] = result;
              hooks.afterRecord?.(record, index, result, scrolled);
              break;
            }
            case 17:
              target._pointerController = pointerController;
              target._layoutOptions = layoutOptions;
              break;
            case 18: documentOf(root).getSelection().selectAllChildren(target); break;
            case 19: copiedText = clipboardText(action, record, target, root); break;
            // Implicit submission of a form without a default button.
            case 20: runInputActivation(target, 4); break;
            default: throw new Error(`Unknown native input action ${action.action}`);
          }
        } catch (error) {
          try { invoke(core, "input_batch_resume", batch, token, 2); } catch { /* Preserve the original listener/host exception. */ }
          throw error;
        }
        invoke(core, "input_batch_resume", batch, token, outcome);
      }
      return { results, scrollbarChanged, valueChanged, copiedText };
    } finally {
      core.status("input_batch_release", batch);
    }
  }
  function dispatchBatch(root, records, hooks = {}) {
    const state = stateFor(root);
    state.root = root;
    const requiresSnapshot = records.some((record) => record.kind.startsWith("pointer-") || record.kind === "wheel");
    const snapshot = hooks.snapshot ?? snapshotFor(root, requiresSnapshot);
    if (snapshot && snapshot.geometryCore !== state.core) {
      throw new TypeError("Input snapshot must use the document's DOM core.");
    }
    const [pointer, length] = encodeRecords(state.core, root, records);
    // The surface's touch-panning opt-in travels with the batch; the engine
    // decides whether a drag pans.
    const touchPanning = root._renderSurface?._touchPanning ? 1 : 0;
    const batch = invoke(state.core, "input_batch_begin", state.handle, snapshot?.geometryHandle ?? 0n, pointer, length, records.length, touchPanning);
    const results = runOwned(state, root, snapshot, batch, records, hooks).results;
    // The engine knows which CSS cursor belongs at a document point. A host
    // that named an element for it gets the answer applied there, so the
    // pointer over text is a text cursor without every interactive host
    // resolving and assigning it again.
    const surface = root._renderSurface;
    if (surface?._cursorTarget && snapshot) {
      for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];
        if (typeof record.x !== "number" || typeof record.y !== "number") {
          continue;
        }
        surface._applyCursor(record.x, record.y);
        break;
      }
    }
    // The scrollbar under the pointer shows an overlay bar and holds it
    // shown (plans/PLAN-native-scrollbars.md, decision 2); a pointer that
    // goes down on a thumb presses it until the pointer goes up.
    const pointerRecord = records.findLast((record) => record.kind.startsWith("pointer-"));
    if (surface && pointerRecord) {
      const positioned = (record) => record.kind !== "pointer-leave" && snapshot &&
        typeof record.x === "number" && typeof record.y === "number";
      let pressed;
      for (const record of records) {
        if (record.kind === "pointer-down" && positioned(record)) {
          const bar = scrollbarAtPoint(snapshot, record.x, record.y);
          pressed = bar && record.x >= bar.thumb.x && record.x < bar.thumb.x + bar.thumb.width &&
              record.y >= bar.thumb.y && record.y < bar.thumb.y + bar.thumb.height
            ? bar
            : null;
        } else if (record.kind === "pointer-up" || record.kind === "pointer-cancel") {
          pressed = null;
        }
      }
      surface._noteScrollbarPointer(
        positioned(pointerRecord) ? scrollbarAtPoint(snapshot, pointerRecord.x, pointerRecord.y) : null,
        pressed,
      );
    }
    return results;
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
  // Host editing commands: 1 text edit (code = input type), 2 select all,
  // 3 clipboard (code 1 copy, 2 cut, 3 paste). The engine owns every
  // default; see $inputEditPrepare.
  function edit(root, operation, target, command, code, text, record) {
    if (typeof text !== "string") throw new TypeError(`${operation}: text must be a string, received ${typeof text}`);
    if (typeof target?._coreHandle !== "bigint") throw new TypeError(`${operation}: target must be a Sandom node, received ${String(target)}`);
    const state = stateFor(root);
    state.root = root;
    const batch = invoke(state.core, "input_edit_begin", state.handle, target._coreHandle, root._coreHandle, command, code, ...state.core.input(text));
    return runOwned(state, root, snapshotFor(root, false), batch, [record]);
  }
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
    insertText(root, text, { inputType = "insertText", target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      const code = inputTypeCode("insertText", inputType, INSERT_TEXT_TYPES);
      return edit(root, "insertText", target, 1, code, text, { kind: "text-edit", text }).valueChanged;
    },
    deleteSelection(root, { inputType = "deleteContentBackward", target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      const code = inputTypeCode("deleteSelection", inputType, DELETE_SELECTION_TYPES);
      return edit(root, "deleteSelection", target, 1, code, "", { kind: "text-edit", text: "" }).valueChanged;
    },
    selectAll(root, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      edit(root, "selectAll", target, 2, 0, "", { kind: "select-all" });
    },
    copy(root, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      return edit(root, "copy", target, 3, 1, "", { kind: "clipboard", clipboardData: new SDDataTransfer() }).copiedText;
    },
    cut(root, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      return edit(root, "cut", target, 3, 2, "", { kind: "clipboard", clipboardData: new SDDataTransfer() }).copiedText;
    },
    paste(root, text, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      const clipboardData = new SDDataTransfer();
      if (typeof text === "string") clipboardData.setData("text/plain", text);
      return edit(root, "paste", target, 3, 3, text, { kind: "clipboard", text, clipboardData }).valueChanged;
    },
  };
  return { ...runtime, ...createInputBindings(runtime) };
}
