# Sandom

Sandom is an experimental rendering engine that runs inside your process. It
accepts a mutable DOM-like tree, performs layout in WebAssembly, rasterizes with
WebGPU, and returns a GPU texture or raw RGBA pixels. It does not start or
retain a browser process.

The canonical distribution is the immutable ES module set at
`https://cdn.urania-libs.com`. This npm package is a convenience distribution of
the same plain ES modules for Node and Bun hosts.

## Requirements

- A WebGPU adapter for pixel or texture output.
- Node 22 or later with the optional peer dependency `webgpu`, or
- Bun 1.3 or later with the optional peer dependency `bun-webgpu`, or
- Deno 2 or a current browser, which provide WebGPU natively.

## Install

```sh
npm install sandom webgpu      # Node
bun  add     sandom bun-webgpu # Bun
```

## Use

```javascript
import "sandom/gpu"; // mounts navigator.gpu on Node and Bun; no-op elsewhere
import { loadFont } from "sandom/font-registry";
import { createSandomDOM } from "sandom/dom";
import { encodePNG } from "sandom/png";

const font = await loadFont(
  "IBM Plex Mono",
  new URL(
    "../test-assets/IBMPlexMono-Regular.ttf",
    import.meta.resolve("sandom"),
  ),
);
const dom = createSandomDOM({ viewportW: 320, viewportH: 180 });
const root = dom.createElement("main");
root.style.width = "320px";
root.style.height = "180px";
// Declare the family that was loaded. Without this the element inherits
// `sans-serif`, which has no system font resolver on a server, and the
// render throws rather than picking a font nobody asked for.
root.style.fontFamily = "IBM Plex Mono";
root.appendChild(dom.createTextNode("DOM in. Pixels out."));
const snapshot = await dom.renderSnapshot(root);
const png = await encodePNG(snapshot.pixels, snapshot.width, snapshot.height);
```

`sandom/gpu` resolves per runtime through conditional exports: the Node entry
mounts Google Dawn from the `webgpu` package, the Bun entry mounts Dawn from
`bun-webgpu`, and the default entry verifies that the host already provides
`navigator.gpu`.

For a server bundle, supply final runtime resources instead of package-relative
URLs:

```javascript
import { createSandomRuntime } from "sandom/runtime";

const runtime = await createSandomRuntime({
  assets: {
    harfbuzz: harfbuzzBytes,
    msdfgen: msdfgenBytes,
  },
});
// The runtime owns its font registry: load into that, not the module-level
// registry, so each runtime keeps separate font and glyph state.
await runtime.loadFont("Inter", interFontURL);
const component = await runtime.renderComponent(componentOptions);
```

Asset values must be `Uint8Array`, `ArrayBuffer`, or absolute URLs. The two
engine assets are `harfbuzz` and `msdfgen`; JPEG, PNG, WebP and JPEG XL bytes
go under `assets.codecs` and stay lazy. Supplying `assets` at all means
supplying every asset the document needs — the runtime stops resolving
package-relative URLs and reports `runtime.assets.mode === "explicit"`.
`resolveSystemFontFamily` is the only other accepted option; there are no
built-in document fonts, so a document's families come from `loadFont` or
`@font-face`. Each runtime owns separate WebAssembly instances, font and glyph
state, path and image caches, and renderer contexts, and releases the last of
those with `runtime.releaseRenderContexts()`.

OpenType scalar metrics come from the exact `@sandom/font-metrics@0.1.0`
dependency. Sandom owns font loading, collection-face selection, WASM
marshalling, and the renderer/registry error policies; it contains no fallback
font-table parser.

## Vite component adapter

Install Vite only when the project uses the optional adapter:

```sh
npm install sandom vite
```

The adapter requires Vite `>=8.2.0 <9` and Deno 2. It validates the installed
Vite version during adapter creation.

```javascript
import { createViteComponentAdapter } from "sandom/adapters/vite";

const adapter = await createViteComponentAdapter({
  vite: {
    root: process.cwd(),
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  },
  entry: "/src/mount-entry.jsx",
  stylesheet: "/src/styles.css?inline",
  revision: { module: "/src/revision.js", export: "SOURCE_REVISION" },
  resources: [{
    module: "/src/resources.js",
    export: "fontURL",
    kind: "font",
  }],
});

const result = await adapter.render({ revision: "source-1" });
await adapter.dispose();
```

The entry module exports `mount(context)`. The adapter imports that module only
after the Deno realm installs Sandom globals.

Each render uses a fresh Deno process. The result has kind
`sandom/component-adapter-result` and version 1.

Pass `server` instead of `vite` creation options to use a caller server. That
server must have a documented `DevEnvironment` with the selected environment
name.

Root package imports do not load Vite or adapter code.

## Compiled application adapter

Use the generic entry for a public compiled browser application:

