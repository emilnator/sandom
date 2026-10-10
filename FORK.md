# This fork

This is [Sandom](https://github.com/fernandoviac/sandom) at `8bff7c4` with fixes that haven't landed upstream yet. Each fix is one commit, so a fix can be dropped once upstream has it. Each one is also offered upstream; the PR texts are in [`fork/prs/`](fork/prs/).

The WebAssembly core (`src/wasm/renderer-core-binary.js`) is upstream's binary, unchanged. Its source isn't public, so the fixes are all JavaScript.

## The fixes

| # | Commit | What it fixes |
|---|---|---|
| 01 | DOM: Node.compareDocumentPosition and the DOCUMENT_POSITION constants | The method was missing; Base UI, floating-ui and Radix threw as they mounted. |
| 02 | Layout getters: an image that hasn't loaded lays out without a natural size instead of throwing | `offsetWidth` and friends threw while any image was loading. |
| 03 | DOM: HTMLImageElement and HTMLSourceElement, with reflected src, srcset, sizes, alt, width and height | `img.src = …` set nothing, so React and Preact images stayed blank. |
| 04 | Component sessions: drop the window's event listeners on dispose | A disposed session's window listeners ran in the next session. |
| 05 | Component sessions: the host hears uncaught errors and rejections the page doesn't handle | An uncaught error in the page ended the Deno process. |
| 06 | Component sessions: pause() and resume(), and 60 Hz host frames without requestAnimationFrame | An animating kept session rendered hundreds of frames a second. |
| 07 | Component sessions: display.colorScheme, and setDisplay() to change it | No dark mode; `matchMedia` lists went stale when the scheme changed. |
| 08 | Component sessions: capture({ height }) paints the page beyond the viewport without the page seeing it | A full-page image meant resizing the viewport, which the page saw. |
| 09 | Component sessions: inspectMotion() and captureFrames() | Sessions couldn't capture an interaction's frames. |
| 10 | Resources: key decoded images by URL and content | A later document could paint an earlier document's image for the same URL. |
| 11 | Resources: release a disposed document's images from the renderer's image table | The 257th distinct image or canvas in a process failed. |
| 12 | Component sessions: the window's event handler attributes | `window.onresize = f` never ran; an element's `on*` setter on the window crashed. |
| 13 | Layout: inline \<img\> and \<svg\> sit on the line | Inline images and icons each took a line of their own. **Workaround**, see below. |

New session API from 06–09: `pause()`, `resume()`, `setDisplay({ colorScheme })`, `capture({ height })`, `inspectMotion()`, `captureFrames({ frameBudget, durationMilliseconds })`, and the `display.colorScheme` option of `renderComponent`. Upstream may name or shape these differently when it takes them.

## Known limits

- **13 is a workaround.** It rewrites the layout records the WebAssembly core writes, just before layout runs, because the core lays out `<img>` and `<svg>` as blocks. It depends on the current binary: re-run repro 13 whenever the binary changes. An image or svg in a table cell, or next to a block element, still breaks the line; `img { display: inline-block }` in author CSS covers images there.
- **Outer `<svg>` sizing is not fixed.** `width="50%"` is read as 50px, and a viewBox-only svg takes the viewBox as its size (repro 14 fails). A JavaScript workaround made common SVGs worse and was dropped; it needs the core. Author CSS (`width`, `height`, `aspect-ratio`) sizes svgs correctly.
- **`capture({ height })`** lays the page out at the capture height, so `vh` and `@media` height queries apply as for a taller window, and running animations and transitions show at rest. Pause and let motion settle before capturing an animated page.
- Page timers (`setTimeout`, `setInterval`, `MessageChannel`) stay the host realm's: they keep running while a session is paused, and outlive `dispose()`.

[`fork/prs/issues.md`](fork/prs/issues.md) describes the core fixes for 13 and outer `<svg>` sizing.

## Using it

Map `sandom/` to this fork's `src/`. The three WebAssembly packages it imports by bare name come from upstream's CDN set, as `fork/run.sh` does:

```json
{
  "imports": {
    "sandom/": "<this fork>/src/",
    "@sandom/color/color.wasm": "https://cdn.urania-libs.com/set/f1e14195019cce73/sandom-color/dist/color.wasm",
    "@sandom/font-metrics/font-metrics.wasm": "https://cdn.urania-libs.com/set/f1e14195019cce73/sandom-font-metrics/dist/font-metrics.wasm",
    "@sandom/gain-map/gain-map.wasm": "https://cdn.urania-libs.com/set/f1e14195019cce73/sandom-gain-map/dist/gain-map.wasm"
  }
}
```

That CDN set's Sandom sources are the same as `8bff7c4` for every file the fixes touch, so the fork changes only the fixes.

## Repros

[`fork/repros/`](fork/repros/) holds one standalone Deno script per issue. They use the public `renderComponent` API and print `PASS`/`FAIL` lines. Run them with Deno 2.9 or later, a WebGPU adapter, and network access to `cdn.urania-libs.com`:

```sh
fork/run.sh .          # every repro against this checkout
fork/run.sh . 04 12    # some of them
```

On this fork, 01–13 print `all passed` and 14 fails as described above. On upstream `8bff7c4`, all fourteen fail.

## Keeping it current

- When upstream takes a fix, drop its commit here.
- When upstream moves, rebase these commits onto it and run every repro. `src/dom/render-component.js` is where commits 04, 06–09 and 12 touch neighbouring lines.
- Each fix also exists on its own branch from `8bff7c4` (`fix/<nn>-<slug>`), for upstream PRs.
