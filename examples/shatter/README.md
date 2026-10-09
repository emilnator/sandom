# Shatter

A settings page drawn by Sandom onto a pane of glass in a three.js WebGPU
scene. Click the glass between the controls and it breaks from that point
into about seventy Voronoi shards. Every shard samples its slice of the same
live document texture, so the switches still flip and the CSS animations
still run on the pieces lying on the floor.

## Pattern

A document inside a three.js scene, as in the Performance section of the
package README:

- One `GPUDevice` for the page. Sandom renders with it, and three.js's
  `WebGPURenderer` is created on it, so the document's texture never leaves
  the GPU. `createTexturePresenter` hands the texture to three.js as an
  `ExternalTexture` once per texture identity; every later frame lands in
  the texture the material already samples. No pixels are read back.
- One render surface for the page's life. The document is ordinary HTML
  with a `<style>` element: real checkboxes behind the switches, text
  inputs, radio buttons, and two infinite CSS animations. A click on a
  switch changes one checkbox; the surface's own loop renders a frame only
  when the document changed or an animation advanced.
- `bindProjectedInput` with a raycast projection. A pointer event becomes a
  ray, the ray hits a shard, the hit's UV is a document coordinate, and the
  document receives a real pointer event there. The same projection serves
  one pane or seventy shards. Its inverse (document point to screen point)
  keeps the browser's text-input sink at the caret while typing on a shard.
- The document decides what a press on the intact pane means: a press on a
  `label`, `button`, or `input` belongs to the page, any other press breaks
  the glass. `claimPointerDown` asks `dom.document.elementFromPoint` and
  keeps the press for the scene only on bare glass.
- three.js renders a frame only when there is something new to show: a
  frame Sandom presented, a step of the fall, a camera move, or a resize.
  Event handlers change the document; nothing changes it from
  `presentFrame`.
- The texture scale (2 texture pixels per document pixel) is chosen once.
  The fall and the camera move never lower it.

The fall is simulated in full at the moment of impact and played back one
step per frame, so it is deterministic for a given impact point, and
Reassemble plays it backwards.

`globalThis.example` exposes read-only state for automation and the
console: whether the pane is whole, the shard count, whether the shards or
the camera are moving, each switch's checked state with its document
rectangle, and the two projections between screen and document points.

## Run

Serve this directory with any static server and open it in a browser with
WebGPU (Chrome or Edge 113 or later, Safari 26):

```sh
npx serve .
# or
python3 -m http.server 8000
```

Sandom, its WebAssembly dependencies, and three.js 0.185.1 load from
jsDelivr through the import map in `index.html`; the Inter and IBM Plex Mono
faces load from the package's `test-assets/` directory.

## Expected result

A pane of glass stands on a dark floor, lit green from the left. On it is a
settings page: a pulsing green dot beside `sandom / glass`, four switches
under Display, name and handle fields and an Auto, Light, Dark selector
under Account, and a progress bar sweeping back and forth under Sync.

Click a switch's row: the switch slides and changes colour on the glass.
Click the glass anywhere else (the pointer shows a crosshair there): the
pane breaks from that point, the shards topple backwards onto the floor, and
the camera rises to look down on them. The pieces lie face up in roughly
the order they hung, still animating. Click a switch's row on any shard and
it flips. Reassemble rewinds the fall into one pane with the document's
state intact. Without WebGPU the page shows a one-line notice instead.

## Licences

The example code is under Apache-2.0, the `sandom` package's licence.
three.js is under the MIT licence. Inter, by Rasmus Andersson, and IBM Plex
Mono, by IBM, are under the SIL Open Font License 1.1.
