# Still image

`render.js` builds a small release card as a DOM tree — a heading, a
paragraph, and a table styled by a `<style>` element — renders it once, and
writes `release-card.png`.

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

The program prints `wrote release-card.png (480×300, … bytes)` and exits.
The PNG shows "Release card" with a blue "stable" pill, a grey paragraph, and
three table rows whose right column is set in IBM Plex Mono on a dark blue
gradient.
