import { parseCSSEasing } from "../dom-wasm/easing.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { createCSSNamespace, readStyleDeclarationText, requireStyleDeclarationWritable } from "./element-mutations.js";
import {
  createCSSStyleSheetClass, installComputedStyleBindings,
  installCSSRuleBindings, installCSSStyleRuleBindings,
  installCSSMediaRuleBindings, installCSSSupportsRuleBindings,
  installCSSFontFaceRuleBindings, installCSSKeyframeRuleBindings,
  installCSSKeyframesRuleBindings, installStyleDeclarationBindings, installRuleStyleDeclarationBindings,
} from "./dom-bindings.generated.js";
import {
  cssPropertyToIDLName,
  idlPropertyToCSSName,
  repeatedListValue,
  supportsStyleProperty,
} from "./style.js";
import {
  defaultFontRegistry,
  fontFamilyCssValue,
  fontFamilyKeyForCssValue,
  registerRuntimeFont,
  unregisterRuntimeFont,
  zeroAdvanceRatioFor,
} from "../font-registry.js";
import { decodeWebFont } from "../web-font.js";
import { resolveElementStyle } from "./resolve-style.js";
import { containingShadowRoot, flatTreeParent } from "./shadow.js";

const USER_AGENT_SOURCE = `
head, base, link, meta, title, style, script, template, [hidden] { display: none; }
html, body, div, main, section, article, header, footer, nav, aside, p, form,
ul, ol, h1, h2, h3, h4, h5, h6, blockquote { display: block; }
li { display: list-item; }
table { display: table; }
thead { display: table-header-group; }
tbody { display: table-row-group; }
tfoot { display: table-footer-group; }
tr { display: table-row; }
td, th { display: table-cell; }
th { font-weight: 700; text-align: center; }
span, a, b, strong, i, em, label, br { display: inline; }
address, figure, figcaption, dl, dt, dd, fieldset, legend, hr, pre,
details, summary, dialog, search { display: block; }
figure { margin: 1em 40px; }
dl { margin: 1em 0; }
dd { margin-left: 40px; }
pre { white-space: pre; margin: 1em 0; }
p, blockquote { margin: 1em 0; }
h1 { font-size: 2em; font-weight: 700; margin: 0.67em 0; }
h2 { font-size: 1.5em; font-weight: 700; margin: 0.83em 0; }
h3 { font-size: 1.17em; font-weight: 700; margin: 1em 0; }
h4 { font-weight: 700; margin: 1.33em 0; }
h5 { font-size: 0.83em; font-weight: 700; margin: 1.67em 0; }
h6 { font-size: 0.67em; font-weight: 700; margin: 2.33em 0; }
b, strong { font-weight: 700; }
i, em { font-style: italic; }
input, textarea { border: 2px inset #767676; padding: 1px 2px; background-color: #ffffff; }
textarea { overflow: auto; }
details:not([open]) > * { display: none; }
details > summary:first-of-type { display: block; }
a[href] { cursor: pointer; }
`;

function liveCollection(items, name) {
  return new Proxy(items, {
    get(target, property) {
      if (property === "item") return (index) => target[index] ?? null;
      if (property === Symbol.toStringTag) return name;
      return Reflect.get(target, property);
    },
  });
}

export function mediaMatches(text, environment) {
  return sharedDomCore.mediaMatches(text, environment);
}

export function supportsCondition(text) {
  return sharedDomCore.supportsCondition(text);
}

export const CSS = createCSSNamespace({ supportsCondition });

function activeNamedRules(rules, name, environment, output = []) {
  for (const rule of rules) {
    if (rule.name === name) output.push(rule);
    else if (rule.name === "media" && mediaMatches(rule.prelude, environment)) {
      activeNamedRules(rule.rules, name, environment, output);
    } else if (rule.name === "supports" && supportsCondition(rule.prelude)) {
      activeNamedRules(rule.rules, name, environment, output);
    }
  }
  return output;
}

export class SDStyleDeclaration {
  constructor(read, names, write = null, remove = null, priority = null) {
    this._read = read;
    this._names = names;
    this._write = write;
    this._remove = remove;
    this._priority = priority;
    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (
          typeof property === "string" &&
          !Reflect.has(target, property) &&
          (property.startsWith("--") || supportsStyleProperty(property))
        ) {
          return target.getPropertyValue(idlPropertyToCSSName(property));
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) => {
        if (
          typeof property === "string" &&
          !Reflect.has(target, property) &&
          (property.startsWith("--") || supportsStyleProperty(property))
        ) {
          target.setProperty(idlPropertyToCSSName(property), value);
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
    });
  }
}

installStyleDeclarationBindings({
  readText: readStyleDeclarationText,
  requireWritable: requireStyleDeclarationWritable,
}, SDStyleDeclaration.prototype);

function coreHandleCache(caches, core) {
  let cache = caches.get(core);
  if (!cache) caches.set(core, cache = new Map());
  return cache;
}

const computedViews = new WeakMap();
const computedViewFinalizer = new FinalizationRegistry(({ coreReference, handle }) => {
  const core = coreReference.deref();
  if (!core) return;
  const views = computedViews.get(core);
  if (!views?.get(handle)?.deref()) views?.delete(handle);
  core.status("computed_view_release", handle);
});

class ComputedStyleDeclaration extends SDStyleDeclaration {
  constructor(element, handle, refresh) {
    super(
      (name) => this._readNormalized(name),
      () => this._propertyNames(),
    );
    this._element = element;
    this._domCore = element._domCore;
    this._coreView = handle;
    this._refreshComputed = refresh;
  }
  _getLength() {
    this._refreshComputed();
    return this._domCore.status("computed_view_count", this._coreView);
  }
  _item(names, index) {
    return names[index] ?? "";
  }
  _propertyNames() {
    this._refreshComputed();
    const count = this._domCore.status("computed_view_count", this._coreView);
    return Array.from({ length: count }, (_, index) =>
      this._domCore.string("computed_view_name", this._coreView, index) ?? ""
    );
  }
  _readNormalized(name) {
    this._refreshComputed();
    return this._domCore.string(
      "computed_value_text", this._coreView, ...this._domCore.input(name),
    ) ?? "";
  }
}
installComputedStyleBindings({}, ComputedStyleDeclaration.prototype);

