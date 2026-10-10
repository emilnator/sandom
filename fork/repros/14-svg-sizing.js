// The size of an outer <svg> in HTML.
// SVG 2 §8.2 and CSS Images §5.2: width and height on an outer svg are presentation
// attributes for the CSS width and height properties, so width="50%" is 50% of the
// containing block. An outer svg with a viewBox and no width has a natural aspect ratio
// but no natural width, so its auto width fills the line (CSS 2 §10.3.2 / CSS Sizing
// "default sizing algorithm"), and its height follows the ratio. Chrome: width="50%"
// in a 200px block is 100px; <svg viewBox="0 0 10 5"> in a 200px block is 200×100.
// Sandom reads the percentage as pixels (50px) and sizes the viewBox-only svg to the
// viewBox (10×5).
import { renderComponent } from "./_setup.js";

let document_;
const component = await renderComponent({
  width: 400,
  height: 400,
  mount: ({ document, container }) => {
    document_ = document;
    container.innerHTML =
      `<div style="width:200px"><svg id=percent style="display:block" width="50%" height="10"></svg></div>` +
      `<div style="width:200px"><svg id=ratio style="display:block" viewBox="0 0 10 5"></svg></div>`;
  },
});
await component.render({ pixels: false });
const size = (id) => {
  const box = document_.getElementById(id).getBoundingClientRect();
  return [box.width, box.height];
};
const results = [];
const check = (name, actual, expected) =>
  results.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });
check('<svg width="50%" height="10"> in a 200px block', size("percent"), [100, 10]);
check('<svg viewBox="0 0 10 5"> in a 200px block', size("ratio"), [200, 100]);
await component.dispose();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)}`);
}
console.log(failed ? `${failed} failed` : "all passed");
