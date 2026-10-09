# Badge batch

`render.js` writes one conference badge per attendee — `badge-1.png` to
`badge-4.png` — from a single template on a single render surface.

## Pattern

- The template is built once. The program keeps the three text nodes that
  differ between badges and sets their `data`; the track colour is a class on
  the root. Nothing is replaced or rebuilt between badges.
- One surface renders every badge. It retains layout, glyph resources, and the
  GPU target, so each badge after the first costs what its changed nodes cost.
  A new document or a new surface per badge pays for the whole template again
  (the Performance section of the package README measures both).
- The device scale (2, print density) is chosen once for the surface's life.
- `renderNow({ pixels: true })` per badge: files need pixels, so each frame is
  read back once.
- The program prints `surface.frameStageCounters`: `layoutPasses` and
  `serializations` count frames that laid out or serialized the document
  again.

## Run

Node 22 or later:

```sh
npm install
node render.js
```

Deno 2:

```sh
deno install
deno run -A render.js
```

## Expected result

Four lines, one per badge, with the frame time and the number of dirty
rectangles, then the counters, for example:

```text
badge-1.png  Ada Okafor       …ms, 1 dirty rectangles
badge-2.png  Mateo Ruiz       …ms, 1 dirty rectangles
badge-3.png  Lin Wei          …ms, 1 dirty rectangles
badge-4.png  Sofia Lindqvist  …ms, 1 dirty rectangles
{ serializations: 4, layoutPasses: 1, retainedCleanFrames: 0 }
```

The first badge pays for the template, its layout, and its glyphs; later
badges reuse them. Each PNG is 720 × 440 pixels: a cream badge with a blue
("engine") or red ("design") top band, the event name in IBM Plex Mono, and
the attendee's name, role, and company in Inter.
