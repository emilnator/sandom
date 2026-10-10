# Layout: inline <img> and <svg> sit on the line

Branch: `fix/13-replaced-elements-inline`

> **A JavaScript workaround, not the fix.** The right fix is in the WebAssembly core's scene build, whose source isn't in this repository; see "The core fix" below. This PR makes common inline images and icons correct today by adjusting the layout records the core writes, just before layout runs. When the core fix lands, drop this PR's code; the repro below then checks the core.

## What was wrong

The core lays out an `<img>` or an outer `<svg>` as a block whatever its computed `display`. Its scene build ends the inline run before the element and wraps the text on each side in an anonymous block. So an image or icon between two pieces of text broke the line: an icon next to `<strong>`, `<em>` or plain text took a line of its own, which breaks most icon libraries. With `display: inline-block` an `<img>` sat on the line, but an `<svg>` still didn't.

## What the spec and Chrome do

An `<img>`'s and an outer `<svg>`'s `display` is the initial `inline` (CSS Display §2; HTML §15 has no UA rule that changes it). An inline replaced element is an atomic inline-level box: it sits on the line, with its bottom margin edge on the baseline (CSS 2 §10.3.2, §10.6.2, §10.8). Chrome lays out `x<svg width=10 height=10></svg>y` on one line.

## What changed

- `src/dom/serialize.js`: an `<img>` or outer `<svg>` (scene displays 20 and 21) is marked inline-level when its author `display` is unset or `inline*`, it isn't floated, and it isn't absolutely or fixed positioned.
- `src/scene-renderer.js`: `applyReplacedElementRecords(nodes)` runs in `writeSceneNodesAndTileConfig`, after the rows are finished and before `layout()`, so every layout path goes through it.
  - For a block parent whose children are only the core's anonymous text runs and inline-level images and svgs, it makes the parent the inline formatting context and each run a plain inline box. The image or svg is then the atomic inline the layout engine already supports inside inline content.
  - A row it changes is stamped with the current generation, as the core's own write-if-changed stamps a changed row, so incremental layout lays it out again. Without the stamp, toggling an svg from `display: block` back to `inline` showed the block layout for one more frame.
  - It runs over every row on every write, so rows a sparse frame doesn't republish keep the rewrite. Each parent is decided once per write.

Limits:

- If the parent also has a block-level child, or isn't a block (a table cell, for instance), the image or svg stays a block, as on `main`.
- It depends on today's record layout and the core's anonymous-box shape, not on a documented interface.
- Outer `<svg>` sizing (percentage `width`/`height` attributes, a viewBox without a size) isn't part of this PR. A JavaScript workaround for it was tried and dropped: it collapsed `width="100%" height="100%"` charts to 0 height and broke `max-width`, percentage margins and author `aspect-ratio`. That needs the core.

## The core fix

When the scene build assigns `image` or `svg`, keep the computed outer display: `inline` and `inline-block` give an atomic inline-level box, while `block` and blockified boxes (floats, absolutely positioned boxes, flex and grid items) keep today's behaviour. `DISPLAY_SVG_ROOT` and the image display need an inline-level variant, or a flag.

## How it was verified

The repo has no test suite for layout (the maintained tests aren't published), so this was checked with standalone Deno repros.

```
Before: FAIL <img> sits on the line after "x"
        FAIL <svg> sits on the line after "x"
        FAIL <svg inline-block> sits on the line after "x"
After:  all 3 pass
```

Common icon structures, compared with `main`:

| Structure | `main` | This PR |
|---|---|---|
| svg before `<strong>` | own line | on the line |
| svg after `<em>` | own line | on the line |
| svg between plain text | own line | on the line |
| svg in a `<button>`, `<a>`, `<li>` or `<label>` | on the line | on the line, unchanged |
| `float: right` image | floated | floated, unchanged |

Between frames, each of these was compared with a fresh render of the final DOM, and all matched:

- toggling the image to `display: block`, and an svg back from `block` to `inline`;
- appending a block child to the parent;
- setting `float`;
- removing the image;
- editing the text beside it;
- inserting an icon into a paragraph that had none.

Per-write cost with 6000 inline svgs followed by a block in one parent is about 21 ms, in line with `main` (27–36 ms in review). Unrelated repros give the same results as before.
