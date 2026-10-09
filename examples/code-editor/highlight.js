// A syntax highlighter for the editor's own source, in about a hundred
// lines and with no dependency.
//
// It is a scanner, not a parser: it walks the source once and emits a span
// per token. That is all a code panel needs; a real parser would be a
// library.
//
// The edited file is JavaScript with a CSS template literal inside it, so
// the scanner has two modes. Template contents are handed to a
// line-oriented CSS pass (the sheet is authored one declaration per line,
// so lines are the right unit), and `${…}` holes fall back to the
// JavaScript scanner.
//
// The output is HTML text, so everything that came from the source is
// escaped on the way out. It is assigned to a layer *behind* a transparent
// textarea, which is why every token keeps its exact characters: the two
// layers must line up glyph for glyph, so the highlighter may never add,
// drop or reorder a single character of the source.

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "default", "delete", "do", "else", "export", "extends",
  "finally", "for", "from", "function", "if", "import", "in", "instanceof",
  "let", "new", "of", "return", "static", "super", "switch", "this", "throw",
  "try", "typeof", "var", "void", "while", "with", "yield",
]);

const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

const escapeText = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const span = (kind, text) =>
  kind === null ? escapeText(text) : `<span class="t-${kind}">${escapeText(text)}</span>`;

// The CSS pass. One line at a time: an at-rule or selector line, a
// declaration, a closing brace, or blank. Each branch splits the line into
// pieces that concatenate back to exactly the original line.
function css(source) {
  let out = "";
  for (const line of source.split("\n")) {
    const indent = line.match(/^\s*/)[0];
    const body = line.slice(indent.length);
    out += indent;
    if (body === "") {
      out += "\n";
      continue;
    }
    // A declaration: property, colon, value, optional semicolon. Matched
    // first, because a one-line rule also contains declarations.
    const declaration = body.match(/^([-\w]+)(\s*:\s*)(.*?)(;?)$/);
    const selector = body.match(/^([^{]*?)(\s*\{\s*)(.*)$/);
    if (declaration && !body.includes("{")) {
      out += span("property", declaration[1]) + span("punct", declaration[2]) +
        cssValue(declaration[3]) + span("punct", declaration[4]);
    } else if (selector) {
      out += span(
        selector[1].trimStart().startsWith("@") ? "keyword" : "selector",
        selector[1],
      ) + span("punct", selector[2]) + cssInline(selector[3]);
    } else if (body === "}" || body === "};") {
      out += span("punct", body);
    } else {
      out += escapeText(body);
    }
    out += "\n";
  }
  // split("\n") on a trailing newline yields one extra empty piece; the
  // loop already appended its newline, so drop the one it added for it.
  return out.slice(0, -1);
}

// The tail of a one-line rule: `display: block; height: 14px; }`.
function cssInline(rest) {
  let out = "";
  for (const piece of rest.split(/(;|\}|\s+)/)) {
    if (piece === undefined || piece === "") continue;
    const declaration = piece.match(/^([-\w]+)(\s*:\s*)(.*)$/);
    if (declaration) {
      out += span("property", declaration[1]) + span("punct", declaration[2]) +
        cssValue(declaration[3]);
    } else if (piece === ";" || piece === "}") {
      out += span("punct", piece);
    } else {
      out += escapeText(piece);
    }
  }
  return out;
}

// A declaration's value: colours and numbers read as values, names as
// keywords of the value grammar.
function cssValue(value) {
  let out = "";
  for (const piece of value.split(/(#[0-9a-fA-F]+|-?\d[\w.%]*|"[^"]*")/)) {
    if (piece === undefined || piece === "") continue;
    out += /^#|^-?\d|^"/.test(piece) ? span("number", piece) : span("value", piece);
  }
  return out;
}

// The JavaScript pass.
export function highlight(source) {
  let out = "";
  let index = 0;
  const text = String(source);
  while (index < text.length) {
    const rest = text.slice(index);
    const character = text[index];
    // Whitespace, kept verbatim so the layers align.
    const space = rest.match(/^\s+/);
    if (space) {
      out += escapeText(space[0]);
      index += space[0].length;
      continue;
    }
    if (rest.startsWith("//")) {
      const end = text.indexOf("\n", index);
      const comment = end === -1 ? rest : text.slice(index, end);
      out += span("comment", comment);
      index += comment.length;
      continue;
    }
    if (rest.startsWith("/*")) {
      const close = text.indexOf("*/", index + 2);
      const comment = close === -1 ? rest : text.slice(index, close + 2);
      out += span("comment", comment);
      index += comment.length;
      continue;
    }
    if (character === '"' || character === "'") {
      const string = readQuoted(text, index, character);
      out += span("string", string);
      index += string.length;
      continue;
    }
    if (character === "`") {
      const consumed = readTemplate(text, index);
      out += consumed.html;
      index += consumed.length;
      continue;
    }
    const number = rest.match(/^-?\d[\w.]*/);
    if (number) {
      out += span("number", number[0]);
      index += number[0].length;
      continue;
    }
    const word = rest.match(/^[A-Za-z_$][\w$]*/);
    if (word) {
      const name = word[0];
      const after = rest.slice(name.length).match(/^\s*\(/);
      out += span(
        KEYWORDS.has(name)
          ? "keyword"
          : LITERALS.has(name)
          ? "number"
          : after
          ? "function"
          : null,
        name,
      );
      index += name.length;
      continue;
    }
    const punctuation = rest.match(/^[^\w\s"'`]+/);
    out += span("punct", punctuation[0]);
    index += punctuation[0].length;
  }
  return out;
}

// The same highlight, one string per source line.
//
// An editor that re-highlights the whole file on every keystroke rewrites
// every node it has; one line per element means a keystroke rewrites one
// line. Splitting the highlighted HTML rather than the source keeps the
// scanner's cross-line state: a template literal or a block comment that
// runs over several lines has its span closed at the line end and reopened
// on the next, so the continuation keeps its colour.
//
// The scanner escapes every byte that came from the source, so inside this
// HTML a `<` is always the start of a tag and a newline is always literal
// text — which is what makes this split exact rather than a guess.
export function highlightLines(source) {
  const html = highlight(source);
  const lines = [];
  const open = [];
  let current = "";
  let index = 0;
  while (index < html.length) {
    if (html[index] === "<") {
      const close = html.indexOf(">", index);
      const tag = html.slice(index, close + 1);
      if (tag.startsWith("</")) open.pop();
      else open.push(tag);
      current += tag;
      index = close + 1;
      continue;
    }
    if (html[index] === "\n") {
      current += "</span>".repeat(open.length);
      lines.push(current);
      current = open.join("");
      index++;
      continue;
    }
    const tagAt = html.indexOf("<", index);
    const newlineAt = html.indexOf("\n", index);
    const stop = Math.min(
      tagAt === -1 ? html.length : tagAt,
      newlineAt === -1 ? html.length : newlineAt,
    );
    current += html.slice(index, stop);
    index = stop;
  }
  lines.push(current);
  return lines;
}

function readQuoted(text, start, quote) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) return text.slice(start, index + 1);
    index += 1;
  }
  return text.slice(start);
}

// A template literal: the backticks and the `${…}` holes are punctuation,
// the holes' contents are JavaScript, and everything between is the CSS the
// sheet is authored in.
function readTemplate(text, start) {
  let index = start + 1;
  let out = span("punct", "`");
  let chunk = "";
  const flush = () => {
    if (chunk !== "") out += `<span class="t-css">${css(chunk)}</span>`;
    chunk = "";
  };
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      chunk += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === "`") {
      flush();
      out += span("punct", "`");
      return { html: out, length: index + 1 - start };
    }
    if (character === "$" && text[index + 1] === "{") {
      flush();
      const close = text.indexOf("}", index);
      const end = close === -1 ? text.length : close;
      out += span("punct", "${") + highlight(text.slice(index + 2, end)) +
        span("punct", "}");
      index = end + 1;
      continue;
    }
    chunk += character;
    index += 1;
  }
  flush();
  return { html: out, length: index - start };
}