const rulesByHandle = new WeakMap();
const ruleFinalizer = new FinalizationRegistry(({ coreReference, handle, sheet }) => {
  const core = coreReference.deref();
  if (!core) return;
  const rules = rulesByHandle.get(core);
  if (!rules?.get(handle)?.deref()) rules?.delete(handle);
  const localRules = sheet?.deref()?._rulesByHandle;
  if (!localRules?.get(handle)?.deref()) localRules?.delete(handle);
  core.status("css_rule_release", handle);
});

class RuleStyleDeclaration extends SDStyleDeclaration {
  constructor(rule) {
    const handle = rule._coreRuleHandle;
    const core = rule._domCore;
    super(
      (name) =>
        core.string(
          "css_rule_get_property",
          handle,
          ...core.input(name),
          0,
        ) ?? "",
      () => {
        const count = core.status("css_rule_style_count", handle);
        return Array.from(
          { length: count },
          (_, index) =>
            core.string("css_rule_style_name", handle, index) ?? "",
        );
      },
      (name, value, priority) => {
        core.status(
          "css_rule_set_property",
          handle,
          ...core.input(name),
          ...core.input(value),
          ...core.input(priority),
        );
        rule._changed();
      },
      (name) => {
        const previous = core.string(
          "css_rule_remove_property",
          handle,
          ...core.input(name),
        ) ?? "";
        rule._changed();
        return previous;
      },
      (name) =>
        core.string(
          "css_rule_get_property",
          handle,
          ...core.input(name),
          1,
        ) ?? "",
    );
    this._rule = rule;
    this._domCore = core;
  }
}

installRuleStyleDeclarationBindings({}, RuleStyleDeclaration.prototype);

export class CSSRule {

  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    this._sheet = sheet;
    this._domCore = core;
    this._coreRuleHandle = handle;
    core.status("css_rule_retain", handle);
    ruleFinalizer.register(this, {
      coreReference: new WeakRef(core),
      handle,
      sheet: sheet && new WeakRef(sheet),
    });
    const reference = new WeakRef(this);
    coreHandleCache(rulesByHandle, core).set(handle, reference);
    sheet?._rulesByHandle.set(handle, reference);
  }
  _bindingParentStyleSheet() {
    if (!this._domCore.status("css_rule_sheet", this._coreRuleHandle)) {
      this._sheet?._rulesByHandle.delete(this._coreRuleHandle);
      this._sheet = null;
    }
    return this._sheet;
  }
  _bindingParentRule() {
    const parent = this._domCore.status(
      "css_rule_parent",
      this._coreRuleHandle,
    );
    return parent ? ruleObject(this.parentStyleSheet, parent, this._domCore) : null;
  }
  _changed() {
    this.parentStyleSheet?._changed();
  }
}

export class CSSStyleRule extends CSSRule {
  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    super(sheet, handle, core);
    // This remains an ordinary binding property, not a new live selector setter.
    this.selectorText = core.string("css_rule_prelude", handle) ?? "";
    this.style = new RuleStyleDeclaration(this);
  }
}

export class CSSGroupingRule extends CSSRule {
  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    super(sheet, handle, core);
    this.conditionText = core.string("css_rule_prelude", handle) ?? "";
    const count = core.status("css_rule_child_count", handle);
    this.cssRules = liveCollection(
      Array.from(
        { length: count },
        (_, index) =>
          ruleObject(
            sheet,
            core.status("css_rule_child_at", handle, index),
            core,
          ),
      ),
      "CSSRuleList",
    );
  }
}

export class CSSMediaRule extends CSSGroupingRule {
}

export class CSSSupportsRule extends CSSGroupingRule {
}

export class CSSFontFaceRule extends CSSRule {
  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    super(sheet, handle, core);
    this.style = new RuleStyleDeclaration(this);
  }
}

export class CSSKeyframeRule extends CSSStyleRule {
}

export class CSSKeyframesRule extends CSSGroupingRule {
}

const ruleBindingRuntime = {
  CSSRule,
  setKeyText(rule, text) {
    const core = rule._domCore;
    core.status("css_rule_set_key_text", rule._coreRuleHandle, ...core.input(text));
  },
};
installCSSRuleBindings(ruleBindingRuntime, CSSRule.prototype);
installCSSStyleRuleBindings(ruleBindingRuntime, CSSStyleRule.prototype);
installCSSMediaRuleBindings(ruleBindingRuntime, CSSMediaRule.prototype);
installCSSSupportsRuleBindings(ruleBindingRuntime, CSSSupportsRule.prototype);
installCSSFontFaceRuleBindings(ruleBindingRuntime, CSSFontFaceRule.prototype);
installCSSKeyframeRuleBindings(ruleBindingRuntime, CSSKeyframeRule.prototype);
installCSSKeyframesRuleBindings(ruleBindingRuntime, CSSKeyframesRule.prototype);

function ruleObject(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
  const existing = coreHandleCache(rulesByHandle, core).get(handle)?.deref();
  if (existing) return existing;
  switch (core.status("css_rule_kind", handle)) {
    case 1:
      return new CSSStyleRule(sheet, handle, core);
    case 4:
      return new CSSMediaRule(sheet, handle, core);
    case 5:
      return new CSSFontFaceRule(sheet, handle, core);
    case 7:
      return new CSSKeyframesRule(sheet, handle, core);
    case 8:
      return new CSSKeyframeRule(sheet, handle, core);
    case 12:
      return new CSSSupportsRule(sheet, handle, core);
    default:
      return new CSSRule(sheet, handle, core);
  }
}

