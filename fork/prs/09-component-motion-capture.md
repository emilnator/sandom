# Component sessions: inspectMotion() and captureFrames()

Branch: `fix/09-component-motion-capture`

## What was wrong

Render surfaces can describe their motion and capture it frame by frame on its own clock, with `surface.inspectMotion()` and `surface.captureFrames()`. The motion-gif example uses both. A component session keeps its surface private, though, and the session object offered neither method. A host recording an interaction in a React page could render one still frame per call, at whatever time the live loop had reached, and had no way to ask what was moving or to capture a transition's frames.

## What changed

`src/dom/render-component.js` adds two session methods.

`inspectMotion()` renders the current state, then returns the surface's motion inspection: classification, finite duration, and so on.

`captureFrames({ frameBudget, durationMilliseconds })` returns an async iterator over the surface's `captureFrames()`:

- On the first `next()`, it queues an operation on the session's operation chain. That operation renders the current state, then stops the live loop and waits until the surface is idle, as `captureFrames()` requires.
- The operation holds the chain for as long as the iteration lasts, so no other session operation interleaves with the capture. Another operation called meanwhile rejects with "A frame capture is active; end its iteration first" instead of waiting behind it, where calling `render()` inside the loop would wait forever.
- When the iteration ends, by finishing, `break`, `return()` or an error, the live loop restarts and the chain moves on.
- `dispose()` ends an iteration that's still open, so it can be called from inside the loop or after an iterator was dropped mid-way. The iterator then stops at its next `next()`.
- Frames keep the surface's contract: their pixels are borrowed until the next frame. Each captured frame is also delivered to `subscribe()` listeners, and after the capture the document's time stands at the motion's end: a 400 ms transition has ended.

How this compares with a browser: there's no browser counterpart. A page can step its own animations through Web Animations (`currentTime`, `pause()`), and a test driver can capture frames on a virtual clock (Chrome DevTools' `HeadlessExperimental.beginFrame`). These methods give a host that second thing for a session.

**One change from the first draft:** the operation is queued inside the generator, not when `captureFrames()` is called. In the draft, an iterator that was created but never read held the operation chain forever, and so did one abandoned with `return()` before its first `next()`. Every later operation hung, `dispose()` included, since it awaits the chain.

**Interaction with `pause()`** (the PR that adds `pause()`/`resume()` and 60 Hz host frames): the capture's `finally` restarts the live loop with `if (!disposeRequested) surface.start()`. Whichever of the two lands second should make that `if (!disposeRequested && !paused) surface.start()`, so that capturing frames of a paused session leaves it paused. As written here, a capture would silently resume a paused session's animation frames. `inspectMotion()` goes through `renderCurrentSurface()`, which the `pause()` PR already makes respect the pause.

## How it was verified

The repo has no test suite for component sessions (the maintained tests aren't published), so this was checked with a standalone Deno repro. After a render, the page sets a class that starts a 400 ms `width` transition (10px → 110px, linear). The repro then asks for `inspectMotion()` and for 8 frames, and counts the red pixels in each frame's middle row:

```
Before: FAIL component.inspectMotion is a function: undefined
        FAIL component.captureFrames is a function: undefined
After:  PASS inspectMotion after the change: a finite motion of 400 ms: finite, 400 ms
        PASS captured several frames: 7 frames
        PASS the box widens across them, from 10 towards 110 px: [14,26,38,50,62,86,98]
        PASS the session renders again afterwards: 120×40
```

Further checks:

- an iterator abandoned before its first `next()` leaves the session working, and `render()` and `dispose()` complete (with the draft, both hung);
- `dispose()` called while a frame is yielded, from inside the loop or after the iterator was dropped, completes and aborts the mount signal; `render()` called then rejects with the message above;
- breaking out of the loop after 2 frames leaves the session rendering;
- a request without `frameBudget` rejects with `frameBudget must be a positive integer`, and the session renders afterwards.

Unrelated repros give the same results as before.
