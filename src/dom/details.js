import { createEvent, dispatchEvent } from "./events.js";

// HTML's details toggle task: a change of a details element's open
// attribute queues one task that fires a ToggleEvent named toggle from the
// state before the first change to the state the element has when the task
// runs. A change while the task is pending leaves it as it is, so several
// changes in one task fire one event, as Chrome does, also when the element
// ends where it started. The DOM core lists the changes, the parser's
// included (details.watpart); the task is one timer turn.
const pendingToggles = new Map();

export function queueDetailsToggle(details, wasOpen) {
  if (pendingToggles.has(details)) return;
  pendingToggles.set(details, wasOpen ? "open" : "closed");
  setTimeout(() => {
    const oldState = pendingToggles.get(details);
    pendingToggles.delete(details);
    const newState = details.hasAttribute("open") ? "open" : "closed";
    dispatchEvent(details, createEvent("toggle", { bubbles: false, cancelable: false, oldState, newState }));
  }, 0);
}
