// Frames of a transition a component session's page starts, for a GIF of an interaction.
// A render surface has inspectMotion() and captureFrames() (the motion-gif example), but a
// component session (renderComponent) exposes neither, and its own surface is private:
// a host can render one still frame per call, at whatever time the live loop reached.
import { renderComponent } from "./_setup.js";

let box;
const component = await renderComponent({
  width: 120,
  height: 40,
  mount: ({ document, container }) => {
    const style = document.createElement("style");
    style.textContent = "body{margin:0}#box{width:10px;height:40px;background:rgb(255,0,0);" +
      "transition:width 400ms linear}#box.open{width:110px}";
    document.head.append(style);
    box = document.createElement("div");
    box.id = "box";
    container.append(box);
  },
});
await component.render({ pixels: false });

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });
check("component.inspectMotion is a function", typeof component.inspectMotion === "function",
  typeof component.inspectMotion);
check("component.captureFrames is a function", typeof component.captureFrames === "function",
  typeof component.captureFrames);

if (typeof component.captureFrames === "function") {
  // The interaction: the page opens the box, which starts a 400 ms transition.
  box.className = "open";
  const motion = await component.inspectMotion();
  check("inspectMotion after the change: a finite motion of 400 ms",
    motion.classification === "finite" && motion.finiteDurationMilliseconds === 400,
    `${motion.classification}, ${motion.finiteDurationMilliseconds} ms`);
  // Red pixels in the middle row: the box's width at each sample.
  const widths = [];
  for await (const frame of component.captureFrames({ frameBudget: 8 })) {
    const floats = frame.pixels.BYTES_PER_ELEMENT === 4;
    const row = (frame.height >> 1) * frame.width * 4;
    let red = 0;
    for (let x = 0; x < frame.width; x++) {
      const r = frame.pixels[row + 4 * x] * (floats ? 255 : 1);
      const g = frame.pixels[row + 4 * x + 1] * (floats ? 255 : 1);
      if (r > 200 && g < 50) red += 1;
    }
    widths.push(red);
  }
  check("captured several frames", widths.length >= 4, `${widths.length} frames`);
  check("the box widens across them, from 10 towards 110 px",
    widths[0] < 40 && widths.at(-1) > 80 && widths.every((w, i) => i === 0 || w >= widths[i - 1]),
    JSON.stringify(widths));
  const after = await component.render({ pixels: false });
  check("the session renders again afterwards", after.width === 120, `${after.width}×${after.height}`);
}
await component.dispose();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
}
console.log(failed ? `${failed} failed` : "all passed");
