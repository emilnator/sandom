export function createComponent({ createElement: element, useState, Input }) {
  return function SearchField({ disabled, invalid, initialValue }) {
    const [value, setValue] = useState(initialValue);
    return element("div", { "data-component": "SearchField", style: { display: "flex", flexDirection: "column", gap: "14px", width: "280px" } },
      element(Input, { disabled, "aria-invalid": invalid, "aria-label": "Search projects", placeholder: "Find your next project…", value, onChange: (event) => setValue(event.target.value), style: { borderRadius: "12px", height: "42px" } }),
      element("p", { "data-testid": "search-state", style: { margin: 0, fontSize: "13px", color: "#71717a" } }, value ? `Searching for ${value}` : "Ready to search"));
  };
}
