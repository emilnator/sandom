// <img> and <source> attributes set through their IDL properties.
// HTML §4.8.3 (HTMLImageElement) and §4.8.2 (HTMLSourceElement): src, srcset, sizes, alt,
// width and height reflect their content attributes (§2.6.1 "Reflecting content
// attributes in IDL attributes"; src as a URL). React, Preact and most libraries set
// `img.src = …`. Sandom has no HTMLImageElement: `img.src = …` makes an own data property,
// the attribute stays unset, and the image never loads.
import { renderComponent } from "./_setup.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=";
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });

let image;
const component = await renderComponent({
  width: 100,
  height: 50,
  url: "https://example.test/page/",
  mount: ({ document, container }) => {
    image = document.createElement("img");
    image.src = PNG;
    image.alt = "dot";
    image.width = 20;
    container.append(image);
    const source = document.createElement("source");
    source.srcset = "a.png 1x, b.png 2x";
    source.sizes = "100vw";
    check("img.src = … sets the src attribute", image.getAttribute("src"), PNG);
    check("img.alt = … sets the alt attribute", image.getAttribute("alt"), "dot");
    check("img.width = 20 sets the width attribute", image.getAttribute("width"), "20");
    check("source.srcset = … sets the srcset attribute", source.getAttribute("srcset"), "a.png 1x, b.png 2x");
    check("source.sizes = … sets the sizes attribute", source.getAttribute("sizes"), "100vw");
    const relative = document.createElement("img");
    relative.setAttribute("src", "pic.png");
    check("img.src reads the attribute as a URL", relative.src, "https://example.test/page/pic.png");
    check("an img without src reads src as \"\"", document.createElement("img").src, "");
    check("HTMLImageElement is a global, and img is one",
      typeof globalThis.HTMLImageElement === "function" && image instanceof globalThis.HTMLImageElement, true);
  },
});
await component.render({ pixels: false });
// Loaded: 20 px wide from its attribute, 10 tall from the image's 2:1 ratio.
check("the image loads: its height comes from its natural ratio",
  [image.offsetWidth, image.offsetHeight], [20, 10]);
await component.dispose();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)}`);
}
console.log(failed ? `${failed} failed` : "all passed");
