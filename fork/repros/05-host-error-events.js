// Errors a page doesn't catch, while a component session is mounted under Deno.
// HTML §8.1.4.6 "report an exception" and §8.1.5.7 (unhandled promise rejections): the
// window hears an ErrorEvent / PromiseRejectionEvent; when no listener cancels it, the
// browser logs it to the console, and the page keeps running. Under Deno the window is the
// realm's global, and Deno reports these by calling globalThis.dispatchEvent, which the
// session replaced: the host's own listeners never hear them, Deno sees them uncancelled,
// and the process exits. Expected: the page's listeners hear it, then (unless the page
// cancelled it) the host's, which can cancel it to keep the process alive, as Deno's
// documentation tells hosts to.
import { renderComponent } from "./_setup.js";

const which = Deno.args[0] ?? "all";
if (which === "all") {
  // Each case in a child process: an uncaught one ends the process it runs in.
  const self = new URL(import.meta.url).pathname;
  let failed = 0;
  for (const name of ["rejection", "timer", "reportError", "cancelled"]) {
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", ...Deno.env.get("REPRO_DENO_FLAGS").split(" "), self, name],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(output.stdout).trim();
    // A rejection the page's own listener cancels is handled: the host doesn't hear of it.
    const hostShouldHear = name !== "cancelled";
    const pass = output.code === 0 && out.includes(`survived ${name}`) &&
      out.includes(`page heard ${name}`) && out.includes(`host heard ${name}`) === hostShouldHear;
    if (!pass) failed += 1;
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: exit code ${output.code}; ${out.split("\n").join(" | ") || "(no output)"}`);
    if (!pass) {
      const err = new TextDecoder().decode(output.stderr).split("\n")
        .filter((line) => line && !line.includes("enumerate_adapters")).slice(0, 2).join(" | ");
      console.log(`     stderr: ${err}`);
    }
  }
  console.log(failed ? `${failed} failed` : "all passed");
  Deno.exit(0);
}

// The host's own safety net, as a long-lived host installs it: it logs
// what the page didn't handle and keeps the process alive.
globalThis.addEventListener("unhandledrejection", (event) => {
  console.log(`host heard ${event.reason?.message}`);
  event.preventDefault();
});
globalThis.addEventListener("error", (event) => {
  console.log(`host heard ${event.error?.message ?? event.message}`);
  event.preventDefault();
});

const component = await renderComponent({
  width: 100,
  height: 100,
  mount: () => {
    globalThis.addEventListener("error", (event) => {
      if (String(event.error?.message ?? event.message).includes(which)) console.log(`page heard ${which}`);
    });
    globalThis.addEventListener("unhandledrejection", (event) => {
      if (String(event.reason?.message).includes(which)) console.log(`page heard ${which}`);
      if (which === "cancelled") event.preventDefault();
    });
    if (which === "rejection" || which === "cancelled") Promise.reject(new Error(which));
    if (which === "timer") setTimeout(() => { throw new Error("timer"); }, 0);
    if (which === "reportError") globalThis.reportError(new Error("reportError"));
  },
});
await new Promise((resolve) => setTimeout(resolve, 50));
await component.render({ pixels: false });
await component.dispose();
console.log(`survived ${which}`);
