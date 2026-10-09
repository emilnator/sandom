# Sandom examples

Each example is a complete program that uses the published `sandom` package
the way the package README's Performance section recommends: one kept render
surface per shown document, only the changed nodes mutated, frames presented
as GPU textures without a readback, and one `GPUDevice` shared by Sandom and
the host.

| Example | Runs in | What it models |
| --- | --- | --- |
| [still-image](./still-image/) | Node, Deno | One PNG from a DOM built in the process |
| [badge-batch](./badge-batch/) | Node, Deno | Many PNGs from one template on one kept surface |
| [motion-gif](./motion-gif/) | Node, Deno | A CSS animation captured to an animated GIF by the surface's clock |
| [react-session](./react-session/) | Node, Deno | A React application mounted once in a kept component session |
| [code-editor](./code-editor/) | Browser | A live editor on a canvas: texture presentation and projected input |
| [wikipedia-scroll](./wikipedia-scroll/) | Browser | A long, scrolling document on a mesh in a three.js WebGPU scene |
| [shatter](./shatter/) | Browser | One live, animated document split across many meshes |

## Running

Node and Deno examples carry a `package.json` that installs `sandom` from
npm. In the example's directory:

```sh
npm install && node render.js          # Node 22 or later
deno install && deno run -A render.js  # Deno 2
```

Browser examples are static pages. Their import map loads `sandom` and
three.js from jsDelivr at pinned versions, so any static file server works.
From this directory:

```sh
python3 -m http.server 8000
```

then open `http://localhost:8000/<example>/` in a browser with WebGPU (Chrome,
Edge, or Safari 26).
