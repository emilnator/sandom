export function createComponent({ createElement: element, useState, Switch }) {
  return function NotificationSwitch({ size, checked: initialChecked, disabled }) {
    const [checked, setChecked] = useState(initialChecked);
    return element("div", { "data-component": "NotificationSwitch", style: { display: "flex", alignItems: "center", gap: "14px" } },
      element(Switch, { size, checked, disabled, onCheckedChange: setChecked, "aria-label": "Notifications" }),
      element("p", { "data-testid": "notification-state", style: { margin: 0, fontSize: "14px" } }, `Project updates ${checked ? "enabled" : "paused"}`));
  };
}