function parseCoreStylesheet(source, { sourceURL = "about:blank" } = {}) {
  const normalizedSource = String(source);
  const sheetHandle = sharedDomCore.createStylesheet();
  sharedDomCore.parseStylesheet(sheetHandle, normalizedSource);
  try {
    return sharedDomCore.stylesheetSnapshot(
      sheetHandle,
      sourceURL,
      normalizedSource,
    );
  } finally {
    sharedDomCore.disposeStylesheet(sheetHandle);
  }
}

// A core sheet outlives its wrapper only until the wrapper is collected.
// Wrappers of binding-owned sheets (constructed, linked, user-agent) by core
// handle, held weakly: a strong entry would keep every adopting document
// alive through the sheet's adopter set. A <style> element's sheet is
// core-owned and wraps on the element.
const sheetsByHandle = new WeakMap();
const sheetFinalizer = new FinalizationRegistry(({ coreReference, handle }) => {
  const core = coreReference.deref();
  if (!core) return;
  const sheets = sheetsByHandle.get(core);
  if (!sheets?.get(handle)?.deref()) sheets?.delete(handle);
  core.disposeStylesheet(handle);
});

class CSSStyleSheetRuntime {
  constructor(
    {
      baseURL = "about:blank", ownerNode = null, coreHandle = 0,
      document = ownerNode?.ownerDocument ?? null,
      core = document?._domCore ?? sharedDomCore,
    } = {},
  ) {
    this.href = null;
    this.ownerNode = ownerNode;
    this._domCore = core;
    this._constructionDocument = document;
    this._baseURL = baseURL;
    this._adopters = new Set();
    this._rulesByHandle = new Map();
    this._snapshotRevision = -1;
    this._snapshotValue = null;
    this._cssRules = liveCollection([], "CSSRuleList");
    if (coreHandle) {
      this._coreSheetHandle = coreHandle;
    } else {
      this._coreSheetHandle = core.createStylesheet();
      coreHandleCache(sheetsByHandle, core).set(this._coreSheetHandle, new WeakRef(this));
      sheetFinalizer.register(this, { coreReference: new WeakRef(core), handle: this._coreSheetHandle });
      core.parseStylesheet(this._coreSheetHandle, "");
    }
  }
  _getDisabled() {
    return this._domCore.stylesheetDisabled(this._coreSheetHandle);
  }
  _setDisabled(value) {
    this._domCore.setStylesheetDisabled(this._coreSheetHandle, value);
  }
  _getMedia() {
    return this._domCore.stylesheetMedia(this._coreSheetHandle);
  }
  _setMedia(value) {
    this._domCore.setStylesheetMedia(this._coreSheetHandle, value);
  }
  // The core re-parses a <style> sheet from its text when the text changes;
  // the snapshot and rule objects follow the core revision.
  get _snapshot() {
    const revision = this._domCore.stylesheetRevision(this._coreSheetHandle);
    if (revision !== this._snapshotRevision) {
      this._snapshotRevision = revision;
      this._snapshotValue = this._domCore.stylesheetSnapshot(
        this._coreSheetHandle,
        this.href ?? this._baseURL,
        this._domCore.stylesheetSource(this._coreSheetHandle),
      );
      this._rebuild();
    }
    return this._snapshotValue;
  }
  _getRules() {
    this._snapshot;
    return this._cssRules;
  }
  _syncOwnerConnection() {
    const owner = this.ownerNode;
    const ownerDocument = owner?.ownerDocument;
    if (owner?.isConnected && ownerDocument) {
      this._domCore.connectStylesheet(
        this._coreSheetHandle,
        owner._coreHandle,
        ownerDocument._coreHandle,
      );
    } else {
      this._domCore.disconnectStylesheet(this._coreSheetHandle);
    }
  }
  _rebuild() {
    this._cssRules.splice(
      0,
      this._cssRules.length,
      ...this._snapshotValue.rules.map((record) =>
        ruleObject(this, record.handle)
      ),
    );
    for (const [handle, reference] of this._rulesByHandle) {
      const rule = reference.deref();
      if (!rule || !this._domCore.status("css_rule_sheet", handle)) {
        if (rule) rule._sheet = null;
        this._rulesByHandle.delete(handle);
      }
    }
  }
  _changed() {
    this._snapshot;
    for (const document of this._adopters) document._invalidateStyles();
  }
  // CSSOM mutation entry points reject malformed rule boundaries. The core
  // retains the source and all rule/declaration records for each revision.
  _setSource(source, rejectMalformed = false) {
    this._domCore.parseStylesheet(
      this._coreSheetHandle,
      source,
      rejectMalformed,
    );
    this._snapshot;
    for (const document of this._adopters) document._invalidateStyles();
  }
  _checkReplaceSource(source) {
    return this._domCore.status(
      "stylesheet_check_source",
      ...this._domCore.input(source),
    );
  }
  _replaceSyncTransport(source) {
    this._setSource(source, true);
  }
  _replaceTransport(source) {
    return Promise.resolve().then(() => {
      this.replaceSync(source);
      return this;
    });
  }
  _defaultInsertIndex(index) {
    return index === undefined ? this.cssRules.length : index;
  }
  _checkInsertIndex(index) {
    return this._domCore.status(
      "stylesheet_check_index",
      this._coreSheetHandle,
      index,
      1,
    );
  }
  _checkDeleteIndex(index) {
    return this._domCore.status(
      "stylesheet_check_index",
      this._coreSheetHandle,
      index,
      0,
    );
  }
  _insertRuleTransport(source, position) {
    const result = this._domCore.status(
      "stylesheet_insert_rule",
      this._coreSheetHandle,
      ...this._domCore.input(source),
      position,
    );
    this._changed();
    return result;
  }
  _deleteRuleTransport(index) {
    this._domCore.status(
      "stylesheet_delete_rule",
      this._coreSheetHandle,
      index,
    );
    this._changed();
  }
  _getDiagnostics() {
    return this._snapshot.diagnostics;
  }
}

export const CSSStyleSheet = createCSSStyleSheetClass({ CSSStyleSheetRuntime });

