# React session

`render.js` mounts a React 19 application — `app.js`, a reminder settings
panel with a counter, a checkbox, and a schedule derived from the counter —
in one Sandom component session. It drives the panel with input records and
writes `before.png` and `after.png`.

## Pattern

- One session for the application's life. `renderComponent` mounts the React
  root once; the first frame, the input, and the frame after it all come from
  that session. A frame on a kept session costs what a frame on a kept render
  surface costs; mounting, rendering, and disposing a session per change
  costs three to seven times as much (the Performance section of the package
  README measures both).
- React DOM runs against the `document` and `window` the session installs.
  The session installs them before it calls `mount`, and `mount` imports
  `react-dom/client` there: React DOM reads them when it loads and on every
  update. `app.js` imports only `react`, which reads neither.
- Input arrives as session records, one batch for one frame: an
  accessibility `press` on the "More reminders" button, then a mouse
  `pointer-down` and `pointer-up` at the checkbox's bounds. Both targets come
  from the accessibility snapshot of the frame before, and the press names
  that frame's `accessibilityRevision`.
- The frame waits for React's commit, not for time. React DOM handles a click
  at discrete priority and commits it in a microtask, before the session
  renders. The first `root.render()` and the schedule, which follows the
  counter through `useDeferredValue`, render in tasks of React's Scheduler
  instead; a transition render yields every 5 ms, so its commit can land
  after `dispatch` has rendered its frame. `SettingsPanel` reports every
  commit from a layout effect, and `render.js` hands the session the commit
  it needs as `ready`: in `mount`'s result for the first frame, and as
  `dispatch`'s second argument for the input's frame. The counter click
  commits twice, the count first and the schedule after it, so the awaited
  commit is named by its state: three reminders, the summary on, three times
  in the schedule.
- The device scale is 2 for the session's whole life.
- `dispatch` returns the frame as a GPU texture. `render({ pixels: true })`
  reads a frame back only for each file.
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

Both write `before.png` and `after.png` to the working directory. React loads
its development build, with its checks and warnings, unless `NODE_ENV` is
`production`.

## Expected result

```text
before.png  reminders "2 09:00 17:00", weekly summary off  (…ms)
after.png   reminders "3 09:00 13:00 17:00", weekly summary on  (…ms)
```

Each line reads a frame's accessibility snapshot: the description of the
"More reminders" button, which is the count and the schedule, and the
checkbox's checked state. The first time covers the session's setup, the
mount, and the first frame; the second covers the input, React's two
commits, and one frame on the kept session.

Each PNG is 720 × 400 pixels. `before.png` shows "Reminders" over a counter
at 2 between "−" and "+" buttons, an unchecked "Weekly summary email" box,
and two blue chips, 09:00 and 17:00. `after.png` shows the counter at 3, the
box checked, and three chips: 09:00, 13:00, and 17:00.

## Licences

The panel's text and styles are part of this example. React and React DOM
are under the MIT licence. Inter, the one font it uses, ships in the sandom
package under `test-assets/` and is licensed under the SIL Open Font License
1.1.
