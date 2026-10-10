// Images a disposed component session used stay registered for the process's life.
// The scene renderer runtime is process-wide and its image table has 256 slots
// (IMAGE_TABLE_MAX_ENTRIES); a slot is taken per distinct image and never given back, so
// a long-lived host (a preview server rendering one page after another) fails its 257th
// distinct image, whatever pages it has disposed. In a browser, a closed page's decoded
// images are released with it.
import { renderComponent } from "./_setup.js";

const RED = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC";
const bytes = Uint8Array.from(atob(RED), (c) => c.charCodeAt(0));
const SESSIONS = 300;
let failure = null;
let rendered = 0;
for (let n = 0; n < SESSIONS && failure === null; n++) {
  const component = await renderComponent({
    width: 20,
    height: 20,
    resolveResource: ({ finalURL }) => ({ bytes, finalURL, contentType: "image/png" }),
    mount: ({ document, container }) => {
      const image = document.createElement("img");
      image.setAttribute("src", `https://images.test/${n}.png`);
      container.append(image);
    },
  });
  try {
    await component.render({ pixels: false });
    rendered += 1;
  } catch (error) {
    failure = `session ${n}: ${error.message.split("\n")[0]}`;
  }
  await component.dispose().catch(() => {});
}
const pass = failure === null && rendered === SESSIONS;
console.log(`${pass ? "PASS" : "FAIL"} ${SESSIONS} sessions, one image each, one at a time: ` +
  `${rendered} rendered${failure ? `; ${failure}` : ""}`);
console.log(pass ? "all passed" : "1 failed");
