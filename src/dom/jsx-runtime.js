const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SVG_ELEMENT_NAMES = new Set([
  "animate",
  "animateMotion",
  "animateTransform",
  "circle",
  "clipPath",
  "defs",
  "desc",
  "ellipse",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "filter",
  "foreignObject",
  "g",
  "image",
  "line",
  "linearGradient",
  "marker",
  "mask",
  "metadata",
  "mpath",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialGradient",
  "rect",
  "set",
  "stop",
  "svg",
  "switch",
  "symbol",
  "text",
  "textPath",
  "tspan",
  "use",
  "view",
]);

export const Fragment = Symbol.for("sandom.jsx.fragment");

function appendChild(parent, child) {
  if (child === null || child === undefined || typeof child === "boolean") {
    return;
  }
  if (Array.isArray(child)) {
    for (const entry of child) appendChild(parent, entry);
    return;
  }
  if (typeof child === "string" || typeof child === "number") {
    parent.appendChild(document.createTextNode(String(child)));
    return;
  }
  if (typeof child === "object" && Number.isInteger(child.nodeType)) {
    parent.appendChild(child);
    return;
  }
  throw new TypeError(`Unsupported JSX child ${String(child)}`);
}

function applyProperties(element, properties) {
  for (const [name, value] of Object.entries(properties)) {
    if (
      name === "children" || value === null || value === undefined ||
      value === false
    ) {
      continue;
    }
    if (name === "class" || name === "className") {
      element.setAttribute("class", value);
      continue;
    }
    if (
      name === "style" && typeof value === "object" && !Array.isArray(value)
    ) {
      for (const [propertyName, propertyValue] of Object.entries(value)) {
        if (propertyValue === null || propertyValue === undefined) continue;
        if (propertyName.startsWith("--")) {
          element.style.setProperty(propertyName, String(propertyValue));
        } else {
          element.style[propertyName] = propertyValue;
        }
      }
      continue;
    }
    if (/^on[A-Z]/.test(name) && typeof value === "function") {
      element.addEventListener(
        `${name[2].toLowerCase()}${name.slice(3)}`,
        value,
      );
      continue;
    }
    element.setAttribute(name, value === true ? "" : String(value));
  }
}

export function jsx(type, properties = {}) {
  const normalizedProperties = properties ?? {};
  if (type === Fragment) {
    const fragment = document.createDocumentFragment();
    appendChild(fragment, normalizedProperties.children);
    return fragment;
  }
  if (typeof type === "function") return type(normalizedProperties);
  if (typeof type !== "string") {
    throw new TypeError(
      "JSX element type must be an intrinsic name or function",
    );
  }
  const element = SVG_ELEMENT_NAMES.has(type)
    ? document.createElementNS(SVG_NAMESPACE, type)
    : document.createElement(type);
  applyProperties(element, normalizedProperties);
  appendChild(element, normalizedProperties.children);
  return element;
}

export const jsxs = jsx;
export const jsxDEV = jsx;
