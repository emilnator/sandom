# Wikipedia scroll

A paper scroll hangs between two wooden rollers in a three.js scene. The paper
carries the Wikipedia article "Dead Sea Scrolls", rendered by Sandom. The mouse
wheel, the trackpad, the keyboard, or a finger drag on the paper scrolls the
article; the text moves over the rollers, and the rollers turn with the
scroll. A click on a link opens the linked Wikipedia page in a new tab.

## Pattern

A document inside a three.js or WebGPU scene, as in the Performance section
of the package README:

- One `GPUDevice` for Sandom and three.js. `createTexturePresenter` hands
  Sandom's frame texture to the scene once per texture identity, and the
  paper material samples it as a `THREE.ExternalTexture`. No pixels are read
  back.
- One Sandom document covers the full visible length of the paper: the front
  of the top roller, the flat face, and the front of the bottom roller. Its
  own scroll container (the `<article>`) moves the text along that path; a
  scroll renders through the kept surface.
- `bindProjectedInput` routes pointer, wheel, and keyboard input from the
  canvas to the document. Its `project` callback raycasts the paper mesh and
  turns the hit's texture coordinates into document pixels, so a click lands
  on the link under the pointer even where the paper curves. A wheel turn
  anywhere on the canvas scrolls the article.
- The rollers read `scrollTop` in a `scroll` listener: one roller
  circumference of scroll is one turn. The three.js frame loop only eases the
  rollers and the camera toward their targets and draws; it never changes the
  Sandom document, whose own loop renders only when the document changes.
- The texture density (two device pixels per CSS pixel) is fixed for the
  document's life.
- On a device with touch input, the surface is created with
  `touchPanning: true`, so a finger drag that starts on the paper pans the
  article. A mouse drag selects text on every device.
- Fonts: Sandom has no system fonts. The page loads the two families the
  article CSS names, Inter and Roboto Slab, from the package's `test-assets/`
  directory with `loadFont`, and `installFontSetFallbackFamilies()` reads the
  coverage index of Sandom's Noto fallback families. The Hebrew word in the
  article loads Noto Sans Hebrew when it is first shown.

The article comes from one pinned revision through the MediaWiki parse API at
load (`article.js`). The browser's `DOMParser` keeps the article prose,
headings, lists, and the infobox and drops the site interface, images,
reference markers, and the sections from "See also" to the end.

`globalThis.example` exposes read-only state (`scrollTop`, `scrollMax`,
`rollerAngle`, and `sandomFrames`, the count of presented Sandom frames) for
automation and the console.

## Run

The page needs a browser with WebGPU (Chrome or Edge 113 or later, Safari 26)
and network access to `en.wikipedia.org` (the article), `cdn.jsdelivr.net`
(Sandom, its WebAssembly dependencies, the fonts, and three.js), and
`cdn.urania-libs.com` (Sandom's Noto fallback font set). From the examples
directory:

```sh
python3 -m http.server 8000
```

then open `http://localhost:8000/wikipedia-scroll/`.

## Expected result

After a short load, a cream paper scroll hangs on a red cord between two
turned wooden rollers on a dark background. The paper shows the title "Dead
Sea Scrolls" in a slab serif, the description "Ancient Jewish biblical
manuscripts", the attribution line, the infobox table, and the start of the
article; the text curls over the top roller and under the bottom one.

A wheel turn over the paper moves the text up the paper and over the top
roller, and both rollers turn by the distance scrolled. Links are dark red;
a click on one opens the Wikipedia page in a new tab. Without WebGPU, or
without network access to Wikipedia, the page shows a one-line notice with
the reason.

## Licences

The page fetches the article at load; this directory contains no copy of the
article text.

| Item | Value |
| --- | --- |
| Article | [Dead Sea Scrolls](https://en.wikipedia.org/wiki/Dead_Sea_Scrolls) |
| Revision | [1373755579](https://en.wikipedia.org/w/index.php?title=Dead_Sea_Scrolls&oldid=1373755579), 7 September 2026 |
| Authors | [Page history](https://en.wikipedia.org/w/index.php?title=Dead_Sea_Scrolls&action=history) |
| Text licence | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Changes | Our own layout. The page omits the images, the reference markers, and the sections from "See also" to the end. |

The document shows the attribution notice at the top of the article. The
page reproduces the article content only, not the Wikipedia logo, wordmark,
tagline, menus, tabs, or styles.

The example code is under Apache-2.0, the `sandom` package's licence.
three.js is under the MIT licence. Inter and Noto Sans Hebrew are under the
SIL Open Font License 1.1; Roboto Slab is under the Apache License 2.0. The
rollers, knobs, cord, and paper are procedural three.js geometry in
`main.js`; no model file is used.
