// A reminder settings panel: a counter, a checkbox, and the day's schedule
// derived from the counter. Plain React.createElement, so the file runs as it
// is, with no JSX build step.

import React from "react";

const h = React.createElement;

// Reminders spread evenly from 09:00 to 17:00.
function scheduleFor(reminders) {
  const first = 9 * 60;
  const span = 8 * 60;
  return Array.from({ length: reminders }, (_, index) => {
    const minutes = reminders === 1 ? first : first + Math.round((span * index) / (reminders - 1));
    const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
    return `${hours}:${String(minutes % 60).padStart(2, "0")}`;
  });
}

export function SettingsPanel({ onCommit }) {
  const [reminders, setReminders] = React.useState(2);
  const [weeklySummary, setWeeklySummary] = React.useState(false);
  // useDeferredValue renders the schedule in a second, interruptible render
  // on a transition lane: a click on the counter commits the count at once
  // and the schedule after it.
  const scheduled = React.useDeferredValue(reminders);
  const schedule = scheduleFor(scheduled);

  // A layout effect runs inside React's commit, after React has written the
  // DOM, so the host learns the moment the document holds this state.
  React.useLayoutEffect(() => {
    onCommit({ reminders, weeklySummary, schedule });
  });

  return h(
    "section",
    { className: "panel" },
    h("h1", null, "Reminders"),
    h(
      "div",
      { className: "row" },
      h("span", { className: "label" }, "Reminders per day"),
      // Each button is described by the count and the schedule, so assistive
      // technology reads the current value with it; the session's
      // accessibility snapshot, which lists controls, carries it too.
      h("button", {
        "aria-label": "Fewer reminders",
        "aria-describedby": "reminder-count reminder-schedule",
        disabled: reminders === 1,
        onClick: () => setReminders((count) => count - 1),
      }, "−"),
      h("output", { id: "reminder-count", className: "count" }, reminders),
      h("button", {
        "aria-label": "More reminders",
        "aria-describedby": "reminder-count reminder-schedule",
        disabled: reminders === 6,
        onClick: () => setReminders((count) => count + 1),
      }, "+"),
    ),
    h(
      "label",
      { className: "row" },
      h("input", {
        type: "checkbox",
        checked: weeklySummary,
        onChange: (event) => setWeeklySummary(event.target.checked),
      }),
      "Weekly summary email",
    ),
    // The spaces between the times separate them in the buttons' accessible
    // description; the flex layout drops them.
    h(
      "p",
      { id: "reminder-schedule", className: "schedule" },
      schedule.flatMap((time, index) => [index > 0 && " ", h("span", { key: time }, time)]),
    ),
  );
}

export const STYLESHEET = `
  html, body { margin: 0; height: 100%; }
  body { font-family: "Inter"; background: #eef1f6; color: #172033; }
  .panel {
    box-sizing: border-box; height: 100%; padding: 22px 26px;
    display: flex; flex-direction: column; gap: 14px;
  }
  h1 { margin: 0; font-size: 22px; font-weight: 700; }
  .row { display: flex; align-items: center; gap: 10px; font-size: 15px; }
  .label { flex: 1; }
  button {
    width: 32px; height: 32px; border: 1px solid #b8c2d6; border-radius: 8px;
    background: #ffffff; color: #172033; font: 600 18px "Inter";
  }
  button:disabled { color: #a3acbd; }
  .count { width: 24px; text-align: center; font-size: 18px; font-weight: 700; }
  input[type="checkbox"] { width: 18px; height: 18px; margin: 0; }
  .schedule { display: flex; gap: 8px; margin: 4px 0 0; }
  .schedule span {
    padding: 5px 10px; border-radius: 999px; background: #2f5bd3;
    color: #ffffff; font-size: 13px; font-weight: 600;
  }
`;
