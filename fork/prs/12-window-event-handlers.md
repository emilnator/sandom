# Component sessions: the window's event handler attributes

Branch: `fix/12-window-event-handlers`

## What was wrong

- A component session's window had no event handler attributes. `window.onresize = f`, `window.onclick = f` and `window.onhashchange = f` set plain properties that never ran, so pages written that way never heard the event.
- `HTMLElement.prototype`'s `on*` setters, called with the window as `this`, registered a listener that threw when its event came, because the handler machinery (`src/dom/node.js`) read `this._domCore`, which only nodes have. The throw was an uncaught `TypeError: Cannot read properties of undefined (reading 'status')`, and under Deno that ends the process.

## What the spec says

HTML §8.1.8.2: `Window` has the GlobalEventHandlers (`onclick`, `onkeydown`, `onresize`, …) and the WindowEventHandlers (`onhashchange`, `onpopstate`, `onmessage`, …). Setting one registers the handler for that event on the window. Assigning `null` removes it.

## What changed

- `src/dom/node.js`
  - The event handler listener resolves its DOM core as `this._domCore ?? this.document?._domCore ?? sharedDomCore`, the same lookup `events.js` uses for a target's core. A handler on the window answers through the window's document.
  - `installWindowEventHandlers(target)` defines accessors on the session's global for every `on*` attribute on `HTMLElement.prototype`, for the whole WindowEventHandlers list, and for `onresize`, a GlobalEventHandler the element bindings don't define yet. Handler names the realm already defines, on the global or on its prototype chain, are left alone. Under Deno that's `onload`, `onerror`, `onunhandledrejection`, `onbeforeunload` and `onunload`; in a worker it also covers `onmessage`.
  - `releaseEventHandlers(target)` removes the handlers set through those attributes and forgets them.
- `src/dom/component-globals.js`: `installComponentGlobals` installs the window's handler attributes.
- `src/dom/render-component.js`: `dispose()` and the setup-failure cleanup call `releaseEventHandlers(globalThis)`, so a later session's handlers register afresh and an earlier session's don't run.

Not in this PR: under Deno, `window.onerror` and `window.onunhandledrejection` stay Deno's own. Deno's `onerror` gets the event as its only argument rather than the five arguments of the HTML `OnErrorEventHandler`, and returning `true` from it doesn't cancel the error. That's plain Deno behaviour, unchanged here. A page's `onunhandledrejection` that calls `preventDefault()` does keep the process alive, and neither handler outlives `dispose()`.

One change from the first draft: it skipped only names the global owns directly (`Object.hasOwn`). Browser worker scopes define `onmessage`, `onerror` and the rest on their prototype, so a session there would have shadowed the worker's own `onmessage`. The check is now `name in target`.

## How it was verified

The repo has no test suite for component sessions (the maintained tests aren't published), so this was checked with a standalone Deno repro.

```
Before: FAIL handlers ran, once each: got [], want ["onclick","onhashchange","onresize"]
        PASS window.onresize reads back the function
        FAIL a second session's handler runs, the first's don't: got [[],0], want [["onclick"],3]
        checking HTMLElement.prototype's onkeydown setter called on the window…
        error: Uncaught TypeError: Cannot read properties of undefined (reading 'status')
            at listener (src/dom/node.js:158:16)      ← the process ends here
After:  PASS handlers ran, once each: got ["onclick","onhashchange","onresize"]
        PASS window.onresize reads back the function
        PASS a second session's handler runs, the first's don't: got [["onclick"],3]
        PASS an element's setter called on the window: the handler runs: got ["onkeydown"]
```

What the repro does:

- It sets `onresize`, `onclick` and `onhashchange` on the window during `mount`.
- It dispatches `click` and `hashchange`, and resizes the session.
- It clears `onresize` and resizes again.
- It disposes and checks that a second session's `onclick` runs and the first's don't.
- Last, it calls `HTMLElement.prototype`'s `onkeydown` setter on the window and dispatches `keydown`.

Unrelated repros give the same results as before.

## Note for whichever lands second

This PR and "Component sessions: drop the window's event listeners on dispose" each add an import and a dispose step at the same place in `render-component.js`. Whichever lands second needs a small rebase there. Both orders work, and the two steps can share one `if (globalsInstalled)` block. Both are still needed together: releasing the window's event target drops the listeners, but not the handler records, and a stale record would swallow the next session's handler of the same type.
