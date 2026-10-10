// A kept component session whose page runs a requestAnimationFrame loop, between renders.
// HTML §8.10.1 (update the rendering): animation frame callbacks run once per rendering
// opportunity, at the display's refresh rate (60 Hz here), and not at all for a hidden
// document (§8.1.7.3 "update the rendering": docs that are not fully active / hidden are
// skipped; Chrome throttles background tabs). Under Deno there's no requestAnimationFrame,
// and the surface's live loop, restarted after every render, falls back to setTimeout(0):
// the page gets a frame every turn of the event loop, on the CPU and GPU, while the host
// waits for its next request. A host also has no way to pause the session.
import { renderComponent } from "./_setup.js";

let frames = 0;
const component = await renderComponent({
  width: 100,
  height: 100,
  mount: ({ container }) => {
    const box = container.ownerDocument.createElement("div");
    container.append(box);
    const step = () => {
      frames += 1;
      box.style.width = `${frames % 50}px`;
      globalThis.requestAnimationFrame(step);
    };
    globalThis.requestAnimationFrame(step);
  },
});
await component.render({ pixels: true });

const idle = async (ms) => {
  const start = frames;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return frames - start;
};

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const live = await idle(1000);
check("live session: at most a 60 Hz display's frames in 1 s", live <= 66, `${live} frames`);

if (typeof component.pause === "function") {
  await component.pause();
  const paused = await idle(500);
  check("paused session: no animation frames", paused === 0, `${paused} frames in 0.5 s`);
  await component.resume();
  const resumed = await idle(200);
  check("resumed session: frames again", resumed > 0, `${resumed} frames in 0.2 s`);
  // A render while paused paints, then the session stays paused.
  await component.pause();
  await component.render({ pixels: false });
  const after = await idle(300);
  check("render while paused: no frames after it", after <= 1, `${after} frames in 0.3 s`);
} else {
  check("component.pause()/resume() exist", false, "typeof component.pause: " + typeof component.pause);
}
await component.dispose();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
}
console.log(failed ? `${failed} failed` : "all passed");
