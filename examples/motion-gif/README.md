# Motion GIF

`render.js` builds a deploy-status card whose spinner, progress sweep, and
three pulsing dots are CSS keyframe animations, captures one loop of them on
the surface's own animation clock, and writes `deploy-status.gif`.

## Pattern

- The motion lives in the document's stylesheet. The program never changes
  a node after the markup is set: the surface samples the animations itself.
- `surface.stop()` turns off the host frame loop. `captureFrames()` requires
  a stopped surface because it sets each sample's time, so the frames come
  from the engine's clock, not from timers or sleeps.
- The first `renderNow({ pixels: true })` starts the animations and seeds a
  CPU snapshot of the frame. Each captured frame after it reads back only the
  tiles its damage covers.
- `recommendMotionCapture` reads `surface.inspectMotion()` and proves the
  animations' shared period: the spinner and dots run for 1 s, the sweep for
  2 s, so one 2000 ms capture loops without a seam. It also sizes the frame
  budget for 25 frames per second, which is a whole number of GIF
  centiseconds per frame.
- `createGifRecorder` takes each frame's pixels and damage and writes only
  the changed region of each GIF frame. In sandom 0.5.0 the recorder compares
  only the first candidate rectangle, so `render.js` passes one rectangle
  that bounds the frame's damage.
- The recorder quantizes to a fixed 6×7×6 palette without dithering, so the
  card uses flat colours on that palette; a gradient background would band.
- The `@keyframes` rules name both endpoints (`from` and `to`). In sandom
  0.5.0 a rule with only a `to` keyframe does not animate.
- The device scale is 2 for the surface's whole life, so the 320×180 card is
  a 640×360 GIF.
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

Both write `deploy-status.gif` to the working directory.

## Expected result

The program prints
`wrote deploy-status.gif (640×360, 50 samples over 2000 ms, … bytes)` and
exits. The GIF loops forever over 2 seconds: on a white card under the bold
heading "Deploying" and the line "Building assets for production", a blue arc
turns around a pale ring, a blue bar sweeps left to right through a pale
track, and three blue dots grow and shrink one after another. The file is
about 86 KB.

## Licences

The card's text and styles are part of this example. Inter, the one font it
uses, ships in the sandom package under `test-assets/` and is licensed under
the SIL Open Font License 1.1.
