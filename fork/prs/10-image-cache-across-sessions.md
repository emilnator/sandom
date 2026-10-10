# Resources: key decoded images by URL and content

Branch: `fix/10-image-cache-across-sessions`

## What was wrong

The scene renderer's runtime is process-wide, and so is its decoded-image cache: `decodedImageByCacheKey` and the registered `imageIndexBySrc` live for the runtime's life. Both were keyed by `resource.cacheKey`, which `createPreparedDocument` set to the resource's final URL alone, even though it computes the bytes' SHA-256 on the next line.

So when two documents' resolvers answered the same URL with different bytes, the later document painted the earlier document's image. A host that renders one component session after another sees that as one page showing another page's logo or avatar. The only way around it was to make every URL unique per session.

## What the spec says

HTML §4.8.4.3, "update the image data": a page's own fetch decides its image's bytes, and the list of available images is per `Document`. Two documents whose fetches return different bytes for one URL each paint their own.

## What changed

- `src/dom/prepared-document.js`: a resource's `cacheKey` is now `` `${finalURL} ${digest}` `` (the SHA-256 the prepared document already computes for each resource). The digest is computed once and used for both `cacheKey` and `digest`. The same URL with the same bytes still shares one decode and one image slot; other bytes get their own.
- `src/scene-renderer.js`: the comment on `decodedImageByCacheKey` now says what the key is.

`cacheKey` isn't part of `session.resources`, so nothing public changes shape. The one visible difference is that a broken image's error message, `Image ${cacheKey}: …`, now names the digest after the URL.

Images a surface resolves without a prepared document, through `createRenderSurface` with a bare resolver, still fall back to the final URL as their key, as before.

## How it was verified

The repo has no test suite for the scene renderer or prepared documents (the maintained tests aren't published), so this was checked with a standalone Deno repro. Three sessions in turn show `https://images.test/logo.png`, and their resolvers answer with a red, a blue and a red PNG:

```
Before: PASS session A, resolver answers red: got [255,0,0], want [255,0,0]
        FAIL session B, same URL, resolver answers blue: got [255,0,0], want [0,0,255]
        PASS session C, same URL, red again: got [255,0,0], want [255,0,0]
After:  all 3 pass
```

Unrelated repros give the same results as before. That includes the repro for the image table's 256-slot limit, which still fails at the 257th distinct image; that's a separate issue.
