import { createEvent, dispatchEvent } from "./events.js";

// Event construction and synchronous host invocation only. Native continuations
// choose every target, state transition, default action, and notification order.
const eventNames = [null, "blur", "focusout", "focus", "focusin", "click", "input", "change"];

export function runInputActivation(node, operation) {
  const core = node._domCore;
  const handle = core.handle("input_activation_begin", node._coreHandle, operation);
  try {
    while (true) {
      const action = core.status("input_activation_next", handle);
      if (action === 0) return;
      const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 32);
      // Capture borrowed bytes before resolving wrappers can enter native code.
      const token = view.getBigUint64(0, true);
      const targetHandle = view.getBigUint64(8, true);
      const relatedHandle = view.getBigUint64(16, true);
      let outcome = 0;
      let failure;
      try {
        const target = core.wrapperFor(targetHandle);
        if (action <= 7) {
          let options;
          if (action <= 4) {
            options = { composed: true, relatedTarget: core.wrapperFor(relatedHandle) };
            if (action === 2 || action === 4) options.bubbles = true;
          } else if (action === 5) {
            options = { bubbles: true, cancelable: true, detail: 1 };
          } else if (action === 6) {
            options = { bubbles: true, composed: true, inputType: null, data: null };
          } else {
            options = { bubbles: true };
          }
          if (!dispatchEvent(target, createEvent(eventNames[action], options))) outcome = 1;
        } else if (action <= 10) {
          // A focus row for an ancestor of the focused element carries
          // that element as related: the ancestor's :focus-within changed.
          target._notifyMutation("state", action === 8 && relatedHandle !== 0n ? "focus-within" : ["focus", "checked", "selected"][action - 8]);
        } else if (action === 11) {
          target.focus();
        } else if (action === 12) {
          target.click();
        } else if (action === 13) {
          target.toggleAttribute("open");
        } else if (action === 14) {
          // A plain Event: oldState/newState would not survive the backend's
          // record-based listener delivery, and the state is on the element.
          dispatchEvent(target, createEvent("toggle", { bubbles: false }));
        } else {
          throw new Error("Unknown native activation action");
        }
      } catch (error) {
        outcome = 2;
        failure = error;
      }
      core.status("input_activation_resume", handle, token, outcome);
      if (outcome === 2) throw failure;
    }
  } finally {
    // Cleanup must not reinterpret an already active native error or overwrite
    // the original host exception after a failed action.
    core.exports.input_activation_release(handle);
  }
}
