// Tree-to-scene serializer: a live SDElement tree (src/dom/node.js) walked
// into a flat scene node array, the shape examples/scenes.js's hand-authored
// scenes use, so the renderScenePixels/renderScene/sandomTreeBoxes pipeline
// consumes a DOM-backed tree unchanged.
//
// The DOM core builds the box tree (scene_build): box kinds, display
// codes, formatting flags, generated and form text, markers, anonymous
// table boxes, order, font faces, and text-run style. Every box's engine
// record is published from its typed native SceneBuildBox; a scene node here
// carries only what the host adds: the box reference, its display name,
// text, host resources (image sources, canvas paint sources), and scroll
// requests. An svg path box also carries its path definition, which the
// renderer resolves through its path atlas; an element that declares
// transitions keeps its resolved transition definitions and its resolved
// CSS transform for the renderer's transition diff.

import { animationTransitionDefinitions } from "../dom-wasm/animation.js";
import { resolvedElementFields } from "./style.js";

// The scene display name of an svg shape box (scene display 22) by its
// tag: sandom's synthetic display:'svg-*' values (examples/render-scene.js,
// design/svg-rendering.md). The core rejects any other SVG tag.
const SVG_SHAPE_DISPLAY = {
  rect: "svg-rect",
  circle: "svg-circle",
  ellipse: "svg-ellipse",
  line: "svg-line",
  g: "svg-group",
  path: "svg-path",
  polygon: "svg-polygon",
  polyline: "svg-polyline",
};

// css-display §2.7: outer-display blockification applied to flex and
// grid items (and through display:contents).
// Scene display names by the core's scene display code
// (src/dom-wasm/scene-build.watpart). A list item's marker is its own box,
// so the item itself is a block; 20 is a replaced raster image.
const DISPLAY_CODE_NAMES = [
  "none",
  "block",
  "inline",
  "inline-block",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "contents",
  "block",
  "table",
  "table-row-group",
  "table-header-group",
  "table-footer-group",
  "table-row",
  "table-cell",
  "inline-table",
  "table-caption",
  "table-column",
  "table-column-group",
  "image",
  "svg",
  "svg-shape",
  "text",
];
const WHITE_SPACE_NAMES = [
  "normal",
  "nowrap",
  "pre",
  "pre-wrap",
  "pre-line",
  "break-spaces",
];

// Box flags of the core's scene records.
const BOX_INLINE_CONTEXT = 1;
const BOX_BFC = 2;
const BOX_TRANSITIONS = 64;

// `transform: none` in the resolved-fields shape, for an element that
// declares transitions and no transform at all: the renderer's transition
// diff needs a transform form on every serialization of such a box, and
// an absent declaration is `none`.
const TRANSFORM_NONE = Object.freeze({
  kind: "cssTransform",
  components: Object.freeze([
    Object.freeze({ kind: "matrix", value: Object.freeze([1, 0, 0, 1, 0, 0]) }),
  ]),
  cssText: "none",
});

// The core builds the box tree (src/dom-wasm/scene-build.watpart): which
// flat-tree children participate, anonymous inline runs, generated content,
// br's forced break, form values and placeholders, list markers, anonymous
// table boxes, and order-modified document order, in the flat breadth-first
// order the engine consumes. This walk fills each box's fields from the
// element's resolved style and the host state the core does not hold (image
// sources, canvas paint sources, scroll requests, SVG attributes).
// The native build row (stable id, source revision) a scene node was
// serialized from, for test access to its unrelocated record: the build's
// rows hang off the publication reference every node of the build shares.
const jsonAbsent = () => undefined;

export function sceneNodeProvenance(node) {
  return node?._corePublication?.boxes?.[node._corePublicationIndex] ?? null;
}

