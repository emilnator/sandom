import { createEvent, dispatchEvent } from "./events.js";

// Only values with JavaScript identity (including nonnumeric direct selection
// assignments) live here. Numeric positions, dirty flags and strings live in core.
const identities = new WeakMap();
function identityFields(node) {
  let fields = identities.get(node);
  if (!fields) identities.set(node, fields = new Map());
  return fields;
}
function status(node, operation, ...args) {
  return node._domCore.status(`input_control_${operation}`, node._coreHandle, ...args);
}
function string(node, operation) {
  return node._domCore.string(`input_control_${operation}`, node._coreHandle);
}
function clamp(node, value, length, minimum = 0) {
  // Unary + is ToNumber, unlike Number() it rejects BigInt as Math.min does.
  return node._domCore.status("input_control_clamp", +value, +length, minimum);
}
export function copyControlIdentities(source, clone) {
  // Native node_clone has already copied portable state. These ordered public
  // reads/writes transport realm identities and preserve overridden descriptors.
  clone._value = source._value;
  clone._valueDirty = source._valueDirty;
  clone._checked = source._checked;
  clone._checkedDirty = source._checkedDirty;
  clone._selected = source._selected;
  clone._selectedDirty = source._selectedDirty;
  clone.selectionStart = source.selectionStart;
  clone.selectionEnd = source.selectionEnd;
  clone.selectionDirection = source.selectionDirection;
}
export const inputControlRuntime = {
  options(node) {
    return status(node, "is_select") ? node.querySelectorAll("option") : undefined;
  },
  selectedIndex(node) {
    return status(node, "selected_index");
  },
  setSelectedIndex(node, value) {
    if (!status(node, "is_select")) return;
    const normalized = Number(value);
    // Iteration and each public setter remain host-observable, including partial
    // effects when a getter, iterator, setter or mutation callback throws.
    const options = [...node.options];
    options.forEach((option, index) => {
      option.selected = Boolean(node._domCore.status("input_control_index_matches", index, normalized));
    });
  },
  value(node) {
    const source = status(node, "value_source");
    if (source === 1) return string(node, "value");
    if (source === 2) return node._value;
    const authored = node.getAttribute("value");
    if (authored !== null) return authored;
    return source === 3 ? node.textContent : "";
  },
  setValue(node, value) {
    const normalized = String(value);
    if (status(node, "is_select")) {
      let state = 0;
      for (const option of node.options) {
        // Native response bit2 suppresses subsequent observable value reads.
        let decision = state;
        if (!state) {
          const other = option.value;
          if (typeof other === "string") {
            decision = node._domCore.status("input_control_value_matches",
              ...node._domCore.input(normalized), ...node._domCore.input(other), state);
          }
        }
        option.selected = Boolean(decision & 1);
        state = decision & 2;
      }
      return;
    }
    // A realm value cannot be strictly equal to the normalized string even if
    // its truthiness/previous native bytes coincide with the normalized value.
    if (identities.get(node)?.has("_value")) status(node, "raw_set", 4, 0);
    if (status(node, "value_set", ...node._domCore.input(normalized))) {
      identities.get(node)?.delete("_value");
      identities.get(node)?.delete("_valueDirty");
      node._notifyMutation("property");
    }
  },
  editValue(node, value, selectionStart, selectionEnd = selectionStart) {
    const normalized = String(value);
    const nextStart = clamp(node, selectionStart, normalized.length);
    const nextEnd = clamp(node, selectionEnd, normalized.length, nextStart);
    const valueChanged = status(node, "value_differs", ...node._domCore.input(normalized)) ||
      identities.get(node)?.has("_value");
    const selectionChanged = node.selectionStart !== nextStart ||
      node.selectionEnd !== nextEnd || node.selectionDirection !== "none";
    status(node, "value_set", ...node._domCore.input(normalized));
    identities.get(node)?.delete("_value");
    identities.get(node)?.delete("_valueDirty");
    node.selectionStart = nextStart;
    node.selectionEnd = nextEnd;
    node.selectionDirection = "none";
    if (valueChanged) node._notifyMutation("property");
    if (selectionChanged) node._notifyMutation("selection");
  },
  defaultValue(node) {
    return status(node, "is_textarea") ? node.textContent : node.getAttribute("value") ?? "";
  },
  setDefaultValue(node, value) {
    if (status(node, "is_textarea")) node.textContent = String(value);
    else node.setAttribute("value", String(value));
  },
  disabled(node) { return Boolean(status(node, "disabled")); },
  setDisabled(node, value) { node.toggleAttribute("disabled", Boolean(value)); },
  checked(node) {
    const source = status(node, "state_source", 0);
    return source === 2 ? node._checked : Boolean(source);
  },
  setChecked(node, value) {
    if (identities.get(node)?.has("_checked")) status(node, "raw_set", 1, 0);
    if (status(node, "checked_set", Boolean(value))) {
      identities.get(node)?.delete("_checked");
      identities.get(node)?.delete("_checkedDirty");
      node._notifyMutation("state", "checked");
    }
  },
  selected(node) {
    const source = status(node, "state_source", 1);
    return source === 2 ? node._selected : Boolean(source);
  },
  setSelected(node, value) {
    if (identities.get(node)?.has("_selected")) status(node, "raw_set", 3, 0);
    if (status(node, "selected_set", Boolean(value))) {
      identities.get(node)?.delete("_selected");
      identities.get(node)?.delete("_selectedDirty");
      node._notifyMutation("state", "selected");
    }
  },
  form(node) { return node._domCore.wrapperFor(status(node, "form")); },
  tabIndex(node) { return status(node, "tab_index"); },
  setTabIndex(node, value) { node.setAttribute("tabindex", String(Number(value))); },
  type(node) { return string(node, "type"); },
  setType(node, value) { node.setAttribute("type", String(value)); },
  selection(node, field) {
    const tag = status(node, "selection_tag", field);
    if (tag === 0) return null;
    if (tag === 2) return identities.get(node)?.get(field);
    return status(node, "selection_get", field);
  },
  setSelection(node, field, value) {
    if (value === null) {
      status(node, "selection_set", field, 0, 0);
      identities.get(node)?.delete(field);
    } else if (typeof value === "number") {
      status(node, "selection_set", field, 1, value);
      identities.get(node)?.delete(field);
    } else {
      status(node, "selection_set", field, 2, 0);
      identityFields(node).set(field, value);
    }
  },
  direction(node) {
    const token = status(node, "direction");
    return token === 0 ? "none" : token === 1 ? "forward" : token === 2 ? "backward" : identities.get(node)?.get("direction");
  },
  setDirection(node, value) {
    const token = value === "none" ? 0 : value === "forward" ? 1 : value === "backward" ? 2 : 3;
    status(node, "direction_set", token);
    if (token === 3) identityFields(node).set("direction", value);
    else identities.get(node)?.delete("direction");
  },
  setSelectionRange(node, start, end, direction = "none") {
    const value = typeof node.value === "string" ? node.value : node.textContent ?? "";
    // Do not normalize end before publishing start: its conversion can throw or
    // reenter and must observe the already-assigned start. Clamp independently.
    node.selectionStart = clamp(node, start, value.length);
    node.selectionEnd = clamp(node, end, value.length);
    node.selectionDirection = direction;
    dispatchEvent(node, createEvent("select", { bubbles: true }));
    node._notifyMutation("selection");
  },
  select(node) {
    const value = typeof node.value === "string" ? node.value : node.textContent ?? "";
    node.setSelectionRange(0, value.length);
  },
  raw(node, name, field) {
    const fields = identities.get(node);
    if (fields?.has(name)) return fields.get(name);
    return Boolean(status(node, "raw_get", field));
  },
  setRaw(node, name, field, value) {
    status(node, "raw_set", field, Boolean(value));
    if (typeof value === "boolean") identities.get(node)?.delete(name);
    else identityFields(node).set(name, value);
  },
  rawValue(node) {
    const fields = identities.get(node);
    if (fields?.has("_value")) return fields.get("_value");
    return node._domCore.nodeString("node_aux_a", node._coreHandle) ?? "";
  },
  setRawValue(node, value) {
    // Raw fields have no coercion or mutation callback. Preserve arbitrary host
    // identity, while string storage remains usable by direct native consumers.
    if (typeof value !== "string") {
      identityFields(node).set("_value", value);
      return;
    }
    const dirty = status(node, "raw_get", 4);
    status(node, "value_set", ...node._domCore.input(value));
    status(node, "raw_set", 4, dirty);
    identities.get(node)?.delete("_value");
  },
};
