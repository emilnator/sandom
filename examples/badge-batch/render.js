// Many images from one template: a conference badge per attendee, all from
// one render surface. The template is built once; each badge changes three
// text nodes and one class, so each frame costs what those nodes changed.
//
//   node render.js            (after npm install)
//   deno run -A render.js     (after deno install)
//
// Writes badge-1.png … badge-4.png to the working directory.

import { createRenderSurface, createSandomDOM, encodeImage, loadFont } from "sandom";
import { writeFile } from "node:fs/promises";
import process from "node:process";

// Deno has WebGPU built in; Node mounts Dawn from the optional `webgpu`
// dependency through sandom/gpu.
if (!globalThis.navigator?.gpu) await import("sandom/gpu");

const WIDTH = 360;
const HEIGHT = 220;

const ATTENDEES = [
  { name: "Ada Okafor", role: "Rendering engineer", company: "Northwind Labs", track: "engine" },
  { name: "Mateo Ruiz", role: "Design systems lead", company: "Harbor & Pine", track: "design" },
  { name: "Lin Wei", role: "GPU programmer", company: "Kestrel Works", track: "engine" },
  { name: "Sofia Lindqvist", role: "Product designer", company: "Fjord Studio", track: "design" },
];

const fontDirectory = new URL("../test-assets/", import.meta.resolve("sandom"));
const fonts = await Promise.all([
  loadFont("Inter", new URL("Inter-Variable.ttf", fontDirectory)),
  loadFont("IBM Plex Mono", new URL("IBMPlexMono-Bold.ttf", fontDirectory)),
]);

// The template, built once.
const dom = createSandomDOM({ viewportW: WIDTH, viewportH: HEIGHT });
const root = dom.createElement("main");
dom.document.appendChild(root);
root.innerHTML = `
  <style>
    main {
      width: ${WIDTH}px; height: ${HEIGHT}px; box-sizing: border-box;
      display: flex; flex-direction: column; padding: 24px 28px;
      font-family: "Inter"; background: #f6f4ef; color: #1b1b1f;
      border-top: 14px solid var(--track);
    }
    main.engine { --track: #3366d9; }
    main.design { --track: #d9533f; }
    .event { font: 700 12px "IBM Plex Mono"; letter-spacing: 0.12em; color: var(--track); }
    .name { margin: auto 0 4px; font-size: 30px; font-weight: 750; letter-spacing: -0.01em; }
    .role { font-size: 15px; color: #4a4a55; }
    .company { margin-top: 2px; font-size: 15px; font-weight: 600; }
  </style>
  <div class="event">RENDER CONF 2026</div>
  <div class="name"></div>
  <div class="role"></div>
  <div class="company"></div>
`;
// Keep the text nodes that change; a badge sets their data and nothing else.
const field = (selector) => root.querySelector(selector).appendChild(dom.createTextNode(""));
const name = field(".name");
const role = field(".role");
const company = field(".company");

const surface = createRenderSurface(root, {
  viewportWidth: WIDTH,
  viewportHeight: HEIGHT,
  deviceScale: 2, // print density, chosen once for the surface's life
});
surface.stop(); // no host frame loop: this program renders on demand

for (const [index, attendee] of ATTENDEES.entries()) {
  name.data = attendee.name;
  role.data = attendee.role;
  company.data = attendee.company;
  root.className = attendee.track;

  const started = performance.now();
  const frame = await surface.renderNow({ pixels: true });
  const milliseconds = performance.now() - started;
  await writeFile(`badge-${index + 1}.png`, await encodeImage(frame, { format: "png" }));
  console.log(
    `badge-${index + 1}.png  ${attendee.name.padEnd(16)} ` +
      `${milliseconds.toFixed(1)} ms, ${frame.dirtyRectangles.length} dirty rectangles`,
  );
}

// layoutPasses and serializations count frames that laid out or serialized
// the document again; retainedCleanFrames counts frames that reused the
// retained scene. A kept surface pays only for what changed.
const { serializations, layoutPasses, retainedCleanFrames } = surface.frameStageCounters;
console.log({ serializations, layoutPasses, retainedCleanFrames });

await surface.shutdown();
for (const font of fonts) font.unload();
// Dawn keeps Node's event loop alive while a GPU device exists.
process.exit(0);
