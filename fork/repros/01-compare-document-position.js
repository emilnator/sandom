// Node.prototype.compareDocumentPosition (DOM Standard §4.4, "compareDocumentPosition(other)").
// Base UI's Select (and floating-ui, Radix, dnd-kit…) call it to order nodes.
import { renderComponent } from "./_setup.js";

const results = [];
const component = await renderComponent({
  width: 200,
  height: 100,
  mount: ({ document, container }) => {
    container.innerHTML = "<ul><li id=a>a</li><li id=b><span id=c>c</span></li></ul>";
    const [a, b, c] = ["a", "b", "c"].map((id) => document.getElementById(id));
    const detached = document.createElement("div");
    const check = (name, run, expected) => {
      let actual;
      try {
        actual = run();
      } catch (error) {
        actual = `${error.name}: ${error.message}`;
      }
      results.push({ name, actual, expected, pass: actual === expected });
    };
    check("typeof Node.prototype.compareDocumentPosition",
      () => typeof globalThis.Node.prototype.compareDocumentPosition, "function");
    check("Node.DOCUMENT_POSITION_FOLLOWING", () => globalThis.Node.DOCUMENT_POSITION_FOLLOWING, 4);
    check("a vs a", () => a.compareDocumentPosition(a), 0);
    check("a vs b (b follows)", () => a.compareDocumentPosition(b), 4);
    check("b vs a (a precedes)", () => b.compareDocumentPosition(a), 2);
    check("b vs c (c contained by b, follows)", () => b.compareDocumentPosition(c), 16 | 4);
    check("c vs b (b contains c, precedes)", () => c.compareDocumentPosition(b), 8 | 2);
    check("a vs c", () => a.compareDocumentPosition(c), 4);
    check("document vs a", () => document.compareDocumentPosition(a), 16 | 4);
    check("a vs detached: DISCONNECTED|IMPLEMENTATION_SPECIFIC set",
      () => a.compareDocumentPosition(detached) & 0x21, 0x21);
    check("disconnected order is consistent",
      () => ((a.compareDocumentPosition(detached) & 6) ^ (detached.compareDocumentPosition(a) & 6)), 6);
  },
});
await component.dispose();
let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: got ${JSON.stringify(r.actual)}, want ${r.expected}`);
}
console.log(failed ? `${failed} failed` : "all passed");
