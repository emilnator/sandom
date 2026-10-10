# Component sessions: drop the window's event listeners on dispose

Branch: `fix/04-window-listeners-survive-dispose`

## What was wrong

A component session installs its window on the realm's `globalThis`, which outlives the session. Listeners registered on that window were never released, so a disposed session's listeners kept running in the next session in the same realm, against that session's document. Page A's `resize` listener could rewrite page B's DOM.

The cause:

- The window's event target binding is acquired in the shared DOM core with no node handle (`event_target_acquire(target._coreHandle ?? 0n)` in `events.js`). It's keyed by `(globalThis, core)`.
- `prepareEventDisposal` releases only targets whose `event_target_document` is the document being disposed. The window binding belongs to no document, so it and its registrations survived every session.
- `dispose()` restores the global property descriptors, so `addEventListener` goes back to the host's, but the registrations stay in the core.
- Every path that names the window lands in that same binding: `window.addEventListener`, a node's `addEventListener` called on the window, and `MediaQueryList`'s or `SandomViewport`'s `addEventListener` called on it.

## What a browser does

In a browser each page has its own `Window`, and its event listener list goes with it (HTML §7.2, `Window`). Nothing page A registered on its window can run in page B.

## What changed

- `src/dom/events.js`: a new `releaseEventTarget(target, core)` removes every listener on the target's binding, then forgets the binding and calls `event_target_release`.
  - Each listener is removed through the core, as `removeEventListener` removes it, and then released with its signal abort handler. Each registration now records its event type and capture flag for this.
  - Removing through the core matters when a dispatch is suspended in an async listener: Sandom's dispatch waits for a listener's promise before calling the next one. A listener removed through the core is skipped when that dispatch resumes. Releasing only the JavaScript side left the core calling a callback that no longer existed, which threw `Cannot read properties of undefined (reading 'callback')` and ended the process.
  - The binding's finalizer registration now takes the binding as its unregister token, so `releaseEventTarget` can unregister it and the handle isn't released twice.
- `src/dom/render-component.js`: `dispose()` and the setup-failure cleanup call `releaseEventTarget(globalThis, document's core)`. It runs before the global descriptors are restored, whatever `restoreAmbientGlobals` says. The next session acquires a fresh window binding.

## How it was verified

The repo has no test suite for `src/dom` (the maintained Chrome-comparison tests aren't published), so this was checked with a standalone Deno repro.

Session A registers a window listener by each path:

- `window.addEventListener`;
- `Node.prototype.addEventListener.call(window)`;
- `MediaQueryList.prototype.addEventListener.call(window)`;
- remove and re-add;
- with a `{ signal }` that's never aborted.

A hears its events and is disposed with `restoreAmbientGlobals: true`. Session B then dispatches `resize` and `click` on its window and resizes.

```
Before: FAIL window.addEventListener: heard in A true, A's listener ran in B 2 time(s) (want 0)
        FAIL Node.prototype.addEventListener.call(window): … ran in B 2 time(s) (want 0)
        FAIL MediaQueryList.prototype.addEventListener.call(window): … ran in B 2 time(s) (want 0)
        FAIL removed again, then re-added (one registration): … ran in B 1 time(s) (want 0)
        FAIL {signal} that is never aborted: … ran in B 2 time(s) (want 0)
        PASS B's own window listener: ran 2 time(s) (want 2)
After:  all 6 pass
```

- The same repro with a plain `dispose()` (`restoreAmbientGlobals` left at its default) also passes.
- A session whose first window listener awaits a promise is disposed mid-dispatch. When the promise resolves, the dispatch finishes without running the disposed session's second listener, and the next session works.
- Unrelated repros give the same results as before.

## Note for whichever lands second

This PR and "Component sessions: the window's event handler attributes" each add an import and a dispose step at the same place in `render-component.js`. Whichever lands second needs a small rebase there. The two steps can share one `if (globalsInstalled)` block.
