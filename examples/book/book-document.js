// The printed matter of every book type, each as one Sandom document: a
// sheet of six page-sized slots plus a strip of folios. The sheet is ink on
// white, read by the book shader as the light each point of ink transmits,
// so it multiplies the paper or card colour the way ink on uncoated stock
// does: white prints nothing, and white type on a coloured field is the
// unprinted stock showing through a printed block.
//
// Slots run row-major, three columns by two rows; each is one printed page
// upright as the reader holds it, edge to edge. `slotFaces` names the leaf
// face each slot prints (2 × leaf for the recto, 2 × leaf + 1 for the
// verso); FOIL_DIE is the hardcover front board, whose dark areas the
// shader turns into pressed gold foil, and UNUSED_SLOT a slot no face takes.
// A type with a template slot prints it on the numbered page faces named by
// `templateFaces` that have no slot of their own. Under the slots, a type
// that prints folios has the folio strip: one cell per page number,
// row-major, for the shader to print page numbers from. The sheet keeps the
// strip's height either way.

import { printedPageSize } from "./bindings.js";

export const PIXELS_PER_MM = 5;
export const DEVICE_SCALE = 2;
export const SLOT_COLUMNS = 3;
export const SLOT_ROWS = 2;
export const FOLIO_COLUMNS = 16;
export const FOLIO_ROWS = 13;
export const FOLIO_WIDTH = 16 * PIXELS_PER_MM;
export const FOLIO_HEIGHT = 6 * PIXELS_PER_MM;

const FOIL_DIE = -2;
const UNUSED_SLOT = -1;
const NO_TEMPLATE = -1;

// The shader prints a folio in a 16 × 6 mm cell whose foot is 11 mm above
// the page's foot; a slot that sets its own folio uses the same cell.
const FOLIO_BOTTOM = 11 * PIXELS_PER_MM;

const folioStrip = () => Array.from({ length: FOLIO_COLUMNS * FOLIO_ROWS }, (_, cell) =>
  `<span style="left: ${(cell % FOLIO_COLUMNS) * FOLIO_WIDTH}px; top: ${Math.floor(cell / FOLIO_COLUMNS) * FOLIO_HEIGHT}px">${cell + 1}</span>`
).join("");

// A straight stroke from (x1, y1) to (x2, y2) in slot pixels: a thin bar
// rotated about its left end.
const stroke = (x1, y1, x2, y2, weight = 2) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
  return `<div class="stroke" style="left: ${x1.toFixed(1)}px; top: ${(y1 - weight / 2).toFixed(1)}px; width: ${length.toFixed(1)}px; height: ${weight}px; transform: rotate(${angle.toFixed(2)}deg)"></div>`;
};

// Parallel strokes at `spacing` across a band from (x, y) to (x + width, y),
// each leaning `lean` pixels right over `height`.
const hatching = (x, y, width, height, spacing, lean, weight = 1.5) =>
  Array.from({ length: Math.floor(width / spacing) + 1 }, (_, index) =>
    stroke(x + index * spacing, y + height, x + index * spacing + lean, y, weight)
  ).join("");

// Vertical strokes every `spacing` from x0 to x1, each running from top(x)
// down to bottom(x): shading kept inside a drawn outline.
const shading = (x0, x1, spacing, top, bottom, weight = 1.5) =>
  Array.from({ length: Math.floor((x1 - x0) / spacing) + 1 }, (_, index) => {
    const x = x0 + index * spacing;
    return stroke(x, top(x), x, bottom(x), weight);
  }).join("");

// An outlined ellipse whose box starts at (x, y); `extra` declarations
// restyle it, e.g. transparent sides to draw only an arc of it.
const ellipse = (x, y, width, height, extra = "") =>
  `<div class="ellipse" style="left: ${x}px; top: ${y}px; width: ${width}px; height: ${height}px;${extra}"></div>`;

// The bottom or right half of the ellipse outline whose box starts at
// (x, y): the whole ellipse inside a box that clips it to that half. An
// ellipse with transparent sides would also draw the ends of its side
// borders.
const arc = (x, y, width, height, side) => side === "bottom"
  ? `<div class="arc" style="left: ${x}px; top: ${y + height / 2}px; width: ${width}px; height: ${height / 2}px">${ellipse(0, -height / 2, width, height)}</div>`
  : `<div class="arc" style="left: ${x + width / 2}px; top: ${y}px; width: ${width / 2}px; height: ${height}px">${ellipse(-width / 2, 0, width, height)}</div>`;

// ---------------------------------------------------------------- hardcover

