// The Wikipedia article on the scroll. The page fetches one pinned revision
// through the MediaWiki parse API at load, keeps the article content, and
// drops the site interface: no logo, tagline, menus, tabs, edit links, or
// Wikipedia styles. The layout below is our own. Every visible string of the
// article comes from the revision; nothing is invented.
//
// Text: CC BY-SA 4.0, attributed in the document itself. Images are omitted
// because each image carries its own licence on its file page.

export const ARTICLE = Object.freeze({
  title: "Dead Sea Scrolls",
  revision: 1373755579,
  revisionDate: "7 September 2026",
  pageUrl: "https://en.wikipedia.org/wiki/Dead_Sea_Scrolls",
  historyUrl: "https://en.wikipedia.org/w/index.php?title=Dead_Sea_Scrolls&action=history",
  revisionUrl: "https://en.wikipedia.org/w/index.php?title=Dead_Sea_Scrolls&oldid=1373755579",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  // The body ends before the first heading in this set: the link lists and
  // the reference apparatus are not article prose.
  stopHeadings: Object.freeze(["See_also", "Notes", "References"]),
});

const PARSE_URL = "https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2" +
  `&oldid=${ARTICLE.revision}&prop=text&disableeditsection=1&disabletoc=1&origin=*`;

const KEEP = new Set([
  "p", "h2", "h3", "h4", "ul", "ol", "li", "dl", "dt", "dd", "blockquote",
  "b", "strong", "i", "em", "sub", "br", "table", "caption", "thead", "tbody",
  "tr", "th", "td", "a",
]);
// Site interface and material outside the text licence.
const DROP_CLASSES = [
  "shortdescription", "mw-empty-elt", "reference", "mw-editsection", "navbox",
  "reflist", "metadata", "ambox", "thumb", "gallery", "sistersitebox",
  "side-box", "infobox-image", "noviewer", "mw-references-wrap", "error",
];
const DROP_TAGS = new Set(["style", "script", "link", "meta", "figure", "img", "audio", "video", "sup"]);

function absoluteHref(href) {
  if (!href || href.startsWith("#")) return null;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://en.wikipedia.org${href}`;
  return href;
}

