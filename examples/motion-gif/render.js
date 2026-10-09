// An animated GIF of a deploy-status card whose spinner, progress sweep, and
// pulsing dots are CSS keyframe animations in the document.
//
//   node render.js            (after npm install)
//   deno run -A render.js     (after deno install)
//
// Writes deploy-status.gif to the working directory.

import {
  createGifRecorder,
  createRenderSurface,
  createSandomDOM,
  loadFont,
  recommendMotionCapture,
} from "sandom";
import { writeFile } from "node:fs/promises";
import process from "node:process";

// Deno has WebGPU built in; Node mounts Dawn from the optional `webgpu`
// dependency through sandom/gpu.
if (!globalThis.navigator?.gpu) await import("sandom/gpu");

const WIDTH = 320;
const HEIGHT = 180;
// Chosen once for the surface's life; the GIF is WIDTH × HEIGHT × SCALE.
const SCALE = 2;

// Sandom has no system fonts: every family the document names is loaded.
const font = await loadFont(
  "Inter",
  new URL("../test-assets/Inter-Variable.ttf", import.meta.resolve("sandom")),
);

const dom = createSandomDOM({
  viewportW: WIDTH,
  viewportH: HEIGHT,
  deviceScale: SCALE,
});
const root = dom.createElement("main");
// A <style> element applies once the tree is connected to the document.
dom.document.appendChild(root);
// All motion is declared here. The durations share a 2 s period (1 s and
// 2 s), so the capture below can prove one loop and the GIF repeats without
// a seam. The colours are flat and sit on the GIF's fixed 6×7×6 palette, which
// has no dithering: a gradient would band.
root.innerHTML = `
  <style>
    main {
      width: ${WIDTH}px; height: ${HEIGHT}px; box-sizing: border-box;
      padding: 22px 24px; font-family: "Inter";
      background: #ffffff; color: #000033;
    }
    header { display: flex; align-items: center; gap: 12px; }
    .spinner {
      width: 22px; height: 22px; box-sizing: border-box;
      border: 3px solid #ccd5ff; border-top-color: #0055cc;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    h1 { margin: 0; font-size: 20px; font-weight: 700; }
    p { margin: 14px 0 18px; color: #335599; font-size: 13px; }
    .track {
      position: relative; height: 8px; overflow: hidden;
      border-radius: 4px; background: #ccd5ff;
    }
    .sweep {
      position: absolute; top: 0; left: 0; width: 35%; height: 100%;
      border-radius: 4px; background: #0055cc;
      animation: sweep 2s ease-in-out infinite;
    }
    footer { display: flex; gap: 8px; margin-top: 22px; }
    .dot {
      width: 10px; height: 10px; border-radius: 50%; background: #0055cc;
      animation: pulse 1s ease-in-out infinite;
    }
    .dot:nth-child(2) { animation-delay: -0.75s; }
    .dot:nth-child(3) { animation-delay: -0.5s; }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes sweep {
      from { transform: translateX(-100%); }
      to { transform: translateX(290%); }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(0.4); }
      50% { transform: scale(1); }
    }
  </style>
  <header><div class="spinner"></div><h1>Deploying</h1></header>
  <p>Building assets for production</p>
  <div class="track"><div class="sweep"></div></div>
  <footer><div class="dot"></div><div class="dot"></div><div class="dot"></div></footer>
`;

const surface = createRenderSurface(root, {
  viewportWidth: WIDTH,
  viewportHeight: HEIGHT,
  deviceScale: SCALE,
});
// captureFrames() drives the surface's animation clock itself, so the host
// frame loop stays off.
surface.stop();
// The first frame starts the animations and seeds a CPU snapshot; every
// captured frame after it reads back only its dirty rectangles.
await surface.renderNow({ pixels: true });

// The recommendation proves the animations' shared period (2000 ms) and a
// frame budget for it at 25 frames per second, a whole number of GIF
// centiseconds per frame.
const recommendation = recommendMotionCapture(
  { kind: "motion-facts", version: 1, ...surface.inspectMotion() },
  { preferredFrameRate: 25 },
);
if (recommendation.kind !== "periodic") {
  throw new Error(`expected a periodic animation, got ${recommendation.kind}`);
}

// createGifRecorder in sandom 0.5.0 compares only the first candidate
// rectangle, so a frame's damage goes in as one rectangle that bounds it.
function damageBounds(rectangles) {
  if (rectangles.length === 0) return rectangles;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const { x, y, width, height } of rectangles) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }
  return [{ x: left, y: top, width: right - left, height: bottom - top }];
}

const recorder = createGifRecorder({
  width: WIDTH * SCALE,
  height: HEIGHT * SCALE,
});
let sampleCount = 0;
for await (
  const frame of surface.captureFrames({
    frameBudget: recommendation.sampling.recommendedFrameBudget,
    durationMilliseconds: recommendation.periodMilliseconds,
  })
) {
  // The pixels are borrowed until the next frame; addFrame copies them. The
  // damage limits the encoder's comparison to what changed, and a sample
  // with no visible change lengthens the previous GIF frame.
  recorder.addFrame({
    pixels: frame.pixels,
    candidateRectangles: damageBounds(frame.dirtyRectangles),
    durationMilliseconds: frame.durationMilliseconds,
  });
  sampleCount++;
}
const gif = recorder.finish();
await writeFile("deploy-status.gif", gif);
console.log(
  `wrote deploy-status.gif (${WIDTH * SCALE}×${HEIGHT * SCALE}, ` +
    `${sampleCount} samples over ${recommendation.periodMilliseconds} ms, ` +
    `${gif.byteLength} bytes)`,
);

await surface.shutdown();
font.unload();
// Dawn keeps Node's event loop alive while a GPU device exists.
process.exit(0);
