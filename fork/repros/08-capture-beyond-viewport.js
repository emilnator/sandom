// A screenshot of the whole page, taller than the viewport, that the page can't observe.
// Chrome's full-page capture (DevTools Protocol Page.captureScreenshot with
// captureBeyondViewport: true, which Puppeteer's and Playwright's fullPage use) paints the
// document beyond the viewport without resizing the layout viewport: no resize event
// (CSSOM View §13.1 "run the resize steps" doesn't run), no media query change
// (CSSOM View §4.2), no ResizeObserver or IntersectionObserver callbacks, and
// innerHeight stays. A component session can only resize its viewport, which the page
// sees, and setVisibleRectangle selects a part of the viewport-sized scene, so nothing
// beyond the viewport is painted.
import { renderComponent } from "./_setup.js";

const VIEWPORT = 200;
const PAGE = 500;
const seen = [];
let document_;
const component = await renderComponent({
  width: 100,
  height: VIEWPORT,
  mount: ({ document, container }) => {
    document_ = document;
    const style = document.createElement("style");
    style.textContent = "body{margin:0}#top{height:" + (PAGE - 50) + "px;background:rgb(0,0,255)}" +
      "#tail{height:50px;background:rgb(255,0,0)}" +
      "#screen{position:absolute;top:0;width:1px;height:100vh}";
    document.head.append(style);
    container.innerHTML = "<div id=top></div><div id=tail></div><div id=screen></div>";
    new globalThis.ResizeObserver((entries) => {
      for (const entry of entries) seen.push(`resize observer ${entry.contentRect.height}`);
    }).observe(document.getElementById("screen"));
    globalThis.addEventListener("resize", () => seen.push(`resize ${globalThis.innerHeight}`));
    globalThis.matchMedia(`(max-height: ${VIEWPORT}px)`)
      .addEventListener("change", (event) => seen.push(`media change ${event.matches}`));
    new globalThis.IntersectionObserver((entries) => {
      for (const entry of entries) seen.push(`intersection ${entry.isIntersecting}`);
    }).observe(document.getElementById("tail"));
  },
});
await component.render({ pixels: false });
seen.length = 0;

// Frames carry float RGBA samples; rowStride is in bytes.
const pixelAt = (frame, y) => {
  const scale = frame.pixels.BYTES_PER_ELEMENT === 1 ? 1 : 255;
  const at = (frame.rowStride / frame.pixels.BYTES_PER_ELEMENT) * y + 4 * 10;
  return [...frame.pixels.subarray(at, at + 3)].map((value) => Math.round(value * scale));
};

let frame;
let how;
if (typeof component.capture === "function") {
  how = "component.capture({ height })";
  frame = await component.capture({ height: PAGE });
} else {
  // Today's options: resize the viewport (the page sees it) ...
  how = "component.resize({ height }) then back";
  await component.resize({ width: 100, height: PAGE });
  frame = await component.render({ pixels: true });
  await component.resize({ width: 100, height: VIEWPORT });
}
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });
console.log(`capturing with ${how}`);
check("frame height in CSS px", frame.height / (frame.deviceScale ?? 1), PAGE);
check("pixel at the bottom row is the tail's red", pixelAt(frame, PAGE - 5), [255, 0, 0]);
check("callbacks the page saw", seen, []);
check("innerHeight afterwards", globalThis.innerHeight, VIEWPORT);
const after = await component.render({ pixels: true });
check("the session's next frame: height", after.height / (after.deviceScale ?? 1), VIEWPORT);
check("the session's next frame: callbacks the page saw", seen, []);

// ... or select a visible rectangle beyond the viewport: nothing is painted there.
const surface = document_._componentRenderSurface;
surface.setVisibleRectangle({ x: 0, y: 0, width: 100, height: PAGE });
const selected = await component.render({ pixels: true });
// Not a check: setVisibleRectangle is raster-only by design; this shows why it can't help.
console.log(`NOTE setVisibleRectangle(0, 0, 100, ${PAGE}): frame ${selected.width}×${selected.height}, ` +
  `bottom row ${JSON.stringify(pixelAt(selected, PAGE - 5))} (the tail is red; beyond the viewport is unpainted)`);
surface.setVisibleRectangle(null);
await component.dispose();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)}`);
}
console.log(failed ? `${failed} failed` : "all passed");