function copyNode(source, target, ownerDocument) {
  for (const child of source.childNodes) {
    if (child.nodeType === 3) {
      target.append(ownerDocument.createTextNode(child.data));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.localName;
    if (DROP_TAGS.has(tag)) continue;
    if (DROP_CLASSES.some((name) => child.classList.contains(name))) continue;
    if (child.getAttribute("style")?.includes("display:none")) continue;
    if (!KEEP.has(tag)) {
      copyNode(child, target, ownerDocument);
      continue;
    }
    if (tag === "table" && !child.classList.contains("infobox") && !child.classList.contains("wikitable")) {
      continue;
    }
    if (tag === "a") {
      const href = absoluteHref(child.getAttribute("href"));
      if (href === null) {
        copyNode(child, target, ownerDocument);
        continue;
      }
      const link = ownerDocument.createElement("a");
      link.setAttribute("href", href);
      copyNode(child, link, ownerDocument);
      target.append(link);
      continue;
    }
    const element = ownerDocument.createElement(tag);
    if (tag === "table") element.className = child.classList.contains("infobox") ? "infobox" : "data";
    if (child.classList.contains("hatnote")) element.className = "hatnote";
    for (const span of ["colspan", "rowspan"]) {
      if (child.hasAttribute(span)) element.setAttribute(span, child.getAttribute(span));
    }
    copyNode(child, element, ownerDocument);
    target.append(element);
  }
}

// Fetches the pinned revision and returns the article body as HTML text.
// The browser's own DOMParser cleans the response; Sandom receives only the
// kept markup.
export async function fetchArticleBody() {
  const response = await fetch(PARSE_URL);
  if (!response.ok) {
    throw new Error(`Wikipedia parse API returned HTTP ${response.status} for revision ${ARTICLE.revision}. Check the network and reload.`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`Wikipedia parse API refused revision ${ARTICLE.revision}: ${payload.error.info}`);
  }
  const parsed = new DOMParser().parseFromString(payload.parse.text, "text/html");
  const output = parsed.createElement("div");
  const content = parsed.querySelector(".mw-parser-output");
  if (content === null) {
    throw new Error(`Revision ${ARTICLE.revision} has no article body in the parse API response.`);
  }
  const description = content.querySelector(".shortdescription")?.textContent.trim() ?? "";
  for (const block of [...content.children]) {
    const heading = block.matches(".mw-heading") ? block.querySelector("h2") : null;
    if (heading && ARTICLE.stopHeadings.includes(heading.id)) break;
    const holder = parsed.createElement("div");
    holder.append(block.cloneNode(true));
    copyNode(holder, output, parsed);
  }
  return { description, html: output.innerHTML };
}

export function articleDocument({ description, html }) {
  return `
<article class="paper">
  <header>
    <h1>${ARTICLE.title}</h1>
    <p class="description">${description}</p>
    <p class="attribution">Text from the Wikipedia article
      <a href="${ARTICLE.revisionUrl}">${ARTICLE.title}</a>, revision ${ARTICLE.revision}
      of ${ARTICLE.revisionDate}, by <a href="${ARTICLE.historyUrl}">its contributors</a>,
      under <a href="${ARTICLE.licenseUrl}">CC BY-SA 4.0</a>.
      Laid out on a scroll; images and references omitted.</p>
  </header>
  <div class="body">${html}</div>
</article>`;
}

// "Inter" and "Roboto Slab" are the faces main.js loads. The stacks name no
// generic family: Sandom has no system fonts, and a generic family without
// an installed face fails the stack. Text in a script these faces do not
// cover (the Hebrew word in the article) takes a Noto fallback face.
//
// The article is the scroll container. `main` fills the paper and holds the
// paper colour, so the colour stays under the text however far it scrolls.
export const ARTICLE_CSS = `
* { box-sizing: border-box; }
main {
  width: 100%;
  height: 100%;
  background: #efe4c8;
  color: #2b2116;
  font-family: "Inter";
  font-size: 17px;
  line-height: 1.6;
}
.paper {
  height: 100%;
  overflow-y: auto;
  /* The rollers are the scrollbar. */
  scrollbar-width: none;
  padding: 150px 64px 190px;
}
h1, h2, h3, h4 { font-family: "Roboto Slab"; color: #1f170e; }
h1 { margin: 0; font-size: 46px; line-height: 1.1; font-weight: 600; }
.description { margin: 6px 0 18px; font-size: 18px; color: #4f412c; }
.attribution {
  margin: 0 0 28px;
  padding: 10px 0;
  border-top: 1px solid #b9a57e;
  border-bottom: 1px solid #b9a57e;
  font-size: 13px;
  line-height: 1.5;
  color: #4f412c;
}
h2 { margin: 34px 0 10px; font-size: 28px; line-height: 1.25; font-weight: 600; border-bottom: 1px solid #b9a57e; padding-bottom: 4px; }
h3 { margin: 24px 0 8px; font-size: 21px; font-weight: 600; }
h4 { margin: 18px 0 6px; font-size: 18px; font-weight: 600; }
p { margin: 0 0 14px; }
ul, ol { margin: 0 0 14px; padding-left: 26px; }
li { margin: 0 0 4px; }
blockquote { margin: 0 0 14px; padding-left: 18px; border-left: 3px solid #b9a57e; color: #4a3b28; }
a { color: #6a2208; text-decoration: none; }
a:hover { text-decoration: underline; }
.hatnote { font-style: italic; color: #4f412c; }
table { border-collapse: collapse; margin: 0 0 18px; font-size: 14px; line-height: 1.4; }
th, td { padding: 5px 8px; border: 1px solid #c9b791; vertical-align: top; text-align: left; }
th { background: #e4d6b3; font-weight: 600; }
.infobox { width: 100%; }
.infobox caption { font-family: "Roboto Slab"; font-size: 19px; font-weight: 600; padding: 6px 0; text-align: left; }
.data { width: 100%; }
`;
