# DOM: Node.compareDocumentPosition and the DOCUMENT_POSITION constants

Branch: `fix/01-compare-document-position`

## What was wrong

`Node.prototype.compareDocumentPosition` didn't exist, and neither did the `DOCUMENT_POSITION_*` constants. Libraries that order nodes call it as they mount: Base UI's Select, floating-ui, Radix and dnd-kit among them. A component built with them threw `TypeError: e.compareDocumentPosition is not a function`.

## What the spec says

DOM Standard §4.4, `compareDocumentPosition(other)`, returns a bitmask built from six constants on `Node` and its prototype: `DISCONNECTED` (1), `PRECEDING` (2), `FOLLOWING` (4), `CONTAINS` (8), `CONTAINED_BY` (16) and `IMPLEMENTATION_SPECIFIC` (32).

- A node compared with itself gives 0.
- A following node gives 4, and a preceding node gives 2.
- A descendant gives 20 (`CONTAINED_BY | FOLLOWING`), and an ancestor gives 10 (`CONTAINS | PRECEDING`).
- Nodes in different trees give `DISCONNECTED | IMPLEMENTATION_SPECIFIC` plus `PRECEDING` or `FOLLOWING`. The spec only asks that the order be consistent.

## What changed

`src/dom/node.js`:

- `SDNode.prototype.compareDocumentPosition(other)` builds each node's ancestor chain to its root through `parentNode`.
  - In the same tree, it finds the first ancestors that differ and walks siblings to order them.
  - In different trees, it orders the two **roots** by core handle. Every node of one tree then sits on the same side of every node of the other. Chrome compares the two nodes' own addresses, which the spec also allows, but here the nodes' own handles aren't transitive: comparing them gave 18 ordering cycles in a check where a child was created before the root it was appended to.
  - Nodes from two different DOM core instances are ordered by a per-core number, assigned on first use, so that pair is consistent too.
  - A non-node argument throws the same `TypeError` that `contains` throws, through `ensureNode`.
- The six constants are defined on `Node` and `Node.prototype` after `installNodeBindings`. They're enumerable and read-only, like WebIDL constants.

`contains` and the rest of `Node`'s methods come from `dom-bindings.generated.js`, which is generated from `src/dom-wasm/dom-interfaces.json` by `tools/generate-dom-interfaces.js`. Neither the generator nor the interface list is in this repository, so the method lives in `node.js`, next to `_transportContains`. If you'd rather keep `Node`'s surface in the IDL, the same algorithm can become a `_transportCompareDocumentPosition` binding, the way `contains` is.

## How it was verified

The repo has no test suite for `src/dom` (the maintained Chrome-comparison tests aren't published), so this was checked with a standalone Deno repro that uses `renderComponent`:

```js
container.innerHTML = "<ul><li id=a>a</li><li id=b><span id=c>c</span></li></ul>";
a.compareDocumentPosition(a)        // 0
a.compareDocumentPosition(b)        // 4
b.compareDocumentPosition(a)        // 2
b.compareDocumentPosition(c)        // 20
c.compareDocumentPosition(b)        // 10
a.compareDocumentPosition(c)        // 4
document.compareDocumentPosition(a) // 20
a.compareDocumentPosition(detached) & 0x21                 // 0x21
(a.compareDocumentPosition(detached) & 6) ^
  (detached.compareDocumentPosition(a) & 6)              // 6: consistent
Node.DOCUMENT_POSITION_FOLLOWING                           // 4
```

- Before: 11 failed (`a.compareDocumentPosition is not a function`).
- After: all 11 pass.
- A transitivity check over several detached trees, whose roots were created after their children, gave no ordering cycles.
- Two nodes from separate `DomCore` instances give 37 one way and 35 the other.
- Unrelated repros for other session, layout and event issues give the same results as before.
