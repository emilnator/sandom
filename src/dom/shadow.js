import { createEvent, dispatchEvent } from "./events.js";

const pendingSlotChanges = new Set();
let slotChangeQueued = false;

// The core reports every slot whose assigned nodes changed as one callback
// record per operation. Delivery keeps the platform's microtask batching: one
// slotchange event per slot per turn, in first-change order.
export function queueSlotChange(slot) {
  pendingSlotChanges.add(slot);
  if (slotChangeQueued) return;
  slotChangeQueued = true;
  queueMicrotask(() => {
    slotChangeQueued = false;
    const changed = [...pendingSlotChanges];
    pendingSlotChanges.clear();
    for (const current of changed) {
      dispatchEvent(current, createEvent("slotchange", { bubbles: true }));
    }
  });
}

export function containingShadowRoot(node) {
  const root = node?.getRootNode?.();
  return root?.host ? root : null;
}

export function shadowIncludingParent(node) {
  return node?.parentNode ?? containingShadowRoot(node)?.host ?? null;
}

export function flatTreeChildren(node) {
  if (!node?._coreHandle) return [];
  return node._domCore.flatTreeChildren(node._coreHandle);
}

export function flatTreeParent(node) {
  if (!node?._coreHandle) return null;
  return node._domCore.flatTreeParent(node._coreHandle);
}
