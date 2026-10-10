# Component sessions: capture({ height }) paints the page beyond the viewport without the page seeing it

Branch: `fix/08-capture-beyond-viewport`

## What was wrong

A host that wanted a full-page image of a session taller than its viewport could only resize the viewport, with `component.resize({ height })` and back. The page saw all of that, both on the way up and on the way back:

- a `resize` event on the window and on `visualViewport`;
- media query lists re-evaluated, with `change` events;
- `ResizeObserver` and `IntersectionObserver` callbacks on the next frames.

`setVisibleRectangle` doesn't help: it selects part of the viewport-sized scene, so rows beyond the viewport come out unpainted (white in the repro).

## What a browser does

Chrome's full-page screenshot paints the document beyond the viewport without resizing the layout viewport. That's DevTools Protocol `Page.captureScreenshot` with `captureBeyondViewport: true`, which Puppeteer's and Playwright's `fullPage` use. None of these reach the page:

- a `resize` event (CSSOM View §13.1's resize steps don't run);
- a media query change (§4.2);
- an observer callback.

`innerHeight` stays the same.

## What changed

- `src/dom/render-component.js`: a new session method, `capture({ height })`.
  - It renders the document once on a **follower surface** over the same root, with the session's width and device scale and the given height. Surfaces at different environment keys already coexist over one root.
    - The session's surface stays primary, so the window, `innerHeight`, its media query lists and its observers stay with it.
    - The follower gets the session's high-dynamic-range render mode if the session has one.
  - The capture frame runs with observer delivery off and with `_suppressAuthoredCallbacks` set, so no animation frame callbacks run. The follower's own animation events (`animationstart` and the rest) aren't dispatched either: a follower restarts the page's CSS animations, and the page would otherwise hear them start again.
  - The follower is shut down afterwards. Restoring the environment and restarting the loop sit in a `finally` that also covers the follower's construction and shutdown, so a renderer that fails to initialize leaves the session as it was.
  - The capture surface sets the document's shared style environment to its own height. Once the capture is done, `capture()` sets the environment back to the session's viewport. Without that, a layout read made before the session's next frame answered for the capture height: a `100vh` element measured 800 instead of 200 right after an 800px capture.
  - The live loop restarts afterwards, as after other operations.
  - A `height` equal to the viewport's renders the session's own surface the same quiet way: no observers, no animation frame callbacks. Two surfaces at the same size can't coexist over one root.
  - Either way, the result is a still frame (pixels and their layout) without the renderer's texture, which belongs to a renderer that's shut down by the time the frame is returned.
  - The renderer factory the session's surface used inline is now a shared `createPersistentRenderer` constant, so both surfaces use it.
- `src/dom/render-surface.js`: `renderNow` accepts a private `_deliverObservers` option and threads it through `_renderOpportunity` to `_render`'s existing `deliverObservers` parameter. The default is unchanged.

Limitations:

- The style environment is shared per document, so the capture is laid out at the capture height. `vh` and CSS `@media` height queries resolve against it in the captured image: with `@media (min-height: 100px)` and a 40px viewport, a 120px capture shows the rule applied, where Chrome's `captureBeyondViewport` doesn't. Page timers that fire while the capture is in flight can also read layout at the capture height; `innerHeight` and existing media query lists don't change.
- Animations and transitions are per surface, and a follower starts with none, so the capture shows them at rest. A transition shows its end state, and a CSS or Web Animation its start. Chrome paints the state in progress. Pause the session and let motion settle before capturing if that matters.
- Each capture creates and shuts down a renderer. Measure the cost before relying on it for many captures in a row.

**Interaction with `pause()`** (the PR that adds `pause()`/`resume()` and 60 Hz host frames): this method restarts the live loop in its `finally` with `if (!disposeRequested) surface.start()`. Whichever of the two lands second should make that `if (!disposeRequested && !paused) surface.start()`, so that capturing a paused session leaves it paused. As written here, a capture would silently resume a paused session's animation frames.

## How it was verified

The repo has no test suite for component sessions (the maintained tests aren't published), so this was checked with a standalone Deno repro. The page is 500px tall, ending in a 50px red block, in a 200px viewport. It has:

- a `resize` listener;
- a `(max-height: 200px)` media query list;
- a `ResizeObserver` on a `100vh` element;
- an `IntersectionObserver` on the bottom block.

```
Before (resize to 500 and back):
        FAIL callbacks the page saw: got ["media change false","resize 500","resize observer 500","intersection true",
             "media change true","resize 200","resize observer 200","intersection false"], want []
        FAIL the session's next frame: callbacks the page saw: (the same 8)
        NOTE setVisibleRectangle(0, 0, 100, 500): bottom row [255,255,255]: beyond the viewport is unpainted
After (component.capture({ height: 500 })):
        PASS frame height 500; bottom row [255,0,0]; callbacks []; innerHeight 200;
             the session's next frame is 200 tall, with callbacks []
```

- A second check reads a `100vh` element's `offsetHeight` right after `capture({ height: 800 })`, before the session's next frame. It gets 200, where it would get 800 without the environment restore.
- A renderer whose initialization or raster fails leaves the environment at the viewport height and the live loop running.
- A capture at the viewport's height delivers no `ResizeObserver` callback for a box changed just before it.
- A page with a CSS animation hears no `animationstart` from the capture.
- Unrelated repros give the same results as before.
