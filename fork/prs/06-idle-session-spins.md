# Component sessions: pause() and resume(), and 60 Hz host frames without requestAnimationFrame

Branch: `fix/06-idle-session-spins`

## What was wrong

A component session kept between operations spun the CPU and GPU whenever its page animated. Two things combined:

- **No frame pacing.** In a host without `requestAnimationFrame` (Deno, Node, Bun), a live surface's frame request fell back to `setTimeout(…, 0)` (`render-surface.js`). A page with a `requestAnimationFrame` loop or a running transition rendered on every turn of the event loop: 435 to 458 frames a second in the repro.
- **No way to stop the loop.** Every session operation restarts the surface's live loop when it finishes (`renderCurrentSurface`'s `finally`), and the session had no method to keep it stopped. A host that kept a session waiting for its next request had no way to idle it.

## What a browser does

- HTML §8.10.1, "update the rendering": animation frame callbacks run once per rendering opportunity, at the display's refresh rate (60 Hz here).
- A hidden document gets no rendering opportunities, and Chrome throttles background tabs.
- A host that keeps a page between requests needs the equivalent of hiding it.

## What changed

- `src/dom/render-surface.js`: without a host `requestAnimationFrame`, the fallback frame request now waits for the next boundary of a 60 Hz vsync grid.
  - It schedules the next boundary after now, but never one a frame has already taken, so a timer that fires slightly early doesn't produce two frames in one interval.
  - A first version that only took the next boundary after `now` made 87 frames a second. A second version, which rounded to the nearest boundary and took the one after it, skipped a boundary whenever a frame's work took more than half an interval: 10 ms of work per frame gave 30 frames a second. This version gives 60 with 0 ms and with 10 ms of work.
- `src/dom/render-component.js`: sessions gain two methods.
  - `pause()` stops the live loop and waits until the surface is idle, so no animation frames run and no transitions advance. `render()`, `inspect()`, `dispatch()`, `resize()` and `displayList()` still paint a frame on request, and that frame delivers observers as usual, but they no longer restart the loop afterwards.
  - `resume()` restarts the loop.
  - Both go through the session's operation chain, like every other operation.

Timers the page set (`setTimeout`, `setInterval`, `MessageChannel`) belong to the host realm and keep running while the session is paused. That's documented in the method's comment. Making them session-owned (held while paused, cleared on dispose) would be a separate, API-level change.

60 Hz pacing alone cuts an animating page's idle frames from about 450 to 60 a second, but it doesn't stop them; `pause()` does.

## How it was verified

The repo has no test suite for component sessions or render surfaces (the maintained tests aren't published), so this was checked with a standalone Deno repro. It renders a page with a `requestAnimationFrame` loop once, then counts animation frames:

```
Before: FAIL live session: at most a 60 Hz display's frames in 1 s: 435 frames
        FAIL component.pause()/resume() exist: typeof component.pause: undefined
After:  PASS live session: at most a 60 Hz display's frames in 1 s: 59–60 frames
        PASS paused session: no animation frames: 0 frames in 0.5 s
        PASS resumed session: frames again: 12 frames in 0.2 s
        PASS render while paused: no frames after it: 0 frames in 0.3 s
```

- The repro was run twice with the same results.
- Unrelated repros, including the ones that capture and inspect frames, give the same results as before.
