// Frozen-snapshot transport. Native scrolling owns chain consumption and
// accumulation; these calls never request live layout or inspect live styles.
import { SCROLL_SOURCES } from "./scroll-core.js";
const keyCodes = Object.freeze({ ArrowLeft: 1, ArrowRight: 2, ArrowUp: 3, ArrowDown: 4, PageUp: 5, PageDown: 6, Home: 7, End: 8, " ": 9 });
export function scrollByChained(surface, snapshot, target, deltaX, deltaY, source) {
  const core = snapshot.geometryCore;
  if (!surface) return { remainingX: deltaX, remainingY: deltaY };
  const changed = core.status("scroll_chain", surface._scrollOwner, snapshot.geometryHandle, target?._coreHandle ?? 0n, deltaX, deltaY, SCROLL_SOURCES[source] ?? 0);
  const result = { remainingX: core.status("scroll_remaining", 0), remainingY: core.status("scroll_remaining", 1) };
  if (changed) {
    surface._snapCheckPending = true;
    surface._dirty = true;
    surface._schedule();
  }
  return result;
}
export function wheelDeltas(snapshot, target, deltaX, deltaY, deltaMode) {
  if (![0, 1, 2].includes(deltaMode)) throw new RangeError(`Unknown wheel deltaMode ${deltaMode}`);
  const core = snapshot.geometryCore;
  core.status("scroll_wheel", snapshot.geometryHandle, target?._coreHandle ?? 0n, deltaX, deltaY, deltaMode);
  return { deltaX: core.status("scroll_remaining", 0), deltaY: core.status("scroll_remaining", 1) };
}
export function keyboardDeltas(snapshot, target, key, shiftKey = false) {
  const core = snapshot.geometryCore;
  if (!core.status("scroll_key", snapshot.geometryHandle, target?._coreHandle ?? 0n, keyCodes[key] ?? 0, shiftKey ? 1 : 0)) return null;
  return { deltaX: core.status("scroll_remaining", 0), deltaY: core.status("scroll_remaining", 1) };
}
