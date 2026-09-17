// Renders one viewport recommendation trace as a standalone HTML document.
//
// The document draws every trial in attempt order, to one shared scale, so
// a reviewer sees what the algorithm tried, what each attempt measured,
// and which constraints rejected it. The selected viewport is the one
// inverted tile. Style follows the Star Taker home style: one monospaced
// face, one size, two colours, inversion as the only emphasis. The thin
// rectangle outlines are data marks of the diagram, not panel chrome.

const FIELD = "#10151c";
const INK = "#e8e4d8";
const DRAWING_WIDTH = 160;
const DRAWING_HEIGHT = 120;

function escapeText(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function trialTile(trial, scale, selectedViewport) {
  const viewport = trial.viewport;
  const selected = selectedViewport !== null &&
    viewport.width === selectedViewport.width &&
    viewport.height === selectedViewport.height &&
    trial.valid;
  const drawnWidth = Math.max(2, Math.round(viewport.width * scale));
  const drawnHeight = Math.max(2, Math.round(viewport.height * scale));
  const bounds = trial.contentBounds;
  const content = bounds.width > 0 && bounds.height > 0
    ? `<div class="content" style="left:${
      Math.round(bounds.x * scale)
    }px;top:${Math.round(bounds.y * scale)}px;width:${
      Math.max(1, Math.round(bounds.width * scale))
    }px;height:${Math.max(1, Math.round(bounds.height * scale))}px"></div>`
    : "";
  const verdict = trial.valid ? "valid" : "invalid";
  const constraints = trial.failedConstraints.length > 0
    ? `<div class="constraints">${
      trial.failedConstraints.map(escapeText).join("<br>")
    }</div>`
    : "";
  return `<div class="tile${selected ? " selected" : ""}">
    <div class="drawing">
      <div class="viewport" style="width:${drawnWidth}px;height:${drawnHeight}px">${content}</div>
    </div>
    <div class="facts code">#${trial.sequence} ${escapeText(trial.source)}
${viewport.width}x${viewport.height}
${selected ? "selected" : verdict}</div>
    ${constraints}
  </div>`;
}

export function viewportPlanDocument(trace) {
  const { inputName, initialViewport, recommendation, plan } = trace;
  const trials = recommendation.trials;
  const maximumWidth = Math.max(
    1,
    ...trials.map((trial) => trial.viewport.width),
  );
  const maximumHeight = Math.max(
    1,
    ...trials.map((trial) => trial.viewport.height),
  );
  const scale = Math.min(
    DRAWING_WIDTH / maximumWidth,
    DRAWING_HEIGHT / maximumHeight,
  );
  const selectedViewport = plan.viewport
    ? { width: plan.viewport.width, height: plan.viewport.height }
    : null;
  const decisionFacts = [
    `input ${inputName}`,
    `initial ${initialViewport.width}x${initialViewport.height}`,
    `classification ${recommendation.classification}`,
    `confidence ${plan.confidence}`,
    `decision ${plan.decision?.reason?.code ?? "-"}`,
    plan.viewport
      ? `plan ${plan.viewport.width}x${plan.viewport.height}`
      : "plan none",
    `trials ${trials.length}`,
  ];
  return `<!DOCTYPE html>
<html>
  <head>
    <style>
      html { font-size: 13px; }
      html, body { margin: 0; width: 100%; min-height: 100%; }
      body {
        background: ${FIELD};
        color: ${INK};
        font-family: "IBM Plex Mono", monospace;
        font-size: 13px;
        line-height: 1.5;
        padding: 2rem 4ch;
      }
      .code { text-transform: uppercase; letter-spacing: 0.2ch; white-space: pre; }
      header { margin-bottom: 2rem; }
      .grid { display: flex; flex-wrap: wrap; gap: 2rem 4ch; }
      .tile { width: ${DRAWING_WIDTH + 16}px; }
      .tile.selected { background: ${INK}; color: ${FIELD}; }
      .drawing { position: relative; width: ${DRAWING_WIDTH}px; height: ${DRAWING_HEIGHT}px; margin: 8px; }
      .viewport { position: absolute; left: 0; top: 0; border: 1px solid currentColor; }
      .content { position: absolute; background: currentColor; }
      .facts { margin: 0 8px; }
      .constraints { margin: 0 8px; }
    </style>
  </head>
  <body>
    <header class="code">viewport plan
${decisionFacts.map(escapeText).join("\n")}</header>
    <div class="grid">
      ${trials.map((trial) => trialTile(trial, scale, selectedViewport)).join("\n")}
    </div>
  </body>
</html>
`;
}
