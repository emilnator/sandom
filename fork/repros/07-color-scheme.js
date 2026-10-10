// prefers-color-scheme for a component session.
// Media Queries 5 §12.4 (prefers-color-scheme) and CSSOM View §4.2: when the user agent's
// color scheme changes, every MediaQueryList whose matches state changed fires a "change"
// event (MediaQueryListEvent) during "evaluate media queries and report changes", and
// `matches` reads the new state. Chrome does this when DevTools emulates the scheme.
// renderComponent has no way to mount in dark, and changing the style environment by
// hand updates CSS but leaves every existing MediaQueryList stale, with no change event.
import { renderComponent } from "./_setup.js";

const results = [];
const check = (name, actual, expected) =>
  results.push({ name, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });

// 1. Mounting in dark.
let mountedDark;
try {
  const component = await renderComponent({
    width: 200,
    height: 100,
    display: { colorScheme: "dark" },
    mount: () => {
      mountedDark = globalThis.matchMedia("(prefers-color-scheme: dark)").matches;
    },
  });
  await component.dispose();
} catch (error) {
  mountedDark = `${error.name}: ${error.message}`;
}
check("renderComponent({display: {colorScheme: 'dark'}}): matchMedia dark at mount", mountedDark, true);

// 2. Switching a mounted session from light to dark.
let list;
const changes = [];
let document_;
const component = await renderComponent({
  width: 200,
  height: 100,
  mount: ({ document, container }) => {
    document_ = document;
    const style = document.createElement("style");
    style.textContent = "#box{width:10px;height:10px}" +
      "@media (prefers-color-scheme: dark){#box{width:30px}}";
    document.head.append(style);
    container.innerHTML = "<div id=box></div>";
    list = globalThis.matchMedia("(prefers-color-scheme: dark)");
    list.addEventListener("change", (event) => changes.push(event.matches));
  },
});
await component.render({ pixels: false });
const box = document_.getElementById("box");
check("light: matches", list.matches, false);
check("light: CSS width", box.offsetWidth, 10);
if (typeof component.setDisplay === "function") {
  // The proposed API.
  await component.setDisplay({ colorScheme: "dark" });
} else {
  // What a host can do today: the internal style environment.
  document_._styleSystem.setEnvironment({ colorScheme: "dark" });
  await component.render({ pixels: false });
}
check("dark: CSS width", box.offsetWidth, 30);
check("dark: existing list's matches", list.matches, true);
check("dark: a new list's matches", globalThis.matchMedia("(prefers-color-scheme: dark)").matches, true);
check("dark: change events on the existing list", changes, [true]);
await component.dispose();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)}`);
}
console.log(failed ? `${failed} failed` : "all passed");
