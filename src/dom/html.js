// HTML parsing and serialization are owned by the WebAssembly core. Host
// wrappers materialize lazily; declarative shadow roots activate here because
// attaching a shadow root is a host-visible element operation.

// Templates in a parsed subtree, in tree order, each followed by the
// templates of its content: an inner declarative shadow root activates after
// the outer one has moved its host into place. The core lists them; the walk
// materializes no other wrapper.
function templatesIn(root) {
  const core = root._domCore;
  const templates = core.selectorQueryAll(root._coreHandle, "template");
  for (let index = 0; index < templates.length; index += 1) {
    const content = templates[index].content;
    if (content !== null) {
      templates.push(...core.selectorQueryAll(content._coreHandle, "template"));
    }
  }
  return templates;
}

function activateDeclarativeShadowRoots(root, fragmentHost = null) {
  for (const template of templatesIn(root)) {
    const mode = template.getAttribute("shadowrootmode");
    const host = template.parentElement ?? (
      template.parentNode === root ? fragmentHost : null
    );
    if (
      (mode !== "open" && mode !== "closed") ||
      !host ||
      host._shadowRoot ||
      host.namespaceURI !== "http://www.w3.org/1999/xhtml"
    ) continue;
    let shadowRoot;
    try {
      shadowRoot = host.attachShadow({
        mode,
        delegatesFocus: template.hasAttribute("shadowrootdelegatesfocus"),
        clonable: template.hasAttribute("shadowrootclonable"),
        slotAssignment: template.getAttribute("shadowrootslotassignment") ??
          "named",
      });
    } catch (error) {
      if (
        !(error instanceof DOMException && error.name === "NotSupportedError")
      ) {
        throw error;
      }
      continue;
    }
    while (template.content.firstChild) {
      shadowRoot.appendChild(template.content.firstChild);
    }
    template.parentNode?.removeChild(template);
  }
  return root;
}

export function parseHTMLDocument(source, documentFactory) {
  const document = documentFactory();
  document._domCore.parseHtmlDocument(document._coreHandle, String(source));
  return activateDeclarativeShadowRoots(document);
}

export function parseHTMLFragment(context, source) {
  const document = context.ownerDocument;
  if (!document) {
    throw new DOMException(
      "Fragment context has no owner document",
      "InvalidStateError",
    );
  }
  const fragment = document.createDocumentFragment();
  document._domCore.parseHtmlFragment(
    context._coreHandle,
    fragment._coreHandle,
    String(source),
  );
  return activateDeclarativeShadowRoots(fragment, context);
}

export function serializeNodeContents(node) {
  return node._domCore.string("html_serialize_children", node._coreHandle, 0);
}

export function serializeNode(node) {
  return node._domCore.string("html_serialize_node", node._coreHandle, 0);
}

// Snapshot output includes every shadow root as a declarative shadow root
// template placed before the host's light children.
export function serializeSnapshotNode(node) {
  return node._domCore.string("html_serialize_node", node._coreHandle, 1);
}
