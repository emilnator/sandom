const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function pushElement(operations, parent, name, attributes, text = null) {
  const identifier = `element-${
    operations.filter((operation) => operation.operation === "create").length
  }`;
  operations.push({
    operation: "create",
    identifier,
    namespace: SVG_NAMESPACE,
    name,
  });
  for (const [attribute, value] of Object.entries(attributes)) {
    operations.push({
      operation: "set-attribute",
      identifier,
      attribute,
      value: String(value),
    });
  }
  if (text !== null) {
    operations.push({ operation: "set-text", identifier, value: text });
  }
  operations.push({ operation: "append", parent, child: identifier });
  return identifier;
}

function rectangleAttributes(rectangle, extra = {}) {
  return {
    x: rectangle.x,
    y: rectangle.y,
    width: rectangle.width,
    height: rectangle.height,
    fill: "none",
    stroke: "#e7edf2",
    "stroke-width": 1,
    ...extra,
  };
}

const DIGIT_SEGMENTS = {
  0: "abcdef",
  1: "bc",
  2: "abdeg",
  3: "abcdg",
  4: "bcfg",
  5: "acdfg",
  6: "acdefg",
  7: "abc",
  8: "abcdefg",
  9: "abcdfg",
};

const SEGMENT_COORDINATES = {
  a: [0, 0, 6, 0],
  b: [6, 0, 6, 6],
  c: [6, 6, 6, 12],
  d: [0, 12, 6, 12],
  e: [0, 6, 0, 12],
  f: [0, 0, 0, 6],
  g: [0, 6, 6, 6],
};

function numericLabelPath(value, x, y) {
  return String(value).split("").map((digit, digitIndex) => {
    const offset = x + digitIndex * 9;
    return [...DIGIT_SEGMENTS[digit]].map((segment) => {
      const [x1, y1, x2, y2] = SEGMENT_COORDINATES[segment];
      return `M${x1 + offset} ${y1 + y}L${x2 + offset} ${y2 + y}`;
    }).join("");
  }).join("");
}

export function createArtifactSvgOperations(artifact) {
  if (!artifact?.viewport) throw new TypeError("artifact must have a viewport");
  const operations = [];
  const root = pushElement(operations, null, "svg", {
    xmlns: SVG_NAMESPACE,
    viewBox: `0 0 ${artifact.viewport.width} ${artifact.viewport.height}`,
    width: artifact.viewport.width,
    height: artifact.viewport.height,
    role: "img",
    "aria-label": `${artifact.kind} artifact overlay`,
  });

  if (artifact.kind === "layout") {
    for (const box of artifact.boxes) {
      pushElement(
        operations,
        root,
        "rect",
        rectangleAttributes(box.borderBox, {
          "data-node-index": box.nodeIndex,
        }),
      );
      pushElement(operations, root, "path", {
        d: numericLabelPath(
          box.nodeIndex,
          box.borderBox.x + 2,
          box.borderBox.y + 2,
        ),
        fill: "none",
        stroke: "#e7edf2",
        "stroke-width": 1,
      });
    }
    for (const line of artifact.lineBoxes) {
      pushElement(operations, root, "line", {
        x1: line.x,
        y1: line.baseline,
        x2: line.x + line.width,
        y2: line.baseline,
        stroke: "#e7edf2",
        "stroke-width": 1,
        "stroke-dasharray": "4 4",
        "data-node-index": line.nodeIndex,
      });
    }
  } else if (artifact.kind === "paint") {
    for (const [boxIndex, entry] of artifact.boxes.entries()) {
      pushElement(
        operations,
        root,
        "rect",
        rectangleAttributes(entry.box, {
          class: entry.kind === "text-run" ? "text-run" : "shape",
          "data-paint-box-index": boxIndex,
          ...(entry.affine
            ? { transform: `matrix(${entry.affine.join(" ")})` }
            : {}),
        }),
      );
    }
  } else if (artifact.kind === "display-list") {
    for (const command of artifact.commands) {
      if (command.geometry?.width !== undefined) {
        pushElement(
          operations,
          root,
          "rect",
          rectangleAttributes(command.geometry, {
            "data-command-index": command.commandIndex,
            "stroke-dasharray": command.clipDepth > 0 ? "4 4" : "none",
          }),
        );
      }
      for (const clip of command.clipEntries ?? []) {
        pushElement(
          operations,
          root,
          "rect",
          rectangleAttributes(clip, {
            "data-command-index": command.commandIndex,
            "stroke-dasharray": "2 2",
          }),
        );
      }
    }
  } else if (artifact.kind === "invalidation") {
    artifact.tileMap.forEach((dirty, index) => {
      if (!dirty) return;
      const column = index % artifact.columns;
      const row = Math.floor(index / artifact.columns);
      pushElement(
        operations,
        root,
        "rect",
        rectangleAttributes({
          x: column * artifact.tileSize,
          y: row * artifact.tileSize,
          width: Math.min(
            artifact.tileSize,
            artifact.viewport.width - column * artifact.tileSize,
          ),
          height: Math.min(
            artifact.tileSize,
            artifact.viewport.height - row * artifact.tileSize,
          ),
        }, { "stroke-dasharray": "6 3", "data-tile-index": index }),
      );
    });
  } else {
    throw new Error(
      `SVG artifact renderer: unknown artifact kind ${artifact.kind}`,
    );
  }

  return Object.freeze(operations.map((operation) => Object.freeze(operation)));
}

export function applySvgOperations(document, parent, operations) {
  const elements = new Map([[null, parent]]);
  for (const operation of operations) {
    if (operation.operation === "create") {
      elements.set(
        operation.identifier,
        document.createElementNS(operation.namespace, operation.name),
      );
    } else if (operation.operation === "set-attribute") {
      elements.get(operation.identifier).setAttribute(
        operation.attribute,
        operation.value,
      );
    } else if (operation.operation === "set-text") {
      elements.get(operation.identifier).textContent = operation.value;
    } else if (operation.operation === "append") {
      elements.get(operation.parent).appendChild(elements.get(operation.child));
    } else {
      throw new Error(
        `SVG artifact renderer: unknown operation ${operation.operation}`,
      );
    }
  }
  return elements.get(operations[0].identifier);
}
