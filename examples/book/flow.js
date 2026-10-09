// An arbitrary Sandom document flowed across a book's numbered pages.
//
// The document is laid out once, as one column the width of a printed page,
// by a single Sandom render surface that stays alive while it is edited and
// used. `pageBreaks` cuts that column into pages at line boundaries; a page
// is rasterized by scrolling the viewport, one page of content tall, to it
// (a frame that only scrolled keeps its layout), and every presented frame
// is copied into the flow sheet cell of the page it shows. The flow sheet
// is a small cache of pages near the open spread.
//
// Redrawing is lazy. The pages in view are kept current; a page out of view
// that a change touched keeps its old raster until the book is about to show
// it, which is when a leaf starts to turn.
//
// Pages break as CSS Fragmentation asks. A page never cuts through a line
// of text or a replaced element. A document's `break-before` and
// `break-after` of page, left, right, recto or verso start a new page, the
// last four after a blank page when that is what puts the new page on its
// side; `avoid` keeps two blocks together, `break-inside: avoid` keeps a
// box whole, and `orphans` and `widows` keep lines of a paragraph together
// at a break. A heading has `break-after: avoid` from the flow's own style
// sheet, as CSS 2.1's default style sheet for print has it, so it stays
// with the first line after it. The space between blocks at a
// break is dropped, as a printed page drops the margins it is cut at.
//
// A page is a sheet of paper, not a screen: a fixed box is placed once where
// it starts, as if absolutely positioned, and a sticky box stays in flow.
// The viewport is one page of content tall, so `100vh` is one page.
//
// Classic inline scripts run once per edit, in order, against a window
// object of their own (createInputWindow): `window`, `document` and the DOM
// constructors they name are the flowed document's, not the page's.

import { PIXELS_PER_MM } from "./book-document.js";

// The flow sheet holds eight pages, in whichever grid of columns and rows
// keeps the sheet squarest: four across for a tall page, two for a wide one.
export const FLOW_CELLS = 8;
// Page margins in millimetres; the foot clears the folio.
export const FLOW_MARGINS = { top: 18, bottom: 24, side: 16 };

