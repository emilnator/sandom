# Still image

`render.js` builds a small release card as a DOM tree — a heading, a
paragraph, and a table styled by a `<style>` element — renders it once, and
writes `release-card.png`. Then it writes two more cards, for the beta and
nightly channels, from the same kept surface.

## Pattern

- `createSandomDOM` and `createRenderSurface` build the document and the
  surface in this process. No browser and no HTML file are involved.
- `surface.stop()` turns off the host frame loop: a program that writes a file
  renders on demand with `renderNow`.
- `renderNow({ pixels: true })` reads the frame back to the CPU because a file
  needs pixels. A live page leaves `pixels` out and presents the texture
  instead (see `code-editor`).
- Fonts come from `loadFont`. Sandom has no system fonts; the package ships
  Inter and IBM Plex Mono under `test-assets/`, and the stylesheet names
  those families.
- The `<style>` element applies once the tree is connected, so `main` is
  appended to `dom.document` before its markup is set.
- `sandom/gpu` is imported only when the host has no `navigator.gpu`. Node
  needs it to mount Dawn from the optional `webgpu` dependency; Deno has
  WebGPU built in, and `deno install` does not install optional
  dependencies.

### Many images from one kept surface

The card is built once. For each further image the program keeps the nodes
that differ — the badge element and its text node, and the version cell's
text node — sets their `data` and the badge's class, and renders the same
surface again. Nothing is replaced or rebuilt between images, and the class
goes on the badge rather than the root, which would restyle every element
under it. The surface retains its layout, glyph resources and GPU target, so
each image after the first costs what its changed nodes cost; a new
document or a new surface per image pays for the whole card again (the
Performance section of the package README measures both).

The program prints each frame's time and `dirtyRectangles` count, then
`surface.frameStageCounters`. The damage is kept in 64-pixel tiles. The
badge change repaints the 2 tiles under the badge. The version cell's text
change repaints 22, every tile of the table and the card's top-left tile:
Sandom's damage for text inside a table cell is wider than the cell. That
is a defect in the engine, not part of the pattern; the program still
changes only the cell's text node.

## Run

Node 22 or later (the optional `webgpu` dependency supplies Dawn):

```sh
npm install
node render.js
```

Deno 2 (WebGPU is built in):

```sh
deno install
deno run -A render.js
```

## Expected result

```text
wrote release-card.png (480×300, … bytes)
wrote release-card-beta.png in … ms, 24 dirty rectangles
wrote release-card-nightly.png in … ms, 24 dirty rectangles
{ serializations: 3, layoutPasses: 1, retainedCleanFrames: 0 }
```

`release-card.png` shows "Release card" with a blue "stable" pill, a grey
paragraph, and three table rows whose right column is set in IBM Plex Mono
on a dark blue gradient; the last row reads `Version 0.5.0`. The beta card
has an amber "beta" pill and version `0.6.0-beta.2`, the nightly card a
violet "nightly" pill and version `0.6.0-nightly.1009`.
