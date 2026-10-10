# Resources: release a disposed document's images from the renderer's image table

Branch: `fix/11-image-table-release`

## What was wrong

The scene renderer's runtime is process-wide, and so is its 256-entry image table (`IMAGE_TABLE_MAX_ENTRIES`).

- Every distinct image took a slot from `nextImageIndex`, which only grew.
- `imageIndexBySrc`, `imagePixelsByIndex` and `imageJoinByKey` kept every registration, and its decoded pixels, for the runtime's life.

A host that renders one component session after another therefore failed its 257th distinct image, however many sessions it had disposed:

```
IMAGE_TABLE overflow: more than 256 images in one renderer
```

The only way out was to restart the process. The decoded pixels of every image ever shown also stayed in memory.

## What a browser does

A closed page's decoded images are released with it, so a browser can show pages one after another indefinitely.

## What changed

- `src/dom/prepared-document.js`: each prepared document makes an `owner` token and puts it on every resource it resolves. `owner.onRelease(listener)` registers a listener, and `release()` calls the listeners after the document's other resources go. `owner.released` says whether that has happened.
- `src/dom/canvas.js`: a canvas context's paint source gets an owner of the same shape, released when the context shuts down, which a document does as it's disposed.
- `src/scene-renderer.js`: image registrations are counted per owner.
  - When an image resource is resolved, its owner is recorded against the image's `cacheKey`. This happens at load time, not at registration, so a document whose load is still in flight keeps the slot alive while another document releases it. The engine joins a document makes for its nodes are recorded too.
  - When an owner is released, its joins and the core resource handles behind them are dropped. For each image whose last owner that was:
    - the `imageIndexBySrc` and `imagePixelsByIndex` entries go;
    - the engine's raster record goes, with `raster_resource_table_release(RASTER_RESOURCE_IMAGE, index)`, which color glyph bitmaps already use;
    - the index goes on a free list.
  - A canvas source's slot and its retained resource handle are released the same way when its context shuts down.
  - `allocateImageIndex()` takes a free index before growing `nextImageIndex`, for decoded images and canvas sources alike. The overflow error now means 256 images and canvases in use at once, not 256 ever.
  - Images resolved without a prepared document, through a bare resolver or a file path, carry no owner and keep their slot for the runtime's life, as before. If such a resolver and a document resolve the same image, the image is kept for good, so releasing the document can't free a slot the other scene still draws.
  - A document released while one of its loads is still in flight owns nothing more. If no live document owns that image when its decode finishes, it isn't registered: the late load reports a broken image ("its document was released") instead of taking a slot nobody will free.

Reusing an index is safe on the GPU side: the rasterizer keys its image textures by the registered entry object, not by index, and destroys the ones a frame no longer draws.

## How it was verified

The repo has no test suite for the scene renderer (the maintained tests aren't published), so this was checked with standalone Deno repros.

300 sessions in turn, each showing one distinct 4×4 PNG and each disposed before the next:

```
Before: FAIL 300 sessions, one image each, one at a time: 256 rendered; session 256: IMAGE_TABLE overflow: more than 256 images in one renderer
After:  PASS 300 sessions, one image each, one at a time: 300 rendered
```

A second check makes sure a reused slot paints the new image, not the old one. It runs 300 sessions in turn, each with two images of its own, 600 distinct images in all. One of the two is used twice, so a document holds more than one join for it. The colours alternate between sessions, and every session's pixels are read back. The result: wrong pixels in 0 sessions.

Further checks:

- 260 sessions in turn, each with a 4×4 `<canvas>`, all render, and no slots are left after disposal (before: overflow at the 257th);
- a scene resolving through a bare resolver keeps painting its red image after a document that shared it is released and another image takes a new slot;
- documents released while their image loads were in flight leave no slots behind;
- with the "key decoded images by URL and content" PR, two documents alive at once that answer one URL with red and blue paint their own, and releasing both leaves no slots.

Unrelated repros give the same results as before. One more passes: the repro for decoded images cached by URL across sessions (red, blue, red from the same URL). Each disposed session's image is now released, so the next session decodes its own bytes. That only covers sessions that run one after another. Documents alive at the same time still need the cache key to include the content, which is the "key decoded images by URL and content" PR. The two PRs are independent and work together.
