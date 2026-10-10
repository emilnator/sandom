// Reading layout synchronously (offsetWidth, getBoundingClientRect) while an <img> hasn't
// loaded yet. In a browser the read succeeds: an image that hasn't loaded has no intrinsic
// size yet (HTML §4.8.4.3 "image request" state "unavailable"; CSS Images §5.2: no natural
// dimensions), so it lays out from its width/height attributes or as 0×0, and the layout
// changes when the image loads.
import { renderComponent } from "./_setup.js";

// A 2×1 red PNG.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=";

const results = [];
const check = (name, run, expected) => {
  let actual;
  try {
    actual = run();
  } catch (error) {
    actual = `${error.name}: ${error.message.slice(0, 160)}`;
  }
  results.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });
};

let image;
let natural;
const component = await renderComponent({
  width: 200,
  height: 100,
  mount: ({ document, container }) => {
    image = document.createElement("img");
    image.setAttribute("src", PNG);
    image.setAttribute("width", "40");
    container.append(image);
    // A sized sibling, read the same way: only the image is in question.
    const box = document.createElement("div");
    box.style.width = "30px";
    container.append(box);
    check("sibling offsetWidth before first render", () => box.offsetWidth, 30);
    check("img offsetWidth before first render (width attribute)", () => image.offsetWidth, 40);
    check("img getBoundingClientRect().width before first render",
      () => image.getBoundingClientRect().width, 40);
    natural = document.createElement("img");
    natural.setAttribute("src", `${PNG}#natural`);
    container.append(natural);
    // Its size until it loads is a broken image's; this only asks that the read succeeds.
    check("img without size attributes before first render: the read succeeds",
      () => typeof natural.offsetWidth, "number");
  },
});
await component.render({ pixels: false });
check("img offsetWidth after first render", () => image.offsetWidth, 40);
check("img without size attributes after first render: its natural width", () => natural.offsetWidth, 2);
// An image added after the first render, read before the next one.
const late = image.ownerDocument.createElement("img");
late.setAttribute("src", `${PNG}#late`);
image.parentNode.append(late);
check("img added after first render, read before the next: the read succeeds",
  () => typeof late.offsetWidth, "number");
await component.render({ pixels: false });
check("that img after the next render", () => late.offsetWidth, 2);
await component.dispose();
let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)}`);
}
console.log(failed ? `${failed} failed` : "all passed");
