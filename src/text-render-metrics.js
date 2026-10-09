function requireRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function finiteNumbers(value, name) {
  if (!Array.isArray(value) || value.some((entry) => !Number.isFinite(entry))) {
    throw new TypeError(`${name} must be an array of finite numbers`);
  }
  return value;
}

function displayTextRuns(displayList) {
  requireRecord(displayList, "Sandom display list");
  if (!Array.isArray(displayList.commands)) {
    throw new TypeError("Sandom display list commands must be an array");
  }
  return displayList.commands.filter((command) =>
    command?.name === "text" && command.textShadow !== true
  );
}

function chromeTextRuns(measurement) {
  requireRecord(measurement, "Chrome text measurement");
  if (!Array.isArray(measurement.runs)) {
    throw new TypeError("Chrome text measurement runs must be an array");
  }
  return measurement.runs;
}

function total(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

function cssFamily(value) {
  const family = String(value ?? "").split(",", 1)[0].trim()
    .replace(/^['"]|['"]$/g, "").toLowerCase();
  return family.split(":").at(-1);
}

function mismatch(kind, expected, actual, tolerance = 0) {
  return Object.freeze({ kind, expected, actual, tolerance });
}

function alignRuns(chromeRuns, sandomRuns) {
  const remaining = new Set(sandomRuns.keys());
  const pairs = chromeRuns.map((chrome) => {
    const text = String(chrome?.text ?? "").trimEnd();
    let selected = null;
    let distance = Infinity;
    for (const index of remaining) {
      const candidate = sandomRuns[index];
      if (String(candidate.text ?? "").trimEnd() !== text) continue;
      const candidateDistance = Math.abs(
        Number(chrome?.bounds?.x ?? 0) - Number(candidate.geometry?.x ?? 0),
      ) + Math.abs(
        Number(chrome?.bounds?.y ?? 0) - Number(candidate.geometry?.y ?? 0),
      );
      if (candidateDistance < distance) {
        selected = index;
        distance = candidateDistance;
      }
    }
    if (selected !== null) remaining.delete(selected);
    return [chrome, selected === null ? null : sandomRuns[selected]];
  });
  for (const index of remaining) pairs.push([null, sandomRuns[index]]);
  return pairs;
}

export function compareTextRendering(chromeMeasurement, sandomDisplayList) {
  const chromeRuns = chromeTextRuns(chromeMeasurement);
  const sandomRuns = displayTextRuns(sandomDisplayList);
  const pairs = alignRuns(chromeRuns, sandomRuns);
  const runs = [];
  for (let index = 0; index < pairs.length; index++) {
    const [chrome, sandom] = pairs[index];
    const mismatches = [];
    if (chrome === null || sandom === null) {
      mismatches.push(mismatch(
        "run-count",
        chrome === null ? 0 : 1,
        sandom === null ? 0 : 1,
      ));
      runs.push(Object.freeze({
        index,
        chromeText: chrome?.text ?? null,
        sandomText: sandom?.text ?? null,
        matches: false,
        mismatches: Object.freeze(mismatches),
      }));
      continue;
    }
    requireRecord(chrome, `Chrome run ${index}`);
    const chromeText = String(chrome.text ?? "").trimEnd();
    const sandomText = String(sandom.text ?? "").trimEnd();
    const chromeAdvances = finiteNumbers(
      chrome.advances,
      `Chrome run ${index} advances`,
    ).slice(0, chromeText.length);
    const sandomAdvances = finiteNumbers(
      sandom.advances,
      `Sandom run ${index} advances`,
    ).slice(0, sandomText.length);
    const fontSize = Number(sandom.fontSize);
    const unitsPerEm = Number(sandom.unitsPerEm);
    if (
      !(fontSize > 0) || !Number.isFinite(fontSize) ||
      !Number.isInteger(unitsPerEm) || unitsPerEm <= 0
    ) {
      throw new TypeError(
        `Sandom run ${index} has invalid fontSize or unitsPerEm`,
      );
    }
    // Chrome derives a Range width from two positions quantized to 1/64 CSS
    // pixel. Sandom rounds one shaped advance to a font unit. The tolerance is
    // the sum of those mechanism-specific bounds.
    const fontUnit = fontSize / unitsPerEm;
    const advanceTolerance = fontUnit + 2 / 64;
    const cumulativeTolerance = advanceTolerance *
      Math.max(chromeAdvances.length, sandomAdvances.length, 1);
    const chromeCharacterCount = chromeText.length;
    if (chromeCharacterCount !== sandomText.length) {
      mismatches.push(mismatch(
        "character-count",
        chromeCharacterCount,
        sandomText.length,
      ));
    }
    if (chromeAdvances.length !== sandomAdvances.length) {
      mismatches.push(mismatch(
        "glyph-count",
        chromeAdvances.length,
        sandomAdvances.length,
      ));
    }
    const chromeTotal = total(chromeAdvances);
    const sandomTotal = total(sandomAdvances);
    if (Math.abs(chromeTotal - sandomTotal) > cumulativeTolerance) {
      mismatches.push(mismatch(
        "cumulative-advance",
        chromeTotal,
        sandomTotal,
        cumulativeTolerance,
      ));
    }
    if (chromeAdvances.length === sandomAdvances.length) {
      const differences = [];
      for (
        let advanceIndex = 0;
        advanceIndex < chromeAdvances.length;
        advanceIndex++
      ) {
        const difference = Math.abs(
          chromeAdvances[advanceIndex] - sandomAdvances[advanceIndex],
        );
        if (difference > advanceTolerance) {
          differences.push(Object.freeze({
            index: advanceIndex,
            expected: chromeAdvances[advanceIndex],
            actual: sandomAdvances[advanceIndex],
            difference,
          }));
        }
      }
      if (differences.length > 0) {
        mismatches.push(Object.freeze({
          kind: "advance-sequence",
          tolerance: advanceTolerance,
          differences: Object.freeze(differences),
        }));
      }
    }
    if (Array.isArray(chrome.glyphIds)) {
      const expected = chrome.glyphIds.join(",");
      const actual = sandom.glyphIds.join(",");
      if (expected !== actual) {
        mismatches.push(mismatch(
          "glyph-identity",
          chrome.glyphIds,
          sandom.glyphIds,
        ));
      }
    }
    const chromeFamily = cssFamily(chrome.font?.family);
    const sandomFamily = cssFamily(sandom.font?.family);
    if (chromeFamily && sandomFamily && chromeFamily !== sandomFamily) {
      mismatches.push(mismatch("font-identity", chromeFamily, sandomFamily));
    }
    if (chrome.bounds && sandom.geometry) {
      const expectedX = Number(chrome.bounds.x);
      const actualX = Number(sandom.geometry.x);
      if (
        Number.isFinite(expectedX) && Number.isFinite(actualX) &&
        Math.abs(expectedX - actualX) > advanceTolerance
      ) {
        mismatches.push(mismatch(
          "run-position",
          { x: expectedX },
          { x: actualX },
          advanceTolerance,
        ));
      }
    }
    runs.push(Object.freeze({
      index,
      chromeText: chrome.text,
      sandomText: sandom.text,
      matches: mismatches.length === 0,
      mismatches: Object.freeze(mismatches),
    }));
  }
  return Object.freeze({
    matches: runs.every((run) => run.matches),
    chromeRunCount: chromeRuns.length,
    sandomRunCount: sandomRuns.length,
    runs: Object.freeze(runs),
  });
}
