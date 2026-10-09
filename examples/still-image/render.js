// One PNG from a DOM built in the process: a release card with a heading, a
// paragraph, and a two-column table, styled by an ordinary stylesheet. Then
// more cards from the same kept surface: each changes two text nodes and a
// class, and each frame costs what those nodes changed.
//
//   node render.js            (after npm install)
//   deno run -A render.js     (after deno install)
//
// Writes release-card.png, release-card-beta.png and
// release-card-nightly.png to the working directory.

import { createRenderSurface, createSandomDOM, encodeImage, loadFont } from "sandom";
import { writeFile } from "node:fs/promises";
import process from "node:process";

// Deno has WebGPU built in; Node mounts Dawn from the optional `webgpu`
// dependency through sandom/gpu.
if (!globalThis.navigator?.gpu) await import("sandom/gpu");

const WIDTH = 480;
const HEIGHT = 300;

// Sandom has no system fonts: every family the document names is loaded.
// The package ships Inter and IBM Plex Mono under test-assets/.
const fontDirectory = new URL("../test-assets/", import.meta.resolve("sandom"));
const fonts = await Promise.all([
  loadFont("Inter", new URL("Inter-Variable.ttf", fontDirectory)),
  loadFont("IBM Plex Mono", new URL("IBMPlexMono-Regular.ttf", fontDirectory)),
]);

const dom = createSandomDOM({ viewportW: WIDTH, viewportH: HEIGHT });
const root = dom.createElement("main");
// A <style> element applies once the tree is connected to the document.
dom.document.appendChild(root);
root.innerHTML = `
  <style>
    main {
      width: ${WIDTH}px; height: ${HEIGHT}px; box-sizing: border-box;
      padding: 28px 32px; font-family: "Inter";
      background: linear-gradient(135deg, #10172a, #1e2b4f);
      color: #e8edf8;
    }
    h1 { margin: 0 0 6px; font-size: 26px; font-weight: 700; }
    p { margin: 0 0 18px; color: #a9b6d3; font-size: 14px; line-height: 1.45; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    td { padding: 7px 0; border-top: 1px solid rgba(255, 255, 255, 0.12); }
    td:last-child { text-align: right; font-family: "IBM Plex Mono"; color: #8fd3ff; }
    .badge {
      display: inline-block; margin-left: 8px; padding: 2px 8px;
      border-radius: 999px; background: #3366d9; font-size: 12px;
      vertical-align: 4px;
    }
    .badge.beta { background: #b7791f; }
    .badge.nightly { background: #7b4bd1; }
  </style>
  <h1>Release card<span class="badge">stable</span></h1>
  <p>A DOM tree built in this process, laid out by Sandom's engine, and
  rasterized on the GPU.</p>
  <table>
    <tr><td>Layout</td><td>WebAssembly</td></tr>
    <tr><td>Raster</td><td>WebGPU</td></tr>
    <tr><td>Version</td><td class="version">0.5.0</td></tr>
  </table>
`;

const surface = createRenderSurface(root, {
  viewportWidth: WIDTH,
  viewportHeight: HEIGHT,
});
surface.stop(); // no host frame loop: this program renders on demand
// `pixels: true` reads the frame back to the CPU, which a file needs.
const frame = await surface.renderNow({ pixels: true });
const png = await encodeImage(frame, { format: "png" });
await writeFile("release-card.png", png);
console.log(`wrote release-card.png (${frame.width}×${frame.height}, ${png.byteLength} bytes)`);

// Many images from one kept surface. The card is not built again: keep the
// nodes that differ between images, set their text and the badge's class,
// and render. The class goes on the badge, not the root: a class on the
// root restyles every element under it. The surface keeps its layout,
// glyphs and GPU target, so each image after the first pays only for the
// nodes it changed; a new document or a new surface per image pays for the
// whole card again.
const badge = root.querySelector(".badge");
const channel = badge.firstChild;
const version = root.querySelector(".version").firstChild;
for (const release of [
  { channel: "beta", version: "0.6.0-beta.2" },
  { channel: "nightly", version: "0.6.0-nightly.1009" },
]) {
  badge.className = `badge ${release.channel}`;
  channel.data = release.channel;
  version.data = release.version;
  const started = performance.now();
  const next = await surface.renderNow({ pixels: true });
  const milliseconds = performance.now() - started;
  const name = `release-card-${release.channel}.png`;
  await writeFile(name, await encodeImage(next, { format: "png" }));
  console.log(
    `wrote ${name} in ${milliseconds.toFixed(1)} ms, ` +
      `${next.dirtyRectangles.length} dirty ${next.dirtyRectangles.length === 1 ? "rectangle" : "rectangles"}`,
  );
}

// serializations and layoutPasses count frames that built the scene from
// the tree again or ran a separate layout pass; retainedCleanFrames counts
// frames that reused the retained scene as it was.
const { serializations, layoutPasses, retainedCleanFrames } = surface.frameStageCounters;
console.log({ serializations, layoutPasses, retainedCleanFrames });

await surface.shutdown();
for (const font of fonts) font.unload();
// Dawn keeps Node's event loop alive while a GPU device exists.
process.exit(0);
