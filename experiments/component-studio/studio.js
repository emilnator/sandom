import { createLiveComponent } from "./live-component.js";

const element = (name) => document.getElementById(name);
const numericFields = ["start", "end", "maximumCases", "width", "height", "deviceScale"];
let catalogue;
let run = null;
let live = null;
let selectedCase = -1;
let selectedNode = -1;
let running = false;
let planning = false;
let stopping = false;
let navigating = false;
let sequence = 0;
let view = "compare";
let currentNodes = [];

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: body instanceof FormData ? {} : { "content-type": "application/json" }, body: body instanceof FormData ? body : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
function showError(error) {
  element("error").textContent = error.message ?? String(error);
  element("error").hidden = false;
  element("status").textContent = "Operation failed. Retained cases remain available for inspection.";
  controls();
}
function clearError() { element("error").hidden = true; }
function controls() {
  element("configuration").disabled = running || planning;
  element("refresh").disabled = running || planning;
  element("resume").disabled = running || planning || !run || run.results.length === run.cases.length;
  element("stop").disabled = !running || stopping;
  element("stop").textContent = stopping ? "Stopping after case…" : "Stop after case";
  element("previous").disabled = selectedCase <= 0;
  element("next").disabled = !run || selectedCase + 1 >= run.results.length;
  element("reset-live").disabled = !live || running || navigating;
  element("live-side").disabled = running || navigating;
  element("interactive").disabled = !live || running || navigating;
  element("inspect-mode").disabled = !live || running || navigating;
  element("count").textContent = `${run?.results.length ?? 0} / ${run?.cases.length ?? 0}`;
  element("progress").max = Math.max(1, run?.cases.length ?? 0);
  element("progress").value = run?.results.length ?? 0;
  element("state").textContent = !element("error").hidden ? "Failed" : running ? stopping ? "Stopping" : "Running" : run && run.results.length === run.cases.length ? "Complete" : "Ready";
  applyMode();
}
function applyMode() {
  const busy = running || navigating || view !== "live";
  const interactive = element("interactive").checked;
  const inspecting = element("inspect-mode").checked;
  live?.setMode({ interactive, inspecting, busy });
  element("interaction-status").textContent = running ? "Sweep capture in progress · live input paused" : inspecting ? "Element picking · component interaction paused" : interactive ? "Interaction enabled · pointer, keyboard, and text input" : "Interaction disabled · inspection available";
}
function configuration() {
  return { component: element("component").value, before: element("before").value, after: element("after").value,
    ...Object.fromEntries(numericFields.map((name) => [name, Number(element(name).value)])) };
}
function fillConfiguration() {
  if (!run) return;
  for (const side of ["before", "after"]) {
    const select = element(side);
    if (![...select.options].some((option) => option.value === run[side].commit)) select.add(new Option(run[side].commit.slice(0, 8), run[side].commit));
    select.value = run[side].commit;
  }
  element("component").value = run.component;
  for (const name of ["width", "height", "deviceScale"]) element(name).value = String(run.viewport[name]);
  element("start").value = String(run.cases[0].index);
  element("end").value = String(run.cases.at(-1).index);
  element("maximumCases").value = String(run.cases.length);
}
async function refreshCatalogue() {
  catalogue = await request("/api/catalogue");
  element("component").replaceChildren(...catalogue.project.components.map((item) => new Option(item.name, item.name)));
  for (const side of ["before", "after"]) element(side).replaceChildren(...catalogue.revisions.map((item) => new Option(`${item.commit.slice(0, 7)} · ${item.subject}`, item.commit)));
  element("before").value = catalogue.revisions[1].commit;
  element("after").value = catalogue.revisions[0].commit;
  fillConfiguration();
}
async function resetRange() {
  if (running || planning) return;
  planning = true;
  controls();
  try {
    const query = new URLSearchParams({ revision: element("after").value, component: element("component").value });
    const { variantCount } = await request(`/api/variants?${query}`);
    element("start").value = "0";
    element("end").value = String(Math.min(5, variantCount - 1));
    element("maximumCases").value = String(Math.min(6, variantCount));
  } finally {
    planning = false;
    controls();
  }
}
async function historyList() {
  const runs = await request("/api/runs");
  element("history").replaceChildren(...runs.map((item) => {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/studio/${item.identifier}`;
    link.textContent = `${item.component} · ${item.completed}/${item.total} cases`;
    const detail = document.createElement("small");
    detail.textContent = `${item.before.slice(0, 7)} → ${item.after.slice(0, 7)} · ${new Date(item.createdAt).toLocaleTimeString()}`;
    link.append(detail);
    row.append(link);
    return row;
  }));
}
function locationUrl() {
  const url = new URL(location.href);
  if (run) url.pathname = `/studio/${run.identifier}`;
  url.searchParams.delete("execute");
  if (selectedCase >= 0) url.searchParams.set("case", String(selectedCase));
  url.searchParams.set("view", view);
  for (const name of ["zoom", "reveal", "live-side", "inspection-side", "source-side"]) url.searchParams.set(name, element(name).value);
  url.searchParams.set("interactive", String(element("interactive").checked));
  url.searchParams.set("pick", String(element("inspect-mode").checked));
  if (selectedNode >= 0) url.searchParams.set("node", String(selectedNode));
  else url.searchParams.delete("node");
  return url;
}
function recordLocation(user = true) {
  const url = locationUrl();
  if (location.href !== url.href) history[user ? "pushState" : "replaceState"]({}, "", url);
}
function renderCases() {
  element("run-title").textContent = run ? `${run.component} / Component evolution` : "Your first component evolution";
  element("case-total").textContent = `${run?.cases.length ?? 0} cases`;
  const list = document.createDocumentFragment();
  run?.cases.forEach((item, index) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = `Variant ${String(item.index).padStart(2, "0")}`;
    button.setAttribute("aria-current", String(index === selectedCase));
    button.disabled = index >= run.results.length;
    const detail = document.createElement("small");
    detail.textContent = index < run.results.length ? "Before + After · captured" : running && index === run.results.length ? "Rendering in Sandom…" : "Queued";
    button.append(detail);
    button.addEventListener("click", () => { element("follow").checked = false; selectCase(index, true).catch(showError); });
    row.append(button);
    list.append(row);
  });
  element("cases").replaceChildren(list);
  controls();
}
function updateComparison() {
  if (run) {
    const zoom = Number(element("zoom").value);
    element("comparison").style.width = `${run.viewport.width * zoom}px`;
    element("comparison").style.height = `${run.viewport.height * zoom}px`;
    element("comparison").style.imageRendering = zoom === 1 ? "auto" : "pixelated";
  }
  element("comparison").style.setProperty("--reveal", `${element("reveal").value}%`);
  element("reveal-value").value = `${element("reveal").value}%`;
}
function showInspector(nodes, context) {
  currentNodes = nodes;
  element("inspection-context").textContent = context;
  element("nodes").replaceChildren(...nodes.map((node, index) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = `<${node.tag}>${node.attributes["data-slot"] ? ` ${node.attributes["data-slot"]}` : ""}${node.attributes["aria-label"] ? ` · ${node.attributes["aria-label"]}` : ""}`;
    button.setAttribute("aria-pressed", String(index === selectedNode));
    button.addEventListener("click", () => {
      selectedNode = index;
      const detail = view === "live" && !running ? live.inspect(index) : currentNodes[index];
      element("element-details").textContent = JSON.stringify(detail, null, 2);
      showInspector(currentNodes, context);
      recordLocation();
    });
    row.append(button);
    return row;
  }));
  if (selectedNode >= 0 && nodes[selectedNode]) element("element-details").textContent = JSON.stringify(nodes[selectedNode], null, 2);
}
function refreshInspection() {
  if (!run || selectedCase < 0) return;
  if (view === "live" && !running) showInspector(live.tree(), `Live ${element("live-side").value} · Sandom DOM`);
  else showInspector(run.results[selectedCase].inspection[element("inspection-side").value], `${element("inspection-side").value === "after" ? "After" : "Before"} · retained capture`);
}
async function sourceView() {
  if (!run) return;
  const selectedRun = run;
  const side = element("source-side").value;
  const response = await fetch(run[side].module);
  if (!response.ok) throw new Error(`Committed module returned HTTP ${response.status}. Verify the selected revision.`);
  const text = await response.text();
  if (run !== selectedRun || element("source-side").value !== side) return;
  element("source-code").textContent = text;
  element("source-identity").textContent = `${side === "before" ? "Before" : "After"} · ${run[side].commit}`;
}
async function mountLive() {
  if (!run || selectedCase < 0 || running || !live) return;
  navigating = true;
  controls();
  try {
    await live.mount(run[element("live-side").value], run.cases[selectedCase].props);
    if (view === "live") refreshInspection();
  } finally { navigating = false; controls(); }
}
async function selectCase(index, user = false) {
  const selectedRun = run;
  const selection = ++sequence;
  const result = run.results[index];
  if (!result) throw new Error(`Case ${index} has not been captured. Select a completed variant.`);
  const images = await Promise.all(["before", "after"].map(async (side) => {
    const image = new Image();
    image.id = `${side}-image`;
    image.alt = `${side === "before" ? "Before" : "After"}, ${run.component}, pairwise variant ${run.cases[index].index}, Sandom render`;
    image.src = result.images[side];
    await image.decode();
    if (image.naturalWidth !== selectedRun.viewport.pixelWidth || image.naturalHeight !== selectedRun.viewport.pixelHeight) throw new Error(`Image ${image.naturalWidth}×${image.naturalHeight} disagrees with retained raster ${selectedRun.viewport.pixelWidth}×${selectedRun.viewport.pixelHeight}. Preserve the run and inspect its files.`);
    return image;
  }));
  if (selection !== sequence || run !== selectedRun) return;
  selectedCase = index;
  selectedNode = -1;
  element("element-details").textContent = "Select a DOM node, or pick an element in the live component.";
  for (const image of images) element(image.id).replaceWith(image);
  element("empty").hidden = true;
  element("comparison").hidden = false;
  element("selection").textContent = `Variant ${run.cases[index].index} · identical props across revisions`;
  element("case-readout").textContent = `${index + 1} / ${run.results.length} captured`;
  element("before-label").textContent = `Left: Before · ${run.before.commit.slice(0, 7)} · Sandom`;
  element("after-label").textContent = `Right: After · ${run.after.commit.slice(0, 7)} · Sandom`;
  element("props").textContent = JSON.stringify(run.cases[index].props, null, 2);
  updateComparison();
  recordLocation(user);
  renderCases();
  if (!running) await mountLive();
  refreshInspection();
  await sourceView();
}
function showView(value) {
  view = value;
  element("compare-panel").hidden = view !== "compare";
  element("live-panel").hidden = view !== "live";
  element("compare-view").setAttribute("aria-pressed", String(view === "compare"));
  element("live-view").setAttribute("aria-pressed", String(view === "live"));
  applyMode();
}
async function createStage() {
  if (live) return;
  live = await createLiveComponent({ canvas: element("live-canvas"), viewport: run.viewport,
    onFrame: (frame) => {
      element("live-text").textContent = frame.text;
      if (frame.inspection) element("element-details").textContent = JSON.stringify(frame.inspection, null, 2);
      if (live && view === "live" && !running) refreshInspection();
    }, onInspect: (detail) => {
      const index = live.tree().findIndex((node) => JSON.stringify(node.attributes) === JSON.stringify(detail.attributes) && node.tag === detail.tag);
      selectedNode = index;
      element("element-details").textContent = JSON.stringify(detail, null, 2);
      refreshInspection();
      recordLocation();
    }, onFault: showError });
  controls();
}
async function executeRun() {
  if (running || !run) return;
  for (const name of ["rendererDigest", "componentRuntimeDigest", "baseStylesheetDigest"]) {
    if (run.rendererIdentity[name] !== catalogue.rendererIdentity[name]) throw new Error(`Fixed renderer ${name} differs from this run. Start a new comparison; retained images remain inspectable.`);
  }
  clearError();
  running = true;
  stopping = false;
  controls();
  try {
    await createStage();
    while (!stopping && run.results.length < run.cases.length) {
      const index = run.results.length;
      const item = run.cases[index];
      element("status").textContent = "Rendering committed component sources in Sandom…";
      element("active-case").textContent = `${run.component} · variant ${item.index}`;
      renderCases();
      const inspection = {};
      const form = new FormData();
      for (const side of ["before", "after"]) {
        inspection[side] = await live.mount(run[side], item.props);
        form.set(side, await live.snapshot(), `${side}.png`);
      }
      form.set("inspection", JSON.stringify(inspection));
      const updated = await request(`/api/runs/${run.identifier}/cases/${index}`, form);
      run.results = updated.results;
      if (element("follow").checked) await selectCase(index);
      renderCases();
    }
    element("status").textContent = run.results.length === run.cases.length ? "Sweep complete. Review the revisions or interact with a live component." : "Stopped between cases. Resume continues the retained plan.";
    element("active-case").textContent = `${run.results.length} retained Before / After pairs`;
    await historyList();
  } finally {
    running = false;
    controls();
    if (selectedCase >= 0) await mountLive();
    refreshInspection();
  }
}
async function startRun() {
  if (running || planning) return;
  clearError();
  planning = true;
  controls();
  try {
    const created = await request("/api/runs", configuration());
    // A page owns one React realm and one fixed-density Sandom document.
    // A new run gets a fresh page so capture geometry and hooks cannot leak.
    location.assign(`/studio/${created.identifier}?execute=1`);
  } finally { planning = false; controls(); }
}
async function restoreLocation() {
  const url = new URL(location.href);
  if (url.pathname !== `/studio/${run.identifier}`) { location.reload(); return; }
  showView(url.searchParams.get("view") === "live" ? "live" : "compare");
  element("zoom").value = ["1", "2", "3", "4"].includes(url.searchParams.get("zoom")) ? url.searchParams.get("zoom") : "1";
  const reveal = Number(url.searchParams.get("reveal") ?? 50);
  element("reveal").value = String(Number.isFinite(reveal) ? Math.max(0, Math.min(100, reveal)) : 50);
  for (const name of ["live-side", "inspection-side", "source-side"]) element(name).value = url.searchParams.get(name) === "before" ? "before" : "after";
  element("interactive").checked = url.searchParams.get("interactive") === "true";
  element("inspect-mode").checked = url.searchParams.get("pick") === "true";
  if (run.results.length) {
    const requested = Number(url.searchParams.get("case") ?? run.results.length - 1);
    await selectCase(Number.isSafeInteger(requested) ? Math.max(0, Math.min(run.results.length - 1, requested)) : 0);
    const node = Number(url.searchParams.get("node"));
    if (url.searchParams.has("node") && Number.isSafeInteger(node) && node >= 0 && node < currentNodes.length) {
      selectedNode = node;
      refreshInspection();
      recordLocation(false);
    }
  }
  updateComparison();
  controls();
}
for (const name of ["zoom", "reveal"]) {
  element(name).addEventListener("input", updateComparison);
  element(name).addEventListener("change", () => { updateComparison(); recordLocation(); });
}
element("run-form").addEventListener("submit", (event) => { event.preventDefault(); startRun().catch(showError); });
for (const name of ["component", "after"]) element(name).addEventListener("change", () => resetRange().catch(showError));
element("refresh").addEventListener("click", () => refreshCatalogue().catch(showError));
element("stop").addEventListener("click", () => { stopping = true; controls(); });
element("resume").addEventListener("click", () => executeRun().catch(showError));
element("previous").addEventListener("click", () => { element("follow").checked = false; selectCase(selectedCase - 1, true).catch(showError); });
element("next").addEventListener("click", () => { element("follow").checked = false; selectCase(selectedCase + 1, true).catch(showError); });
for (const [name, value] of [["compare-view", "compare"], ["live-view", "live"]]) element(name).addEventListener("click", () => {
  showView(value);
  recordLocation();
  if (value === "live" && !running) mountLive().catch(showError);
  else refreshInspection();
});
for (const name of ["interactive", "inspect-mode"]) element(name).addEventListener("change", () => { applyMode(); recordLocation(); });
element("live-side").addEventListener("change", () => { selectedNode = -1; recordLocation(); mountLive().catch(showError); });
element("inspection-side").addEventListener("change", () => { selectedNode = -1; refreshInspection(); recordLocation(); });
element("source-side").addEventListener("change", () => { recordLocation(); sourceView().catch(showError); });
element("reset-live").addEventListener("click", () => mountLive().catch(showError));
globalThis.addEventListener("popstate", () => { if (running) stopping = true; restoreLocation().catch(showError); });
globalThis.addEventListener("pagehide", () => { live?.dispose().catch(console.error); });
async function initialize() {
  await refreshCatalogue();
  element("deviceScale").value = String(Math.max(2, globalThis.devicePixelRatio));
  const url = new URL(location.href);
  const match = url.pathname.match(/^\/studio\/([0-9a-f-]{36})$/);
  if (!match && url.pathname !== "/studio" && url.pathname !== "/") throw new Error(`Unknown studio location ${url.pathname}. Open /studio or a run from history.`);
  if (match) {
    run = await request(`/api/runs/${match[1]}`);
    fillConfiguration();
    element("provenance").textContent = JSON.stringify({ before: run.before, after: run.after, rendererIdentity: run.rendererIdentity, schemaDigest: run.schemaDigest, coverage: run.coverage, viewport: run.viewport }, null, 2);
    renderCases();
    await createStage();
    const execute = url.searchParams.get("execute") === "1";
    if (execute) { url.searchParams.delete("execute"); history.replaceState({}, "", url); }
    await restoreLocation();
    if (execute) await executeRun();
    else element("status").textContent = run.results.length === run.cases.length ? "Retained comparison loaded. Select a variant to review or interact." : "Retained run loaded. Resume to capture the remaining variants.";
    element("active-case").textContent = `${run.results.length} retained Before / After pairs`;
  } else {
    await resetRange();
    controls();
    if (!url.search) await startRun();
  }
  await historyList();
  controls();
}
initialize().catch(showError);
