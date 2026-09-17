import { installRangeBindings, installSelectionBindings } from "./dom-bindings.generated.js";
// Language wrappers for native UTF-16 Range/Selection boundaries. Native
// records retain nodes independently of these wrappers and are generation checked.
const finalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ core, handle }) => core.status("selection_release", handle))
  : null;

function requireBoundary(document, node, offset) {
  if (node === null || typeof node !== "object" || typeof node.nodeType !== "number") {
    throw new TypeError("Range boundary must be a Node");
  }
  // The owner check precedes Number(offset), including user conversion hooks.
  document._domCore.selectionStatus("selection_boundary_validate", document._coreHandle, node._coreHandle, 0);
  const normalized = Number(offset);
  document._domCore.selectionStatus("selection_boundary_validate", document._coreHandle, node._coreHandle, normalized);
  return normalized;
}

export function compareBoundaryPoints(nodeA, offsetA, nodeB, offsetB) {
  return nodeA._domCore.selectionStatus("selection_compare", nodeA._coreHandle, offsetA, nodeB._coreHandle, offsetB);
}

class SelectionRecord {
  constructor(document, kind) {
    this._document = document;
    this._core = document._domCore;
    this._handle = this._core.handle("selection_create", document._coreHandle, kind);
    finalizer?.register(this, { core: this._core, handle: this._handle }, this);
  }
  _boundaries(ordered = false) {
    return this._core.selectionBoundaries(this._handle, ordered);
  }
  _set(operation, node = null, offset = 0, other = null, otherOffset = 0) {
    return this._core.selectionStatus("selection_set", this._handle, operation, node?._coreHandle ?? 0n, offset, other?._coreHandle ?? 0n, otherOffset);
  }
  _text() {
    return this._core.selectionSpans(this._handle).map(([node, start, end]) => node.data.slice(start, end)).join("");
  }
  _release() {
    finalizer?.unregister(this);
    this._core.status("selection_release", this._handle);
  }
}

export class SDRange extends SelectionRecord {
  constructor(document) {
    if (document?.nodeType !== 9) throw new TypeError("Range requires a Document");
    super(document, 48);
  }
  _bindingStartContainer() { return this._boundaries()[0]; }
  _bindingStartOffset() { return this._boundaries()[1]; }
  _bindingEndContainer() { return this._boundaries()[2]; }
  _bindingEndOffset() { return this._boundaries()[3]; }
  _bindingCollapsed() {
    const [a, ao, b, bo] = this._boundaries();
    return a === b && ao === bo;
  }
  _bindingCommonAncestorContainer() {
    return this._core.wrapperFor(this._core.handle("selection_common_ancestor", this._handle));
  }
  _bindingSetStart(node, offset) { this._set(1, node, requireBoundary(this._document, node, offset)); }
  _bindingSetEnd(node, offset) { this._set(2, node, requireBoundary(this._document, node, offset)); }
  _bindingSetStartBefore(node) { this._set(7, node); }
  _bindingSetStartAfter(node) { this._set(8, node); }
  _bindingSetEndBefore(node) { this._set(9, node); }
  _bindingSetEndAfter(node) { this._set(10, node); }
  _bindingCollapse(toStart = false) { this._set(toStart ? 3 : 4); }
  _bindingSelectNodeContents(node) { this._set(5, node); }
  _bindingCloneRange() {
    const clone = new SDRange(this._document);
    const [a, ao, b, bo] = this._boundaries();
    try { clone._set(0, a, ao, b, bo); } catch (error) { clone._release(); throw error; }
    return clone;
  }
  _bindingToString() { return this._text(); }
}

export class SDSelection extends SelectionRecord {
  constructor(document, onChange) {
    super(document, 49);
    this._onChange = onChange;
  }
  _bindingAnchorNode() { return this._boundaries()[0]; }
  _bindingAnchorOffset() { return this._boundaries()[1]; }
  _bindingFocusNode() { return this._boundaries()[2]; }
  _bindingFocusOffset() { return this._boundaries()[3]; }
  _bindingRangeCount() { return this.anchorNode === null ? 0 : 1; }
  _bindingIsCollapsed() {
    const [a, ao, b, bo] = this._boundaries();
    return a === null || (a === b && ao === bo);
  }
  _bindingType() { return this.rangeCount === 0 ? "None" : this.isCollapsed ? "Caret" : "Range"; }
  _orderedRange() {
    const boundaries = this._boundaries(true);
    if (boundaries === null) return null;
    const range = new SDRange(this._document);
    try { range._set(0, ...boundaries); } catch (error) { range._release(); throw error; }
    return range;
  }
  _setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
    anchorOffset = requireBoundary(this._document, anchorNode, anchorOffset);
    focusOffset = requireBoundary(this._document, focusNode, focusOffset);
    const previous = this.focusNode ?? this.anchorNode;
    if (this._set(0, anchorNode, anchorOffset, focusNode, focusOffset)) {
      this._onChange(this.focusNode ?? previous);
    }
  }
  _bindingSetBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
    this._setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  }
  _bindingCollapse(node, offset = 0) {
    if (node === null) { this.removeAllRanges(); return; }
    this._setBaseAndExtent(node, offset, node, offset);
  }
  _bindingSetPosition(node, offset = 0) { this.collapse(node, offset); }
  _bindingExtend(node, offset = 0) {
    if (this.anchorNode === null) throw new DOMException("Selection has no range", "InvalidStateError");
    this._setBaseAndExtent(this.anchorNode, this.anchorOffset, node, offset);
  }
  _bindingSelectAllChildren(node) {
    requireBoundary(this._document, node, 0);
    this._setBaseAndExtent(node, 0, node, this._core.status("selection_boundary_length", node._coreHandle));
  }
  _bindingAddRange(range) {
    if (!(range instanceof SDRange) || range._document !== this._document) {
      throw new DOMException("Range belongs to another document", "WrongDocumentError");
    }
    this._setBaseAndExtent(...range._boundaries());
  }
  _bindingGetRangeAt(index) {
    if (index !== 0 || this.anchorNode === null) {
      throw new DOMException("Selection range does not exist", "IndexSizeError");
    }
    return this._orderedRange();
  }
  _bindingRemoveAllRanges() {
    const previous = this.focusNode ?? this.anchorNode;
    if (this._set(6)) this._onChange(previous);
  }
  _bindingEmpty() { this.removeAllRanges(); }
  _bindingContainsNode(node, allowPartialContainment = false) {
    return this._core.selectionStatus("selection_contains", this._handle, node._coreHandle, Boolean(allowPartialContainment)) !== 0;
  }
  _selectedSpans() {
    return this._core.selectionSpans(this._handle);
  }
  _removed(node) {
    const previous = this.focusNode ?? this.anchorNode;
    if (this._core.status("selection_removed", this._handle, node._coreHandle)) {
      this._onChange(previous);
    }
  }
  _bindingToString() { return this._text(); }
}

installRangeBindings({}, SDRange.prototype);
installSelectionBindings({}, SDSelection.prototype);
