# Sandom Component Studio

Component Studio runs pairwise component sweeps with Sandom. It compares two
committed versions of an end-user component project. Both sides use the same
renderer, viewport, raster density, and generated props.

## Start

Keep this repository beside the `sandom` checkout and its local library
checkouts. `import-map.json` maps the library prefix that Sandom sources import
to that workspace, as paths under `../`. The server derives the page's import
map from the same file and serves those paths under `/libraries/`. The Sandom
checkout supplies its prepared React and shadcn realm bundle, processed
stylesheet, renderer modules, and Inter font.

The public Sandom repository carries this studio under
`experiments/component-studio/` as reference code. That copy omits
`import-map.json`, because the library prefix names a private workspace, and it
carries no Git history. To run it, place it in a Git repository beside a Sandom
source checkout, supply an import map with the specifiers that Sandom sources
import, and commit at least two revisions of the component project.

```sh
deno task start
```

Open `http://127.0.0.1:9361/studio`. Set `STUDIO_PORT` to select another port.
The server binds to the loopback interface. The page needs WebGPU.

Set `STUDIO_PROJECT` to the path of another local Git codebase with a committed
`components.json` manifest:

```sh
STUDIO_PROJECT=/path/to/component-codebase deno task start
```

The unconfigured landing page starts a sweep for the first registered component
automatically. It captures the first six generated variants, or all variants
when the schema produces fewer. The fixture project starts with ActionButton.
The configuration waits for variant generation before it accepts range edits.
A run URL restores retained results. It starts further captures only when the
operator selects **Resume sweep**. **Stop after case** completes the active
Before / After pair and stops before the next variant.

## Component projects

`components.json` identifies the project, stylesheet, component modules, and
property schemas. It uses `sandom/component-project` version 1. Module and
schema paths can identify files in a project's source directories.

Each component module exports `createComponent(runtime)`. The function returns
a React component. `runtime` supplies the same React functions and shadcn
components used by the Sandom realm. Use its `createElement`, hooks, and
components. A second React copy has a different hook dispatcher.

The fixture modules are plain JavaScript. They need no build step. The module
loader also serves relative imports and public assets from the same commit.
The component code uses the Sandom realm through the supplied runtime. Browser
global DOM access identifies the host page, rather than the component document.

Each schema declares the component's finite property domains. The shared
SandScript-backed generator selects pairwise examples from the **After**
schema. The studio passes each example to both revisions. A component absent
from either revision produces an error. Unsupported props or source errors
remain visible failures.

To inspect a codebase evolution:

1. Add the component factory, stylesheet, schema, and manifest entry.
2. Commit the component sources.
3. Change the component and commit its evolved sources.
4. Select **Refresh revisions**.
5. Select Before, After, a component, and an inclusive variant range.
6. Select **Run pairwise sweep**.

The supplied Git history contains a neutral interface baseline and a violet
component evolution. The evolution changes action text, notification text,
field geometry, and component styling. These are component changes. The
renderer stays fixed.

## Review and interaction

**Before / After** shows retained Sandom captures. The images are stacked.
The reveal slider and visible divider select the boundary. Before is left of
the divider. After is right of it. Zoom selects natural CSS size or integer
magnification. The image region scrolls to show the complete capture.

**Live component** mounts the selected case from Before or After. **Enable
interaction** controls pointer, hover, keyboard, text composition, clipboard,
and wheel delivery through Sandom's projected-input binding. Turning it off
releases the binding and keyboard focus. It preserves the component's React
state. **Reset component** restores the case's initial state.

**Pick an element** temporarily pauses component interaction. A click selects
the Sandom element under the pointer. The DOM tree also selects elements with
interaction disabled. The inspector shows attributes, text, bounds, computed
styles, and control state. Captured-side inspection reads retained records;
live inspection reads the live Sandom document. The source panel shows the
exact committed component module.

The URL stores the run, case, view, selected sides, zoom, reveal position,
interaction mode, and selected DOM node. Reload, Back, and Forward restore
those selections. Unsaved live component state is transient; a restored view
starts from the retained case props.

## Source and capture identity

The service reads component modules, imports, stylesheets, and schemas with
`git show` from full commit identifiers. Working-tree edits do not alter a
selected revision. Run provenance records both commits, source digests, the
After schema digest, renderer identity, viewport, and fixed raster density.
The page renders both revisions through one loaded Sandom runtime. Renderer
identity drift refuses additional capture for a retained run.

Coverage counters emitted as 64-bit integers use decimal strings in the
JavaScript Object Notation records.

This is a local developer tool. Component modules execute trusted code in the
studio page. Use reviewed project sources. The tool does not sandbox an
untrusted project.

## Retained formats

`.studio/runs/<identifier>/run.json` uses
`sandom/component-evolution-run` version 1. A resumable run is a mutable durable
source. The run contains its plan and retained results. Each result references
`cases/<index>/before.png` and `after.png`, with DOM inspection records for both
sides. Completed runs and captures are sealed historical evidence.

The service rejects unsupported run versions. It preserves their bytes. An
image upload must match the plan's physical raster dimensions. A result
appends at the next planned position. Existing completed case results remain
immutable. An interrupted upload can replace its uncommitted case files on
resume. Atomic manifest replacement publishes the complete result.

## Verification

```sh
deno task check
deno task test
```

The server tests cover committed-source reads, bounded pairwise planning,
nested routes, and the API boundary. Browser verification exercises actual
Sandom renders, reveal and zoom, live interaction, element inspection, and
navigation restoration.
