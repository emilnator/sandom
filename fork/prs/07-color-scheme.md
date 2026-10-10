# Component sessions: display.colorScheme, and setDisplay() to change it

Branch: `fix/07-color-scheme`

## What was wrong

- `renderComponent` had no way to mount a page in dark mode. Its `display` option accepted only `colorGamut` and `dynamicRange`, and threw `TypeError: Unknown display option colorScheme`. The style environment's `colorScheme` was always `"light"` (`stylesheet.js`).
- A host could change the scheme only through internals, with `document._styleSystem.setEnvironment({ colorScheme })`. That restyled CSS, but every existing `MediaQueryList` kept its old `matches` and fired no `change`.
  - `MediaQueryList.matches` is a snapshot, refreshed by `_reevaluate()`.
  - `_reevaluate()` runs only on the surface's creation and resize paths, never after `setEnvironment`.
  - Charts and theme hooks that read the scheme in script kept their mount-time colors.

## What the spec and Chrome do

- Media Queries 5 §12.4: `prefers-color-scheme` answers from the user's preference.
- CSSOM View §4.2, "evaluate media queries and report changes": when the environment changes, each `MediaQueryList` whose result changed fires `change` (a `MediaQueryListEvent`), and `matches` reads the new state.
- Chrome does exactly this when DevTools emulates the color scheme: CSS restyles, and existing lists update and fire `change`.

## What changed

`src/dom/render-component.js`:

- `display.colorScheme` (`"light"` or `"dark"`) is accepted and validated like `colorGamut` and `dynamicRange`. It applies to the style environment before the first style resolution, so `matchMedia` during `mount` already answers for it.
- A new session method, `setDisplay({ colorScheme })`, changes it on a live session:
  - it sets the style environment, which restyles CSS;
  - it re-evaluates the document's media query lists, which updates `matches` and fires `change` on each list whose result changed;
  - then it renders and returns the frame, like `resize()`.

  It runs on the session's operation chain and rejects unknown keys.

The re-evaluation was deliberately not added to `setEnvironment` itself. `render-animation.js` swaps the environment temporarily for an inspection, and that must not fire `change` events at the page.

## How it was verified

The repo has no test suite for component sessions (the maintained tests aren't published), so this was checked with a standalone Deno repro. It mounts a session with `display: { colorScheme: "dark" }`, then switches a light session to dark with a `(prefers-color-scheme: dark)` list and a `change` listener attached, plus a CSS rule that changes a width:

```
Before: FAIL renderComponent({display: {colorScheme: 'dark'}}): matchMedia dark at mount: got "TypeError: Unknown display option colorScheme", want true
        PASS light: matches / CSS width
        PASS dark: CSS width: got 30, want 30           (switched through the internal setEnvironment)
        FAIL dark: existing list's matches: got false, want true
        PASS dark: a new list's matches: got true, want true
        FAIL dark: change events on the existing list: got [], want [true]
After:  all 7 pass (mounted with display.colorScheme, switched with component.setDisplay)
```

Unrelated repros give the same results as before.
