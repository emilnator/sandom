// The renderer's image cache outlives component sessions, keyed by URL alone.
// Each page in a browser loads its own resources: the HTTP cache may reuse a response, but
// a resource the page's own fetch (here, its resolveResource) answers with other bytes is
// decoded from those bytes (HTML §4.8.4.3 "update the image data"; the list of available
// images is per Document). Sandom's scene renderer runtime is process-wide, and it keys
// decoded images by final URL: session B, whose resolver returns a blue image for a URL
// session A's returned red for, paints A's red one.
import { renderComponent } from "./_setup.js";

const RED = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC";
const BLUE = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEUlEQVR4nGNgYPj/HxWTLAAAHGAf4baQ7OcAAAAASUVORK5CYII=";
const bytes = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

async function paint(base64) {
  const component = await renderComponent({
    width: 20,
    height: 20,
    resolveResource: ({ finalURL }) => ({ bytes: bytes(base64), finalURL, contentType: "image/png" }),
    mount: ({ document, container }) => {
      const style = document.createElement("style");
      style.textContent = "body{margin:0}img{display:block;width:20px;height:20px}";
      document.head.append(style);
      const image = document.createElement("img");
      image.setAttribute("src", "https://images.test/logo.png");
      container.append(image);
    },
  });
  const frame = await component.render({ pixels: true });
  const at = (frame.rowStride / frame.pixels.BYTES_PER_ELEMENT) * 10 + 4 * 10;
  const scale = frame.pixels.BYTES_PER_ELEMENT === 1 ? 1 : 255;
  const pixel = [...frame.pixels.subarray(at, at + 3)].map((value) => Math.round(value * scale));
  await component.dispose();
  return pixel;
}

const results = [];
const check = (name, actual, expected) =>
  results.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });
check("session A, resolver answers red", await paint(RED), [255, 0, 0]);
check("session B, same URL, resolver answers blue", await paint(BLUE), [0, 0, 255]);
check("session C, same URL, red again", await paint(RED), [255, 0, 0]);

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)}`);
}
console.log(failed ? `${failed} failed` : "all passed");
