// A component session's window listeners must go with the session. In a browser each page
// has its own Window, so nothing page A registered on its window can run in page B
// (HTML §7.2 "Window": a navigation creates a new Window and its event listener list).
// renderComponent installs its window on the realm's globalThis, and Sandom stores window
// listeners by (globalThis, shared DOM core); dispose() restores the global properties but
// leaves those registrations in place, so session A's listeners run in session B.
import { renderComponent } from "./_setup.js";

const heard = [];
const paths = {
  "window.addEventListener": () =>
    globalThis.addEventListener("resize", () => heard.push("window.addEventListener")),
  "Node.prototype.addEventListener.call(window)": (document) =>
    document.body.addEventListener.call(globalThis, "resize",
      () => heard.push("Node.prototype.addEventListener.call(window)")),
  "MediaQueryList.prototype.addEventListener.call(window)": () => {
    const list = globalThis.matchMedia("(min-width: 1px)");
    list.addEventListener.call(globalThis, "resize",
      () => heard.push("MediaQueryList.prototype.addEventListener.call(window)"));
  },
  "removed again, then re-added (one registration)": () => {
    const listener = () => heard.push("removed again, then re-added (one registration)");
    globalThis.addEventListener("click", listener);
    globalThis.removeEventListener("click", listener);
    globalThis.addEventListener("click", listener);
  },
  "{signal} that is never aborted": () =>
    globalThis.addEventListener("resize", () => heard.push("{signal} that is never aborted"),
      { signal: new AbortController().signal }),
};

// Session A registers on its window by every path, then goes.
const a = await renderComponent({
  width: 200,
  height: 100,
  mount: ({ document }) => {
    for (const add of Object.values(paths)) add(document);
  },
});
await a.render({ pixels: false });
globalThis.dispatchEvent(new Event("resize"));
globalThis.dispatchEvent(new Event("click"));
const whileMounted = [...heard];
heard.length = 0;
await a.dispose({ restoreAmbientGlobals: true });

// Session B, in the same realm, dispatches resize and click on its window, then resizes.
let ownHeard = 0;
const b = await renderComponent({
  width: 200,
  height: 100,
  mount: () => globalThis.addEventListener("resize", () => ownHeard += 1),
});
globalThis.dispatchEvent(new Event("resize"));
globalThis.dispatchEvent(new Event("click"));
await b.resize({ width: 300, height: 100 });
await b.dispose({ restoreAmbientGlobals: true });

let failed = 0;
for (const name of Object.keys(paths)) {
  const registered = whileMounted.includes(name);
  const leaked = heard.filter((entry) => entry === name).length;
  const pass = registered && leaked === 0;
  if (!pass) failed += 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: heard in A ${registered}, A's listener ran in B ${leaked} time(s) (want 0)`);
}
const ownPass = ownHeard === 2;
if (!ownPass) failed += 1;
console.log(`${ownPass ? "PASS" : "FAIL"} B's own window listener: ran ${ownHeard} time(s) (want 2)`);
console.log(failed ? `${failed} failed` : "all passed");
