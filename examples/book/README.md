# Book

A library of books on a table, drawn with [VGPU](https://vgpu.sh): a
hardcover, a paperback, a saddle-stitched booklet, a ring-bound notebook and
a top-bound sketchpad. Leaves turn under simulated physics when you drag
them. Every printed page is Sandom: each book prints its own document, and
the sidebar editor prints any HTML and CSS across the numbered pages as a
live document you can click, select and type into on the paper.

## Pattern

A document inside a WebGPU scene, as in the Performance section of the
package README:

- One `GPUDevice` for the page. VGPU creates it, Sandom renders with it
  (`createSceneRenderer({ graphicsDevice })`), and every presented frame is
  copied into the book's page sheet with `copyTextureToTexture`. No pixels
  are read back.
- A document laid out once, then paged by scrolling. `flow.js` keeps one
  render surface whose viewport is one page of content tall. It lays the
  document out as one column, reads the line boxes and break properties
  from the presented frame and `getBoundingClientRect`, and cuts the column
  into pages (`pageBreaks`: `break-before`, `break-after`, `break-inside`,
  `orphans`, `widows`). Each page is then rasterized by scrolling the
  viewport to it, a scroll-only frame that serializes and lays out nothing.
- Lazy redraw. The flow sheet caches eight pages near the open spread. The
  pages in view are kept current; a change that reaches pages out of view
  marks them stale, and they are drawn again when a leaf starts to turn
  toward them.
- Replacing the printed document keeps the engine. "Load the essay" and
  "Load the website" (and every edit in the editor) call `setContent`,
  which replaces the body and style sheet of the flow's live document. The
  surface, its renderer, glyph caches and GPU targets, the page sheet and
  the input binding all stay, so a different document costs one
  serialization of its own content and a scroll-only frame per page shown,
  not a new surface. A new surface is made only when the page size changes
  (another book type) or the editor's document is chosen again after the
  book's own pages, which releases it.
- `bindProjectedInput` with the book's projection. A pointer becomes a ray
  from the camera; a hit on a resting page's text block is a point on that
  page, which `flow.documentPoint` turns into a point of the surface's
  viewport. The inverse (`unproject`) follows the caret back through the
  page and the camera, so the browser's composition window opens at the
  caret on the paper. Margins, fore edges and covers stay with the book and
  turn pages.
- The book draws only when something changed: a leaf moving, a camera move,
  a new Sandom frame in the sheet, a control. The key-light and sky maps are
  drawn again only when the book's shape or the light changes.
- The device scale (2 texture pixels per CSS pixel, at 5 CSS pixels per
  millimetre of paper) is chosen once and never changes during a turn.

Classic inline scripts in an edited document run once per edit against
their own window object (`createInputWindow`), so `document` in the
website's sign-up script is the printed document. Fixed boxes are placed as
if absolutely positioned and sticky boxes stay in flow, because a page is
paper, not a screen.

`globalThis.example` exposes read-only state for automation and the
console: the open spread, the flowed document's pages and its surface's
counters, and projections from an element of the printed document or a
point on a stack to a client point on the canvas.

## Run

Serve this directory with any static server and open it in a browser with
WebGPU (Chrome or Edge 113 or later, Safari 26):

```sh
npx serve .
# or
python3 -m http.server 8000
```

Sandom, its WebAssembly dependencies and VGPU 0.5.0 load from jsDelivr
through the import map in `index.html`. Inter loads from the sandom
package's `test-assets/`; Crimson Text loads from the Google Fonts
repository at a pinned commit. The shaders are the `.wgsl` files beside the
page, fetched at start.

## Expected result

A closed blue hardcover lies on a table, "On Paper" stamped in gold. Page
Down, a tap of Space, or Next page opens the cover; dragging a page from its
fore edge across the spine turns it, and it falls under its own weight.
Drag the table to orbit, hold Space and drag to pan, and scroll to zoom.

Choose "Load the website": the sidebar status reads `3 pages, laid out in …
ms`, and the book prints the site across its pages. Turn to page 2, click
the Name field on the paper and type: the text and caret appear on the
printed page. "Load the essay" prints the essay in Crimson Text in place of
the website, with each section starting on a new page.

The book type, paper weight, stock and tone, and the light are in the
sidebar. Without WebGPU the status line reports it instead.

## Limits

- A box cut by a page break is clipped at the cut instead of closing and
  continuing on the next page; `@page` and left and right page margins are
  not read; Sandom does not implement `text-indent`.
- Physics runs on the main thread, about 4–7 ms per turning leaf.
- A ring-bound page stops at the left stack instead of turning a full 360°.

## Licences

The example code and shaders are under Apache-2.0, the `sandom` package's
licence. VGPU is under the MIT licence. Inter, by Rasmus Andersson, and
Crimson Text, by Sebastian Kosch, are under the SIL Open Font License 1.1.