function cascadeFor(system, element, pseudoElement) {
  const core = element._domCore;
  // The core lists the sheets of every scope that can reach the element,
  // matches ordinary, shadow-scoped, and ::part rules, offers inline
  // declarations, and resolves custom properties, var() references, and
  // the CSS-wide keywords against the flat-tree parent's stored record; the
  // environment gates @media in that plan.
  core.mediaEnvironmentSet(system.environment);
  const resolve = () => {
    if (!pseudoElement) {
      return core.styleElementResolve(element._coreHandle);
    }
    // A pseudo-element inherits from its element and is not stored.
    system.resolvedFields(element);
    core.cascadeBegin();
    core.cascadeElementCollect(
      element._coreHandle,
      pseudoElement === "::before" ? 1 : pseudoElement === "::after" ? 2 : 0,
    );
    core.status("cascade_finish");
    return core.computedStyleResolve(
      element._coreHandle,
      element._coreHandle,
      false,
    );
  };
  // Font families are host state: the core lists the font-family values it
  // met without an answer, the registry keys them, and the element resolves
  // again with the answers in place.
  let result = resolve();
  let context = core.computedContext();
  while (context.pending) {
    system.answerFontFamilyRequests();
    result = resolve();
    context = core.computedContext();
  }
  // A font-family value no family matches inherits; the inherited family is
  // the fallback the failed resource diagnostic reports.
  for (const [property, value] of result.declarations) {
    if (property === "fontFamily" && system._unresolvedFamilies.has(value)) {
      system.recordFontFallback(value, context.fontFamily);
    }
  }
  return {
    authoredValues: new Map(result.declarations),
    declarations: result.declarations,
    customProperties: result.customProperties,
    context,
  };
}

// The wrapper of a core-owned <style> sheet lives on its element; binding-
// owned sheets are found by handle.
function wrapElementSheet(element, handle) {
  let sheet = element._sheetWrapper;
  if (sheet?._coreSheetHandle !== handle || sheet?._domCore !== element._domCore) {
    sheet = new CSSStyleSheet({
      baseURL: element.ownerDocument.baseURI,
      ownerNode: element,
      coreHandle: handle,
    });
    sheet._adopters.add(element.ownerDocument);
    element._sheetWrapper = sheet;
  }
  return sheet;
}

function wrapSheet(core, handle) {
  const known = sheetsByHandle.get(core)?.get(handle)?.deref();
  if (known) return known;
  const owner = core.stylesheetOwner(handle);
  if (!owner) throw new Error("Active stylesheet has no wrapper");
  return wrapElementSheet(owner, handle);
}