const EPSILON = 0.5;
const UNBREAKABLE = "img, svg, video, canvas, iframe, tr, input, select, textarea, button";
// Boxes `break-before`, `break-after` and `break-inside` apply to.
const BLOCK_LEVEL = /^(block|flow-root|list-item|flex|grid|table|table-row|table-row-group|table-header-group|table-footer-group)$/;
// Break values that force a page break, and the side of the book the page
// after the break must be on, as the parity of its index: the book binds on
// its left, so page 1 (index 0) is a recto, a right-hand page.
const FORCED_BREAKS = new Map([
  ["page", null], ["always", null], ["left", 1], ["verso", 1], ["right", 0], ["recto", 0],
]);
const AVOIDED_BREAKS = new Set(["avoid", "avoid-page"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(["eval", "arguments", "this", "undefined", "NaN", "Infinity"]);

// Page spans `{ top, bottom }` in column pixels; a blank page, which a
// left, right, recto or verso break adds to reach its side, is `{ top,
// bottom: top, blank: true }`. The input, in column positions:
// - `bands`: extents that never break: lines, replaced elements, form
//   controls. A band taller than a page is cut where the page ends and
//   continues on the next.
// - `keeps`: boxes with `break-inside: avoid`, kept whole when they fit.
// - `edges`: top edges of block boxes, where a page after a break starts.
// - `forced`: `{ position, value }` forced breaks, at the top edge of a box
//   (`break-before`) or its bottom edge (`break-after`), in document order.
// - `avoided`: positions of a `break-before` or `break-after` avoid.
// - `blocks`: `{ lines, orphans, widows }`, the line boxes of each block
//   container.
// - `end`: the bottom of the content.
//
// A forced break ends the page it falls on unless nothing precedes it
// there; then it only chooses the page's side. Otherwise a page breaks as
// low as it can: never through a band, and, by the rules CSS Fragmentation
// relaxes first when a page has no other break, neither leaving fewer than
// `orphans` lines of a block before the break or `widows` after it, nor
// through a keep or at an avoided position. The next page starts at its
// first content, dropping the gap it was cut in.
export const pageBreaks = ({ bands, end, contentHeight, keeps = [], edges = [], forced = [], avoided = [], blocks = [] }) => {
  if (!(contentHeight > 0)) throw new RangeError(`Page content height ${contentHeight} must be positive`);
  const content = [...bands, ...keeps];
  const starts = [...content.map(({ top }) => top), ...edges];
  const breaks = forced.filter(({ value }) => FORCED_BREAKS.has(value)).sort((a, b) => a.position - b.position);
  const blockLines = blocks.map((block) => ({ ...block, lines: [...block.lines].sort((a, b) => a.top - b.top) }));
  const contentBetween = (from, to) => content.some(({ top }) => top >= from - EPSILON && top < to - EPSILON);
  const crosses = (extents, start, cut) =>
    extents.some(({ top, bottom }) => top > start + EPSILON && top < cut - EPSILON && bottom > cut + EPSILON);
  // Whether the page from `start` may end at `cut` under `rules`: 1 keeps
  // bands whole, 2 also keeps and avoids, 3 also orphans and widows.
  const allows = (start, cut, rules) => {
    // The bottom of the content on this page before the break, and the
    // top of the content after it.
    let before = -Infinity;
    let after = Infinity;
    for (const { top, bottom } of content) {
      if (bottom > start + EPSILON && bottom <= cut + EPSILON) before = Math.max(before, bottom);
      if (top >= cut - EPSILON) after = Math.min(after, top);
    }
    if (before === -Infinity || crosses(bands, start, cut)) return false;
    if (rules < 2) return true;
    if (crosses(keeps, start, cut)) return false;
    if (avoided.some((position) => position >= before - EPSILON && position <= after + EPSILON)) return false;
    if (rules < 3) return true;
    for (const { lines, orphans, widows } of blockLines) {
      let above = 0;
      let below = 0;
      let last = null;
      let next = null;
      for (const line of lines) {
        if (line.top >= cut - EPSILON) {
          below++;
          next ??= line;
        } else if (line.top >= start - EPSILON) {
          above++;
          last = line;
        }
      }
      // Only a block whose own lines meet at the break counts them.
      if (above === 0 || below === 0 || last.bottom < before - EPSILON || next.top > after + EPSILON) continue;
      if (above < orphans || below < widows) return false;
    }
    return true;
  };
  // The lowest break the page allows, relaxing rules until one does; a
  // band taller than the page is cut at its end.
  const cutAt = (start, limit) => {
    const candidates = [limit, ...content.map(({ top }) => top).filter((top) => top > start + EPSILON && top < limit - EPSILON)]
      .sort((a, b) => b - a);
    for (let rules = 3; rules > 0; rules--) {
      const cut = candidates.find((candidate) => allows(start, candidate, rules));
      if (cut !== undefined) return cut;
    }
    return limit;
  };
  // The page after a break at `position` starts there when content runs
  // across it, else at the first content or box edge below it.
  const pageStart = (position) => {
    if (content.some(({ top, bottom }) => top < position - EPSILON && bottom > position + EPSILON)) return position;
    let first = Infinity;
    for (const top of starts) if (top >= position - EPSILON && top < first) first = top;
    return first === Infinity ? position : Math.max(position, first);
  };
  const pages = [];
  let start = 0;
  let next = 0;
  while (start < end - EPSILON) {
    // Forced breaks with nothing before them on this page choose its side;
    // a sided value outranks page, and a later one an earlier one.
    let side = null;
    for (; next < breaks.length && !contentBetween(start, breaks[next].position); next++) {
      side = FORCED_BREAKS.get(breaks[next].value) ?? side;
    }
    if (side !== null && pages.length % 2 !== side) pages.push({ top: start, bottom: start, blank: true });
    const limit = start + contentHeight;
    const forcedBreak = breaks[next];
    if (forcedBreak !== undefined && forcedBreak.position < Math.min(limit, end) + EPSILON) {
      pages.push({ top: start, bottom: forcedBreak.position });
      start = pageStart(forcedBreak.position);
      continue;
    }
    if (end <= limit + EPSILON) {
      pages.push({ top: start, bottom: end });
      break;
    }
    const cut = cutAt(start, limit);
    pages.push({ top: start, bottom: cut });
    start = pageStart(cut);
  }
  return pages;
};

const samePages = (a, b) =>
  a.length === b.length &&
  a.every((page, index) => page.top === b[index].top && page.bottom === b[index].bottom && page.blank === b[index].blank);

// Line boxes from the text runs laid out on them: runs that overlap
// vertically share a line.
const lineBoxes = (runs) => {
  const lines = [];
  for (const run of [...runs].sort((a, b) => a.top - b.top)) {
    const line = lines.at(-1);
    if (line !== undefined && run.top < line.bottom - EPSILON) line.bottom = Math.max(line.bottom, run.bottom);
    else lines.push({ top: run.top, bottom: run.bottom });
  }
  return lines;
};

// What `pageBreaks` needs, in column positions, from the surface's
// presented frame scrolled by `scrollTop`: every laid-out line of text,
// also as a line box of its block container, every replaced element and
// form control, and the edges and break properties of every block box.
const measureColumn = (frame, root, scrollTop) => {
  if (!frame?.textGeometryByNode) throw new Error("The flow surface has presented no frame with text geometry");
  const document = root.ownerDocument;
  const styles = new Map();
  const style = (element) => {
    let computed = styles.get(element);
    if (computed === undefined) styles.set(element, computed = document.getComputedStyle(element));
    return computed;
  };
  const bands = [];
  const runs = new Map();
  for (const [node, geometry] of frame.textGeometryByNode) {
    const anchors = geometry.anchors;
    const shift = (geometry.translationY ?? 0) + scrollTop;
    // A text node's lines belong to its nearest block container; a form
    // control's lines are inside the control.
    let container = null;
    if (node.nodeType === 3) {
      container = node.parentElement;
      while (container !== null && ["inline", "contents"].includes(style(container).display)) container = container.parentElement;
    }
    for (let index = 0; index < anchors.length; index += 4) {
      const band = { top: anchors[index + 1] + shift, bottom: anchors[index + 1] + anchors[index + 3] + shift };
      bands.push(band);
      if (container === null) continue;
      if (!runs.has(container)) runs.set(container, []);
      runs.get(container).push(band);
    }
  }
  const keeps = [];
  const edges = [];
  const forced = [];
  const avoided = [];
  const hidden = new Set();
  let end = 0;
  for (const element of root.querySelectorAll("body *")) {
    const computed = style(element);
    if (computed.display === "none" || hidden.has(element.parentElement)) {
      hidden.add(element);
      continue;
    }
    const box = element.getBoundingClientRect();
    const top = box.top + scrollTop;
    const bottom = box.bottom + scrollTop;
    if (box.height > 0) {
      end = Math.max(end, bottom);
      if (element.matches(UNBREAKABLE)) bands.push({ top, bottom });
    }
    if (!BLOCK_LEVEL.test(computed.display)) continue;
    if (box.height > 0) {
      edges.push(top);
      if (AVOIDED_BREAKS.has(computed.breakInside)) keeps.push({ top, bottom });
    }
    for (const [value, position] of [[computed.breakBefore, top], [computed.breakAfter, bottom]]) {
      if (FORCED_BREAKS.has(value)) forced.push({ position, value });
      else if (AVOIDED_BREAKS.has(value)) avoided.push(position);
    }
  }
  for (const band of bands) end = Math.max(end, band.bottom);
  const blocks = [...runs].map(([container, lines]) => ({
    lines: lineBoxes(lines),
    orphans: Number(style(container).orphans),
    widows: Number(style(container).widows),
  }));
  return { bands, keeps, edges, forced, avoided, blocks, end };
};

// Side margins pad the column, and the padding under it lets the last page
// scroll to the top of the viewport, which scrolls without a bar. Both sit
// on the root, out of reach of the document's own body styles. Headings
// avoid a break after them, as CSS 2.1's default style sheet for print
// has it; the document's own rules override that.
const FRAME_CSS = ({ side }, contentHeight) => `
  html { margin: 0; padding: 0 ${side}px ${contentHeight}px; background: #fff; scrollbar-width: none; }
  body { margin: 0; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
`;

// The flow for one book type. `onChange` runs whenever the pages or a cell
// changed and the book should draw again.
export class PageFlow {
  constructor({
    device, createSheet, createRenderSurface, createSceneRenderer, createSandomDOM, createInputWindow, DOMParser,
    pageWidth, pageHeight, deviceScale, onChange, onNavigate,
  }) {
    this.device = device;
    this.deviceScale = deviceScale;
    this.onChange = onChange;
    // Asks the book to show a page the document moved to by itself.
    this.onNavigate = onNavigate;
    this.pageWidth = pageWidth * PIXELS_PER_MM;
    this.pageHeight = pageHeight * PIXELS_PER_MM;
    this.margins = Object.fromEntries(Object.entries(FLOW_MARGINS).map(([edge, millimetres]) => [edge, millimetres * PIXELS_PER_MM]));
    this.contentHeight = this.pageHeight - this.margins.top - this.margins.bottom;
    this.cellWidth = Math.round(this.pageWidth * deviceScale);
    this.cellHeight = Math.round(this.pageHeight * deviceScale);
    const limit = device.limits.maxTextureDimension2D;
    const grids = [1, 2, 4, 8]
      .map((columns) => ({ columns, rows: FLOW_CELLS / columns }))
      .map((grid) => ({ ...grid, largest: Math.max(grid.columns * this.cellWidth, grid.rows * this.cellHeight) }))
      .sort((a, b) => a.largest - b.largest);
    if (grids[0].largest > limit) {
      throw new Error(`${FLOW_CELLS} pages of ${this.cellWidth}×${this.cellHeight} px need a ${grids[0].largest} px sheet side; the device allows ${limit} px`);
    }
    this.columns = grids[0].columns;
    this.rows = grids[0].rows;
    this.sheet = createSheet(this.cellWidth * this.columns, this.cellHeight * this.rows);
    // Blank page: every cell is cleared to it before a page is copied in.
    this.blank = device.createTexture({
      label: "flow-blank-page", size: [this.cellWidth, this.cellHeight], format: "rgba16float",
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.blank }, new Uint16Array(this.cellWidth * this.cellHeight * 4).fill(0x3c00),
      { bytesPerRow: this.cellWidth * 8 }, [this.cellWidth, this.cellHeight]);
    // Each cell: the page it holds (−1 none), whether a raster of that page
    // has landed in it, and whether that raster is current.
    this.cellPages = new Array(FLOW_CELLS).fill(-1);
    this.cellShown = new Array(FLOW_CELLS).fill(false);
    this.cellFresh = new Array(FLOW_CELLS).fill(false);
    this.visiblePages = [];
    this.prefetchPages = [];
    // The page the reader is using; the viewport rests on it between rasters.
    this.focusPage = -1;
    this.pages = [];
    this.error = null;
    this.timings = { layout: 0, measure: 0, pages: [] };
    this.working = false;
    this.contentChanged = false;
    this.layoutStale = false;
    this.measuredLayoutPasses = -1;

    const source = new DOMParser().parseFromString(
      `<!doctype html><html lang="en"><head><style>${FRAME_CSS(this.margins, this.contentHeight)}</style><style></style></head><body></body></html>`,
      "text/html",
    );
    this.document = source;
    this.root = source.documentElement;
    this.userStyle = source.querySelectorAll("style")[1];
    this.body = source.body;
    this.backend = createSandomDOM({ document: source, viewportW: this.pageWidth, viewportH: this.contentHeight });
    this.window = createInputWindow(source);
    this.surface = createRenderSurface(this.root, {
      viewportWidth: this.pageWidth,
      viewportHeight: this.contentHeight,
      deviceScale,
      createPersistentRenderer: (options) => createSceneRenderer({ ...options, graphicsDevice: device }),
      presentFrame: (frame) => this.#present(frame),
    });
    // A change to the document can reach pages out of view; they are marked
    // stale and redrawn when they next come into view.
    this.observer = new this.window.MutationObserver(() => this.#touchOtherPages());
    this.observer.observe(this.body, { subtree: true, childList: true, characterData: true, attributes: true });
    // Focus moving to a control on another page (Tab, a script) turns the
    // book to that page.
    this.document.addEventListener("focusin", () => {
      if (!this.working && this.pages.length > 0) this.#followDocument();
    });
    // A selection can reach pages out of view; they are redrawn when shown.
    this.document.addEventListener("selectionchange", () => this.#touchOtherPages());
  }

  get scrollTop() {
    return this.surface.inspectScrolling().effectiveTop;
  }

  // The printed page whose top the viewport rests on, or −1 between pages.
  // A blank page shares its top with the page after it.
  #pageAtScroll() {
    const top = this.scrollTop;
    return this.pages.findIndex((page) => !page.blank && Math.abs(page.top - top) <= EPSILON);
  }

  #touchOtherPages() {
    const current = this.#pageAtScroll();
    let touched = false;
    for (let cell = 0; cell < FLOW_CELLS; cell++) {
      if (this.cellPages[cell] !== current && this.cellFresh[cell]) {
        this.cellFresh[cell] = false;
        touched = true;
      }
    }
    if (touched) this.#work();
  }

  // Copies every presented frame into the cell of the page it shows, below
  // the top margin; a frame between pages shows no page and is dropped.
  #present(frame) {
    if (frame.device !== this.device || !frame.textureImage?.texture) {
      throw new Error("Sandom flow frame is not on the book's GPU device");
    }
    const { texture: source, width, height, format } = frame.textureImage;
    const expectedWidth = Math.round(this.pageWidth * this.deviceScale);
    const expectedHeight = Math.round(this.contentHeight * this.deviceScale);
    if (width !== expectedWidth || height !== expectedHeight || format !== "rgba16float") {
      throw new Error(`Sandom flow page is ${width}×${height} ${format}; the book expects ${expectedWidth}×${expectedHeight} rgba16float`);
    }
    if (this.surface.frameStageCounters.layoutPasses !== this.measuredLayoutPasses) {
      this.layoutStale = true;
      this.#work();
    }
    const page = this.#pageAtScroll();
    if (!this.working && page !== this.focusPage && this.focusPage >= 0) this.#followDocument();
    const cell = page < 0 ? -1 : this.cellPages.indexOf(page);
    if (cell < 0) return;
    const span = this.pages[page];
    this.#land(cell, source, Math.min(height, Math.round((span.bottom - span.top) * this.deviceScale)));
  }

  // Clears a cell to blank paper, copies the top `rows` rows of `source`
  // into it below the top margin, and marks the cell's page current.
  #land(cell, source, rows) {
    const originX = (cell % this.columns) * this.cellWidth;
    const originY = Math.floor(cell / this.columns) * this.cellHeight;
    const encoder = this.device.createCommandEncoder({ label: "copy-flow-page" });
    encoder.copyTextureToTexture({ texture: this.blank }, { texture: this.sheet.created.gpu, origin: [originX, originY] },
      [this.cellWidth, this.cellHeight, 1]);
    if (rows > 0) {
      encoder.copyTextureToTexture({ texture: source },
        { texture: this.sheet.created.gpu, origin: [originX, originY + Math.round(this.margins.top * this.deviceScale)] },
        [source.width, rows, 1]);
    }
    this.device.queue.submit([encoder.finish()]);
    this.sheet.mipmaps();
    this.cellShown[cell] = true;
    this.cellFresh[cell] = true;
    this.onChange();
  }

  // The document scrolled itself: a scrolling key, or focus moving to a
  // control out of view. The page it went to, the one holding the focused
  // element, else the one under the middle of the viewport, becomes the
  // page in use; the book turns to it and the viewport returns to its top.
  #followDocument() {
    const focused = this.document.activeElement;
    let position;
    if (focused && focused !== this.body && focused !== this.root) {
      const box = focused.getBoundingClientRect();
      position = this.scrollTop + (box.top + box.bottom) / 2;
    } else {
      position = this.scrollTop + this.contentHeight / 2;
    }
    let page = this.pages.findIndex((span) => position < span.bottom);
    if (page < 0) page = this.pages.length - 1;
    if (page < 0) return;
    this.focusPage = -1;
    this.focus(page);
    this.onNavigate(page);
  }

  // Replaces the document's content and styles in the live surface, runs
  // its scripts, and places its fixed and sticky boxes for paper.
  setContent({ html, css }) {
    this.userStyle.textContent = css;
    this.body.innerHTML = html;
    this.error = null;
    try {
      this.#runScripts();
      this.#placeForPaper();
    } catch (error) {
      this.error = error;
    }
    this.contentChanged = true;
    this.layoutStale = true;
    this.#work();
  }

  #runScripts() {
    const names = [];
    const values = [];
    for (const name of Object.keys(this.window)) {
      if (!IDENTIFIER.test(name) || RESERVED.has(name)) continue;
      names.push(name);
      values.push(this.window[name]);
    }
    for (const script of this.body.querySelectorAll("script")) {
      const type = script.getAttribute("type");
      if (type !== null && type !== "" && type !== "text/javascript") continue;
      if (script.hasAttribute("src")) {
        throw new Error(`The script with src ${JSON.stringify(script.getAttribute("src"))} is not loaded; put the code inline`);
      }
      // The names rebind lexically, so free identifiers such as `document`
      // reach the flowed document; `this` is its window.
      new Function(...names, script.textContent).apply(this.window, values);
    }
    // Sandom's events are the host's Event class.
    this.document.dispatchEvent(new Event("DOMContentLoaded"));
  }

  #placeForPaper() {
    for (const element of this.body.querySelectorAll("*")) {
      const position = this.document.getComputedStyle(element).position;
      if (position === "fixed") element.style.setProperty("position", "absolute", "important");
      else if (position === "sticky") element.style.setProperty("position", "relative", "important");
    }
  }

  // The pages the book shows now, which are kept current, and the pages it
  // may show next, which only need to be ready.
  want({ visible, prefetch }) {
    const valid = (page) => page >= 0 && page < this.pages.length;
    const nextVisible = visible.filter(valid);
    const nextPrefetch = prefetch.filter((page) => valid(page) && !nextVisible.includes(page));
    const combined = [...nextVisible, ...nextPrefetch].slice(0, FLOW_CELLS);
    if (combined.join(" ") === [...this.visiblePages, ...this.prefetchPages].join(" ") &&
      nextVisible.length === this.visiblePages.length) return;
    this.visiblePages = combined.slice(0, nextVisible.length);
    this.prefetchPages = combined.slice(nextVisible.length);
    this.#work();
  }

  // Page index held by each cell for the book uniform, −1 for none.
  cellContents() {
    return this.cellPages.map((page, cell) => this.cellShown[cell] ? page : -1);
  }

  // A point on `page` in page CSS pixels (from its top left corner) as a
  // viewport point of the surface, or null outside the page's text block.
  // `tracking` keeps a pressed gesture following past the block's edge.
  documentPoint(page, x, y, tracking) {
    const span = this.pages[page];
    if (span === undefined) return null;
    const contentY = y - this.margins.top;
    const inside = x >= this.margins.side && x <= this.pageWidth - this.margins.side &&
      contentY >= 0 && contentY <= span.bottom - span.top;
    if (!inside && !tracking) return null;
    return { x, y: span.top + contentY - this.scrollTop };
  }

  // The inverse of documentPoint on the page in use: a viewport point of
  // the surface as `{ page, x, y }`, a point on that page in page CSS pixels
  // from its top left corner, or null when no page is in use or the point
  // is outside the page's printed rows.
  pagePoint(x, y) {
    const span = this.pages[this.focusPage];
    if (span === undefined) return null;
    const contentY = y + this.scrollTop - span.top;
    if (x < 0 || x > this.pageWidth || contentY < 0 || contentY > span.bottom - span.top) return null;
    return { page: this.focusPage, x, y: this.margins.top + contentY };
  }

  // The reader is using `page`: the viewport returns to it after rasters.
  focus(page) {
    if (page === this.focusPage) return;
    this.focusPage = page;
    this.#work();
  }

  // Starts delivering frames of the document's own: hover, caret blink,
  // selection, input.
  interact() {
    this.surface.start();
  }

  // One worker moves the viewport: a layout goes first, then pages in view
  // that are stale, then pages to prefetch that no cell holds, and finally
  // the viewport returns to the page in use.
  async #work() {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        if (this.layoutStale) {
          this.layoutStale = false;
          await this.#layout();
          continue;
        }
        const heldFresh = (page) => {
          const cell = this.cellPages.indexOf(page);
          return cell >= 0 && this.cellFresh[cell];
        };
        const page = this.visiblePages.find((wanted) => !heldFresh(wanted)) ??
          this.prefetchPages.find((wanted) => !this.cellPages.includes(wanted));
        if (page !== undefined) {
          await this.#rasterize(page);
          continue;
        }
        const focus = this.pages[this.focusPage];
        if (focus !== undefined && Math.abs(focus.top - this.scrollTop) > EPSILON) {
          this.surface.viewport.scrollTo(0, focus.top);
          await this.surface.renderNow();
          continue;
        }
        break;
      }
    } catch (error) {
      this.error = error;
      this.onChange();
      throw error;
    } finally {
      this.working = false;
    }
  }

  async #layout() {
    const started = performance.now();
    try {
      if (this.contentChanged) await this.surface.renderNow();
      const laidOut = performance.now();
      const layoutPasses = this.surface.frameStageCounters.layoutPasses;
      const pages = pageBreaks({
        ...measureColumn(this.surface.presentedFrame, this.root, this.scrollTop),
        contentHeight: this.contentHeight,
      });
      this.measuredLayoutPasses = layoutPasses;
      if (this.contentChanged) {
        this.timings.layout = laidOut - started;
        this.timings.pages = [];
      }
      this.timings.measure = performance.now() - laidOut;
      if (!this.contentChanged && samePages(pages, this.pages)) return;
      this.pages = pages;
    } catch (error) {
      // The editor shows the failure; the book keeps blank pages.
      this.error = error;
      this.pages = [];
    }
    this.contentChanged = false;
    this.cellFresh.fill(false);
    for (let cell = 0; cell < FLOW_CELLS; cell++) {
      if (this.cellPages[cell] >= this.pages.length) {
        this.cellPages[cell] = -1;
        this.cellShown[cell] = false;
      }
    }
    this.visiblePages = this.visiblePages.filter((page) => page < this.pages.length);
    this.prefetchPages = this.prefetchPages.filter((page) => page < this.pages.length);
    this.onChange();
  }

  async #rasterize(page) {
    let cell = this.cellPages.indexOf(page);
    if (cell < 0) {
      const wanted = [...this.visiblePages, ...this.prefetchPages];
      cell = this.cellPages.findIndex((held) => !wanted.includes(held));
      if (cell < 0) throw new Error(`No flow cell free for page ${page}; the ${FLOW_CELLS} cells hold ${this.cellPages.join(", ")}`);
      // The cell stops showing its old page before the new one lands in it.
      this.cellPages[cell] = page;
      this.cellShown[cell] = false;
      this.cellFresh[cell] = false;
      this.onChange();
    }
    // A blank page is paper alone; nothing is rendered for it.
    if (this.pages[page].blank) {
      this.#land(cell, null, 0);
      return;
    }
    const started = performance.now();
    this.surface.viewport.scrollTo(0, this.pages[page].top);
    await this.surface.renderNow();
    if (!this.cellFresh[cell] && this.cellPages[cell] === page && !this.layoutStale) {
      throw new Error(`Page ${page + 1} did not land: the viewport rests at ${this.scrollTop} px, not the page top ${this.pages[page].top} px`);
    }
    this.timings.pages.push(performance.now() - started);
  }

  async shutdown() {
    this.observer.disconnect();
    await this.surface.shutdown();
    this.sheet.created.destroy();
    this.blank.destroy();
  }
}