// Slot 0 is the front board's foil die; slots 1 … 5 are pages 1 … 5. Pages
// 4 and 5 set their own folios; every other page takes its folio from the
// strip.
const hardcover = ({ slotWidth, place }) => ({
  slotFaces: [FOIL_DIE, 2, 3, 4, 5, 6],
  templateSlot: NO_TEMPLATE,
  templateFaces: "all",
  folios: true,
  css: `
  body { position: relative; color: #1b1a19; font-family: "Crimson Text"; font-size: 23px; line-height: 34px; }

  .cover { display: flex; flex-direction: column; align-items: center; color: #000; }
  .cover .frame { position: absolute; inset: 60px 56px; border: 3px solid #000; }
  .cover .inner { position: absolute; inset: 72px 68px; border: 1px solid #000; }
  .cover h1 { margin-top: 250px; font-size: 76px; line-height: 84px; font-weight: 600; letter-spacing: 3px; }
  .cover .ornament { margin-top: 26px; width: 120px; height: 3px; background: #000; }
  .cover .author { margin-top: 34px; font-size: 30px; letter-spacing: 7px; font-family: "Inter"; }
  .cover .mark { position: absolute; left: ${slotWidth / 2 - 28}px; bottom: 130px; width: 56px; height: 56px; border: 3px solid #000; border-radius: 50%; }

  .page { padding: 110px 80px 120px 80px; }
  .title { text-align: center; padding-top: 250px; }
  .title h1 { font-size: 58px; line-height: 64px; font-weight: 600; letter-spacing: 2px; }
  .title .subtitle { margin-top: 20px; font-style: italic; font-size: 27px; }
  .title .author { margin-top: 150px; font-family: "Inter"; font-size: 17px; letter-spacing: 6px; }
  .title .press { position: absolute; left: 0; right: 0; bottom: 110px; font-family: "Inter"; font-size: 13px; letter-spacing: 4px; color: #6b2a1e; }
  .colophon { padding-top: 640px; font-size: 16px; line-height: 24px; color: #3a3836; }
  .colophon p + p { margin-top: 14px; }
  .epigraph { padding-top: 300px; padding-left: 150px; font-style: italic; font-size: 24px; line-height: 36px; }
  .epigraph .source { margin-top: 18px; font-style: normal; font-family: "Inter"; font-size: 13px; letter-spacing: 3px; }
  .chapter-number { padding-top: 120px; font-family: "Inter"; font-size: 14px; letter-spacing: 6px; color: #6b2a1e; }
  .chapter-title { margin: 18px 0 60px; font-size: 44px; line-height: 50px; font-weight: 600; }
  .text p { text-align: justify; hyphens: auto; font-style: normal; }
  .text p + p { text-indent: 34px; }
  .initial { font-size: 46px; line-height: 30px; color: #6b2a1e; }
  .text .folio { position: absolute; left: 0; width: 100%; bottom: 64px; text-align: center; text-indent: 0; font-size: 17px; }
`,
  html: `
<section class="slot cover" style="${place(0)}" aria-label="Front board">
  <div class="frame"></div><div class="inner"></div>
  <h1>On Paper</h1>
  <div class="ornament"></div>
  <p class="author">A. MOREAU</p>
  <div class="mark"></div>
</section>
<section class="slot page title" style="${place(1)}" aria-label="Page 1">
  <h1>On Paper</h1>
  <p class="subtitle">Notes on fibre, ink and the turning leaf</p>
  <p class="author">A. MOREAU</p>
  <p class="press">SANDOM PRESS</p>
</section>
<section class="slot page colophon" style="${place(2)}" aria-label="Page 2">
  <p>Set in Crimson Text and Inter. The type on these pages was laid out and rasterized by Sandom on the graphics card, and never left it.</p>
  <p>Printed on cotton book paper. Each leaf is a sheet of measured stiffness that bends, drags on the air, and settles on the ones before it.</p>
</section>
<section class="slot page epigraph" style="${place(3)}" aria-label="Page 3">
  <p>A page is a door that closes behind you, softly, and waits.</p>
  <p class="source">— FROM THE BINDERY</p>
</section>
<section class="slot page text" style="${place(4)}" aria-label="Page 4">
  <p class="chapter-number">CHAPTER ONE</p>
  <h2 class="chapter-title">The Weight of a Leaf</h2>
  <p class="opening"><span class="initial">P</span>ick up a sheet of good paper and it answers the hand before the eye. It has a weight, a stiffness, a faint tooth under the thumb; it resists being bent and then gives, all at once, in a long curve that runs from the fingers to the far edge.</p>
  <p>Grammage is the paper maker's word for that weight: grams to the square metre. Heavier stock is thicker, and a sheet's stiffness grows with the cube of its thickness, so a leaf of heavy paper turns slowly and deliberately where a thin one flutters.</p>
  <p class="folio">4</p>
</section>
<section class="slot page text" style="${place(5)}" aria-label="Page 5">
  <p>Air matters more than we notice. A falling leaf pushes the air beneath it aside, and near the stack the air has nowhere to go; the page floats the last few millimetres down on a cushion of its own making.</p>
  <p>The spine holds every leaf along one line. Near it the pages rise to meet the binding in a curve, and the thicker the book, the deeper that gutter and the further the fore edge draws in toward the middle.</p>
  <p>Hold the page up to the light and the other side shows through, reversed, faint as a watermark. Paper is not a surface but a thin felt of fibres, and light wanders through it.</p>
  <p class="folio">5</p>
</section>
`,
});

// ---------------------------------------------------------------- paperback

// A novel on off-white card and cream wove. Slot 0 is the front cover
// (face 0), slots 1 … 4 are pages 1 … 4 (faces 2 … 5) and slot 5 the
// outside of the back cover (face 195). Rectos keep the wider margin on
// the left, versos on the right: the bound edge.
const BARCODE_BARS = "3112112311213121321111232111131211231221231112311322211211132213111231231213";