export function createDocumentStyleSystem(document, environment = {}) {
  const core = document._domCore;
  const userAgentSheet = new CSSStyleSheet({ baseURL: "sandom:user-agent", document });
  userAgentSheet._setSource(USER_AGENT_SOURCE);
  core.setUserAgentStylesheet(
    document._coreHandle,
    userAgentSheet._coreSheetHandle,
  );
  const ownedSheets = new Set();
  const resolved = new WeakMap();
  function resolutionFor(system, element) {
    const cached = resolved.get(element);
    if (cached?.generation === system.generation) return cached.value;
    const parent = flatTreeParent(element);
    const parentContext = parent?.nodeType === 1
      ? resolutionFor(system, parent).childContext
      : { customProperties: new Map(), inheritedFields: {} };
    const value = resolveElementStyle(
      element.style,
      parentContext,
      system.environment,
    );
    resolved.set(element, { generation: system.generation, value });
    return value;
  }
  const adopted = [];
  const linkedResources = new Map();
  function stylesheetLinkIsEligible(element) {
    const relations = (element.getAttribute("rel") ?? "").toLowerCase().split(
      /\s+/,
    );
    const type = element.getAttribute("type");
    return element.isConnected &&
      relations.includes("stylesheet") &&
      !element.disabled &&
      !element.hasAttribute("disabled") &&
      Boolean(element.getAttribute("href"));
  }

  function dispatchResourceEvent(element, type) {
    queueMicrotask(() => element.dispatchEvent(new Event(type)));
  }
  const fontResources = new Map();
  const fontPending = new Set();
  let fontsReleased = false;
  const fontRuleIDs = new WeakMap();
  let nextFontRuleID = 1;
  function publishFontResource(rule, resource, state) {
    let id = fontRuleIDs.get(rule);
    if (id === undefined) {
      id = nextFontRuleID++;
      fontRuleIDs.set(rule, id);
    }
    resource.catalogID = id;
    const registry = ensureFontRegistry();
    core.status(
      "font_catalog_availability", registry.fontCatalogHandle,
      document._coreHandle, id, ...core.input(resource.family), state,
    );
  }
  let selectedFontRegistry = null;
  let unsubscribeFontRegistry = null;
  function ensureFontRegistry() {
    const registry = document._sandomFontRegistry ?? defaultFontRegistry;
    if (registry !== selectedFontRegistry) {
      selectedFontRegistry?.unbindDocument(document);
      unsubscribeFontRegistry?.();
      selectedFontRegistry = registry;
      unsubscribeFontRegistry = registry.subscribe(fontStateChanged, { weak: true });
    }
    core.status(
      "font_catalog_activate", registry.fontCatalogHandle, document._coreHandle,
    );
    return registry;
  }

  // Native catalog changes own cache/revision consequences; this only wakes
  // the host scheduler for asynchronous loading and metric completion.
  function fontStateChanged() {
    if (!fontsReleased) {
      document._renderSurface?._broadcastMutation("font", document);
    }
  }

  function releaseFontResource(resource) {
    if (resource.catalogID !== undefined && !fontsReleased) {
      core.status(
        "font_catalog_availability", ensureFontRegistry().fontCatalogHandle,
        document._coreHandle, resource.catalogID, ...core.input(resource.family), -1,
      );
    }
    if (resource.state === "pending") {
      resource.controller.abort(
        new DOMException("Font load became obsolete", "AbortError"),
      );
    } else if (resource.state === "loaded") {
      (
        document._sandomFontRegistry?.unregisterRuntimeFont ??
          unregisterRuntimeFont
      )(resource.familyKey, resource);
    }
  }

  function absolutizeResourceURLs(source, baseURL) {
    return source.replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (whole, quote, value) => {
        const trimmed = value.trim();
        if (/^(?:data:|blob:|#)/i.test(trimmed)) return whole;
        if (trimmed.startsWith("/")) return whole;
        return `url("${new URL(trimmed, baseURL).href}")`;
      },
    );
  }

  async function resolveSheetSource(
    document,
    requestedURL,
    baseURL,
    signal,
    ancestors = [],
  ) {
    if (!document._resolveStylesheet) {
      throw new DOMException(
        `No stylesheet resolver is configured for ${requestedURL}`,
        "NetworkError",
      );
    }
    const absoluteURL = new URL(requestedURL, baseURL).href;
    if (ancestors.includes(absoluteURL)) {
      throw new DOMException(
        `Stylesheet import cycle at ${absoluteURL}`,
        "NetworkError",
      );
    }
    const response = await document._resolveStylesheet({
      requestedURL: absoluteURL,
      authoredURL: requestedURL,
      baseURL,
      kind: "stylesheet",
      document,
      signal,
    });
    if (signal.aborted) throw signal.reason;
    if (!response || typeof response.source !== "string") {
      throw new TypeError(
        "Stylesheet resolver must return { source, finalURL }",
      );
    }
    const finalURL =
      new URL(response.finalURL ?? absoluteURL, absoluteURL).href;
    const parsedSource = parseCoreStylesheet(response.source, {
      sourceURL: finalURL,
    });
    const importedSources = [];
    const importedRanges = [];
    for (const rule of parsedSource.rules) {
      if (rule.name !== "import") continue;
      const match =
        /^(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)|"([^"]*)"|'([^']*)')\s*(.*)$/i
          .exec(rule.prelude);
      if (!match) continue;
      const importedURL = match.slice(1, 6).find((value) =>
        value !== undefined
      );
      const media = match[6].trim();
      const imported = await resolveSheetSource(
        document,
        importedURL,
        finalURL,
        signal,
        [...ancestors, absoluteURL],
      );
      importedSources.push(
        media
          ? `@media ${media} { ${imported.source} }\n`
          : `${imported.source}\n`,
      );
      importedRanges.push([
        rule.location.offset,
        rule.location.endOffset,
      ]);
    }
    let localSource = response.source;
    for (
      const [start, end] of importedRanges.sort((left, right) =>
        right[0] - left[0]
      )
    ) {
      localSource = localSource.slice(0, start) + localSource.slice(end);
    }
    return {
      source: importedSources.join("") +
        absolutizeResourceURLs(localSource, finalURL),
      finalURL,
    };
  }

  const system = {
    environment: {
      viewportWidth: 1280,
      viewportHeight: 720,
      mediaType: "screen",
      colorScheme: "light",
      reducedMotion: false,
      // The default render pipeline works in an extended rgba16float
      // encoding that preserves display-p3 chroma end to end, so p3 is
      // the truthful default gamut. Dynamic range stays standard unless
      // the host declares a high-dynamic-range presentation.
      colorGamut: "p3",
      dynamicRange: "standard",
      ...environment,
    },
    get generation() {
      ensureFontRegistry();
      return core.styleGeneration(document._coreHandle);
    },
    setEnvironment(values) {
      let changed = false;
      for (const [name, value] of Object.entries(values)) {
        if (this.environment[name] === value) continue;
        this.environment[name] = value;
        changed = true;
      }
      if (changed) this.invalidate();
    },
    invalidate() {
      core.styleInvalidate(document._coreHandle);
      this.reconcileSoon();
    },
    // Owner connections and the linked-sheet/font reconcile without a
    // cascade invalidation: for mutations the core already invalidates
    // itself (attributes, scoped to the element's subtree; tree and text
    // changes, the whole cascade), so a host bump here would only widen
    // a scoped one to every element.
    reconcileSoon() {
      for (const sheet of ownedSheets) sheet._syncOwnerConnection();
      if (!this._reconcileQueued) {
        this._reconcileQueued = true;
        queueMicrotask(() => {
          this._reconcileQueued = false;
          this.reconcile();
        });
      }
    },
    // Linked stylesheets and font-face rules are functions of the tree, the
    // attributes and the active sheets, and every change to those bumps the
    // style generation - so an unchanged generation owes no re-walk. Stamped
    // BEFORE reconciling: a load completing inside bumps the generation and
    // the next frame reconciles again, which is idempotent.
    reconcile() {
      const generation = this.generation;
      if (this._reconciledGeneration === generation) return;
      this._reconciledGeneration = generation;
      this.reconcileResources();
      this.reconcileFonts();
    },
    sheetForElement(element) {
      if (!element || !["style", "link"].includes(element.localName)) {
        return null;
      }
      if (element.localName === "link") {
        return linkedResources.get(element)?.sheet ?? null;
      }
      const handle = element._domCore.elementStylesheet(element._coreHandle);
      if (!handle) return null;
      return wrapElementSheet(element, handle);
    },
    reconcileResources() {
      const connectedLinks = new Set(
        core.elementsByTagName(document._coreHandle, "link"),
      );
      for (const [element, resource] of linkedResources) {
        if (
          !connectedLinks.has(element) || !stylesheetLinkIsEligible(element)
        ) {
          resource.controller?.abort(
            new DOMException("Stylesheet load became obsolete", "AbortError"),
          );
          linkedResources.delete(element);
          element._stylesheetState = "inactive";
        }
      }
      for (const element of connectedLinks) {
        if (!stylesheetLinkIsEligible(element)) {
          element._stylesheetState = "inactive";
          continue;
        }
        const href = element.getAttribute("href");
        const unresolvedSignature = `${href}\n${document.baseURI}`;
        let requestedURL;
        try {
          requestedURL = new URL(href, document.baseURI).href;
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          if (element._stylesheetFailedHref !== unresolvedSignature) {
            element._stylesheetFailedHref = unresolvedSignature;
            element._stylesheetState = "failed";
            dispatchResourceEvent(element, "error");
          }
          continue;
        }
        element._stylesheetFailedHref = null;
        const signature = `${requestedURL}\n${document.baseURI}`;
        const previous = linkedResources.get(element);
        if (previous?.signature === signature) continue;
        previous?.controller.abort(
          new DOMException("Stylesheet load became obsolete", "AbortError"),
        );
        const controller = new AbortController();
        const resource = {
          signature,
          controller,
          state: "pending",
          sheet: null,
          error: null,
        };
        linkedResources.set(element, resource);
        element._stylesheetState = "pending";
        resource.pending = resolveSheetSource(
          document,
          href,
          document.baseURI,
          controller.signal,
        ).then(({ source, finalURL }) => {
          if (
            controller.signal.aborted ||
            linkedResources.get(element) !== resource
          ) return;
          const sheet = new CSSStyleSheet({
            baseURL: finalURL,
            ownerNode: element,
          });
          sheet.href = finalURL;
          sheet._setSource(source);
          sheet.media = element.getAttribute("media") ?? "";
          sheet._adopters.add(document);
          ownedSheets.add(sheet);
          sheet._syncOwnerConnection();
          resource.sheet = sheet;
          resource.state = "loaded";
          element._stylesheetState = "loaded";
          this.invalidate();
          dispatchResourceEvent(element, "load");
        }).catch((error) => {
          if (
            controller.signal.aborted ||
            linkedResources.get(element) !== resource
          ) return;
          resource.error = error;
          resource.state = "failed";
          element._stylesheetState = "failed";
          this.invalidate();
          dispatchResourceEvent(element, "error");
        });
      }
    },
    reconcileFonts() {
      if (fontsReleased) return;
      const activeFontRules = new Set();
      for (const { sheet } of this.activeSheets()) {
        for (
          const rule of activeNamedRules(
            sheet._snapshot.rules,
            "font-face",
            this.environment,
          )
        ) {
          activeFontRules.add(rule);
          const declarations = new Map(
            rule.declarations.map((declaration) => [
              declaration.property.toLowerCase(),
              declaration.value,
            ]),
          );
          const familySource = declarations.get("font-family");
          const family = familySource === undefined ? undefined : core.string(
            "font_family_normalize", ...core.input(familySource), 0,
          );
          const sourceDescriptor = declarations.get("src") ?? "";
          const sourceMatch = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(
            sourceDescriptor,
          );
          if (!family || !sourceMatch) continue;
          const baseURL = sheet.href ?? sheet._baseURL;
          const weight = Number.parseInt(
            declarations.get("font-weight") ?? "400",
            10,
          ) || 400;
          const style = declarations.get("font-style") ?? "normal";
          // A rule already resolved (loaded, pending or failed) is not
          // re-published: publishing bumps the style generation, and a
          // failed url() re-failed on every reconcile kept every frame of
          // the document live.
          if (fontResources.has(rule)) continue;
          let requestedURL;
          try {
            requestedURL = new URL(sourceMatch[1], baseURL).href;
          } catch (error) {
            fontResources.set(rule, {
              state: "failed",
              error,
              family,
              requestedURL: sourceMatch[1],
              finalURL: null,
              selectedFallbackKeys: new Set(),
            });
            publishFontResource(rule, fontResources.get(rule), 2);
            continue;
          }
          if (!document._resolveStylesheet) {
            fontResources.set(rule, {
              state: "failed",
              error: new DOMException(
                `No stylesheet resolver is configured for ${requestedURL}`,
                "NetworkError",
              ),
              family,
              requestedURL,
              finalURL: null,
              selectedFallbackKeys: new Set(),
            });
            publishFontResource(rule, fontResources.get(rule), 2);
            continue;
          }
          const controller = new AbortController();
          const resource = {
            state: "pending",
            controller,
            family,
            requestedURL,
            finalURL: null,
            selectedFallbackKeys: new Set(),
          };
          publishFontResource(rule, resource, 0);
          const pending = Promise.resolve(document._resolveStylesheet({
            requestedURL,
            authoredURL: sourceMatch[1],
            baseURL,
            kind: "font",
            document,
          })).then(async (response) => {
            if (
              controller.signal.aborted || fontResources.get(rule) !== resource
            ) {
              return;
            }
            const source = response?.bytes ?? response?.source;
            const bytes = source instanceof Uint8Array
              ? source
              : source instanceof ArrayBuffer
              ? new Uint8Array(source)
              : null;
            if (!bytes) {
              throw new TypeError(
                "Font resolver response must provide Uint8Array bytes",
              );
            }
            const finalURL = new URL(
              response.finalURL ?? requestedURL,
              requestedURL,
            ).href;
            const decodedBytes = await decodeWebFont(bytes);
            if (
              controller.signal.aborted || fontResources.get(rule) !== resource
            ) {
              return;
            }
            const familyKey = (
              document._sandomFontRegistry?.registerRuntimeFont ??
                registerRuntimeFont
            )(family, decodedBytes, {
              weight,
              style,
              finalURL,
              owner: resource,
            });
            Object.assign(resource, {
              state: "loaded",
              familyKey,
              finalURL,
            });
            publishFontResource(rule, resource, 1);
            fontStateChanged();
          }).catch((error) => {
            if (
              controller.signal.aborted || fontResources.get(rule) !== resource
            ) {
              return;
            }
            Object.assign(resource, { state: "failed", error });
            publishFontResource(rule, resource, 2);
            fontStateChanged();
          }).finally(() => {
            fontPending.delete(pending);
          });
          fontPending.add(pending);
          fontResources.set(rule, resource);
          pending.then(() => this.invalidate());
        }
      }
      for (const [rule, resource] of fontResources) {
        if (activeFontRules.has(rule)) continue;
        releaseFontResource(resource);
        fontResources.delete(rule);
        fontStateChanged();
      }
    },
    releaseFonts() {
      if (fontsReleased) return;
      fontsReleased = true;
      unsubscribeFontRegistry?.();
      unsubscribeFontRegistry = null;
      selectedFontRegistry?.unbindDocument(document);
      for (const resource of fontResources.values()) {
        releaseFontResource(resource);
      }
      if (fontResources.size !== 0) fontStateChanged();
      fontResources.clear();
    },
    _unresolvedFamilies: new Set(),
    answerFontFamilyRequests() {
      const registry = document._sandomFontRegistry;
      const keyFamily = registry?.fontFamilyKeyForCssValue ??
        fontFamilyKeyForCssValue;
      const ratioFor = registry?.zeroAdvanceRatioFor ?? zeroAdvanceRatioFor;
      for (const cssValue of core.fontFamilyRequests()) {
        let key = null;
        try {
          key = keyFamily(cssValue, {
            isUnavailable: (family) => this.fontFamilyIsUnavailable(family),
          });
        } catch {
          // No registered or system family matches: the value inherits.
        }
        if (key !== null) this.recordFontFallback(cssValue, key);
        if (key === null) this._unresolvedFamilies.add(cssValue);
        else this._unresolvedFamilies.delete(cssValue);
        core.setFontFamily(
          cssValue,
          key,
          key === null ? 0 : ratioFor(key),
        );
      }
    },
    fontFamilyIsUnavailable(familyName) {
      return core.status(
        "font_catalog_unavailable", ensureFontRegistry().fontCatalogHandle,
        document._coreHandle, ...core.input(String(familyName)),
      ) !== 0;
    },
    recordFontFallback(authoredFontFamily, selectedFamilyKey) {
      for (const resource of fontResources.values()) {
        if (
          resource.state === "failed" &&
          core.status(
            "font_family_list_contains", ...core.input(String(authoredFontFamily)),
            ...core.input(resource.family),
          ) !== 0
        ) {
          resource.selectedFallbackKeys.add(selectedFamilyKey);
        }
      }
    },
    get resourceDiagnostics() {
      return Object.freeze(
        [...fontResources.values()]
          .filter((resource) => resource.state === "failed")
          .map((resource) => {
            const selectedFallbacks = Object.freeze(
              [...resource.selectedFallbackKeys].map((familyKey) =>
                Object.freeze({
                  familyKey,
                  fontFamily: (
                    document._sandomFontRegistry?.fontFamilyCssValue ??
                      fontFamilyCssValue
                  )(familyKey),
                })
              ),
            );
            const fallbackMessage = selectedFallbacks.length === 0
              ? ""
              : `; using ${
                selectedFallbacks.map((fallback) => fallback.fontFamily).join(
                  " or ",
                )
              }`;
            return Object.freeze({
              code: "font-resource-unavailable",
              severity: "warning",
              recoverable: true,
              message:
                `Font resource ${resource.requestedURL} for "${resource.family}" is unavailable${fallbackMessage}: ${
                  resource.error?.message ?? String(resource.error)
                }`,
              unavailableFontFamily: resource.family,
              selectedFallbacks,
              resource: Object.freeze({
                kind: "font",
                requestedFinalURL: resource.requestedURL,
                finalURL: resource.finalURL,
              }),
              cause: Object.freeze({
                name: resource.error?.name ?? "Error",
                message: resource.error?.message ?? String(resource.error),
              }),
            });
          }),
      );
    },
    async ready() {
      this.reconcile();
      await Promise.all(
        [...linkedResources.values()]
          .map((resource) => resource.pending)
          .filter(Boolean),
      );
      const stylesheetErrors = [...linkedResources.values()]
        .filter((resource) => resource.state === "failed")
        .map((resource) => resource.error);
      if (stylesheetErrors.length > 0) {
        throw new AggregateError(
          stylesheetErrors,
          `${stylesheetErrors.length} stylesheet resource(s) failed`,
        );
      }
      // A linked sheet that just loaded may declare fonts.
      this.reconcile();
      await Promise.all([...fontPending]);
    },
    activeSheets(scopeRoot = document) {
      return core.activeStylesheets(scopeRoot._coreHandle).map((
        handle,
      ) => ({
        sheet: wrapSheet(core, handle),
        origin: handle === userAgentSheet._coreSheetHandle ? 0 : 1,
      }));
    },
    cascadedFor(element, pseudoElement = null) {
      ensureFontRegistry();
      return cascadeFor(this, element, pseudoElement);
    },
    hoverStateAffectsStyle(element) {
      element._domCore.mediaEnvironmentSet(this.environment);
      return element._domCore.cascadeStateAffects(element._coreHandle, "hover");
    },
    activeStateAffectsStyle(element) {
      element._domCore.mediaEnvironmentSet(this.environment);
      return element._domCore.cascadeStateAffects(element._coreHandle, "active");
    },
    keyframesFor(name, scopeRoot = document) {
      let matching = null;
      for (const { sheet } of this.activeSheets(scopeRoot)) {
        for (
          const rule of activeNamedRules(
            sheet._snapshot.rules,
            "keyframes",
            this.environment,
          )
        ) {
          if (rule.prelude === name) matching = rule;
        }
      }
      if (!matching) return null;
      const byOffset = new Map();
      for (const frameRule of matching.rules) {
        for (const selector of frameRule.selectorText.split(",")) {
          const normalized = selector.trim().toLowerCase();
          const offset = normalized === "from"
            ? 0
            : normalized === "to"
            ? 1
            : Number.parseFloat(normalized) / 100;
          if (!Number.isFinite(offset) || offset < 0 || offset > 1) continue;
          const frame = byOffset.get(offset) ?? { offset };
          for (const declaration of frameRule.declarations) {
            if (declaration.property === "animation-timing-function") {
              frame.easing = parseCSSEasing(declaration.value);
            } else {
              frame[cssPropertyToIDLName(declaration.property)] =
                declaration.value;
            }
          }
          byOffset.set(offset, frame);
        }
      }
      return [...byOffset.values()].sort((left, right) =>
        left.offset - right.offset
      );
    },
    animationDefinitions(element, pseudoElement = null) {
      // resolutionFor memoizes per element per generation and reuses the
      // parent's cached childContext - the same resolution serialization
      // consumes. The old inline recursion re-resolved the whole ancestor
      // chain uncached on every call, which made the per-frame
      // animation-definition scan quadratic in tree depth.
      const elementResolution = resolutionFor(this, element);
      const { fields } = pseudoElement === null
        ? elementResolution
        : resolveElementStyle(
          element.style,
          elementResolution.childContext,
          this.environment,
          pseudoElement,
        );
      const names = fields.animationName ?? ["none"];
      const compositions = fields.animationComposition ?? ["replace"];
      const durations = fields.animationDuration ?? [0];
      const delays = fields.animationDelay ?? [0];
      const timingFunctions = fields.animationTimingFunction ?? ["ease"];
      const iterationCounts = fields.animationIterationCount ?? [1];
      const directions = fields.animationDirection ?? ["normal"];
      const fillModes = fields.animationFillMode ?? ["none"];
      const playStates = fields.animationPlayState ?? ["running"];
      const timelines = fields.animationTimeline ?? ["auto"];
      const rangeStarts = fields.animationRangeStart ?? ["normal"];
      const rangeEnds = fields.animationRangeEnd ?? ["normal"];
      const scopeRoot = containingShadowRoot(element) ?? document;
      return names.flatMap((name, listIndex) => {
        if (name === "none") return [];
        const authoredKeyframes = this.keyframesFor(name, scopeRoot);
        if (!authoredKeyframes || authoredKeyframes.length < 2) return [];
        const defaultEasing = repeatedListValue(timingFunctions, listIndex);
        const keyframes = authoredKeyframes.map((frame) => ({
          ...frame,
          easing: frame.easing ?? defaultEasing,
        }));
        return [{
          name,
          listIndex,
          keyframes,
          composition: repeatedListValue(compositions, listIndex),
          timing: {
            duration: repeatedListValue(durations, listIndex),
            delay: repeatedListValue(delays, listIndex),
            easing: "linear",
            iterations: repeatedListValue(iterationCounts, listIndex),
            direction: repeatedListValue(directions, listIndex),
            fill: repeatedListValue(fillModes, listIndex),
            timeline: repeatedListValue(timelines, listIndex),
            rangeStart: repeatedListValue(rangeStarts, listIndex),
            rangeEnd: repeatedListValue(rangeEnds, listIndex),
          },
          paused: repeatedListValue(playStates, listIndex) === "paused",
        }];
      });
    },
    styleSheets() {
      return liveCollection(
        this.activeSheets().filter((entry) =>
          entry.origin === 1 && entry.sheet.ownerNode
        ).map((entry) => entry.sheet),
        "StyleSheetList",
      );
    },
    resolvedFields(element) {
      if (!element || element.nodeType !== 1) {
        throw new TypeError("resolvedFields requires an Element");
      }
      return resolutionFor(this, element).fields;
    },
    computedStyle(element, pseudoElement = null) {
      if (!element || element.nodeType !== 1) {
        throw new TypeError("getComputedStyle requires an Element");
      }
      const core = element._domCore;
      const views = coreHandleCache(computedViews, core);
      const registry = element.ownerDocument?._sandomFontRegistry ?? defaultFontRegistry;
      const handle = core.status(
        "computed_view_get", element._coreHandle,
        ...core.input(String(pseudoElement ?? "")), registry.fontCatalogHandle,
      );
      const cached = views.get(handle)?.deref();
      if (cached) {
        core.status("computed_view_release", handle);
        return cached;
      }
      const refresh = () => {
        // Resolve directly into the native field store; no scene-field decode
        // or JavaScript computed serialization is involved in readback.
        (element.ownerDocument?._styleSystem ?? this).cascadedFor(element, pseudoElement);
        const registry = element.ownerDocument?._sandomFontRegistry ?? defaultFontRegistry;
        core.status("computed_view_capture", handle, registry.fontCatalogHandle);
      };
      const declaration = new ComputedStyleDeclaration(element, handle, refresh);
      views.set(handle, new WeakRef(declaration));
      computedViewFinalizer.register(declaration, { coreReference: new WeakRef(core), handle });
      return declaration;
    },
    fontSet: {
      get status() {
        return fontPending.size ? "loading" : "loaded";
      },
      get ready() {
        return Promise.all([...fontPending]).then(() => this);
      },
      check() {
        return fontPending.size === 0;
      },
      load() {
        return this.ready.then(() => []);
      },
    },
    adopted,
  };
  userAgentSheet._adopters.add(document);
  return system;
}

