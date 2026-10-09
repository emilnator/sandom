import { generateVariants } from "sandom/component-variants";

const projectRoot = new URL("./", import.meta.url);
const libraryRoot = new URL("../", projectRoot);
const decoder = new TextDecoder();
const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const revisionPattern = /^[0-9a-f]{40,64}$/;
const contentTypes = { js: "text/javascript", mjs: "text/javascript", html: "text/html; charset=utf-8", css: "text/css", json: "application/json", wasm: "application/wasm", png: "image/png", svg: "image/svg+xml", ttf: "font/ttf", woff2: "font/woff2", wgsl: "text/plain" };
const libraries = new Set(["sandom", "sandom-color", "sandom-font-metrics", "sandom-gain-map", "sandom-gif", "sandom-fonts", "sandscript", "msgpack"]);

async function git(arguments_, cwd = projectRoot) {
  const result = await new Deno.Command("git", { args: arguments_, cwd, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) throw new Error(`Git ${arguments_[0]} failed: ${decoder.decode(result.stderr).trim()}`);
  return result.stdout;
}
function safePath(path) {
  if (!path || path.split("/").some((part) => !part || part.startsWith(".") || part.includes("\\")) || !contentTypes[path.split(".").at(-1)]) {
    throw new Error(`Unsupported source path ${JSON.stringify(path)}. Use a public component module, stylesheet, schema, or asset path.`);
  }
  return path;
}
async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function revision(value, repository = projectRoot) {
  if (!revisionPattern.test(value)) throw new Error(`Revision ${JSON.stringify(value)} is not a full commit identifier. Refresh the revision list.`);
  return decoder.decode(await git(["rev-parse", "--verify", `${value}^{commit}`], repository)).trim();
}
async function source(commit, path, repository = projectRoot) { return await git(["show", `${await revision(commit, repository)}:${safePath(path)}`], repository); }
async function manifest(commit, repository = projectRoot) {
  const value = JSON.parse(decoder.decode(await source(commit, "components.json", repository)));
  if (value.format !== "sandom/component-project" || value.version !== 1 || !Array.isArray(value.components)) throw new Error(`Unsupported component project ${value.format} version ${value.version}; expected sandom/component-project version 1.`);
  safePath(value.stylesheet);
  for (const component of value.components) { safePath(component.module); safePath(component.schema); }
  return value;
}
async function componentSource(commit, name, repository = projectRoot) {
  const project = await manifest(commit, repository);
  const entry = project.components.find((component) => component.name === name);
  if (!entry) throw new Error(`Component ${JSON.stringify(name)} is absent from commit ${commit}. Choose a component present in both revisions.`);
  const moduleBytes = await source(commit, entry.module, repository);
  const stylesheetBytes = await source(commit, project.stylesheet, repository);
  return { commit, modulePath: entry.module, stylesheetPath: project.stylesheet,
    moduleDigest: await digest(moduleBytes), stylesheetDigest: await digest(stylesheetBytes), schema: entry.schema };
}
function fileResponse(bytes, path) { return new Response(bytes, { headers: { "content-type": contentTypes[path.split(".").at(-1)], "cache-control": "no-store" } }); }
function validateRun(run) {
  if (run.format !== "sandom/component-evolution-run" || run.version !== 1) throw new Error(`Unsupported run ${run.format} version ${run.version}; expected sandom/component-evolution-run version 1. Preserve this evidence and use its matching inspector.`);
  return run;
}
// The browser resolves library modules through /libraries/, which serves the
// workspace directory that import-map.json addresses as "../". Deriving the
// page map from that file keeps one owner for the library prefix.
async function studioDocument() {
  const { imports } = JSON.parse(await Deno.readTextFile(new URL("import-map.json", projectRoot)));
  const browserImports = {};
  for (const [specifier, target] of Object.entries(imports)) {
    if (!target.startsWith("../")) throw new Error(`import-map.json target ${JSON.stringify(target)} for ${specifier} is outside the library workspace. Map it to a path under "../".`);
    browserImports[specifier] = `/libraries/${target.slice(3)}`;
  }
  const html = await Deno.readTextFile(new URL("index.html", projectRoot));
  const marker = "<!-- studio-import-map -->";
  if (!html.includes(marker)) throw new Error(`index.html lacks ${marker}. Restore the import-map marker in its head.`);
  return new TextEncoder().encode(html.replace(marker, `<script type="importmap">${JSON.stringify({ imports: browserImports })}</script>`));
}

export async function createStudioServer({ port = 9361, componentRepository = projectRoot, evidenceDirectory = new URL(".studio/", projectRoot) } = {}) {
  const directory = evidenceDirectory instanceof URL ? evidenceDirectory : new URL(evidenceDirectory, projectRoot);
  const repository = componentRepository instanceof URL ? componentRepository : new URL(`${componentRepository.replace(/\/?$/, "/")}`, projectRoot);
  await Deno.mkdir(new URL("runs/", directory), { recursive: true });
  const assetCache = new Map();
  const rendererRoot = new URL("sandom/", libraryRoot);
  const rendererIdentity = { commit: decoder.decode(await git(["rev-parse", "HEAD"], rendererRoot)).trim() };
  for (const [name, path] of [["rendererDigest", "src/wasm/renderer-core.wasm"], ["componentRuntimeDigest", "examples/design-system/dist/mount.realm.js"], ["baseStylesheetDigest", "examples/design-system/dist/styles.css"]]) {
    const bytes = await Deno.readFile(new URL(path, rendererRoot));
    rendererIdentity[name] = await digest(bytes);
    assetCache.set(`sandom/${path}`, bytes);
  }
  const writes = new Set();
  function runPath(identifier) {
    if (!identifierPattern.test(identifier)) throw new Error(`Invalid run identifier ${identifier}. Open a run from history.`);
    return new URL(`runs/${identifier}/run.json`, directory);
  }
  async function save(run) {
    const temporary = new URL("run.tmp", runPath(run.identifier));
    await Deno.writeTextFile(temporary, JSON.stringify(run, null, 2));
    await Deno.rename(temporary, runPath(run.identifier));
  }
  async function load(identifier) { return validateRun(JSON.parse(await Deno.readTextFile(runPath(identifier)))); }
  async function catalogue() {
    const head = decoder.decode(await git(["rev-parse", "HEAD"], repository)).trim();
    const currentProject = await manifest(head, repository);
    const sourceDirectories = new Set([currentProject.stylesheet, ...currentProject.components.flatMap((component) => [component.module, component.schema])]
      .map((path) => path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/` : "."));
    const text = decoder.decode(await git(["log", "--format=%H%x09%s%x09%aI", "--", "components.json", ...sourceDirectories], repository));
    const revisions = text.trim().split("\n").filter(Boolean).map((line) => {
      const [commit, subject, date] = line.split("\t");
      return { commit, subject, date };
    });
    if (revisions.length < 2) throw new Error("The component repository has fewer than two committed revisions. Commit a component evolution before opening comparison.");
    const project = await manifest(revisions[0].commit, repository);
    return { project, revisions, rendererIdentity, componentRepository: repository.href };
  }
  async function handler(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && request.headers.has("origin") && request.headers.get("origin") !== url.origin) return Response.json({ error: "Studio writes require the local studio origin." }, { status: 403 });
      if (request.method === "GET" && url.pathname === "/api/catalogue") return Response.json(await catalogue());
      if (request.method === "GET" && url.pathname === "/api/variants") {
        const commit = await revision(url.searchParams.get("revision"), repository);
        const project = await manifest(commit, repository);
        const component = project.components.find((entry) => entry.name === url.searchParams.get("component"));
        if (!component) throw new Error(`Component ${url.searchParams.get("component")} is absent from ${commit}. Select a component in this revision.`);
        const schema = JSON.parse(decoder.decode(await source(commit, component.schema, repository)));
        const { variants } = generateVariants(schema, { strategy: "pairwise", maximumVariants: 65536, limits: { memoryBytes: 16777216 } });
        return Response.json({ variantCount: variants.length });
      }
      const revisionSource = url.pathname.match(/^\/api\/revisions\/([0-9a-f]{40,64})\/(.+)$/);
      if (request.method === "GET" && revisionSource) return fileResponse(await source(revisionSource[1], decodeURIComponent(revisionSource[2]), repository), revisionSource[2]);
      const retainedSource = url.pathname.match(/^\/api\/runs\/([^/]+)\/source\/(before|after)\/(.+)$/);
      if (request.method === "GET" && retainedSource) {
        const retained = await load(retainedSource[1]);
        const repository = new URL(retained.componentRepository);
        return fileResponse(await source(retained[retainedSource[2]].commit, decodeURIComponent(retainedSource[3]), repository), retainedSource[3]);
      }
      if (url.pathname === "/api/runs") {
        if (request.method === "GET") {
          const runs = [];
          for await (const entry of Deno.readDir(new URL("runs/", directory))) {
            if (!entry.isDirectory) throw new Error(`Unknown run-store entry ${entry.name}; preserve it and inspect the store.`);
            const run = await load(entry.name);
            runs.push({ identifier: run.identifier, component: run.component, createdAt: run.createdAt, total: run.cases.length, completed: run.results.length, before: run.before.commit, after: run.after.commit });
          }
          return Response.json(runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
        }
        if (request.method === "POST") {
          const input = await request.json();
          for (const [name, minimum, maximum] of [["start", 0, 65535], ["end", 0, 65535], ["maximumCases", 1, 256], ["width", 1, 2048], ["height", 1, 2048]]) {
            if (!Number.isSafeInteger(input[name]) || input[name] < minimum || input[name] > maximum) throw new Error(`${name} is ${input[name]}; use an integer from ${minimum} to ${maximum}.`);
          }
          if (input.end < input.start) throw new Error(`End index ${input.end} precedes start index ${input.start}. Reverse the range.`);
          if (!Number.isFinite(input.deviceScale) || input.deviceScale < 2 || input.width * input.deviceScale > 4096 || input.height * input.deviceScale > 4096) throw new Error(`Raster ${input.width * input.deviceScale}×${input.height * input.deviceScale} with density ${input.deviceScale} exceeds the 4096-pixel limit or density is below 2. Adjust capture settings.`);
          const before = await componentSource(await revision(input.before, repository), input.component, repository);
          const after = await componentSource(await revision(input.after, repository), input.component, repository);
          if (before.commit === after.commit) throw new Error("Before and After identify the same commit. Select distinct component revisions.");
          const schemaBytes = await source(after.commit, after.schema, repository);
          const generated = generateVariants(JSON.parse(decoder.decode(schemaBytes)), { strategy: "pairwise", maximumVariants: 65536, limits: { memoryBytes: 16777216 } });
          if (input.end >= generated.variants.length) throw new Error(`End index ${input.end} exceeds the last pairwise index ${generated.variants.length - 1}. Reduce the range.`);
          const cases = generated.variants.slice(input.start, input.end + 1).slice(0, input.maximumCases).map((props, index) => ({ index: input.start + index, props }));
          const run = { format: "sandom/component-evolution-run", version: 1, identifier: crypto.randomUUID(), createdAt: new Date().toISOString(), component: input.component,
            before, after, componentRepository: repository.href, schemaDigest: await digest(schemaBytes),
            coverage: JSON.parse(JSON.stringify(generated.report, (_name, value) => typeof value === "bigint" ? value.toString() : value)),
            variantCount: generated.variants.length, rendererIdentity,
            viewport: { width: input.width, height: input.height, deviceScale: input.deviceScale, pixelWidth: Math.trunc(input.width * input.deviceScale), pixelHeight: Math.trunc(input.height * input.deviceScale) }, cases, results: [] };
          for (const side of ["before", "after"]) {
            run[side].module = `/api/runs/${run.identifier}/source/${side}/${run[side].modulePath}`;
            run[side].stylesheet = `/api/runs/${run.identifier}/source/${side}/${run[side].stylesheetPath}`;
          }
          await Deno.mkdir(new URL(`runs/${run.identifier}/`, directory));
          await save(run);
          return Response.json(run, { status: 201 });
        }
      }
      const runResource = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/cases\/([0-9]+)(?:\/(before|after)\.png)?)?$/);
      if (runResource) {
        const [, identifier, caseText, imageSide] = runResource;
        if (request.method === "GET") {
          const run = await load(identifier);
          if (caseText === undefined) return Response.json(run);
          if (imageSide) return fileResponse(await Deno.readFile(new URL(`cases/${caseText}/${imageSide}.png`, runPath(identifier))), "capture.png");
          const result = run.results[Number(caseText)];
          if (!result) return Response.json({ error: "Case has not been captured" }, { status: 404 });
          return Response.json(result);
        }
        if (request.method === "POST" && caseText !== undefined && !imageSide) {
          if (writes.has(identifier)) return Response.json({ error: "A capture upload is in progress. Wait for its result." }, { status: 409 });
          writes.add(identifier);
          try {
            const run = await load(identifier);
            const caseIndex = Number(caseText);
            if (caseIndex !== run.results.length || caseIndex >= run.cases.length) return Response.json({ error: `Case ${caseIndex} cannot append at retained position ${run.results.length}. Reload the run.` }, { status: 409 });
            const form = await request.formData();
            const inspection = JSON.parse(String(form.get("inspection")));
            const caseDirectory = new URL(`cases/${caseIndex}/`, runPath(identifier));
            await Deno.mkdir(caseDirectory, { recursive: true });
            const images = {};
            for (const side of ["before", "after"]) {
              const image = form.get(side);
              if (!(image instanceof File) || image.type !== "image/png" || image.size > 8388608) throw new Error(`${side} capture must be a PNG file under 8 MiB. Reduce the capture dimensions.`);
              const bytes = new Uint8Array(await image.arrayBuffer());
              const dimensions = new DataView(bytes.buffer);
              if (bytes.length < 24 || decoder.decode(bytes.subarray(1, 4)) !== "PNG" || dimensions.getUint32(16) !== run.viewport.pixelWidth || dimensions.getUint32(20) !== run.viewport.pixelHeight) throw new Error(`${side} PNG does not match the retained raster ${run.viewport.pixelWidth}×${run.viewport.pixelHeight}. Reload the run.`);
              await Deno.writeFile(new URL(`${side}.png`, caseDirectory), bytes);
              images[side] = `/api/runs/${identifier}/cases/${caseIndex}/${side}.png`;
            }
            run.results.push({ index: caseIndex, variantIndex: run.cases[caseIndex].index, images, inspection });
            await save(run);
            return Response.json(run, { status: 201 });
          } finally { writes.delete(identifier); }
        }
      }
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "Unknown API route or method" }, { status: 404 });
      if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
      if (url.pathname === "/" || url.pathname === "/studio" || url.pathname.startsWith("/studio/")) return fileResponse(await studioDocument(), "index.html");
      if (["/studio.js", "/live-component.js", "/studio.css"].includes(url.pathname)) return fileResponse(await Deno.readFile(new URL(url.pathname.slice(1), projectRoot)), url.pathname);
      if (url.pathname.startsWith("/libraries/")) {
        const path = safePath(decodeURIComponent(url.pathname.slice(11)));
        if (!libraries.has(path.split("/")[0])) return Response.json({ error: "Unknown local library" }, { status: 404 });
        if (!assetCache.has(path)) assetCache.set(path, await Deno.readFile(new URL(path, libraryRoot)));
        return fileResponse(assetCache.get(path), path);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: error.message }, { status: error instanceof Deno.errors.NotFound ? 404 : 400 });
    }
  }
  const server = Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, handler);
  return { url: `http://127.0.0.1:${server.addr.port}/studio`, shutdown: () => server.shutdown(), rendererIdentity };
}
if (import.meta.main) {
  const server = await createStudioServer({ port: Number(Deno.env.get("STUDIO_PORT") ?? "9361"), componentRepository: Deno.env.get("STUDIO_PROJECT") ?? projectRoot });
  console.log(`Component evolution studio: ${server.url}`);
  Deno.addSignalListener("SIGINT", async () => { await server.shutdown(); });
}
