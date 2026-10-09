const SNAPSHOT_KIND = "document-html-snapshot";
const METRICS_KIND = "document-layer-metrics";
// Version 2 (2026-08-24): layout worlds are per (root, logical viewport);
// the artifact viewport is CSS pixels only. deviceScale left the shape —
// layout facts are density-invariant, density belongs to raster surfaces.
const ARTIFACT_VERSION = 2;
const PAINT_OPERATION_KINDS = new Set([
  "rectangle",
  "text",
  "text-shadow",
  "image",
  "svg-path",
  "box-shadow",
]);

// Producer-owned field classification:
// - snapshot capture metadata: instance, revision, html;
// - snapshot identity: rootIdentifier, identifier, sceneIndex,
//   parentIdentifier, childIdentifiers;
// - metrics capture metadata: sizingSource, worldKey;
// - metrics identity: nodeIdentifiers, includedNodeIdentifiers,
//   nodeIdentifier, childIdentifiers, nodeIndex, operationIndex, commandIndex,
//   identifier, startCommandIndex, endCommandIndex, startOperationIndex,
//   endOperationIndex;
// - content: every other field admitted by the exact-shape validators below.
// A producer field addition therefore fails validation until this module
// classifies and compares it deliberately.

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, path) {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
}

function requireExactFields(value, expectedFields, path) {
  requireRecord(value, path);
  const actualFields = Object.keys(value);
  for (const field of expectedFields) {
    if (!Object.hasOwn(value, field)) {
      throw new TypeError(`${path}.${field} is required.`);
    }
  }
  for (const field of actualFields) {
    if (!expectedFields.includes(field)) {
      throw new TypeError(`${path}.${field} is not a supported field.`);
    }
  }
}

function requireString(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be ${nullable ? "a string or null" : "a string"}.`);
  }
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean.`);
  }
}

function requireFiniteNumber(value, path, { positive = false } = {}) {
  if (!Number.isFinite(value) || (positive && !(value > 0))) {
    throw new TypeError(
      `${path} must be a ${positive ? "positive " : ""}finite number.`,
    );
  }
}

function requireNonnegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a nonnegative integer.`);
  }
}

function requireArray(value, path) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
}

function requireStringArray(value, path) {
  requireArray(value, path);
  value.forEach((item, index) => requireString(item, `${path}[${index}]`));
}

function requireUniqueStrings(value, path) {
  requireStringArray(value, path);
  const seen = new Set();
  for (const item of value) {
    if (seen.has(item)) {
      throw new TypeError(`${path} contains the repeated value ${JSON.stringify(item)}.`);
    }
    seen.add(item);
  }
}

function requireRectangle(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return;
  requireExactFields(value, ["x", "y", "width", "height"], path);
  for (const field of ["x", "y", "width", "height"]) {
    requireFiniteNumber(value[field], `${path}.${field}`);
  }
}

function requireNumberArray(value, path, requiredLength = null) {
  requireArray(value, path);
  if (requiredLength !== null && value.length !== requiredLength) {
    throw new TypeError(`${path} must contain exactly ${requiredLength} numbers.`);
  }
  value.forEach((item, index) =>
    requireFiniteNumber(item, `${path}[${index}]`)
  );
}

function requireAffine(value, path) {
  if (value === null) return;
  requireNumberArray(value, path, 6);
}


function traverseTree(rootIdentifiers, nodeByIdentifier, childField, pathPrefix) {
  const pathByIdentifier = new Map();
  const visiting = new Set();
  const visited = new Set();
  const parentByIdentifier = new Map();

  const visit = (identifier, nodePath) => {
    if (visiting.has(identifier)) {
      throw new TypeError(`${pathPrefix} contains a cycle at ${JSON.stringify(identifier)}.`);
    }
    if (visited.has(identifier)) return;
    const node = nodeByIdentifier.get(identifier);
    if (!node) {
      throw new TypeError(`${pathPrefix} contains the missing node ${JSON.stringify(identifier)}.`);
    }
    visiting.add(identifier);
    pathByIdentifier.set(identifier, nodePath);
    node[childField].forEach((childIdentifier, childIndex) => {
      if (!nodeByIdentifier.has(childIdentifier)) {
        throw new TypeError(
          `${pathPrefix} node ${JSON.stringify(identifier)} contains the missing child ${JSON.stringify(childIdentifier)}.`,
        );
      }
      if (parentByIdentifier.has(childIdentifier)) {
        throw new TypeError(
          `${pathPrefix} contains the repeated child ${JSON.stringify(childIdentifier)}.`,
        );
      }
      parentByIdentifier.set(childIdentifier, identifier);
      visit(childIdentifier, [...nodePath, childIndex]);
    });
    visiting.delete(identifier);
    visited.add(identifier);
  };

  rootIdentifiers.forEach((identifier, rootIndex) => {
    if (!nodeByIdentifier.has(identifier)) {
      throw new TypeError(`${pathPrefix} contains the missing root ${JSON.stringify(identifier)}.`);
    }
    if (!visited.has(identifier)) {
      visit(identifier, rootIdentifiers.length === 1 ? [] : [rootIndex]);
    }
  });
  if (visited.size !== nodeByIdentifier.size) {
    const unreachableIdentifier = [...nodeByIdentifier.keys()].find((identifier) =>
      !visited.has(identifier)
    );
    throw new TypeError(
      `${pathPrefix} contains the unreachable node ${JSON.stringify(unreachableIdentifier)}.`,
    );
  }
  return { pathByIdentifier, parentByIdentifier };
}

function validateDocumentSnapshot(artifact, label) {
  requireExactFields(
    artifact,
    ["kind", "version", "instance", "revision", "rootIdentifier", "html", "nodes"],
    label,
  );
  if (artifact.kind !== SNAPSHOT_KIND) {
    throw new TypeError(`${label}.kind must be ${JSON.stringify(SNAPSHOT_KIND)}.`);
  }
  if (artifact.version !== ARTIFACT_VERSION) {
    throw new RangeError(`${label}.version must be ${ARTIFACT_VERSION}.`);
  }
  requireString(artifact.instance, `${label}.instance`);
  requireNonnegativeInteger(artifact.revision, `${label}.revision`);
  requireString(artifact.rootIdentifier, `${label}.rootIdentifier`);
  requireString(artifact.html, `${label}.html`);
  requireArray(artifact.nodes, `${label}.nodes`);
  if (artifact.nodes.length === 0) {
    throw new TypeError(`${label}.nodes must contain the root node.`);
  }

  const nodeByIdentifier = new Map();
  const sceneIndices = new Set();
  artifact.nodes.forEach((node, index) => {
    const nodePath = `${label}.nodes[${index}]`;
    requireExactFields(
      node,
      ["identifier", "sceneIndex", "parentIdentifier", "childIdentifiers", "source"],
      nodePath,
    );
    requireString(node.identifier, `${nodePath}.identifier`);
    if (nodeByIdentifier.has(node.identifier)) {
      throw new TypeError(`${label}.nodes contains the repeated identifier ${JSON.stringify(node.identifier)}.`);
    }
    nodeByIdentifier.set(node.identifier, node);
    requireNonnegativeInteger(node.sceneIndex, `${nodePath}.sceneIndex`);
    if (sceneIndices.has(node.sceneIndex)) {
      throw new TypeError(`${label}.nodes contains the repeated sceneIndex ${node.sceneIndex}.`);
    }
    sceneIndices.add(node.sceneIndex);
    requireString(node.parentIdentifier, `${nodePath}.parentIdentifier`, {
      nullable: true,
    });
    requireUniqueStrings(node.childIdentifiers, `${nodePath}.childIdentifiers`);
    const sourcePath = `${nodePath}.source`;
    requireRecord(node.source, sourcePath);
    requireString(node.source.kind, `${sourcePath}.kind`);
    if (node.source.kind === "element") {
      requireExactFields(
        node.source,
        ["kind", "localName", "namespace", "attributes"],
        sourcePath,
      );
      requireString(node.source.localName, `${sourcePath}.localName`);
      requireString(node.source.namespace, `${sourcePath}.namespace`, {
        nullable: true,
      });
      requireArray(node.source.attributes, `${sourcePath}.attributes`);
      node.source.attributes.forEach((attribute, attributeIndex) => {
        const attributePath =
          `${sourcePath}.attributes[${attributeIndex}]`;
        requireExactFields(
          attribute,
          ["name", "value", "namespace", "prefix"],
          attributePath,
        );
        requireString(attribute.name, `${attributePath}.name`);
        requireString(attribute.value, `${attributePath}.value`);
        requireString(attribute.namespace, `${attributePath}.namespace`, {
          nullable: true,
        });
        requireString(attribute.prefix, `${attributePath}.prefix`, {
          nullable: true,
        });
      });
    } else if (node.source.kind === "text") {
      requireExactFields(node.source, ["kind", "text"], sourcePath);
      requireString(node.source.text, `${sourcePath}.text`);
    } else if (
      node.source.kind === "viewport" ||
      node.source.kind === "generated"
    ) {
      requireExactFields(
        node.source,
        ["kind", "generated", "display"],
        sourcePath,
      );
      requireBoolean(node.source.generated, `${sourcePath}.generated`);
      if (node.source.generated !== (node.source.kind === "generated")) {
        throw new TypeError(
          `${sourcePath}.generated is inconsistent with ${sourcePath}.kind.`,
        );
      }
      requireString(node.source.display, `${sourcePath}.display`);
    } else {
      throw new TypeError(
        `${sourcePath}.kind is unsupported: ${JSON.stringify(node.source.kind)}.`,
      );
    }
  });

  const root = nodeByIdentifier.get(artifact.rootIdentifier);
  if (!root) {
    throw new TypeError(`${label}.rootIdentifier does not resolve to a node.`);
  }
  if (root.parentIdentifier !== null) {
    throw new TypeError(`${label} root node must have a null parentIdentifier.`);
  }
  const tree = traverseTree(
    [artifact.rootIdentifier],
    nodeByIdentifier,
    "childIdentifiers",
    `${label}.nodes`,
  );
  for (const node of artifact.nodes) {
    const expectedParent = tree.parentByIdentifier.get(node.identifier) ?? null;
    if (node.parentIdentifier !== expectedParent) {
      throw new TypeError(
        `${label} node ${JSON.stringify(node.identifier)} has an inconsistent parentIdentifier.`,
      );
    }
  }
  return { artifact, nodeByIdentifier, pathByIdentifier: tree.pathByIdentifier };
}

function validateTextChunk(chunk, path) {
  requireExactFields(
    chunk,
    [
      "nodeIdentifier",
      "operationIndex",
      "text",
      "fontSize",
      "lineHeight",
      "ascent",
      "descent",
      "baseline",
      "glyphAdvances",
    ],
    path,
  );
  requireString(chunk.nodeIdentifier, `${path}.nodeIdentifier`);
  requireNonnegativeInteger(chunk.operationIndex, `${path}.operationIndex`);
  requireString(chunk.text, `${path}.text`);
  for (const field of ["fontSize", "lineHeight", "ascent", "descent"]) {
    requireFiniteNumber(chunk[field], `${path}.${field}`);
  }
  requireExactFields(chunk.baseline, ["x", "y"], `${path}.baseline`);
  requireFiniteNumber(chunk.baseline.x, `${path}.baseline.x`);
  requireFiniteNumber(chunk.baseline.y, `${path}.baseline.y`);
  requireNumberArray(chunk.glyphAdvances, `${path}.glyphAdvances`);
}


function validatePaintOperation(operation, path) {
  const commonFields = [
    "operationIndex",
    "commandIndex",
    "kind",
    "nodeIndex",
    "logicalRectangle",
    "affine",
    "clipEntries",
    "opacity",
    "blendMode",
    "compositingGroupIdentifiers",
    "stackingContextIdentifiers",
    "nodeIdentifier",
  ];
  const textFields = [
    "text",
    "fontSize",
    "lineHeight",
    "ascent",
    "descent",
    "baseline",
    "glyphCount",
    "glyphAdvances",
    "glyphs",
  ];
  requireRecord(operation, path);
  requireString(operation.kind, `${path}.kind`);
  if (!PAINT_OPERATION_KINDS.has(operation.kind)) {
    throw new TypeError(
      `${path}.kind is unsupported: ${JSON.stringify(operation.kind)}.`,
    );
  }
  const isText = operation.kind === "text" || operation.kind === "text-shadow";
  requireExactFields(operation, isText ? [...commonFields, ...textFields] : commonFields, path);
  requireNonnegativeInteger(operation.operationIndex, `${path}.operationIndex`);
  requireNonnegativeInteger(operation.commandIndex, `${path}.commandIndex`);
  requireNonnegativeInteger(operation.nodeIndex, `${path}.nodeIndex`);
  requireString(operation.nodeIdentifier, `${path}.nodeIdentifier`);
  requireRectangle(operation.logicalRectangle, `${path}.logicalRectangle`);
  requireAffine(operation.affine, `${path}.affine`);
  requireArray(operation.clipEntries, `${path}.clipEntries`);
  operation.clipEntries.forEach((entry, index) => {
    const entryPath = `${path}.clipEntries[${index}]`;
    requireExactFields(
      entry,
      ["flags", "x", "y", "width", "height", "radii", "affine", "pathMask"],
      entryPath,
    );
    requireNonnegativeInteger(entry.flags, `${entryPath}.flags`);
    for (const field of ["x", "y", "width", "height"]) {
      requireFiniteNumber(entry[field], `${entryPath}.${field}`);
    }
    requireNumberArray(entry.radii, `${entryPath}.radii`, 8);
    requireAffine(entry.affine, `${entryPath}.affine`);
    requireBoolean(entry.pathMask, `${entryPath}.pathMask`);
  });
  requireFiniteNumber(operation.opacity, `${path}.opacity`);
  requireString(operation.blendMode, `${path}.blendMode`);
  requireUniqueStrings(
    operation.compositingGroupIdentifiers,
    `${path}.compositingGroupIdentifiers`,
  );
  requireUniqueStrings(
    operation.stackingContextIdentifiers,
    `${path}.stackingContextIdentifiers`,
  );
  if (isText) {
    requireString(operation.text, `${path}.text`);
    for (const field of ["fontSize", "lineHeight", "ascent", "descent"]) {
      requireFiniteNumber(operation[field], `${path}.${field}`);
    }
    requireExactFields(operation.baseline, ["x", "y"], `${path}.baseline`);
    requireFiniteNumber(operation.baseline.x, `${path}.baseline.x`);
    requireFiniteNumber(operation.baseline.y, `${path}.baseline.y`);
    requireNumberArray(operation.glyphAdvances, `${path}.glyphAdvances`);
    requireArray(operation.glyphs, `${path}.glyphs`);
    requireNonnegativeInteger(operation.glyphCount, `${path}.glyphCount`);
    if (operation.glyphCount !== operation.glyphs.length) {
      throw new TypeError(
        `${path}.glyphCount does not match ${path}.glyphs.length.`,
      );
    }
    operation.glyphs.forEach((glyph, glyphIndex) => {
      const glyphPath = `${path}.glyphs[${glyphIndex}]`;
      requireExactFields(
        glyph,
        ["x", "width", "sourceStart", "sourceEnd", "rtl"],
        glyphPath,
      );
      requireFiniteNumber(glyph.x, `${glyphPath}.x`);
      requireFiniteNumber(glyph.width, `${glyphPath}.width`);
      requireNonnegativeInteger(glyph.sourceStart, `${glyphPath}.sourceStart`);
      requireNonnegativeInteger(glyph.sourceEnd, `${glyphPath}.sourceEnd`);
      requireBoolean(glyph.rtl, `${glyphPath}.rtl`);
      if (glyph.sourceEnd < glyph.sourceStart) {
        throw new TypeError(
          `${glyphPath}.sourceEnd must not precede ${glyphPath}.sourceStart.`,
        );
      }
    });
  }
}


function valuesExactlyEqual(baseline, current) {
  if (Object.is(baseline, current)) return true;
  if (Array.isArray(baseline) && Array.isArray(current)) {
    return baseline.length === current.length &&
      baseline.every((value, index) => valuesExactlyEqual(value, current[index]));
  }
  if (isRecord(baseline) && isRecord(current)) {
    const baselineFields = Object.keys(baseline);
    const currentFields = Object.keys(current);
    return baselineFields.length === currentFields.length &&
      baselineFields.every((field) =>
        Object.hasOwn(current, field) &&
        valuesExactlyEqual(baseline[field], current[field])
      );
  }
  return false;
}

function validateLayerMetrics(artifact, label) {
  requireExactFields(
    artifact,
    [
      "kind",
      "version",
      "sizingSource",
      "worldKey",
      "viewport",
      "nodeIdentifiers",
      "includedNodeIdentifiers",
      "layoutRectangles",
      "nodes",
      "textChunks",
      "paintOperations",
      "compositingGroups",
    ],
    label,
  );
  if (artifact.kind !== METRICS_KIND) {
    throw new TypeError(`${label}.kind must be ${JSON.stringify(METRICS_KIND)}.`);
  }
  if (artifact.version !== ARTIFACT_VERSION) {
    throw new RangeError(`${label}.version must be ${ARTIFACT_VERSION}.`);
  }
  requireString(artifact.sizingSource, `${label}.sizingSource`);
  requireString(artifact.worldKey, `${label}.worldKey`);
  requireExactFields(artifact.viewport, ["width", "height"], `${label}.viewport`);
  for (const field of ["width", "height"]) {
    requireFiniteNumber(artifact.viewport[field], `${label}.viewport.${field}`, {
      positive: true,
    });
  }
  requireUniqueStrings(artifact.nodeIdentifiers, `${label}.nodeIdentifiers`);
  if (artifact.nodeIdentifiers.length === 0) {
    throw new TypeError(`${label}.nodeIdentifiers must contain at least one root.`);
  }
  requireUniqueStrings(
    artifact.includedNodeIdentifiers,
    `${label}.includedNodeIdentifiers`,
  );
  requireArray(artifact.nodes, `${label}.nodes`);

  const nodeByIdentifier = new Map();
  artifact.nodes.forEach((node, index) => {
    const nodePath = `${label}.nodes[${index}]`;
    requireExactFields(
      node,
      ["nodeIdentifier", "childIdentifiers", "rectangle", "textChunks", "paintOperations"],
      nodePath,
    );
    requireString(node.nodeIdentifier, `${nodePath}.nodeIdentifier`);
    if (nodeByIdentifier.has(node.nodeIdentifier)) {
      throw new TypeError(`${label}.nodes contains the repeated identifier ${JSON.stringify(node.nodeIdentifier)}.`);
    }
    nodeByIdentifier.set(node.nodeIdentifier, node);
    requireUniqueStrings(node.childIdentifiers, `${nodePath}.childIdentifiers`);
    requireRectangle(node.rectangle, `${nodePath}.rectangle`, { nullable: true });
    requireArray(node.textChunks, `${nodePath}.textChunks`);
    node.textChunks.forEach((chunk, chunkIndex) =>
      validateTextChunk(chunk, `${nodePath}.textChunks[${chunkIndex}]`)
    );
    requireArray(node.paintOperations, `${nodePath}.paintOperations`);
    node.paintOperations.forEach((operation, operationIndex) =>
      validatePaintOperation(operation, `${nodePath}.paintOperations[${operationIndex}]`)
    );
  });

  if (nodeByIdentifier.size !== artifact.includedNodeIdentifiers.length) {
    throw new TypeError(`${label}.includedNodeIdentifiers must identify every node exactly once.`);
  }
  for (const identifier of artifact.includedNodeIdentifiers) {
    if (!nodeByIdentifier.has(identifier)) {
      throw new TypeError(`${label}.includedNodeIdentifiers contains an unknown node.`);
    }
  }
  const tree = traverseTree(
    artifact.nodeIdentifiers,
    nodeByIdentifier,
    "childIdentifiers",
    `${label}.nodes`,
  );

  requireArray(artifact.layoutRectangles, `${label}.layoutRectangles`);
  const layoutNodeIdentifiers = new Set();
  artifact.layoutRectangles.forEach((record, index) => {
    const recordPath = `${label}.layoutRectangles[${index}]`;
    requireExactFields(record, ["nodeIdentifier", "borderBox", "textChunks"], recordPath);
    requireString(record.nodeIdentifier, `${recordPath}.nodeIdentifier`);
    if (!nodeByIdentifier.has(record.nodeIdentifier)) {
      throw new TypeError(`${recordPath}.nodeIdentifier does not resolve to a node.`);
    }
    if (layoutNodeIdentifiers.has(record.nodeIdentifier)) {
      throw new TypeError(`${label}.layoutRectangles contains a repeated node.`);
    }
    layoutNodeIdentifiers.add(record.nodeIdentifier);
    requireRectangle(record.borderBox, `${recordPath}.borderBox`, {
      nullable: true,
    });
    requireArray(record.textChunks, `${recordPath}.textChunks`);
  });

  requireArray(artifact.paintOperations, `${label}.paintOperations`);
  const operationIndices = new Set();
  artifact.paintOperations.forEach((operation, index) => {
    validatePaintOperation(operation, `${label}.paintOperations[${index}]`);
    if (!nodeByIdentifier.has(operation.nodeIdentifier)) {
      throw new TypeError(`${label}.paintOperations[${index}].nodeIdentifier does not resolve to a node.`);
    }
    if (operationIndices.has(operation.operationIndex)) {
      throw new TypeError(`${label}.paintOperations contains a repeated operationIndex.`);
    }
    operationIndices.add(operation.operationIndex);
  });

  requireArray(artifact.textChunks, `${label}.textChunks`);
  artifact.textChunks.forEach((chunk, index) => {
    validateTextChunk(chunk, `${label}.textChunks[${index}]`);
    if (!nodeByIdentifier.has(chunk.nodeIdentifier)) {
      throw new TypeError(`${label}.textChunks[${index}].nodeIdentifier does not resolve to a node.`);
    }
    if (!operationIndices.has(chunk.operationIndex)) {
      throw new TypeError(`${label}.textChunks[${index}].operationIndex does not resolve to an operation.`);
    }
  });

  requireArray(artifact.compositingGroups, `${label}.compositingGroups`);
  const groupIdentifiers = new Set();
  artifact.compositingGroups.forEach((group, index) => {
    const groupPath = `${label}.compositingGroups[${index}]`;
    const requiredFields = [
      "identifier",
      "kind",
      "nodeIndex",
      "startCommandIndex",
      "endCommandIndex",
      "startOperationIndex",
      "endOperationIndex",
      "stackingContext",
      "nodeIdentifier",
    ];
    requireRecord(group, groupPath);
    requireString(group.kind, `${groupPath}.kind`);
    let groupContentFields;
    if (group.kind === "opacity") {
      groupContentFields = ["opacity", "blendMode"];
    } else if (group.kind === "blend-layer") {
      groupContentFields = ["blendMode"];
    } else if (
      group.kind === "backdrop-filter" ||
      group.kind === "mask-layer" ||
      group.kind === "background"
    ) {
      groupContentFields = [];
    } else {
      throw new TypeError(
        `${groupPath}.kind is unsupported: ${JSON.stringify(group.kind)}.`,
      );
    }
    requireExactFields(
      group,
      [...requiredFields, ...groupContentFields],
      groupPath,
    );
    requireString(group.identifier, `${groupPath}.identifier`);
    if (group.nodeIndex !== null) {
      requireNonnegativeInteger(group.nodeIndex, `${groupPath}.nodeIndex`);
    }
    requireNonnegativeInteger(
      group.startCommandIndex,
      `${groupPath}.startCommandIndex`,
    );
    requireNonnegativeInteger(
      group.endCommandIndex,
      `${groupPath}.endCommandIndex`,
    );
    requireNonnegativeInteger(
      group.startOperationIndex,
      `${groupPath}.startOperationIndex`,
    );
    if (
      !Number.isInteger(group.endOperationIndex) ||
      group.endOperationIndex < -1
    ) {
      throw new TypeError(
        `${groupPath}.endOperationIndex must be an integer of at least -1.`,
      );
    }
    requireBoolean(group.stackingContext, `${groupPath}.stackingContext`);
    requireString(group.nodeIdentifier, `${groupPath}.nodeIdentifier`, {
      nullable: true,
    });
    if ((group.nodeIndex === null) !== (group.nodeIdentifier === null)) {
      throw new TypeError(`${groupPath} has inconsistent node identity fields.`);
    }
    if (Object.hasOwn(group, "opacity")) {
      requireFiniteNumber(group.opacity, `${groupPath}.opacity`);
    }
    if (Object.hasOwn(group, "blendMode")) {
      requireString(group.blendMode, `${groupPath}.blendMode`);
    }
    const expectedStackingContext = group.kind === "opacity" ||
      group.kind === "backdrop-filter";
    if (group.stackingContext !== expectedStackingContext) {
      throw new TypeError(
        `${groupPath}.stackingContext is inconsistent with ${groupPath}.kind.`,
      );
    }
    if (groupIdentifiers.has(group.identifier)) {
      throw new TypeError(`${label}.compositingGroups contains a repeated identifier.`);
    }
    groupIdentifiers.add(group.identifier);
    if (group.nodeIdentifier !== null && !nodeByIdentifier.has(group.nodeIdentifier)) {
      throw new TypeError(`${label}.compositingGroups[${index}].nodeIdentifier does not resolve to a node.`);
    }
  });
  artifact.paintOperations.forEach((operation, operationPosition) => {
    for (
      const [field, identifiers] of [
        ["compositingGroupIdentifiers", operation.compositingGroupIdentifiers],
        ["stackingContextIdentifiers", operation.stackingContextIdentifiers],
      ]
    ) {
      for (const identifier of identifiers) {
        if (!groupIdentifiers.has(identifier)) {
          throw new TypeError(
            `${label}.paintOperations[${operationPosition}].${field} contains an unknown group.`,
          );
        }
      }
    }
  });

  const layoutRectangleByIdentifier = new Map(
    artifact.layoutRectangles.map((record) => [record.nodeIdentifier, record.borderBox]),
  );
  for (const node of artifact.nodes) {
    const expectedRectangle = layoutRectangleByIdentifier.get(node.nodeIdentifier) ?? null;
    if (!valuesExactlyEqual(node.rectangle, expectedRectangle)) {
      throw new TypeError(
        `${label} node ${JSON.stringify(node.nodeIdentifier)} has an inconsistent rectangle.`,
      );
    }
    const expectedTextChunks = artifact.textChunks.filter((chunk) =>
      chunk.nodeIdentifier === node.nodeIdentifier
    );
    if (!valuesExactlyEqual(node.textChunks, expectedTextChunks)) {
      throw new TypeError(
        `${label} node ${JSON.stringify(node.nodeIdentifier)} has inconsistent textChunks.`,
      );
    }
    const expectedPaintOperations = artifact.paintOperations.filter((operation) =>
      operation.nodeIdentifier === node.nodeIdentifier
    );
    if (!valuesExactlyEqual(node.paintOperations, expectedPaintOperations)) {
      throw new TypeError(
        `${label} node ${JSON.stringify(node.nodeIdentifier)} has inconsistent paintOperations.`,
      );
    }
  }

  return {
    artifact,
    nodeByIdentifier,
    pathByIdentifier: tree.pathByIdentifier,
  };
}


function longestCommonSubsequence(
  baselineValues,
  currentValues,
  baselineKey,
  currentKey = baselineKey,
) {
  const rowCount = baselineValues.length + 1;
  const columnCount = currentValues.length + 1;
  const lengths = Array.from(
    { length: rowCount },
    () => new Uint32Array(columnCount),
  );
  for (let baselineIndex = baselineValues.length - 1; baselineIndex >= 0; baselineIndex--) {
    for (let currentIndex = currentValues.length - 1; currentIndex >= 0; currentIndex--) {
      lengths[baselineIndex][currentIndex] =
        baselineKey(baselineValues[baselineIndex]) ===
            currentKey(currentValues[currentIndex])
          ? lengths[baselineIndex + 1][currentIndex + 1] + 1
          : Math.max(
            lengths[baselineIndex + 1][currentIndex],
            lengths[baselineIndex][currentIndex + 1],
          );
    }
  }

  const alignment = [];
  let baselineIndex = 0;
  let currentIndex = 0;
  while (
    baselineIndex < baselineValues.length ||
    currentIndex < currentValues.length
  ) {
    if (
      baselineIndex < baselineValues.length &&
      currentIndex < currentValues.length &&
      baselineKey(baselineValues[baselineIndex]) ===
        currentKey(currentValues[currentIndex])
    ) {
      alignment.push({ baselineIndex, currentIndex });
      baselineIndex++;
      currentIndex++;
    } else if (
      currentIndex < currentValues.length &&
      (baselineIndex === baselineValues.length ||
        lengths[baselineIndex][currentIndex + 1] >=
          lengths[baselineIndex + 1][currentIndex])
    ) {
      alignment.push({ baselineIndex: null, currentIndex });
      currentIndex++;
    } else {
      alignment.push({ baselineIndex, currentIndex: null });
      baselineIndex++;
    }
  }
  return alignment;
}

function makeChange(
  change,
  baseline,
  current,
  baselineNodePath,
  currentNodePath,
  fieldPath,
  baselineIdentifier,
  currentIdentifier,
) {
  return {
    change,
    nodePath: currentNodePath ?? baselineNodePath,
    baselineNodePath,
    currentNodePath,
    fieldPath,
    baseline,
    current,
    ...(baselineIdentifier === undefined ? {} : { baselineIdentifier }),
    ...(currentIdentifier === undefined ? {} : { currentIdentifier }),
  };
}

function appendValueChanges(
  changes,
  baseline,
  current,
  baselineNodePath,
  currentNodePath,
  fieldPath,
  baselineIdentifier,
  currentIdentifier,
) {
  if (Object.is(baseline, current)) return;
  if (Array.isArray(baseline) && Array.isArray(current)) {
    const sharedLength = Math.min(baseline.length, current.length);
    for (let index = 0; index < sharedLength; index++) {
      appendValueChanges(
        changes,
        baseline[index],
        current[index],
        baselineNodePath,
        currentNodePath,
        [...fieldPath, index],
        baselineIdentifier,
        currentIdentifier,
      );
    }
    for (let index = sharedLength; index < baseline.length; index++) {
      changes.push(makeChange(
        "removed",
        baseline[index],
        null,
        baselineNodePath,
        currentNodePath,
        [...fieldPath, index],
        baselineIdentifier,
        currentIdentifier,
      ));
    }
    for (let index = sharedLength; index < current.length; index++) {
      changes.push(makeChange(
        "added",
        null,
        current[index],
        baselineNodePath,
        currentNodePath,
        [...fieldPath, index],
        baselineIdentifier,
        currentIdentifier,
      ));
    }
    return;
  }
  if (isRecord(baseline) && isRecord(current)) {
    const fields = new Set([...Object.keys(baseline), ...Object.keys(current)]);
    for (const field of fields) {
      const hasBaseline = Object.hasOwn(baseline, field);
      const hasCurrent = Object.hasOwn(current, field);
      if (!hasBaseline || !hasCurrent) {
        changes.push(makeChange(
          hasBaseline ? "removed" : "added",
          hasBaseline ? baseline[field] : null,
          hasCurrent ? current[field] : null,
          baselineNodePath,
          currentNodePath,
          [...fieldPath, field],
          baselineIdentifier,
          currentIdentifier,
        ));
      } else {
        appendValueChanges(
          changes,
          baseline[field],
          current[field],
          baselineNodePath,
          currentNodePath,
          [...fieldPath, field],
          baselineIdentifier,
          currentIdentifier,
        );
      }
    }
    return;
  }
  changes.push(makeChange(
    "changed",
    baseline,
    current,
    baselineNodePath,
    currentNodePath,
    fieldPath,
    baselineIdentifier,
    currentIdentifier,
  ));
}

function resultFromChanges(changes) {
  return changes.length === 0
    ? { result: "match", changes: [] }
    : { result: "changed", changes };
}

function compareSnapshotNodePair(
  baselineNode,
  currentNode,
  baselineNodePath,
  currentNodePath,
  baselineNodes,
  currentNodes,
  changes,
) {
  appendValueChanges(
    changes,
    baselineNode.source,
    currentNode.source,
    baselineNodePath,
    currentNodePath,
    ["source"],
    baselineNode.identifier,
    currentNode.identifier,
  );

  const baselineChildren = baselineNode.childIdentifiers.map((identifier) =>
    baselineNodes.get(identifier)
  );
  const currentChildren = currentNode.childIdentifiers.map((identifier) =>
    currentNodes.get(identifier)
  );
  for (
    const aligned of longestCommonSubsequence(
      baselineChildren,
      currentChildren,
      (node) =>
        node.source.kind === "element"
          ? `element\u0000${node.source.localName}\u0000${node.source.namespace ?? ""}`
          : node.source.kind,
    )
  ) {
    if (aligned.baselineIndex === null) {
      const currentChild = currentChildren[aligned.currentIndex];
      const childPath = [...currentNodePath, aligned.currentIndex];
      changes.push(makeChange(
        "added",
        null,
        currentChild.source,
        null,
        childPath,
        ["node"],
        undefined,
        currentChild.identifier,
      ));
    } else if (aligned.currentIndex === null) {
      const baselineChild = baselineChildren[aligned.baselineIndex];
      const childPath = [...baselineNodePath, aligned.baselineIndex];
      changes.push(makeChange(
        "removed",
        baselineChild.source,
        null,
        childPath,
        null,
        ["node"],
        baselineChild.identifier,
        undefined,
      ));
    } else {
      compareSnapshotNodePair(
        baselineChildren[aligned.baselineIndex],
        currentChildren[aligned.currentIndex],
        [...baselineNodePath, aligned.baselineIndex],
        [...currentNodePath, aligned.currentIndex],
        baselineNodes,
        currentNodes,
        changes,
      );
    }
  }
}

function textChunkContent(chunk) {
  return {
    text: chunk.text,
    fontSize: chunk.fontSize,
    lineHeight: chunk.lineHeight,
    ascent: chunk.ascent,
    descent: chunk.descent,
    baseline: chunk.baseline,
    glyphAdvances: chunk.glyphAdvances,
  };
}

function alignMetricNodes(baseline, current) {
  const pairs = [];
  const removedSubtrees = [];
  const addedSubtrees = [];
  const baselineTokenByIdentifier = new Map();
  const currentTokenByIdentifier = new Map();
  let nextToken = 0;

  const recordUnmatchedSubtree = (node, nodePath, side) => {
    const tokenByIdentifier = side === "baseline"
      ? baselineTokenByIdentifier
      : currentTokenByIdentifier;
    const nodeByIdentifier = side === "baseline"
      ? baseline.nodeByIdentifier
      : current.nodeByIdentifier;
    const pendingNodes = [node];
    while (pendingNodes.length > 0) {
      const pendingNode = pendingNodes.pop();
      tokenByIdentifier.set(
        pendingNode.nodeIdentifier,
        `${side}-node-${nextToken++}`,
      );
      for (const childIdentifier of pendingNode.childIdentifiers) {
        pendingNodes.push(nodeByIdentifier.get(childIdentifier));
      }
    }
    (side === "baseline" ? removedSubtrees : addedSubtrees).push({
      node,
      nodePath,
    });
  };

  const alignPair = (
    baselineNode,
    currentNode,
    baselineNodePath,
    currentNodePath,
  ) => {
    const token = `node-${nextToken++}`;
    baselineTokenByIdentifier.set(baselineNode.nodeIdentifier, token);
    currentTokenByIdentifier.set(currentNode.nodeIdentifier, token);
    pairs.push({ baselineNode, currentNode, baselineNodePath, currentNodePath });
    const baselineChildren = baselineNode.childIdentifiers.map((identifier) =>
      baseline.nodeByIdentifier.get(identifier)
    );
    const currentChildren = currentNode.childIdentifiers.map((identifier) =>
      current.nodeByIdentifier.get(identifier)
    );
    for (
      const aligned of longestCommonSubsequence(
        baselineChildren,
        currentChildren,
        () => "node",
      )
    ) {
      if (aligned.baselineIndex === null) {
        recordUnmatchedSubtree(
          currentChildren[aligned.currentIndex],
          [...currentNodePath, aligned.currentIndex],
          "current",
        );
      } else if (aligned.currentIndex === null) {
        recordUnmatchedSubtree(
          baselineChildren[aligned.baselineIndex],
          [...baselineNodePath, aligned.baselineIndex],
          "baseline",
        );
      } else {
        alignPair(
          baselineChildren[aligned.baselineIndex],
          currentChildren[aligned.currentIndex],
          [...baselineNodePath, aligned.baselineIndex],
          [...currentNodePath, aligned.currentIndex],
        );
      }
    }
  };

  const baselineRoots = baseline.artifact.nodeIdentifiers.map((identifier) =>
    baseline.nodeByIdentifier.get(identifier)
  );
  const currentRoots = current.artifact.nodeIdentifiers.map((identifier) =>
    current.nodeByIdentifier.get(identifier)
  );
  const rootAlignment = longestCommonSubsequence(
    baselineRoots,
    currentRoots,
    () => "root",
  );
  for (const aligned of rootAlignment) {
    if (aligned.baselineIndex === null) {
      const node = currentRoots[aligned.currentIndex];
      recordUnmatchedSubtree(
        node,
        current.pathByIdentifier.get(node.nodeIdentifier),
        "current",
      );
    } else if (aligned.currentIndex === null) {
      const node = baselineRoots[aligned.baselineIndex];
      recordUnmatchedSubtree(
        node,
        baseline.pathByIdentifier.get(node.nodeIdentifier),
        "baseline",
      );
    } else {
      alignPair(
        baselineRoots[aligned.baselineIndex],
        currentRoots[aligned.currentIndex],
        baseline.pathByIdentifier.get(baselineRoots[aligned.baselineIndex].nodeIdentifier),
        current.pathByIdentifier.get(currentRoots[aligned.currentIndex].nodeIdentifier),
      );
    }
  }
  return {
    pairs,
    removedSubtrees,
    addedSubtrees,
    baselineTokenByIdentifier,
    currentTokenByIdentifier,
  };
}

function requireCompatibleViewport(baseline, current) {
  for (const field of ["width", "height"]) {
    if (!Object.is(baseline.artifact.viewport[field], current.artifact.viewport[field])) {
      throw new RangeError(
        `Artifact viewport ${field} differs: baseline ${baseline.artifact.viewport[field]}, current ${current.artifact.viewport[field]}.`,
      );
    }
  }
}

function operationContent(operation, groupTokenByIdentifier) {
  const content = {
    kind: operation.kind,
    logicalRectangle: operation.logicalRectangle,
    affine: operation.affine,
    clipEntries: operation.clipEntries,
    opacity: operation.opacity,
    blendMode: operation.blendMode,
    compositingGroupIdentifiers: operation.compositingGroupIdentifiers.map((
      identifier,
    ) => groupTokenByIdentifier.get(identifier)),
    stackingContextIdentifiers: operation.stackingContextIdentifiers.map((
      identifier,
    ) => groupTokenByIdentifier.get(identifier)),
  };
  if (operation.kind === "text" || operation.kind === "text-shadow") {
    Object.assign(content, {
      text: operation.text,
      fontSize: operation.fontSize,
      lineHeight: operation.lineHeight,
      ascent: operation.ascent,
      descent: operation.descent,
      baseline: operation.baseline,
      glyphAdvances: operation.glyphAdvances,
      glyphs: operation.glyphs,
    });
  }
  return content;
}

function compositingGroupContent(group) {
  return {
    kind: group.kind,
    stackingContext: group.stackingContext,
    ...(Object.hasOwn(group, "opacity") ? { opacity: group.opacity } : {}),
    ...(Object.hasOwn(group, "blendMode") ? { blendMode: group.blendMode } : {}),
  };
}

export function compareDocumentSnapshots(baselineArtifact, currentArtifact) {
  const baseline = validateDocumentSnapshot(baselineArtifact, "baseline");
  const current = validateDocumentSnapshot(currentArtifact, "current");
  const changes = [];
  compareSnapshotNodePair(
    baseline.nodeByIdentifier.get(baselineArtifact.rootIdentifier),
    current.nodeByIdentifier.get(currentArtifact.rootIdentifier),
    [],
    [],
    baseline.nodeByIdentifier,
    current.nodeByIdentifier,
    changes,
  );
  return resultFromChanges(changes);
}

export function compareLayerMetrics(baselineArtifact, currentArtifact) {
  const baseline = validateLayerMetrics(baselineArtifact, "baseline");
  const current = validateLayerMetrics(currentArtifact, "current");
  requireCompatibleViewport(baseline, current);
  const alignment = alignMetricNodes(baseline, current);
  const changes = [];

  for (const { node, nodePath } of alignment.removedSubtrees) {
    changes.push(makeChange(
      "removed",
      { rectangle: node.rectangle, textChunks: node.textChunks.map(textChunkContent) },
      null,
      nodePath,
      null,
      ["node"],
      node.nodeIdentifier,
      undefined,
    ));
  }
  for (const { node, nodePath } of alignment.addedSubtrees) {
    changes.push(makeChange(
      "added",
      null,
      { rectangle: node.rectangle, textChunks: node.textChunks.map(textChunkContent) },
      null,
      nodePath,
      ["node"],
      undefined,
      node.nodeIdentifier,
    ));
  }
  for (
    const { baselineNode, currentNode, baselineNodePath, currentNodePath } of
      alignment.pairs
  ) {
    appendValueChanges(
      changes,
      baselineNode.rectangle,
      currentNode.rectangle,
      baselineNodePath,
      currentNodePath,
      ["rectangle"],
      baselineNode.nodeIdentifier,
      currentNode.nodeIdentifier,
    );
    appendValueChanges(
      changes,
      baselineNode.textChunks.map(textChunkContent),
      currentNode.textChunks.map(textChunkContent),
      baselineNodePath,
      currentNodePath,
      ["textChunks"],
      baselineNode.nodeIdentifier,
      currentNode.nodeIdentifier,
    );
  }
  return resultFromChanges(changes);
}

export function comparePaintArtifacts(baselineArtifact, currentArtifact) {
  const baseline = validateLayerMetrics(baselineArtifact, "baseline");
  const current = validateLayerMetrics(currentArtifact, "current");
  requireCompatibleViewport(baseline, current);
  const nodeAlignment = alignMetricNodes(baseline, current);
  const baselineOperations = baselineArtifact.paintOperations;
  const currentOperations = currentArtifact.paintOperations;
  const baselineGroupTokenByIdentifier = new Map(
    baselineArtifact.compositingGroups.map((group, index) => [
      group.identifier,
      `group-${index}`,
    ]),
  );
  const currentGroupTokenByIdentifier = new Map(
    currentArtifact.compositingGroups.map((group, index) => [
      group.identifier,
      `group-${index}`,
    ]),
  );
  const operationKey = (operation, tokenByIdentifier) =>
    `${operation.kind}\u0000${tokenByIdentifier.get(operation.nodeIdentifier)}`;
  const alignment = longestCommonSubsequence(
    baselineOperations,
    currentOperations,
    (operation) =>
      operationKey(operation, nodeAlignment.baselineTokenByIdentifier),
    (operation) =>
      operationKey(operation, nodeAlignment.currentTokenByIdentifier),
  );
  const changes = [];
  const baselineOperationTokenByIndex = new Map();
  const currentOperationTokenByIndex = new Map();
  let nextOperationToken = 0;

  for (const aligned of alignment) {
    if (aligned.baselineIndex === null) {
      const operation = currentOperations[aligned.currentIndex];
      currentOperationTokenByIndex.set(
        operation.operationIndex,
        `current-operation-${nextOperationToken++}`,
      );
      changes.push(makeChange(
        "added",
        null,
        operationContent(operation, currentGroupTokenByIdentifier),
        null,
        current.pathByIdentifier.get(operation.nodeIdentifier),
        ["paintOperations", aligned.currentIndex],
        undefined,
        operation.nodeIdentifier,
      ));
    } else if (aligned.currentIndex === null) {
      const operation = baselineOperations[aligned.baselineIndex];
      baselineOperationTokenByIndex.set(
        operation.operationIndex,
        `baseline-operation-${nextOperationToken++}`,
      );
      changes.push(makeChange(
        "removed",
        operationContent(operation, baselineGroupTokenByIdentifier),
        null,
        baseline.pathByIdentifier.get(operation.nodeIdentifier),
        null,
        ["paintOperations", aligned.baselineIndex],
        operation.nodeIdentifier,
        undefined,
      ));
    } else {
      const baselineOperation = baselineOperations[aligned.baselineIndex];
      const currentOperation = currentOperations[aligned.currentIndex];
      const operationToken = `operation-${nextOperationToken++}`;
      baselineOperationTokenByIndex.set(
        baselineOperation.operationIndex,
        operationToken,
      );
      currentOperationTokenByIndex.set(
        currentOperation.operationIndex,
        operationToken,
      );
      appendValueChanges(
        changes,
        operationContent(baselineOperation, baselineGroupTokenByIdentifier),
        operationContent(currentOperation, currentGroupTokenByIdentifier),
        baseline.pathByIdentifier.get(baselineOperation.nodeIdentifier),
        current.pathByIdentifier.get(currentOperation.nodeIdentifier),
        ["paintOperations", aligned.currentIndex],
        baselineOperation.nodeIdentifier,
        currentOperation.nodeIdentifier,
      );
    }
  }

  const groupCount = Math.max(
    baselineArtifact.compositingGroups.length,
    currentArtifact.compositingGroups.length,
  );
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const baselineGroup = baselineArtifact.compositingGroups[groupIndex];
    const currentGroup = currentArtifact.compositingGroups[groupIndex];
    if (baselineGroup === undefined) {
      changes.push(makeChange(
        "added",
        null,
        compositingGroupContent(currentGroup),
        null,
        currentGroup.nodeIdentifier === null
          ? null
          : current.pathByIdentifier.get(currentGroup.nodeIdentifier),
        ["compositingGroups", groupIndex],
        undefined,
        currentGroup.nodeIdentifier ?? undefined,
      ));
      continue;
    }
    if (currentGroup === undefined) {
      changes.push(makeChange(
        "removed",
        compositingGroupContent(baselineGroup),
        null,
        baselineGroup.nodeIdentifier === null
          ? null
          : baseline.pathByIdentifier.get(baselineGroup.nodeIdentifier),
        null,
        ["compositingGroups", groupIndex],
        baselineGroup.nodeIdentifier ?? undefined,
        undefined,
      ));
      continue;
    }
    const baselineGroupPath = baselineGroup.nodeIdentifier === null
      ? null
      : baseline.pathByIdentifier.get(baselineGroup.nodeIdentifier);
    const currentGroupPath = currentGroup.nodeIdentifier === null
      ? null
      : current.pathByIdentifier.get(currentGroup.nodeIdentifier);
    const baselineNodeToken = baselineGroup.nodeIdentifier === null
      ? null
      : nodeAlignment.baselineTokenByIdentifier.get(baselineGroup.nodeIdentifier);
    const currentNodeToken = currentGroup.nodeIdentifier === null
      ? null
      : nodeAlignment.currentTokenByIdentifier.get(currentGroup.nodeIdentifier);
    if (baselineNodeToken !== currentNodeToken) {
      changes.push(makeChange(
        "changed",
        baselineGroupPath,
        currentGroupPath,
        baselineGroupPath,
        currentGroupPath,
        ["compositingGroups", groupIndex, "node"],
        baselineGroup.nodeIdentifier ?? undefined,
        currentGroup.nodeIdentifier ?? undefined,
      ));
    }
    appendValueChanges(
      changes,
      compositingGroupContent(baselineGroup),
      compositingGroupContent(currentGroup),
      baselineGroupPath,
      currentGroupPath,
      ["compositingGroups", groupIndex],
      baselineGroup.nodeIdentifier ?? undefined,
      currentGroup.nodeIdentifier ?? undefined,
    );
    const baselineMembers = baselineOperations
      .filter((operation) =>
        operation.operationIndex >= baselineGroup.startOperationIndex &&
        (baselineGroup.endOperationIndex === null ||
          operation.operationIndex <= baselineGroup.endOperationIndex)
      )
      .map((operation) => baselineOperationTokenByIndex.get(operation.operationIndex))
      .filter((token) => token !== undefined)
      .sort();
    const currentMembers = currentOperations
      .filter((operation) =>
        operation.operationIndex >= currentGroup.startOperationIndex &&
        (currentGroup.endOperationIndex === null ||
          operation.operationIndex <= currentGroup.endOperationIndex)
      )
      .map((operation) => currentOperationTokenByIndex.get(operation.operationIndex))
      .filter((token) => token !== undefined)
      .sort();
    appendValueChanges(
      changes,
      baselineMembers,
      currentMembers,
      baselineGroupPath,
      currentGroupPath,
      ["compositingGroups", groupIndex, "operations"],
      baselineGroup.nodeIdentifier ?? undefined,
      currentGroup.nodeIdentifier ?? undefined,
    );
  }

  return resultFromChanges(changes);
}
