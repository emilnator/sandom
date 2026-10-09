export function createComponent({ createElement: element, useState, Button }) {
  return function ActionButton({ variant, size, disabled, withIcon }) {
    const [activations, setActivations] = useState(0);
    const icon = withIcon ? element("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": "true" },
      element("path", { d: "m9 18 6-6-6-6" })) : null;
    return element("div", { "data-component": "ActionButton", style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "18px" } },
      element(Button, { variant, size, disabled, onClick: () => setActivations((value) => value + 1), "aria-label": "Publish project", "data-testid": "action-button", style: { boxShadow: "0 4px 12px rgba(104, 81, 216, 0.16)" } }, "Publish project", icon),
      element("p", { "data-testid": "activation-count", style: { margin: 0, fontSize: "13px", color: "#71717a" } }, `${activations} publish actions`));
  };
}
