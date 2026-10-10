// <img> and <svg> are inline-level replaced elements.
// CSS Display §2 and HTML §15.4.1: img's and an outer svg's display is the initial
// `inline` (no UA rule changes it); an inline replaced element is an atomic inline box
// that sits on the line beside text (CSS 2 §10.3.2, §10.6.2), its bottom on the baseline.
// Sandom lays both out as blocks, each on a line of its own. With display:inline-block an
// img sits on the line, but an outer svg still doesn't.
import { renderComponent } from "./_setup.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=";
let document_;
const component = await renderComponent({
  width: 400,
  height: 200,
  mount: ({ document, container }) => {
    document_ = document;
    container.innerHTML = `<p id=a style="margin:0">x<img id=img src="${PNG}" width=20 height=10>y</p>` +
      `<p id=b style="margin:0">x<svg id=svg width=10 height=10></svg>y</p>` +
      `<p id=c style="margin:0">x<svg id=svgib style="display:inline-block" width=10 height=10></svg>y</p>`;
  },
});
await component.render({ pixels: false });
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });
for (const [line, id] of [["a", "img"], ["b", "svg"], ["c", "svgib"]]) {
  const element = document_.getElementById(id);
  const box = element.getBoundingClientRect();
  const lineBox = document_.getElementById(line).getBoundingClientRect();
  // On the first line, after the "x".
  check(`<${element.localName}${id === "svgib" ? " inline-block" : ""}> sits on the line after "x"`,
    box.left > lineBox.left && box.top < lineBox.top + 20, true);
}
await component.dispose();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)}`);
}
console.log(failed ? `${failed} failed` : "all passed");