export function setAdoptedStyleSheets(root, sheets) {
  const next = [...sheets];
  if (
    next.some((sheet) => !(sheet instanceof CSSStyleSheet) || sheet.ownerNode)
  ) {
    throw new DOMException(
      "Only constructible stylesheets may be adopted",
      "NotAllowedError",
    );
  }
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  for (const sheet of next) {
    if (
      sheet._domCore !== document._domCore ||
      sheet._constructionDocument &&
      sheet._constructionDocument !== document
    ) {
      throw new DOMException(
        "A constructed stylesheet cannot be adopted by a different document",
        "NotAllowedError",
      );
    }
  }
  root._domCore.setAdoptedStylesheets(
    root._coreHandle,
    next.map((sheet) => sheet._coreSheetHandle),
  );
  for (const sheet of next) sheet._constructionDocument = document;
  const adoptedSheets = root.nodeType === 9
    ? root._styleSystem.adopted
    : root._adoptedStyleSheets;
  for (const sheet of adoptedSheets) sheet._adopters.delete(root);
  adoptedSheets.splice(0, adoptedSheets.length, ...next);
  for (const sheet of next) sheet._adopters.add(root);
  document._invalidateStyles();
}

export function cssSupports(property, value) {
  if (arguments.length === 1) return supportsCondition(property);
  return supportsStyleProperty(property) && String(value).trim() !== "";
}
