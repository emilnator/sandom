# Component sessions: the host hears uncaught errors and rejections the page doesn't handle

Branch: `fix/05-host-error-events`

## What was wrong

A component session replaces the realm global's `dispatchEvent` with Sandom's (`installComponentGlobals`). Deno reports uncaught exceptions, unhandled promise rejections and `reportError` by calling `globalThis.dispatchEvent`, so those events now reached only the page's listeners in Sandom's store. The host's own `error` and `unhandledrejection` listeners, in Deno's store, never ran.

Deno documents that a host keeps its process alive by cancelling these events in such listeners. Since the host never heard them, Deno saw them uncancelled and ended the process. That covered any page that:

- threw from a timer;
- left a rejection unhandled;
- reported a render error through `reportError`, as React 19 does.

A long-lived host lost every session in the process, and its reply with them.

## What the spec and a browser do

HTML §8.1.4.6 ("report an exception") and §8.1.5.7 (unhandled promise rejections): the window's `error` / `unhandledrejection` listeners hear the event. If none cancels it, the user agent logs it, and the page keeps running.

Under Deno, the window is the realm's global, and the host's listener plays the user agent's part: it's what decides whether the process survives. So the page's listeners should hear the event first, and the host's after them unless the page cancelled it.

## What changed

`src/dom/component-globals.js`: the window's `dispatchEvent` keeps the host's original.

- It dispatches to the page through Sandom first, as before.
- If the event is an `ErrorEvent` `"error"` or a `PromiseRejectionEvent` `"unhandledrejection"` and no page listener cancelled it, a copy goes to the host's `dispatchEvent`. The copy has the same message, filename, line, column and error, or the same promise and reason.
- If a host listener cancels the copy, the original is cancelled too, so Deno sees it handled.
- For these two events, `dispatchEvent` returns a boolean, as in a browser, and whether the page cancelled is read when the dispatch returns. Sandom's dispatch otherwise returns a promise when a page listener is async; Deno took that promise for "not cancelled" and ended the process even when the page had cancelled. An async listener now cancels as it does in a browser, by calling `preventDefault()` before its first `await`.
- A session started after a `dispose({ restoreAmbientGlobals: false })` finds the previous session's `dispatchEvent` on the global. It unwraps it to the realm's own instead of wrapping it, so page listeners don't hear each error twice.

It has to be a copy: Deno's dispatch silently delivers nothing for an event that has already been dispatched once. Dispatching the original was tried first.

Notes:

- These events aren't trusted (`isTrusted` is false even for Deno's own), so a synthetic `ErrorEvent` the page dispatches on its window also reaches the host's listeners. That's harmless. A host that cares can tell by the stack.
- Where the global has no `dispatchEvent` (Node), nothing changes. Where there's no `PromiseRejectionEvent` (Bun), only `error` events are forwarded.

## How it was verified

The repo has no test suite for component sessions (the maintained tests aren't published), so this was checked with a standalone Deno repro. Because the failure is the process exiting, it runs each case in a child Deno.

Before the session, the host installs `error` and `unhandledrejection` listeners that log and call `preventDefault()`. The page adds its own listeners and then:

- rejects a promise;
- throws from a timer;
- calls `reportError`;
- or rejects a promise its own listener cancels.

```
Before: FAIL rejection:   exit code 1; page heard rejection   (error: Uncaught (in promise) Error: rejection)
        FAIL timer:       exit code 1; page heard timer       (error: Uncaught Error: timer)
        FAIL reportError: exit code 1; page heard reportError (error: Uncaught Error: reportError)
        PASS cancelled:   exit code 0; page heard cancelled | survived cancelled
After:  PASS rejection / timer / reportError: exit code 0; page heard … | host heard … | survived …
        PASS cancelled: the page cancels it; the host doesn't hear it
```

Further checks:

- an async page listener that calls `preventDefault()` before its first `await` keeps a timer's throw from reaching the host, and the process survives;
- after a dispose that keeps the globals, a second session's page listener hears an error once, then the host.

Unrelated repros give the same results as before.
