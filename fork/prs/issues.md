# Issues for the WebAssembly core

These two need the WebAssembly core, whose source isn't in this repository, so they're written up as issues for the core. For the first, a JavaScript workaround is on `fix/13-replaced-elements-inline` (see `13-replaced-elements-inline.md`), and the core fix below should replace it. The second has no workaround: one was tried and made common responsive SVGs worse, so it needs the core. Each has a standalone Deno repro that uses `renderComponent` and prints `PASS`/`FAIL` lines. Line references are to `8bff7c4`.

---

## Layout: `<img>` and outer `<svg>` are laid out as blocks, not inline

### Problem

Every inline image and icon lands on a line of its own. An `<img>` or an outer `<svg>` between two letters breaks the line in two. Most icon libraries render inline `<svg>`s, so their icons each take a full line.

- With `display: inline-block`, an `<img>` sits on the line, so the core does honour an inline-level outer display for images in that case.
- An outer `<svg>` still breaks the line with `display: inline-block`.

### What the spec says

- An `<img>`'s and an outer `<svg>`'s `display` is the initial `inline` (CSS Display §2). HTML §15's UA stylesheet has no rule that changes it.
- An inline replaced element is an atomic inline-level box: it sits on the line, with its bottom margin edge on the baseline (CSS 2 §10.3.2, §10.6.2, §10.8).

### Root cause

It's in the WebAssembly core.

- The core's scene build (`src/dom-wasm/scene-build.watpart`, not in this repository) gives `img` the scene display `"image"` (code 20) and an outer `svg` the display `"svg"` (code 21); see `src/dom/serialize.js:104-130`.
- Both ignore the element's computed outer display.
- The UA sheet (`src/dom/stylesheet.js:31-104`) has no rule for either, so the computed value is already `inline`. Adding `img, svg { display: inline }` there changes nothing; that was tried.

### Repro

Three paragraphs: `x<img width=20 height=10>y`, `x<svg width=10 height=10></svg>y`, and `x<svg style="display:inline-block" …></svg>y`. Each checks that the replaced element sits on the first line, after the `x`:

```
FAIL <img> sits on the line after "x": got false, want true
FAIL <svg> sits on the line after "x": got false, want true
FAIL <svg inline-block> sits on the line after "x": got false, want true
```

### Proposal (WebAssembly core)

- When the scene build assigns `image` or `svg`, keep the element's computed outer display as the box's outer display:
  - `inline` and `inline-block` make an atomic inline-level box on the line, its bottom on the baseline;
  - `block`, and blockified boxes (floats, absolutely positioned boxes, flex and grid items), make a block-level box, as today.
- The layout's `DISPLAY_SVG_ROOT` (`src/wasm/layout.js`) and the image display need an inline-level variant, or a flag next to them.
- The repro above is the acceptance test. It should pass with no author CSS.

---

## SVG: outer `<svg>` reads `width="50%"` as pixels, and a viewBox-only `<svg>` takes the viewBox as its size

### Problem

Responsive SVG charts and icons come out at the wrong size:

- `<svg width="50%">` is laid out 50px wide, whatever its containing block.
- `<svg viewBox="0 0 10 5">` with no `width`/`height` is laid out at 10×5px, the viewBox's numbers, instead of filling the line.

### What the spec and Chrome do

- On an outer `<svg>`, `width` and `height` are presentation attributes for the CSS `width` and `height` properties (SVG 2 §8.2, "sizing properties"). So `width="50%"` is 50% of the containing block, and author CSS overrides it.
- An outer `<svg>` with a `viewBox` and no `width` has a natural aspect ratio but no natural size. Its auto width fills the containing block, and its height follows the ratio (CSS 2 §10.3.2; CSS Images §5.2, default sizing).
- In Chrome, `width="50%"` in a 200px block is 100px wide, and `viewBox="0 0 10 5"` in a 200px block is 200×100.

### Root cause

It's in the WebAssembly core.

- The svg root's `width`/`height` attributes and viewBox reach layout through the core's records, not the JS scene node; the serialized node carries only `display: "svg"`.
- `src/wasm/layout.js:564` documents the viewBox flag as "0 = no viewBox (use intrinsic px)".
- `DISPLAY_SVG_ROOT` sizes from width/height/viewBox. Percentages are taken as pixels, and a viewBox is taken as a natural size.

### Repro

Two `display:block` svgs, each in a 200px-wide block:

```
FAIL <svg width="50%" height="10"> in a 200px block: got [50,10], want [100,10]
FAIL <svg viewBox="0 0 10 5"> in a 200px block: got [10,5], want [200,100]
```

### Proposal (WebAssembly core)

- Map `width`/`height` on an outer `<svg>` to CSS `width`/`height` presentation hints, keeping the unit, so percentages resolve against the containing block and author CSS still overrides them.
- Give an svg root with a `viewBox` and no `width`/`height` a natural aspect ratio and no natural size, so auto sizing uses the containing block's width and the height follows the ratio.
- The repro above is the acceptance test.
