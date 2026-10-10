# Layout getters: an image that hasn't loaded lays out without a natural size instead of throwing

Branch: `fix/02-sync-layout-unloaded-image`

## What was wrong

Reading `offsetWidth`, `getBoundingClientRect()` or any other synchronous layout getter threw while the document held an image that hadn't loaded yet:

```
Error: imageIndexForSync: image "data:image/png;base64,…" (resource key …) not registered yet — synchronous layout-getters require the tree to have been rendered …
```

This happened even when the read was on an unrelated element: one unloaded `<img>` anywhere in the tree made every geometry read throw. It hit:

- any read during `mount`, before the first render had loaded the page's images;
- any read after an `<img>` was added, until the next render.

Components that measure as they mount, which is common in React, threw on any page with an image.

## Why this reverses the "honest contract"

`imageIndexForSync` and the comment on `emitSceneCommandsSync` call throwing the honest contract, "rather than silently blocking or guessing wrong". That holds for fonts and SVG paths: a layout without them would guess at text metrics or geometry a browser would have. It doesn't hold for images, because a browser has a defined answer for an image that hasn't loaded, and no guess is involved:

- HTML §4.8.4.3: while an image's request isn't complete, its state is "unavailable".
- CSS Images §5.2: an unavailable image has no natural dimensions. It's sized from its `width`/`height` (attributes or CSS), or else laid out without a natural size.
- Chrome never blocks or fails a layout read on an image fetch. `img.offsetWidth` right after `img.src = …` answers from the attributes, or as an image with no natural size, and `naturalWidth` is 0. Layout changes once the image loads, which is why pages that need the final size wait for `load` or `img.decode()`.

So the read answering now and changing after the load *is* the browser's behaviour, and throwing is the deviation. Fonts and SVG paths keep the throwing contract.

## What changed

- `src/scene-renderer.js`
  - `imageIndexForSync`: an image that isn't registered yet resolves to no image index, as a broken image already does. It's not recorded as broken, so the next frame loads it as usual. The resolver notes that the current synchronous layout met a loading image.
  - `layoutTreeBoxesSync`: such a layout is provisional. It drops the `syncLayoutWrite` it would hand to the next frame, and reports `loading.images = true` through an optional `options.loading` object.
  - The comments on `imageIndexForSync`, `emitSceneCommandsSync` and `layoutTreeBoxesSync` now describe the image case. The throwing contract is kept for fonts and SVG paths.
- `src/dom/live-geometry.js` (`computeLayoutBoxes`) offers a provisional layout to the surface marked as provisional.
- `src/dom/render-surface.js`: the surface holds a provisional layout like any other, so later getters answer from it, but `_takeSyncLayout` refuses it.
  - If the next frame took its rows and boxes, the image's box would stay unsized after the image loaded. An earlier version of this change did exactly that: the image stayed 200px wide instead of its natural 2px.
  - If it weren't held at all, every getter would lay out the whole tree again while the image loads. In review, 300 `offsetWidth` reads in a 300-element page took about 2.5 s that way. Held, they take 2 ms, as without an image.

Until it loads, an `<img>` without size attributes lays out as a broken image does in Sandom today, a block filling the line. That's Sandom's existing block layout for replaced elements, a separate issue. This change only makes the read succeed and the next frame correct.

## How it was verified

The repo has no test suite for the scene renderer or layout getters (the maintained Chrome-comparison tests aren't published), so this was checked with a standalone Deno repro. It uses `renderComponent` with a 2×1 PNG `data:` URL:

| Check | Before | After |
|---|---|---|
| sized sibling's `offsetWidth` before first render | throws | 30 |
| `<img width=40>` `offsetWidth` before first render | throws | 40 |
| `<img width=40>` `getBoundingClientRect().width` before first render | throws | 40 |
| unsized `<img>` read before first render succeeds | throws | number |
| `<img width=40>` after first render | 40 | 40 |
| unsized `<img>` after first render: natural width | 2 | 2 |
| `<img>` added after first render, read before the next | throws | number |
| that `<img>` after the next render: natural width | 2 | 2 |

- Before: 5 failed.
- After: all 8 pass.
- A second check reverts `src` from an unloaded image to a loaded one between frames; the next frame paints the loaded one.
- Unrelated repros give the same results as before.
