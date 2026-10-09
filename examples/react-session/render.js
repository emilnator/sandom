// A React 19 application in one kept component session: mounted once, driven
// by input records, rendered again on the same session.
//
//   node render.js            (after npm install)
//   deno run -A render.js     (after deno install)
//
// Writes before.png and after.png to the working directory and prints what
// each frame's accessibility snapshot reports.

import { encodeImage, loadFont, renderComponent } from "sandom";
import React from "react";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { SettingsPanel, STYLESHEET } from "./app.js";

// Deno has WebGPU built in; Node mounts Dawn from the optional `webgpu`
// dependency through sandom/gpu.
if (!globalThis.navigator?.gpu) await import("sandom/gpu");

const WIDTH = 360;
const HEIGHT = 200;

// Sandom has no system fonts: the stylesheet names Inter, which the package
// ships under test-assets/.
const font = await loadFont(
  "Inter",
  new URL("../test-assets/Inter-Variable.ttf", import.meta.resolve("sandom")),
);

// When React's commit lands. React DOM handles a click at discrete priority:
// the update takes the sync lane and commits in a microtask
// (ensureRootIsScheduled → processRootScheduleInMicrotask in react-dom's
// client build), before dispatch() renders. Every other lane — the first
// root.render(), transitions, useDeferredValue — renders in a task of React's
// Scheduler (a setImmediate or MessageChannel callback), and a transition
// render yields to the host every 5 ms, so those commits can land after
// dispatch() has rendered its frame. The session awaits a `ready` promise
// before it renders: mount's result for the first frame, dispatch's second
// argument for an input's frame. The program hands it the commit it needs
// instead of guessing a delay.
//
// SettingsPanel reports each commit from a layout effect; `committed(accept)`
// resolves on the first commit whose state `accept` takes. A click on the
// counter commits twice — the count at once, the deferred schedule after it —
// so the predicate names the state the frame must show.
let awaited = null;
const onCommit = (state) => {
  if (awaited?.accept(state)) {
    awaited.resolve(state);
    awaited = null;
  }
};
const committed = (accept) => new Promise((resolve) => (awaited = { accept, resolve }));

let started = performance.now();
const component = await renderComponent({
  width: WIDTH,
  height: HEIGHT,
  deviceScale: 2, // chosen once for the session's life
  // The URL names the stylesheet; the session reads its source from here.
  stylesheets: [{ url: "https://settings.example/settings.css", source: STYLESHEET }],
  async mount({ container }) {
    // react-dom reads `window` and `document` when it loads and on every
    // update: import it here, after the session has installed them.
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container);
    const ready = committed(() => true);
    root.render(React.createElement(SettingsPanel, { onCommit }));
    return { ready, dispose: () => root.unmount() };
  },
});
// `pixels: true` reads the frame back to the CPU, which a file needs.
const before = await component.render({ pixels: true });
const mountMilliseconds = performance.now() - started;
await writeFile("before.png", await encodeImage(before, { format: "png" }));

// The accessibility snapshot names the session's controls; the counter
// buttons carry the count and the schedule as their description.
const controls = (frame) => {
  const nodes = frame.accessibility.nodes;
  return {
    more: nodes.find((node) => node.role === "button" && node.name === "More reminders"),
    weekly: nodes.find((node) => node.role === "checkbox"),
  };
};
const report = (file, frame, milliseconds) => {
  const { more, weekly } = controls(frame);
  console.log(
    `${file.padEnd(12)}reminders "${more.description}", ` +
      `weekly summary ${weekly.checked ? "on" : "off"}  (${milliseconds.toFixed(1)} ms)`,
  );
};
report("before.png", before, mountMilliseconds);

// One input batch, one frame: an accessibility press on "More reminders",
// then a mouse click at the checkbox's bounds. Both come from the snapshot of
// the frame before; the press names that frame's accessibility revision.
const { more, weekly } = controls(before);
const x = weekly.bounds.x + weekly.bounds.width / 2;
const y = weekly.bounds.y + weekly.bounds.height / 2;
started = performance.now();
const changed = await component.dispatch([
  {
    kind: "accessibility-action",
    accessibilityRevision: before.accessibilityRevision,
    nodeIdentifier: more.identifier,
    action: "press",
  },
  { kind: "pointer-down", pointerId: 1, pointerType: "mouse", x, y },
  { kind: "pointer-up", pointerId: 1, pointerType: "mouse", x, y },
], {
  ready: committed((state) =>
    state.reminders === 3 && state.weeklySummary && state.schedule.length === 3
  ),
});
const dispatchMilliseconds = performance.now() - started;
report("after.png", changed, dispatchMilliseconds);
// The dispatched frame stays on the GPU; one readback for the file.
const after = await component.render({ pixels: true });
await writeFile("after.png", await encodeImage(after, { format: "png" }));

// Disposal unmounts the React root and restores the realm's globals.
await component.dispose();
font.unload();
// Dawn keeps Node's event loop alive while a GPU device exists.
process.exit(0);
