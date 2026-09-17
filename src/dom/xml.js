// XML parsing and serialization are owned by the freestanding DOM core.
// This binding only creates host wrappers and marshals strings/handles.

export function parseXMLDocument(source, mimeType, documentFactory) {
  const document = documentFactory();
  document.contentType = mimeType;
  document._xmlDocument = true;
  document._domCore.parseXmlDocument(document._coreHandle, String(source));
  return document;
}

export function parseXMLFragment(context, source) {
  const document = context.ownerDocument;
  if (!document) {
    throw new DOMException(
      "Fragment context has no owner document",
      "InvalidStateError",
    );
  }
  const fragment = document.createDocumentFragment();
  document._domCore.parseXmlFragment(
    context._coreHandle,
    fragment._coreHandle,
    String(source),
  );
  return fragment;
}

export function serializeXMLNode(node) {
  return node._domCore.string("xml_serialize_node", node._coreHandle);
}

export function serializeXMLNodeContents(node) {
  return node._domCore.string("xml_serialize_children", node._coreHandle);
}
