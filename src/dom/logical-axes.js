export function logicalAxes(fields = {}) {
  const writingMode = fields.writingMode ?? 'horizontal-tb';
  const rightToLeft = (fields.direction ?? 'ltr') === 'rtl';
  if (writingMode === 'vertical-rl') {
    return {
      block: { axis: 'x', startAtHigh: true },
      inline: { axis: 'y', startAtHigh: rightToLeft },
    };
  }
  if (writingMode === 'vertical-lr') {
    return {
      block: { axis: 'x', startAtHigh: false },
      inline: { axis: 'y', startAtHigh: rightToLeft },
    };
  }
  return {
    block: { axis: 'y', startAtHigh: false },
    inline: { axis: 'x', startAtHigh: rightToLeft },
  };
}

export function resolveAxis(axis, fields = {}) {
  if (axis === 'x') return { axis, startAtHigh: horizontalOriginAtHigh(fields) };
  if (axis === 'y') return { axis, startAtHigh: false };
  const logical = logicalAxes(fields);
  if (axis === 'block' || axis === 'inline') return logical[axis];
  throw new Error(`unknown logical axis "${axis}"`);
}

export function physicalAlignment(alignment, axis) {
  if (!axis.startAtHigh) return alignment;
  if (alignment === 'start') return 'end';
  if (alignment === 'end') return 'start';
  return alignment;
}

export function horizontalOriginAtHigh(fields = {}) {
  const axes = logicalAxes(fields);
  return axes.block.axis === 'x' ? axes.block.startAtHigh : axes.inline.startAtHigh;
}

export function horizontalScrollRange(fields, maximum) {
  return horizontalOriginAtHigh(fields)
    ? { minimum: -maximum, maximum: 0 }
    : { minimum: 0, maximum };
}

export function normalizedHorizontalOffset(fields, offset, maximum) {
  return horizontalOriginAtHigh(fields) ? offset + maximum : offset;
}

export function exposedHorizontalOffset(fields, normalized, maximum) {
  return horizontalOriginAtHigh(fields) ? normalized - maximum : normalized;
}