export function serializeToScene(
  root,
  {
    viewportWidth = 1280,
    viewportHeight = 720,
    generatedContent = null,
    viewport: renderViewport = null,
  } = {},
) {
  const core = root._domCore;
  const styleSystem = root.ownerDocument?._styleSystem;
  core.lengthViewport(viewportWidth, viewportHeight);
  if (styleSystem) core.mediaEnvironmentSet(styleSystem.environment);
  if (generatedContent) {
    for (const { element, pseudoElement, text } of generatedContent) {
      core.sceneGeneratedOverride(
        element._coreHandle,
        pseudoElement === "::before" ? 1 : 2,
        text,
      );
    }
  }
  const publicationRef = { core, handle: 0, boxes: null, toJSON: jsonAbsent };
  let { boxes, expansions, rootContext } = core.sceneBuild(
    root._coreHandle,
    renderViewport !== null,
    publicationRef,
  );
  // Resolving one family may expose another inherited/descendant value on
  // the next build. Drain the native request queue before publishing boxes.
  while (styleSystem && core.fontFamilyRequests().length) {
    styleSystem.answerFontFamilyRequests();
    ({ boxes, expansions, rootContext } = core.sceneBuild(
      root._coreHandle,
      renderViewport !== null,
      publicationRef,
    ));
  }
  const rootWriting = rootContext;
  const canvasBackground = core.sceneCanvasBackground();
  const textBytesOf = (box) =>
    box.textLength === 0
      ? undefined
      : core.engineRecordPublicationText(publication).slice(
        box.textOffset, box.textOffset + box.textLength,
      );
  // Every box is lowered natively now, under this serialization's media
  // environment, into one core-retained publication. Frames relocate its
  // rows (engine_record_frame); the serialization owns the handle and
  // releases it when replaced or collected. Nodes reference it through one
  // shared object that never enters the renderer's JSON node signature.
  const publication = core.engineRecordPublish(
    root._coreHandle,
    renderViewport?.width ?? 0,
    renderViewport?.height ?? 0,
  );
  // Every scene node of this build holds this reference, and the
  // publication it names must outlive them: a caller keeps `nodes` and
  // drops the wrapper this function returns (`const { nodes } =
  // serializeToScene(root)` is the shape every direct renderer call
  // uses), so the collection backstop below hangs off the reference, not
  // off the wrapper. It hung off the wrapper, and a render whose scene
  // outlived its serialization object failed mid-frame with "Invalid
  // resource state" when the collector got there first.
  publicationRef.handle = publication;
  publicationRef.boxes = boxes;
  Object.freeze(publicationRef);
  publications.register(publicationRef, { core, publication }, publicationRef);
  // The rows this publication lowered anew; every other row took the
  // previous publication's bytes for its identity, so nothing the engine
  // reads of that node changed. The rows changed at their index (lowered
  // anew, or reused from another index after an earlier sibling was
  // inserted or removed) are the renderer's change set: its per-index
  // state belongs to whatever sat at the index last frame.
  const loweredRows = core.engineRecordLowered(publication);
  const changedRows = core.engineRecordChanged(publication);
  const reusedRows = core.engineRecordReused(publication);
  const nodes = new Array(boxes.length);
  const indexOf = new Map();
  let textBoxes = 0;
  // The CSS font-family value behind each family entry a box's face names,
  // captured now: the renderer keys and registers faces by it.
  const familyCss = new Map();
  const faceCssOf = (packed) => {
    const family = packed >>> 12;
    if (family === 0) return "";
    let css = familyCss.get(family);
    if (css === undefined) {
      css = core.fontFamilyCss(family);
      familyCss.set(family, css);
    }
    return css;
  };
  const imageSources = new Map();
  for (const handle of expansions) indexOf.set(core.wrapperFor(handle), null);
  // Requested scroll offsets live in the surface's scroll states. Read them
  // once from the owner rather than searching it per element: an element
  // without a state (nearly all of them) requests nothing.
  const scrollOwner = root._renderSurface?._scrollOwner ?? 0n;
  const scrollRequests = new Map();
  for (let index = 0; scrollOwner; index += 1) {
    const state = core.status("scroll_owner_state", scrollOwner, index);
    if (!state) break;
    const node = core.status("scroll_state_node", state);
    if (!node) continue;
    const left = core.status("scroll_value", state, 0);
    const top = core.status("scroll_value", state, 1);
    if (left !== 0 || top !== 0) scrollRequests.set(Number(node), [left, top]);
  }

  const childrenOf = (box) =>
    box.children.length ? { children: box.children } : {};
  // The core writes a box's engine record from its kind, flags, and scene
  // display code (writeNode) and from the element the record derives
  // from: the box's own element, or the context element a text box
  // inherits from.
  const coreBox = (box) => ({
    _coreBox: box.kind | (box.flags << 8) | (box.display << 24),
    _corePublication: publicationRef,
    _coreFont: box.font,
    _coreFontCss: faceCssOf(box.font),
  });
  const textBox = (box) => {
    textBoxes += 1;
    const node = { display: "text" };
    // A text root without a parent element has no core record.
    if (box.context !== 0n) {
      node.whiteSpace = WHITE_SPACE_NAMES[box.whiteSpace];
      node.letterSpacing = box.letterSpacing;
      if (box.owner !== undefined) node.generatedOwnerIndex = box.owner;
      node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
      node._corePublication = publicationRef;
      node._coreFont = box.font;
      node._coreFontCss = faceCssOf(box.font);
      node._coreBoxHandle = Number(box.context);
    }
    Object.defineProperty(node, "text", {
      enumerable: true,
      get: () => box.text ?? "",
    });
    return node;
  };

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    switch (box.kind) {
      case 1: {
        const element = core.wrapperFor(box.handle);
        indexOf.set(element, index);
        nodes[index] = elementScene(element, box);
        break;
      }
      case 2: {
        const node = core.wrapperFor(box.handle);
        indexOf.set(node, index);
        nodes[index] = textBox(box);
        break;
      }
      case 3:
      case 10: {
        // An anonymous inline run, or the wrapper an outside marker's
        // inline content moves into: a block holding an inline
        // formatting context. Field by field like the text and element
        // paths: a justified article's runs are a large share of its boxes.
        const node = { display: "block", inlineCtx: true };
        if (box.children.length) node.children = box.children;
        node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
        node._corePublication = publicationRef;
        node._coreFont = box.font;
        node._coreFontCss = faceCssOf(box.font);
        node._coreBoxHandle = Number(box.context);
        nodes[index] = node;
        break;
      }
      case 4:
      case 5:
      case 6:
      case 7:
      case 8:
      case 9:
        nodes[index] = textBox(box);
        break;
      case 11:
        // A display:contents root's formatting root.
        nodes[index] = {
          display: "block",
          bfc: true,
          ...childrenOf(box),
          ...coreBox(box),
          _coreHandle: Number(box.handle),
        };
        break;
      case 12: {
        const node = { display: DISPLAY_CODE_NAMES[box.display] };
        if (box.children.length) node.children = box.children;
        node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
        node._corePublication = publicationRef;
        node._coreFont = box.font;
        node._coreFontCss = faceCssOf(box.font);
        node._coreBoxHandle = 0;
        nodes[index] = node;
        break;
      }
      case 13:
        nodes[index] = {
          display: "block",
          bfc: true,
          width: renderViewport.width,
          height: renderViewport.height,
          ...rootWriting,
          _coreBox: 13,
          _corePublication: publicationRef,
          scrollLeft: renderViewport._requestedLeft,
          scrollTop: renderViewport._requestedTop,
          ...childrenOf(box),
        };
        break;
      default:
        throw new Error(`serializeToScene: unknown box kind ${box.kind}`);
    }
    nodes[index]._corePublication = publicationRef;
    nodes[index]._corePublicationIndex = index;
  }

  function elementScene(el, box) {
    // An svg shape's name comes from its tag; a path, polygon, or polyline
    // carries its path definition (the box text) for the host's path
    // atlas; svg text carries its text.
    const display = box.display === 22
      ? SVG_SHAPE_DISPLAY[el.localName]
      : DISPLAY_CODE_NAMES[box.display];
    // background-image url() layers are host resources: the renderer
    // resolves each URL to an image index and writes it into the record's
    // layer entries. Gradient and none layers stay in the core's record.
    const imageLayers = box.host & 2
      ? core.sceneResourceLayers(el._coreHandle)
      : [];
    let pathDefinition = null;
    if (box.display === 22 && box.text !== null) {
      const request = core.engineSvgRequest(
        box.stableId,
        box.sourceRevision,
        textBytesOf(box),
        box.stableId,
      );
      // The request's uint64 identity is carried as its decimal string:
      // every identity bit stays in the renderer's node signature, which
      // is plain JSON.
      pathDefinition = {
        d: box.text,
        identity: request.identity.toString(),
        resourceRevision: request.resourceRevision,
        fillRule: ["nonzero", "evenodd"][request.fillRule],
        stroke: request.stroke,
      };
    }
    const resource = box.host & 1 ? core.sceneResourceNode(el._coreHandle) : 0n;
    const resourceInfo = resource === 0n ? null : core.resourceInfo(resource);
    // Built field by field: this runs once per element per serialization,
    // and object spreads here were a measurable share of the frame.
    const node = {};
    // A box that declares transitions also keeps an owned copy of its
    // unrelocated record: the renderer reads transition endpoints from the
    // previous and next serialization, never from the shared engine buffer.
    //
    // The record carries the transform list already folded into one affine
    // (engine-transform.watpart), which CSS cannot interpolate: matching
    // function lists interpolate component-wise (an angle for rotate()),
    // matrices only as the mismatched-list fallback. So the CSS form comes
    // along too, per serialization and immutable like the record — the same
    // resolved-fields shape the render surface's transform-only frames
    // already put on a retained node.
    if (box.flags & BOX_TRANSITIONS) {
      node.transitionDefinitions = animationTransitionDefinitions(el);
      node._coreRecord = core.engineRecordCopy(
        box.stableId,
        box.sourceRevision,
      );
      const fields = resolvedElementFields(el);
      node.transform = fields.transform ?? TRANSFORM_NONE;
      if (fields.transformOrigin !== undefined) {
        node.transformOrigin = fields.transformOrigin;
      }
    }
    if (el === root) Object.assign(node, rootWriting);
    node.display = display;
    // The element behind the box, for the core's engine record. Handles
    // are (generation << 32 | index) and fit a double exactly.
    node._coreHandle = Number(el._coreHandle);
    node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
    node._corePublication = publicationRef;
    node._coreFont = box.font;
    node._coreFontCss = faceCssOf(box.font);
    if (box.flags & BOX_BFC) node.bfc = true;
    if (box.flags & BOX_INLINE_CONTEXT) node.inlineCtx = true;
    if (resourceInfo !== null) {
      if (resourceInfo.kind === 1) node.src = core.resourceKey(resource);
      if (resourceInfo.kind === 2) {
        imageSources.set(resourceInfo.id, el._canvasContext.paintSource);
        node.canvasSourceIdentifier = resourceInfo.id;
      }
      node.resourceIdentifier = resourceInfo.id;
    }
    if (box.display === 23) {
      Object.defineProperty(node, "text", {
        enumerable: true,
        get: () => box.text ?? "",
      });
    }
    if (pathDefinition !== null) {
      node.d = pathDefinition.d;
      node._coreSvgRequest = pathDefinition;
    }
    if (imageLayers.length) node.backgroundImages = imageLayers;
    if (scrollOwner && !el._scrollState) {
      const request = scrollRequests.get(node._coreHandle);
      node.scrollLeft = request === undefined ? 0 : request[0];
      node.scrollTop = request === undefined ? 0 : request[1];
    } else {
      // A state the element already holds may predate the surface and
      // attaches to it on this read.
      node.scrollLeft = el._requestedScrollLeft;
      node.scrollTop = el._requestedScrollTop;
    }
    if (box.children.length) node.children = box.children;
    return node;
  }

  core.attachSceneResources(nodes, root._coreHandle);
  let released = false;
  const serialized = {
    nodes,
    geometryBoxes: boxes,
    ...(renderViewport === null ? {} : { viewportIndex: 0 }),
    indexOf,
    // Text geometry (carets, glyphs) is read back from the paint artifact;
    // a scene without text boxes has none to read.
    textBoxes,
    loweredRows,
    changedRows,
    // Rows that took the previous publication's lowered bytes.
    reusedRows,
    canvasBackground,
    imageSources,
    // A DOM-backed box's scene node carries no style; the style system's
    // generation tells the persistent renderer when core records may have
    // changed.
    styleGeneration: styleSystem?.generation ?? 0,
    publication,
    // Sparse row lists are relative to this exact native predecessor, not
    // merely the last scene rendered by a surface. Revisions survive handle
    // reuse after a foreign publication has been released.
    publicationRevision: core.engineRecordRevision(publication),
    previousPublicationRevision: core.engineRecordPrevious(publication),
    // The wrapper keeps the reference alive too, so a caller that holds
    // only the wrapper (a layout getter's envelope) keeps the publication.
    publicationRef,
    release() {
      if (released) return;
      released = true;
      publications.unregister(publicationRef);
      core.engineRecordRelease(publication);
    },
  };
  return serialized;
}

// Publications are freed when their serialization is replaced (release())
// or, as a backstop, when the reference every node of the scene holds is
// collected.
const publications = new FinalizationRegistry(({ core, publication }) => {
  try {
    core.engineRecordRelease(publication);
  } catch { /* released or disposed */ }
});
