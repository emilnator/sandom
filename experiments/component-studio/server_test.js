import { createStudioServer } from "./server.js";

function assert(condition, message) { if (!condition) throw new Error(message); }
async function git(repository, args) {
  const result = await new Deno.Command("git", { args, cwd: repository, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("component plans use committed source, preserve pairwise bounds, and isolate API routes", async () => {
  const temporary = await Deno.makeTempDir({ prefix: "component-studio-" });
  const repository = new URL(`file://${temporary}/project/`);
  const evidenceDirectory = new URL(`file://${temporary}/evidence/`);
  await Deno.mkdir(new URL("src/", repository), { recursive: true });
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "Component Studio Test"]);
  await git(repository, ["config", "user.email", "studio-test@localhost"]);
  await Deno.writeTextFile(new URL("components.json", repository), JSON.stringify({ format: "sandom/component-project", version: 1, name: "Test project", stylesheet: "src/theme.css", components: [{ name: "Control", module: "src/control.js", schema: "src/control.schema.json" }] }));
  await Deno.writeTextFile(new URL("src/control.js", repository), "export const color = '#222222';\n");
  await Deno.writeTextFile(new URL("src/theme.css", repository), "button { color: #222222; }\n");
  await Deno.writeTextFile(new URL("src/control.schema.json", repository), JSON.stringify({ type: "object", properties: { size: { type: "string", enum: ["small", "large"] }, enabled: { type: "boolean" } }, required: ["size", "enabled"], additionalProperties: false }));
  await git(repository, ["add", "--", "components.json", "src/control.js", "src/control.schema.json", "src/theme.css"]);
  await git(repository, ["commit", "-m", "Initial control", "--", "components.json", "src/control.js", "src/control.schema.json", "src/theme.css"]);
  const before = await git(repository, ["rev-parse", "HEAD"]);
  const evolvedBytes = "export const color = '#6851d8';\n";
  await Deno.writeTextFile(new URL("src/control.js", repository), evolvedBytes);
  await git(repository, ["add", "--", "src/control.js"]);
  await git(repository, ["commit", "-m", "Evolve control color", "--", "src/control.js"]);
  const after = await git(repository, ["rev-parse", "HEAD"]);
  await Deno.writeTextFile(new URL("src/control.js", repository), "throw new Error('Uncommitted source must remain outside the capture');\n");
  const server = await createStudioServer({ port: 0, componentRepository: repository, evidenceDirectory });
  const origin = new URL(server.url).origin;
  try {
    const catalogue = await (await fetch(`${origin}/api/catalogue`)).json();
    assert(catalogue.revisions[0].commit === after && catalogue.revisions[1].commit === before, "Manifest-declared source directories must define component history");
    const variants = await (await fetch(`${origin}/api/variants?revision=${after}&component=Control`)).json();
    assert(variants.variantCount === 4, "Small schemas must expose their actual pairwise range for automatic first sweeps");
    const configuration = { component: "Control", before, after, start: 1, end: 3, maximumCases: 2, width: 460, height: 300, deviceScale: 2 };
    const response = await fetch(`${origin}/api/runs`, { method: "POST", body: JSON.stringify(configuration) });
    const run = await response.json();
    assert(response.status === 201, JSON.stringify(run));
    assert(run.cases.map((item) => item.index).join(",") === "1,2", "Inclusive bounds and maximumCases must select the intended pairwise section");
    const moduleBytes = await (await fetch(`${origin}${run.after.module}`)).text();
    assert(moduleBytes === evolvedBytes, "Working-tree edits must not replace committed component source");
    const sourceFromSecondServer = await createStudioServer({ port: 0, evidenceDirectory });
    try {
      const restoredBytes = await (await fetch(`${new URL(sourceFromSecondServer.url).origin}${run.after.module}`)).text();
      assert(restoredBytes === evolvedBytes, "Retained source routes must bind to the run's repository, not the server's current project");
    } finally { await sourceFromSecondServer.shutdown(); }
    const nested = await fetch(`${origin}/studio/${run.identifier}?case=1&view=live`);
    assert(nested.ok && nested.headers.get("content-type").startsWith("text/html"), "Nested review locations must serve the studio document");
    await nested.text();
    const foreign = await fetch(`${origin}/api/runs`, { method: "POST", headers: { origin: "https://foreign.invalid" }, body: JSON.stringify(configuration) });
    assert(foreign.status === 403, "Foreign pages must not create local captures");
    await foreign.text();
    const obsolete = await fetch(`${origin}/runs`, { method: "POST", body: JSON.stringify(configuration) });
    assert(obsolete.status === 405, "Non-API writes must not perform capture operations");
    await obsolete.text();
    const unknown = await fetch(`${origin}/api/unknown-operation`);
    assert(unknown.status === 404 && (await unknown.json()).error, "Unknown API operations must return a structured error");
    const rejected = await fetch(`${origin}/api/runs`, { method: "POST", body: JSON.stringify({ ...configuration, end: 4 }) });
    assert(rejected.status === 400 && (await rejected.json()).error.includes("last pairwise index 3"), "Out-of-domain indices must fail instead of shrinking the plan");
    const missingRevision = await fetch(`${origin}/api/runs`, { method: "POST", body: JSON.stringify({ ...configuration, after: "0".repeat(40) }) });
    assert(missingRevision.status === 400 && (await missingRevision.json()).error.includes("Git rev-parse failed"), "A missing commit must be observable");
    const history = await (await fetch(`${origin}/api/runs`)).json();
    assert(history.length === 1 && history[0].identifier === run.identifier && history[0].completed === 0, "Rejected plans must leave no orphaned run-store entries");
  } finally {
    await server.shutdown();
    await Deno.remove(temporary, { recursive: true });
  }
});