const paperback = ({ slotWidth, place }) => ({
  slotFaces: [0, 2, 3, 4, 5, 195],
  templateSlot: NO_TEMPLATE,
  templateFaces: "all",
  folios: true,
  css: `
  body { position: relative; color: #1c1b1a; font-family: "Crimson Text"; font-size: 19px; line-height: 27px; }

  .front .field { position: absolute; left: 0; top: 0; width: ${slotWidth}px; height: 600px; background: #2d5c61; }
  .front .sun { position: absolute; left: 318px; top: 360px; width: 170px; height: 170px; border-radius: 50%; background: #e1a43c; }
  .front .sea { position: absolute; left: 0; top: 470px; width: ${slotWidth}px; height: 130px; background: #22474b; }
  .front .swell { position: absolute; left: 40px; height: 2px; background: #fff; }
  .front .kind { position: absolute; left: 56px; top: 86px; font-family: "Inter"; font-size: 13px; letter-spacing: 5px; color: #fff; }
  .front h1 { position: absolute; left: 52px; top: 128px; font-size: 76px; line-height: 76px; font-weight: 600; color: #fff; }
  .front .author { position: absolute; left: 0; top: 648px; width: ${slotWidth}px; text-align: center; font-family: "Inter"; font-size: 21px; letter-spacing: 7px; }
  .front .praise { position: absolute; left: 70px; top: 700px; width: ${slotWidth - 140}px; text-align: center; font-style: italic; font-size: 19px; line-height: 25px; color: #4a4744; }
  .imprint { position: absolute; left: 0; width: ${slotWidth}px; display: flex; flex-direction: column; align-items: center; font-family: "Inter"; font-size: 10px; letter-spacing: 4px; color: #2d5c61; }
  .imprint .mark { width: 34px; height: 34px; margin-bottom: 9px; border: 2px solid #2d5c61; border-radius: 50%; font-family: "Crimson Text"; font-size: 20px; line-height: 30px; letter-spacing: 0; text-align: center; font-weight: 600; }
  .front .imprint { top: 790px; }

  .recto { padding: 76px 48px 110px 64px; }
  .verso { padding: 76px 64px 110px 48px; }
  .half-title { text-align: center; }
  .half-title h1 { margin-top: 170px; font-size: 40px; line-height: 46px; font-weight: 600; letter-spacing: 4px; }
  .half-title .rule { width: 60px; height: 2px; margin: 26px auto 0; background: #2d5c61; }
  .half-title .author { margin-top: 26px; font-style: italic; font-size: 25px; }
  .half-title .imprint { top: 740px; }
  .copyright { font-size: 13px; line-height: 19px; color: #3d3a37; }
  .copyright .notices { position: absolute; left: 48px; right: 64px; bottom: 110px; }
  .copyright p + p { margin-top: 11px; }
  .chapter .number { margin-top: 150px; font-family: "Inter"; font-size: 13px; letter-spacing: 6px; color: #2d5c61; }
  .chapter h2 { margin: 12px 0 44px; font-size: 36px; line-height: 42px; font-weight: 600; }
  .prose p + p::before { content: ""; display: inline-block; width: 24px; }
  .prose .smallcaps { font-family: "Inter"; font-size: 13px; letter-spacing: 2px; }

  .back .field { position: absolute; left: 0; top: 0; width: ${slotWidth}px; height: 560px; background: #2d5c61; }
  .back .blurb { position: absolute; left: 60px; top: 90px; width: ${slotWidth - 124}px; color: #fff; font-size: 21px; line-height: 29px; }
  .back .blurb p + p { margin-top: 16px; }
  .back .blurb .lead { font-style: italic; font-size: 25px; line-height: 32px; }
  .back .category { position: absolute; left: 60px; top: 600px; font-family: "Inter"; font-size: 11px; letter-spacing: 4px; color: #2d5c61; }
  .back .barcode { position: absolute; left: 60px; top: 650px; width: 200px; height: 130px; padding: 12px 14px 0; background: #fff; }
  .back .bars { display: flex; height: 84px; }
  .back .bars div { height: 84px; }
  .back .digits { margin-top: 4px; font-family: "Inter"; font-size: 12px; line-height: 14px; letter-spacing: 3px; text-align: center; }
  .back .imprint { left: 300px; width: 220px; top: 676px; }
`,
  html: `
<section class="slot front" style="${place(0)}" aria-label="Front cover">
  <div class="field"></div>
  <div class="sun"></div>
  <div class="sea"></div>
  <div class="swell" style="top: 502px; width: 150px"></div>
  <div class="swell" style="top: 530px; left: 210px; width: 250px"></div>
  <div class="swell" style="top: 562px; left: 90px; width: 190px"></div>
  <p class="kind">A NOVEL</p>
  <h1>The<br>Salt<br>Road</h1>
  <p class="author">INES VARGA</p>
  <p class="praise">A morning out, an afternoon back, and everything a family keeps in a tin.</p>
  <div class="imprint"><div class="mark">S</div>SANDOM PAPERBACKS</div>
</section>
<section class="slot recto half-title" style="${place(1)}" aria-label="Page 1">
  <h1>THE SALT ROAD</h1>
  <div class="rule"></div>
  <p class="author">Ines Varga</p>
  <div class="imprint"><div class="mark">S</div>SANDOM PAPERBACKS</div>
</section>
<section class="slot verso copyright" style="${place(2)}" aria-label="Page 2">
  <div class="notices">
    <p>First published by Sandom Paperbacks in 2026.</p>
    <p>Copyright © Ines Varga, 2026. The author asserts the moral right to be identified as the author of this work.</p>
    <p>This is a work of fiction. The salt road, the town at its end and everyone who walks it are imagined; any likeness to real places or people is chance.</p>
    <p>Set in Crimson Text and Inter. Printed on 90 g/m² cream book wove and bound with a flat glued spine.</p>
    <p>Sandom Paperbacks · catalogue SP 117</p>
  </div>
</section>
<section class="slot recto chapter prose" style="${place(3)}" aria-label="Page 3">
  <p class="number">ONE</p>
  <h2>The Road Out</h2>
  <p><span class="smallcaps">MY GRANDMOTHER</span> kept the salt in a blue tin by the stove, and when the tin was empty she walked to the flats to fill it. It took her a morning there and an afternoon back. She never bought salt; she said salt that had been paid for tasted of the shop.</p>
  <p>When I was nine she took me with her. We left before the light, with the tin wrapped in a cloth and two heels of bread in her apron pocket, and the road went down between the dunes so gradually that I could not have said where it stopped being a road and became sand.</p>
  <div class="slot-folio">3</div>
</section>
<section class="slot verso prose" style="${place(4)}" aria-label="Page 4">
  <p>The flats began where the grass gave up. They were grey and level and they shone, and far out, where the sea should have been, there was only a line of brighter light. My grandmother walked straight at it as if she were late.</p>
  <p>Every few hundred steps there was a pan: a square of ground scraped flat and walled with a lip of clay no higher than my ankle. Some held water the colour of weak tea. Some had dried to a crust that broke under a thumb, and those were the ones she wanted.</p>
  <p>She showed me how to lift the crust with the edge of a scallop shell, never pressing down, so that the mud underneath stayed where it was. The good salt came away in plates, white on top and grey beneath. We scraped the grey off with our nails and put the white in the tin.</p>
  <p>By noon the tin was half full and my fingertips were raw. We sat on the lip of a dry pan to eat the bread, and she broke off a flake of salt and put it on my tongue. It tasted of nothing at first, and then of the flats, the weed and the long wind off the water.</p>
  <p>“Why does nobody else come?” I asked.</p>
  <p>She thought about it for a long time. “They do,” she said at last. “Just not today.”</p>
  <div class="slot-folio">4</div>
</section>
<section class="slot back" style="${place(5)}" aria-label="Back cover">
  <div class="field"></div>
  <div class="blurb">
    <p class="lead">Every spring, Nell Aske walks her grandmother's road to the salt flats with a blue tin wrapped in a cloth.</p>
    <p>This year the tin is hers. The road is shorter than she remembers, the dunes have moved, and someone has been scraping the pans before her.</p>
    <p>A novel about inheritance, patience and the small, exact work of the hands.</p>
  </div>
  <p class="category">FICTION</p>
  <div class="barcode">
    <div class="bars">${[...BARCODE_BARS].map((width, index) =>
      `<div style="width: ${width * 2}px; background: ${index % 2 === 0 ? "#111" : "#fff"}"></div>`).join("")}</div>
    <p class="digits">5 026117 004182</p>
  </div>
  <div class="imprint"><div class="mark">S</div>SANDOM PAPERBACKS</div>
</section>
`,
});

// ---------------------------------------------------------------- booklet

// A two-ink zine, fluorescent pink and blue on white, self-covered: slot 0
// is page 1 (face 0), slots 1 and 2 are pages 2 and 3, slots 3 and 4 the
// centre spread, pages 12 and 13, and slot 5 page 24, the back cover. The
// spread is one composition twice the page wide, shown through each slot
// from its own half.
const booklet = ({ slotWidth, slotHeight, place }) => {
  const spread = `
    <div class="spread">
      <div class="sun"></div>
      <div class="sea"></div>
      ${[[620, 90, 520], [652, 330, 610], [688, 170, 360], [688, 760, 540], [724, 40, 420], [724, 1010, 380], [770, 520, 700], [820, 150, 300], [820, 1100, 280]]
        .map(([top, left, width]) => `<div class="wave" style="top: ${top}px; left: ${left}px; width: ${width}px"></div>`).join("")}
      <h2><span>TWICE A DAY</span><span class="second">THE HARBOUR EMPTIES</span></h2>
      <p class="caption">Low water, the equinox spring tide. The boats lie down on their sides in the mud and the whole floor of the harbour, which nobody has seen since the autumn, is out in the air for an hour.</p>
      <p class="times">HIGH 06:12 · LOW 12:31 · HIGH 18:40 · LOW 00:55</p>
    </div>`;
  return {
    slotFaces: [0, 1, 2, 11, 12, 23],
    templateSlot: NO_TEMPLATE,
    templateFaces: "all",
    folios: true,
    css: `
  body { position: relative; color: #171717; font-family: "Inter"; font-size: 18px; line-height: 26px; }

  .cover { background: #ff5c80; }
  .cover .circle { position: absolute; left: 330px; top: 520px; width: 470px; height: 470px; border-radius: 50%; background: #3656a8; }
  .cover h1 { position: absolute; left: 44px; top: 70px; font-size: 200px; line-height: 170px; font-weight: 700; letter-spacing: 6px; color: #fff; }
  .cover .issue { position: absolute; left: 50px; top: 440px; font-size: 22px; font-weight: 700; letter-spacing: 4px; }
  .cover .strap { position: absolute; left: 50px; top: 490px; width: 300px; font-family: "Crimson Text"; font-style: italic; font-size: 32px; line-height: 38px; }
  .cover .free { position: absolute; left: 50px; bottom: 60px; font-size: 14px; font-weight: 700; letter-spacing: 3px; color: #fff; }

  .inside { padding: 80px 64px 110px 64px; }
  .kicker { font-size: 14px; font-weight: 700; letter-spacing: 4px; color: #ff5c80; }
  .contents h2 { margin-top: 10px; font-size: 44px; line-height: 50px; font-weight: 700; letter-spacing: 1px; }
  .contents ol { margin-top: 34px; padding: 0; list-style: none; }
  .contents li { display: flex; padding: 12px 0; border-top: 2px solid #3656a8; font-size: 20px; line-height: 28px; }
  .contents li .page { width: 60px; font-weight: 700; color: #3656a8; }
  .contents li .what { flex: 1; }
  .contents .note { margin-top: 40px; padding: 26px 28px; background: #ffe0e7; font-family: "Crimson Text"; font-size: 20px; line-height: 28px; }
  .contents .note .signed { margin-top: 10px; font-style: italic; }

  .article h2 { margin-top: 10px; font-size: 56px; line-height: 62px; font-weight: 700; letter-spacing: 1px; }
  .article .standfirst { margin: 22px 0 34px; font-family: "Crimson Text"; font-style: italic; font-size: 26px; line-height: 34px; color: #3656a8; }
  .article .columns { display: flex; gap: 34px; }
  .article .column { flex: 1; font-family: "Crimson Text"; font-size: 20px; line-height: 28px; }
  .article .column p + p { margin-top: 14px; }
  .article .dot { display: inline-block; width: 13px; height: 13px; margin-right: 8px; border-radius: 50%; background: #ff5c80; }

  .spread { position: absolute; top: 0; width: ${2 * slotWidth}px; height: ${slotHeight}px; }
  .spread-left .spread { left: 0; }
  .spread-right .spread { left: ${-slotWidth}px; }
  .spread .sun { position: absolute; left: ${slotWidth - 280}px; top: 330px; width: 560px; height: 560px; border-radius: 50%; background: #ff5c80; }
  .spread .sea { position: absolute; left: 0; top: 600px; width: ${2 * slotWidth}px; height: ${slotHeight - 600}px; background: #3656a8; }
  .spread .wave { position: absolute; height: 4px; border-radius: 2px; background: #fff; }
  .spread h2 { position: absolute; left: 70px; top: 90px; width: ${2 * slotWidth - 140}px; font-weight: 700; color: #3656a8; text-align: center; }
  .spread h2 span { display: block; font-size: 190px; line-height: 180px; letter-spacing: 8px; }
  .spread h2 .second { margin-top: 14px; font-size: 72px; line-height: 80px; letter-spacing: 10px; color: #171717; }
  .spread .caption { position: absolute; left: 70px; top: 880px; width: 480px; font-family: "Crimson Text"; font-style: italic; font-size: 21px; line-height: 28px; color: #fff; }
  .spread .times { position: absolute; left: ${slotWidth + 110}px; top: 960px; font-size: 14px; font-weight: 700; letter-spacing: 3px; color: #fff; }

  .back { padding: 110px 70px; }
  .back .circle { position: absolute; left: 70px; top: 110px; width: 150px; height: 150px; border-radius: 50%; background: #ff5c80; }
  .back .band { position: absolute; left: 0; bottom: 0; width: ${slotWidth}px; height: 280px; background: #3656a8; }
  .back .about { margin-top: 210px; font-family: "Crimson Text"; font-size: 23px; line-height: 32px; }
  .back .about p + p { margin-top: 16px; }
  .back .sign-off { position: absolute; left: 70px; bottom: 170px; font-size: 32px; line-height: 40px; font-weight: 700; letter-spacing: 1px; color: #fff; }
  .back .credits { position: absolute; left: 70px; bottom: 110px; font-size: 12px; letter-spacing: 3px; color: #fff; }
`,
    html: `
<section class="slot cover" style="${place(0)}" aria-label="Page 1, front cover">
  <div class="circle"></div>
  <h1>LOW<br>TIDE</h1>
  <p class="issue">ISSUE 03 · SPRING</p>
  <p class="strap">Field notes from the harbour wall</p>
  <p class="free">FREE · TAKE ONE · PASS IT ON</p>
</section>
<section class="slot inside contents" style="${place(1)}" aria-label="Page 2">
  <p class="kicker">IN THIS ISSUE</p>
  <h2>Everything the sea put down</h2>
  <ol>
    <li><span class="page">3</span><span class="what">What the water leaves</span></li>
    <li><span class="page">6</span><span class="what">A field guide to the wall</span></li>
    <li><span class="page">9</span><span class="what">Tide tables, annotated</span></li>
    <li><span class="page">12</span><span class="what">Twice a day</span></li>
    <li><span class="page">16</span><span class="what">Bladderwrack, and how to pop it</span></li>
    <li><span class="page">20</span><span class="what">The man with the bucket</span></li>
    <li><span class="page">23</span><span class="what">Letters</span></li>
  </ol>
  <div class="note">
    <p>This issue was nearly about boats. Then the spring tides came and took the water out further than any of us had seen it go, and we spent a week walking on the bottom of the harbour instead.</p>
    <p class="signed">— the Harbour Wall Walking Club</p>
  </div>
  <div class="slot-folio">2</div>
</section>
<section class="slot inside article" style="${place(2)}" aria-label="Page 3">
  <p class="kicker">WALKS</p>
  <h2>What the water leaves</h2>
  <p class="standfirst">An hour either side of low tide, the harbour floor is a museum that rearranges itself twice a day.</p>
  <div class="columns">
    <div class="column">
      <p><span class="dot"></span>Start at the slipway, where the concrete runs out into ribbed sand. The ribs are the tide's handwriting: close together where the water ran fast, wide where it dawdled.</p>
      <p>Past the first mooring chain the sand turns to mud, and the mud is full of small round holes. Stand still and some of them will breathe at you.</p>
      <p>Things we found last week, in order: a bicycle bell, a crab the size of a fingernail, half a teacup with a blue rim, a mooring rope gone soft as wool, and the anchor of a boat nobody remembers.</p>
    </div>
    <div class="column">
      <p>Under the wall, in the shade, the stones are furred green and the pools stay full. Lift nothing you cannot put back the right way up.</p>
      <p>By the harbour mouth the water is already on its way back, a thin bright sheet sliding over the mud faster than you would think. That is the moment to turn round.</p>
      <p>Walk back along the line of weed the last tide left, and you are walking along yesterday's high water. Everything the sea put down, it will come back for.</p>
    </div>
  </div>
  <div class="slot-folio">3</div>
</section>
<section class="slot spread-left" style="${place(3)}" aria-label="Page 12, left half of the centre spread">${spread}</section>
<section class="slot spread-right" style="${place(4)}" aria-label="Page 13, right half of the centre spread">${spread}</section>
<section class="slot back" style="${place(5)}" aria-label="Page 24, back cover">
  <div class="circle"></div>
  <div class="about">
    <p>Low Tide is written, drawn and folded by the Harbour Wall Walking Club. Six sheets, one staple, two inks, no adverts.</p>
    <p>The next issue comes out when the autumn equinox tides come round. Until then: check the tables, wear boots, and turn back before the water does.</p>
  </div>
  <div class="band"></div>
  <p class="sign-off">Leave this copy<br>somewhere wet.</p>
  <p class="credits">LOW TIDE · ISSUE 03 · PRINTED IN PINK AND BLUE</p>
</section>
`,
  };
};

// ---------------------------------------------------------------- notebook

// Feint ruled with a margin, wire bound through holes 7 mm in from the
// bound edge: the left edge of a recto, the right edge of a verso. Ruling
// and writing stay out of a 12 mm strip at both edges, so one template
// serves both faces. Slot 0 is the front cover's label on kraft card, slot
// 1 the template, slots 2 … 4 pages 1 … 3 with notes written over their
// own ruling, and slot 5 the outside of the back cover (face 103).
const HOLE_CLEARANCE = 12 * PIXELS_PER_MM;
const RULE_PITCH = 7 * PIXELS_PER_MM;
const FIRST_RULE = 30 * PIXELS_PER_MM;
const MARGIN_RULE = 32 * PIXELS_PER_MM;

const notebook = ({ slotWidth, slotHeight, place }) => {
  const ruleCount = Math.floor((slotHeight - HOLE_CLEARANCE - FIRST_RULE) / RULE_PITCH) + 1;
  const ruling = `
    <p class="date">DATE</p><div class="date-line"></div>
    ${Array.from({ length: ruleCount }, (_, index) =>
      `<div class="rule" style="top: ${FIRST_RULE + index * RULE_PITCH}px"></div>`).join("")}
    <div class="margin"></div>`;
  // Writing sits on the ruling: line boxes one pitch tall, placed so that
  // the first baseline of Crimson Text at 26 px falls just above rule `line`
  // (0-based).
  const notes = (line, body) =>
    `<div class="notes" style="top: ${FIRST_RULE + (line - 1) * RULE_PITCH + 8}px">${body}</div>`;
  return {
    slotFaces: [0, UNUSED_SLOT, 2, 3, 4, 103],
    templateSlot: 1,
    templateFaces: "all",
    folios: false,
    css: `
  body { position: relative; color: #1b1a19; font-family: "Inter"; font-size: 16px; line-height: 22px; }

  .label { position: absolute; left: 150px; top: 250px; width: ${slotWidth - 240}px; height: 330px; border: 4px solid #2a1c12; color: #2a1c12; }
  .label .inner { position: absolute; inset: 8px; border: 1px solid #2a1c12; }
  .label h1 { position: absolute; left: 0; right: 0; top: 46px; text-align: center; font-family: "Crimson Text"; font-size: 64px; line-height: 70px; font-weight: 600; letter-spacing: 16px; }
  .label .field { position: absolute; left: 44px; right: 44px; height: 30px; border-bottom: 2px solid #2a1c12; font-size: 13px; letter-spacing: 4px; }
  .kraft-imprint { position: absolute; left: 0; right: 0; bottom: 90px; text-align: center; font-size: 12px; letter-spacing: 4px; color: #2a1c12; }
  .kraft-imprint .mark { width: 30px; height: 30px; margin: 0 auto 12px; border: 3px solid #2a1c12; border-radius: 50%; }
  .back-imprint { position: absolute; left: ${HOLE_CLEARANCE + 60}px; right: ${HOLE_CLEARANCE + 60}px; bottom: 120px; text-align: center; font-size: 13px; line-height: 21px; letter-spacing: 1px; color: #2a1c12; }
  .back-imprint .mark { width: 30px; height: 30px; margin: 0 auto 18px; border: 3px solid #2a1c12; border-radius: 50%; }

  .rule { position: absolute; left: ${HOLE_CLEARANCE}px; width: ${slotWidth - 2 * HOLE_CLEARANCE}px; height: 2px; background: #a8c6e6; }
  .margin { position: absolute; left: ${MARGIN_RULE}px; top: 0; width: 2px; height: ${slotHeight}px; background: #eaa0a0; }
  .date { position: absolute; left: ${slotWidth - HOLE_CLEARANCE - 250}px; top: ${FIRST_RULE - 70}px; font-size: 11px; letter-spacing: 3px; color: #8fb2d8; }
  .date-line { position: absolute; left: ${slotWidth - HOLE_CLEARANCE - 190}px; top: ${FIRST_RULE - 56}px; width: 190px; height: 2px; background: #a8c6e6; }

  .notes { position: absolute; left: ${MARGIN_RULE + 16}px; width: ${slotWidth - MARGIN_RULE - 16 - HOLE_CLEARANCE - 10}px; font-family: "Crimson Text"; font-style: italic; font-size: 26px; line-height: ${RULE_PITCH}px; color: #22357a; }
  .notes p { position: relative; }
  .notes .in-margin { position: absolute; left: ${-MARGIN_RULE + HOLE_CLEARANCE + 6 - 16}px; width: ${MARGIN_RULE - HOLE_CLEARANCE - 14}px; text-align: right; }
  .notes .underlined { border-bottom: 2px solid #22357a; }
  .notes .struck { text-decoration: line-through; }
  .notes .ringed { padding: 0 10px; border: 2px solid #22357a; border-radius: 50%; }
  .written-date { position: absolute; left: ${slotWidth - HOLE_CLEARANCE - 180}px; top: ${FIRST_RULE - 86}px; font-family: "Crimson Text"; font-style: italic; font-size: 24px; color: #22357a; }
`,
    html: `
<section class="slot" style="${place(0)}" aria-label="Front cover">
  <div class="label">
    <div class="inner"></div>
    <h1>NOTES</h1>
    <p class="field" style="top: 170px">NAME</p>
    <p class="field" style="top: 230px">SUBJECT</p>
  </div>
  <div class="kraft-imprint"><div class="mark"></div>SANDOM STATIONERY · 100 PAGES · FEINT RULED</div>
</section>
<section class="slot" style="${place(1)}" aria-label="Ruled page">${ruling}</section>
<section class="slot" style="${place(2)}" aria-label="Page 1">${ruling}
  <p class="written-date">3 March</p>
  ${notes(0, `
    <p><span class="underlined">Paper tests</span>, a list</p>
    <p><span class="in-margin">1.</span>Tear it along the grain, then across. Along: a clean edge. Across: ragged, fibres sticking out like hair.</p>
    <p><span class="in-margin">2.</span>Hold it to the window. The fibres show as clouds, darker where they clump.</p>
    <p><span class="in-margin">3.</span>Fold, unfold, fold again. After nine folds the crease turns white and soft.</p>
    <p><span class="in-margin">4.</span>Wet one corner: it curls toward the dry side, always across the grain.</p>
    <p>So the grain runs <span class="underlined">down the page</span> in this book. Good: the leaves turn easily.</p>`)}
</section>
<section class="slot" style="${place(3)}" aria-label="Page 2">${ruling}
  ${notes(1, `
    <p>Weights to compare:</p>
    <p><span class="in-margin">90</span>this pad. Shows the pen through from the other side, just.</p>
    <p><span class="in-margin">150</span>sketchbook. Turns slowly, lands flat.</p>
    <p><span class="in-margin">300</span>the cover card. Does not want to bend at all.</p>
    <p>Stiffness goes with the cube of thickness, so twice as thick is <span class="underlined">eight times</span> as stiff. Ask at the bindery whether that is why the endpapers <span class="ringed">crack first</span>.</p>`)}
</section>
<section class="slot" style="${place(4)}" aria-label="Page 3">${ruling}
  <p class="written-date">4 March</p>
  ${notes(0, `
    <p><span class="underlined">Questions for Thursday</span></p>
    <p><span class="in-margin">–</span>How far apart are the holes? Looks like half an inch, check.</p>
    <p><span class="in-margin">–</span>Why do the rings never quite close?</p>
    <p><span class="in-margin">–</span>Does a page turn faster on a wire than on a glued spine?</p>
    <p><span class="in-margin">–</span><span class="struck">Bring the old ledger</span> (lent to M.)</p>
    <p>Buy more of these.</p>`)}
</section>
<section class="slot" style="${place(5)}" aria-label="Back cover">
  <div class="back-imprint">
    <div class="mark"></div>
    <p>Sandom Stationery</p>
    <p>Fifty sheets, one hundred pages of 90 g/m² white paper, feint ruled at 7 mm with a margin, wire bound between card covers.</p>
  </div>
</section>
`,
  };
};

// ---------------------------------------------------------------- sketchpad

// Landscape, bound along the head, whose top 15 mm is glued and stays bare.
// Slot 0 is the grey-green card cover, slot 1 a faint 5 mm grid for every
// recto, slots 2 … 4 pencil sketches on pages 1, 3 and 5 (faces 2, 4, 6),
// drawn over their own copy of the grid.
const HEAD_CLEARANCE = 15 * PIXELS_PER_MM;
const GRID_PITCH = 5 * PIXELS_PER_MM;

// Half the chord of an ellipse centred at `centre` with semi-axis `across`
// along x and `along` along y, at x.
const halfChord = (centre, across, along) => (x) => along * Math.sqrt(Math.max(0, 1 - ((x - centre) / across) ** 2));

const sketchpad = ({ slotWidth, slotHeight, place }) => {
  const gridLeft = GRID_PITCH;
  const gridTop = HEAD_CLEARANCE + GRID_PITCH;
  const gridColumns = Math.floor((slotWidth - 2 * gridLeft) / GRID_PITCH);
  const gridRows = Math.floor((slotHeight - gridTop - GRID_PITCH) / GRID_PITCH);
  const grid = [
    ...Array.from({ length: gridRows + 1 }, (_, row) =>
      `<div class="grid" style="left: ${gridLeft}px; top: ${gridTop + row * GRID_PITCH}px; width: ${gridColumns * GRID_PITCH + 1}px; height: 1px"></div>`),
    ...Array.from({ length: gridColumns + 1 }, (_, column) =>
      `<div class="grid" style="left: ${gridLeft + column * GRID_PITCH}px; top: ${gridTop}px; width: 1px; height: ${gridRows * GRID_PITCH + 1}px"></div>`),
  ].join("");
  const cupRim = halfChord(315, 95, 22);
  const cupBase = halfChord(315, 69, 22);
  const pear = halfChord(655, 95, 100);
  const cylinder = halfChord(535, 85, 28);
  const sphere = halfChord(815, 115, 115);
  const equator = halfChord(815, 115, 25);
  const stillLife = [
    stroke(90, 560, 960, 548, 2),
    // Cup: rim, walls, base, handle, saucer; shaded on its right.
    ellipse(220, 318, 190, 44),
    stroke(222, 340, 246, 486, 2.5),
    stroke(408, 340, 384, 486, 2.5),
    arc(246, 462, 138, 44, "bottom"),
    arc(372, 362, 56, 80, "right"),
    ellipse(170, 478, 290, 70),
    ellipse(208, 492, 214, 38),
    shading(356, 398, 7, (x) => 340 + cupRim(x) + 3, (x) => Math.min(484 + cupBase(x) - 3, 340 + (408 - x) * 146 / 24)),
    // Pear: body, shoulder, stalk, leaf; shaded on its right.
    ellipse(560, 350, 190, 200),
    ellipse(598, 264, 112, 130),
    stroke(654, 266, 668, 222, 3),
    ellipse(670, 216, 64, 26, " transform: rotate(-24deg);"),
    shading(700, 742, 7, (x) => 450 - 0.3 * pear(x), (x) => 450 + pear(x) - 4),
    // Cast shadows on the table.
    hatching(462, 500, 80, 46, 10, 22),
    hatching(752, 470, 150, 78, 12, 30),
  ].join("");
  const landscape = [
    stroke(60, 470, 990, 470, 2),
    ellipse(-120, 380, 620, 260, " border-bottom-color: transparent; border-left-color: transparent; border-right-color: transparent;"),
    ellipse(330, 330, 760, 330, " border-bottom-color: transparent; border-left-color: transparent; border-right-color: transparent;"),
    ellipse(744, 190, 96, 96),
    // A lane running down to the foreground.
    stroke(506, 470, 360, 650, 2),
    stroke(530, 470, 620, 650, 2),
    // Trees: trunks and crowns.
    stroke(214, 404, 214, 470, 2.5),
    ellipse(170, 312, 88, 104),
    stroke(284, 420, 284, 470, 2.5),
    ellipse(252, 352, 64, 76),
    stroke(870, 380, 870, 470, 2.5),
    ellipse(818, 272, 104, 124),
    // Birds.
    stroke(560, 200, 578, 212, 2), stroke(578, 212, 596, 198, 2),
    stroke(610, 176, 624, 186, 2), stroke(624, 186, 640, 174, 2),
    stroke(470, 236, 482, 244, 2), stroke(482, 244, 494, 234, 2),
    // Ploughed fields either side of the lane.
    hatching(640, 500, 280, 60, 14, -30),
    hatching(110, 560, 190, 70, 14, -26),
  ].join("");
  const solids = [
    stroke(80, 560, 970, 560, 2),
    // Cube: front face and the two faces seen in recession, the right one
    // in shade.
    `<div class="shape" style="left: 120px; top: 330px; width: 180px; height: 180px"></div>`,
    stroke(120, 330, 190, 270, 2), stroke(300, 330, 370, 270, 2), stroke(300, 510, 370, 450, 2),
    stroke(190, 270, 370, 270, 2), stroke(370, 270, 370, 450, 2),
    shading(308, 364, 8, (x) => 330 - (x - 300) * 60 / 70 + 4, (x) => 510 - (x - 300) * 60 / 70 - 4),
    // Cylinder: top ellipse, sides, lower rim; shaded on its right.
    ellipse(450, 244, 170, 56),
    stroke(451, 272, 451, 498, 2), stroke(619, 272, 619, 498, 2),
    arc(450, 470, 170, 56, "bottom"),
    shading(574, 612, 7, (x) => 272 + cylinder(x) + 4, (x) => 498 + cylinder(x) - 4),
    // Sphere, opaque over its cast shadow, with its equator; shaded below
    // the equator on the right.
    ellipse(770, 494, 220, 40, " border-color: transparent; background: #e1e4e6;"),
    ellipse(700, 280, 230, 230, " background: #fff;"),
    arc(700, 372, 230, 50, "bottom"),
    shading(852, 918, 8, (x) => 397 + equator(x) + 4, (x) => 395 + sphere(x) - 4),
  ].join("");
  return {
    slotFaces: [0, UNUSED_SLOT, 2, 4, 6, UNUSED_SLOT],
    templateSlot: 1,
    templateFaces: "recto",
    folios: false,
    css: `
  body { position: relative; color: #4a4e53; font-family: "Inter"; font-size: 16px; line-height: 22px; }

  .card { color: #121412; }
  .card h1 { position: absolute; left: 90px; top: 230px; font-size: 120px; line-height: 120px; font-weight: 700; letter-spacing: 10px; }
  .card .rule { position: absolute; left: 96px; top: 380px; width: 560px; height: 4px; background: #121412; }
  .card .size { position: absolute; left: 96px; top: 410px; font-size: 30px; line-height: 40px; font-weight: 600; letter-spacing: 2px; }
  .card .weight { position: absolute; left: 96px; top: 456px; font-size: 30px; line-height: 40px; font-weight: 600; letter-spacing: 2px; }
  .card .details { position: absolute; left: 96px; bottom: 90px; font-size: 14px; letter-spacing: 4px; }
  .card .mark { position: absolute; right: 100px; bottom: 80px; width: 110px; height: 110px; border: 4px solid #121412; border-radius: 50%; }
  .card .mark::after { content: ""; position: absolute; left: 22px; top: 50px; width: 58px; height: 4px; background: #121412; transform: rotate(-35deg); }

  .grid { position: absolute; background: #e3e7ea; }
  .stroke { position: absolute; background: #54585d; transform-origin: 0 50%; border-radius: 2px; }
  .ellipse { position: absolute; border: 2px solid #54585d; border-radius: 50%; }
  .shape { position: absolute; border: 2px solid #54585d; }
  .arc { position: absolute; overflow: hidden; }
  .annotation { position: absolute; font-family: "Crimson Text"; font-style: italic; font-size: 24px; line-height: 30px; color: #6a6e73; }
`,
    html: `
<section class="slot card" style="${place(0)}" aria-label="Front cover">
  <h1>SKETCH</h1>
  <div class="rule"></div>
  <p class="size">210 × 148</p>
  <p class="weight">150 g/m²</p>
  <p class="details">32 SHEETS · HEAVY CARTRIDGE · TOP BOUND</p>
  <div class="mark"></div>
</section>
<section class="slot" style="${place(1)}" aria-label="Grid">${grid}</section>
<section class="slot" style="${place(2)}" aria-label="Page 1">${grid}${stillLife}
  <p class="annotation" style="left: 700px; top: 610px">kitchen table, 9.40 am</p>
</section>
<section class="slot" style="${place(3)}" aria-label="Page 3">${grid}${landscape}
  <p class="annotation" style="left: 90px; top: 130px">from the stile, looking south</p>
</section>
<section class="slot" style="${place(4)}" aria-label="Page 5">${grid}${solids}
  <p class="annotation" style="left: 90px; top: 610px">light from the upper left; shade the far faces</p>
</section>
`,
  };
};

const CONTENT = { hardcover, paperback, booklet, notebook, sketchpad };

// The printed matter of `type`, an entry of BOOK_TYPES: the document source,
// its slot and sheet sizes in CSS pixels, and the plan of what each slot
// prints.
export const bookDocument = (type) => {
  const content = CONTENT[type?.name];
  if (!content) {
    throw new Error(
      `No printed matter for book type ${JSON.stringify(type?.name)}; known types: ${Object.keys(CONTENT).join(", ")}. ` +
        "Pass an entry of BOOK_TYPES from bindings.js.",
    );
  }
  const { pageWidth, pageHeight } = printedPageSize(type);
  const slotWidth = pageWidth * PIXELS_PER_MM;
  const slotHeight = pageHeight * PIXELS_PER_MM;
  const documentWidth = SLOT_COLUMNS * slotWidth;
  const documentHeight = SLOT_ROWS * slotHeight + FOLIO_ROWS * FOLIO_HEIGHT;
  const place = (slot) =>
    `left: ${(slot % SLOT_COLUMNS) * slotWidth}px; top: ${Math.floor(slot / SLOT_COLUMNS) * slotHeight}px;`;
  const { css, html, slotFaces, templateSlot, templateFaces, folios } = content({ slotWidth, slotHeight, place });
  const sheetCss = `
  html, body { width: ${documentWidth}px; height: ${documentHeight}px; margin: 0; overflow: hidden; background: #fff; }
  * { box-sizing: border-box; margin: 0; }
  .slot { position: absolute; width: ${slotWidth}px; height: ${slotHeight}px; overflow: hidden; }
${css}
  .slot-folio { position: absolute; left: 0; width: 100%; bottom: ${FOLIO_BOTTOM}px; height: ${FOLIO_HEIGHT}px; text-align: center; text-indent: 0; font-size: 17px; line-height: ${FOLIO_HEIGHT}px; }
  .folios { position: absolute; left: 0; top: ${SLOT_ROWS * slotHeight}px; }
  .folios span { position: absolute; width: ${FOLIO_WIDTH}px; height: ${FOLIO_HEIGHT}px; text-align: center; font-size: 17px; line-height: ${FOLIO_HEIGHT}px; }
`;
  const strip = folios ? `<div class="folios" aria-hidden="true">${folioStrip()}</div>` : "";
  return {
    source: `<!doctype html>
<html lang="en"><head><style>${sheetCss}</style></head><body>${html}${strip}
</body></html>`,
    slotWidth,
    slotHeight,
    documentWidth,
    documentHeight,
    slotFaces,
    templateSlot,
    templateFaces,
    folios,
  };
};
