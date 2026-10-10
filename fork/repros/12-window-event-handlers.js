// Event handler IDL attributes on the window: window.onresize = …, window.onclick = ….
// HTML §8.1.8.2: Window has the GlobalEventHandlers (onclick, onkeydown, …) and the
// WindowEventHandlers (onresize, onhashchange, onpopstate, onmessage, …); setting one adds
// the handler as a listener for that event on the window. A component session's window
// has none of them: `window.onresize = f` is a plain property and f never runs. A page
// that calls an element's on* setter with the window as `this` registers a listener that
// throws when the event comes (node.js reads `this._domCore`, which the window lacks), and
// under Deno that throw ends the process.
import { renderComponent } from "./_setup.js";

const results = [];
const check = (name, actual, expected) =>
  results.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });
const report = () => {
  let failed = 0;
  for (const r of results.splice(0)) {
    if (!r.pass) failed += 1;
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)}`);
  }
  return failed;
};

const heard = [];
const component = await renderComponent({
  width: 100,
  height: 100,
  mount: () => {
    globalThis.onresize = () => heard.push("onresize");
    globalThis.onclick = () => heard.push("onclick");
    globalThis.onhashchange = () => heard.push("onhashchange");
  },
});
await component.render({ pixels: false });
globalThis.dispatchEvent(new Event("click"));
globalThis.dispatchEvent(new Event("hashchange"));
await component.resize({ width: 120, height: 100 });
const handlerValue = typeof globalThis.onresize;
globalThis.onresize = null;
await component.resize({ width: 140, height: 100 });
await component.dispose({ restoreAmbientGlobals: true });

// A second session: the first one's handlers are gone, and its own work.
const second = [];
const next = await renderComponent({
  width: 100,
  height: 100,
  mount: () => {
    globalThis.onclick = () => second.push("onclick");
  },
});
globalThis.dispatchEvent(new Event("click"));
await next.dispose({ restoreAmbientGlobals: true });

check("handlers ran, once each", heard, ["onclick", "onhashchange", "onresize"]);
check("window.onresize reads back the function", handlerValue, "function");
check("a second session's handler runs, the first's don't", [second, heard.length], [["onclick"], 3]);
let failed = report();

// Last, as at HEAD it ends the process: an element's setter called on the window.
console.log("checking HTMLElement.prototype's onkeydown setter called on the window…");
const keys = [];
const third = await renderComponent({
  width: 100,
  height: 100,
  mount: () => {
    Object.getOwnPropertyDescriptor(globalThis.HTMLElement.prototype, "onkeydown").set
      .call(globalThis, () => keys.push("onkeydown"));
  },
});
globalThis.dispatchEvent(new Event("keydown"));
await third.dispose({ restoreAmbientGlobals: true });
check("an element's setter called on the window: the handler runs", keys, ["onkeydown"]);
failed += report();
console.log(failed ? `${failed} failed` : "all passed");