```javascript
import {
  createCompiledApplicationAdapter,
} from "sandom/adapters/compiled-application";

const adapter = await createCompiledApplicationAdapter({
  documentURL: "http://127.0.0.1:3000/component-review",
  readiness: {
    selector: "html",
    attribute: "data-application-ready",
  },
});

const result = await adapter.render({ revision: "source-1" });
await adapter.dispose();
```

The adapter fetches one public document and a finite resource set.
It executes selected classic scripts in document order.
It transfers assets, resources, pixels, and images as raw bytes.
Application console calls return as structured diagnostics.
The realm reserves standard output for protocol frames.
The realm owns application timers and WebSockets.
Terminal disposal cancels timers and closes sockets.
It then emits evidence and destroys the process without global restoration.

Each render uses a fresh Deno process.
The process receives an empty environment.
The host command does not require environment-variable permission.
The adapter rejects missing readiness, unlisted scripts, missing resources,
incomplete disposal, standard-error output, and an inexact exit.

## Next.js component adapter

Install Next.js only when the project uses the optional entry:

```sh
npm install sandom next react react-dom
```

The adapter requires Next.js `>=16.3.1 <17` and Deno 2.
It validates the installed Next.js version during adapter creation.

```javascript
import { createNextComponentAdapter } from "sandom/adapters/next";

const adapter = await createNextComponentAdapter({
  documentURL: "http://127.0.0.1:3000/component-review",
  serverEnvironmentURL:
    "http://127.0.0.1:3000/api/server-environment",
});

const result = await adapter.render({
  revision: "source-1",
  interaction: {
    target: { selector: "[data-component-action]" },
  },
});
await adapter.dispose();
```

The adapter uses public Next.js HTML, scripts, resources, and the development
middleware manifest.
It supplies a real WebSocket to the isolated realm.

The server environment endpoint returns global descriptors, Sandom global
names, and one process identifier.
The adapter requires this record to stay unchanged.

The Next.js entry does not use a private compiler registry.
It does not call a production build.
It creates a fresh realm after incremental compilation.

Root package imports do not load compiled-application or Next.js adapter code.


## Bun

No JavaScriptCore feature flag is needed: Sandom's engine and HarfBuzz share one
WebAssembly memory, so Bun compiles the engine binary with default settings.

On Bun, WGSL compilation errors do not surface: `bun-webgpu` does not implement
`getCompilationInfo`, so `sandom/gpu` stubs it.

## Live component interaction

`renderComponent()` returns one live component session. The session accepts
closed pointer, wheel, key, composition, and accessibility-action records.

```javascript
import { renderComponent } from "sandom/dom";

const component = await renderComponent({
  width: 320,
  height: 180,
  mount({ document, container }) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", "Example checkbox");
    container.appendChild(checkbox);
  },
});

const initial = await component.render();
const checkbox = initial.accessibility.nodes.find((node) =>
  node.role === "checkbox"
);
const successor = await component.dispatch([{
  kind: "accessibility-action",
  accessibilityRevision: initial.accessibilityRevision,
  nodeIdentifier: checkbox.identifier,
  action: "press",
}]);
await component.dispose();
```

Each accepted frame contains pixels, focus, changed control states, interactive
text geometry, and one matching accessibility snapshot.

The maintained defaults cover button, text input, textarea, checkbox, radio,
select, option, and label controls. The package does not provide form
submission, validation, clipboard, file input, document drag and drop, context
menus, auxiliary click, double-click defaults, or cross-document navigation.

## Entry points

- `sandom/runtime` — the bundler-safe `createSandomRuntime` entry.
- `sandom` — scene renderer: `createSandomRuntime`,
  `createLayoutArtifact`, `createDisplayListArtifact`,
  `createInvalidationArtifact`, and `renderScenePixels`.
- `sandom/dom` — the public DOM facade: `createSandomRuntime`,
  `createSandomDOM`, `renderComponent`, render planning, inspection, and
  browser-worker rendering.
- `sandom/web-component` — the `<sandom-renderer>` browser component.
- `sandom/font-registry` — `loadFont` and the font family registry.
- `sandom/gpu` — runtime-conditional `navigator.gpu` mounting.
- `sandom/adapters/vite` — the optional Vite development adapter.
- `sandom/adapters/compiled-application` — the public browser-application
  adapter.
- `sandom/adapters/next` — the optional Next.js development adapter.
- `sandom/component-adapter-result` — the shared result validator.
- `sandom/component-adapter-realm-protocol` — the versioned realm protocol.
- `sandom/src/*.js` — direct module access, identical to the CDN layout.

## Project status

Sandom is experimental. It implements a tested subset of DOM, CSS, layout,
animation, image, text, and interaction behavior. Unsupported records and
invalid public inputs fail loudly instead of producing a partial result.
