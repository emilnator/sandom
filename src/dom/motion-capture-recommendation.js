import { instantiate as instantiateMotionCapture } from "../wasm/motion-capture-binary.js";

const MAXIMUM_SIGNED_64_BIT_INTEGER = 9223372036854775807n;
const SUPPORTED_DIRECTIONS = new Set([
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
]);

function greatestCommonDivisor(left, right) {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function exactPositiveRational(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const text = String(value).toLowerCase();
  const [coefficient, exponentText] = text.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [integer, fraction = ""] = coefficient.split(".");
  let numerator = BigInt(integer + fraction);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  const divisor = greatestCommonDivisor(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  if (
    numerator > MAXIMUM_SIGNED_64_BIT_INTEGER ||
    denominator > MAXIMUM_SIGNED_64_BIT_INTEGER
  ) {
    return null;
  }
  return { numerator, denominator };
}

function directedProgress(direction, iterationIndex, progress) {
  const reverse = direction === "reverse" ||
    (direction === "alternate" && iterationIndex % 2 === 1) ||
    (direction === "alternate-reverse" && iterationIndex % 2 === 0);
  return reverse ? 1 - progress : progress;
}

function keyframeSignaturesAtProgress(effect, progress) {
  const keyframe = effect.keyframes?.find((candidate) =>
    candidate.offset === progress
  );
  if (!keyframe) return null;
  const signatures = {};
  for (const propertyName of effect.propertyNames) {
    const signature = keyframe.valueSignatures?.[propertyName];
    if (signature === undefined) return null;
    signatures[propertyName] = signature;
  }
  return signatures;
}

function freezeRecommendation(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeRecommendation(entry)));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          freezeRecommendation(entry),
        ]),
      ),
    );
  }
  return value;
}

export function recommendMotionCapture(motionInspection, options = {}) {
  if (
    motionInspection?.kind !== "motion-facts" ||
    motionInspection.version !== 1 ||
    !Array.isArray(motionInspection.effects)
  ) {
    throw new TypeError(
      "recommendMotionCapture() requires version 1 normalized motion facts",
    );
  }
  const preferredFrameRate = Number(options.preferredFrameRate ?? 30);
  const maximumFrameRate = Number(options.maximumFrameRate ?? 60);
  const maximumFrameCount = Number(options.maximumFrameCount ?? 300);
  const maximumPeriodMilliseconds = Number(
    options.maximumPeriodMilliseconds ?? 60000,
  );
  if (!Number.isFinite(preferredFrameRate) || preferredFrameRate <= 0) {
    throw new RangeError("preferredFrameRate must be a positive number");
  }
  if (
    !Number.isFinite(maximumFrameRate) || maximumFrameRate <= 0 ||
    maximumFrameRate < preferredFrameRate
  ) {
    throw new RangeError(
      "maximumFrameRate must be a positive number not below preferredFrameRate",
    );
  }
  if (
    !Number.isInteger(maximumFrameCount) || maximumFrameCount <= 0 ||
    maximumFrameCount > 2147483647
  ) {
    throw new RangeError("maximumFrameCount must be a positive 32-bit integer");
  }
  if (
    !Number.isSafeInteger(maximumPeriodMilliseconds) ||
    maximumPeriodMilliseconds <= 0
  ) {
    throw new RangeError(
      "maximumPeriodMilliseconds must be a positive safe integer",
    );
  }

  const progressingEffects = motionInspection.effects.filter((effect) =>
    effect.playState === "running" && effect.playbackRate !== 0 &&
    effect.changesRenderedOutput !== false
  );
  if (progressingEffects.length === 0) {
    return freezeRecommendation({
      version: 1,
      kind: "still",
      durationMilliseconds: 0,
      periodMilliseconds: null,
      periodRational: null,
      returnsToInitialState: true,
      confidence: "proven",
      reason: { code: "no-progressing-rendered-effects" },
      sampling: {
        strategy: "adaptive",
        preferredFrameRate,
        maximumFrameRate,
        maximumFrameCount,
        requiredSampleCount: 1,
        recommendedFrameBudget: 1,
        mandatorySampleTimesMilliseconds: [0],
        recommendedSampleTimesMilliseconds: [0],
      },
    });
  }

  const externalEffect = progressingEffects.find((effect) =>
    effect.timeline === "external"
  );
  if (externalEffect) {
    return freezeRecommendation({
      version: 1,
      kind: "externally-driven",
      durationMilliseconds: null,
      periodMilliseconds: null,
      periodRational: null,
      returnsToInitialState: null,
      confidence: "proven",
      reason: {
        code: "external-timeline-requires-progress-schedule",
        effectOrder: externalEffect.effectOrder ?? null,
        animationName: externalEffect.animationName || null,
        condition: externalEffect.timeline,
      },
      sampling: null,
    });
  }

  const unknownChangeEffect = progressingEffects.find((effect) =>
    effect.changesRenderedOutput === null
  );
  if (unknownChangeEffect) {
    return freezeRecommendation({
      version: 1,
      kind: "indeterminate",
      durationMilliseconds: null,
      periodMilliseconds: null,
      periodRational: null,
      returnsToInitialState: null,
      confidence: "indeterminate",
      reason: {
        code: "rendered-change-not-structurally-provable",
        effectOrder: unknownChangeEffect.effectOrder ?? null,
        animationName: unknownChangeEffect.animationName || null,
        condition: "incomplete-keyframe-values",
      },
      sampling: null,
    });
  }

  const invalidCompositionOrder = progressingEffects.find((effect, index) =>
    !Number.isInteger(effect.effectOrder) ||
    (index > 0 && effect.effectOrder <= progressingEffects[index - 1].effectOrder)
  );
  if (invalidCompositionOrder) {
    return freezeRecommendation({
      version: 1,
      kind: "indeterminate",
      durationMilliseconds: null,
      periodMilliseconds: null,
      periodRational: null,
      returnsToInitialState: null,
      confidence: "indeterminate",
      reason: {
        code: "effect-composition-order-not-provable",
        effectOrder: invalidCompositionOrder.effectOrder ?? null,
        animationName: invalidCompositionOrder.animationName || null,
        condition: "non-unique-or-missing-effect-order",
      },
      sampling: null,
    });
  }

  const infiniteEffects = progressingEffects.filter((effect) =>
    effect.iterationCount === Infinity
  );
  const finiteEffects = progressingEffects.filter((effect) =>
    effect.iterationCount !== Infinity
  );
  let kind;
  let durationMilliseconds;
  let periodMilliseconds = null;
  let periodRational = null;
  let returnsToInitialState;
  let confidence;
  let reason;

  if (infiniteEffects.length > 0) {
    if (finiteEffects.length > 0) {
      const effect = finiteEffects[0];
      return freezeRecommendation({
        version: 1,
        kind: "indeterminate",
        durationMilliseconds: null,
        periodMilliseconds: null,
        periodRational: null,
        returnsToInitialState: null,
        confidence: "indeterminate",
        reason: {
          code: "changing-effect-membership-prevents-shared-recurrence",
          effectOrder: effect.effectOrder,
          animationName: effect.animationName || null,
          condition: "finite-and-infinite-effects-contribute-concurrently",
        },
        sampling: null,
      });
    }
    const recurrenceExports = instantiateMotionCapture({}).exports;
    if (!recurrenceExports.recurrence_prepare(BigInt(maximumPeriodMilliseconds))) {
      throw new Error(
        `Cannot prepare recurrence proof: WebAssembly error ${recurrenceExports.motion_error()}`,
      );
    }
    for (const effect of infiniteEffects) {
      if (!SUPPORTED_DIRECTIONS.has(effect.direction)) {
        return freezeRecommendation({
          version: 1,
          kind: "indeterminate",
          durationMilliseconds: null,
          periodMilliseconds: null,
          periodRational: null,
          returnsToInitialState: null,
          confidence: "indeterminate",
          reason: {
            code: "unsupported-recurrence-direction",
            effectOrder: effect.effectOrder,
            animationName: effect.animationName || null,
            condition: effect.direction ?? null,
          },
          sampling: null,
        });
      }
      if (effect.phase !== "active" || !effect.effectMembershipAtInspection) {
        return freezeRecommendation({
          version: 1,
          kind: "indeterminate",
          durationMilliseconds: null,
          periodMilliseconds: null,
          periodRational: null,
          returnsToInitialState: null,
          confidence: "indeterminate",
          reason: {
            code: "effect-phase-prevents-boundary-recurrence",
            effectOrder: effect.effectOrder,
            animationName: effect.animationName || null,
            condition: effect.phase ?? "unknown",
          },
          sampling: null,
        });
      }
      const duration = exactPositiveRational(effect.durationMilliseconds);
      const playbackRate = exactPositiveRational(Math.abs(effect.playbackRate));
      if (!duration || !playbackRate) {
        return freezeRecommendation({
          version: 1,
          kind: "indeterminate",
          durationMilliseconds: null,
          periodMilliseconds: null,
          periodRational: null,
          returnsToInitialState: null,
          confidence: "indeterminate",
          reason: {
            code: "exact-timing-representation-unsupported",
            effectOrder: effect.effectOrder,
            animationName: effect.animationName || null,
            condition: !duration ? "duration" : "playback-rate",
          },
          sampling: null,
        });
      }
      const directionCycle = effect.direction === "alternate" ||
          effect.direction === "alternate-reverse"
        ? 2n
        : 1n;
      if (
        !recurrenceExports.recurrence_add_effect_period(
          duration.numerator,
          duration.denominator,
          playbackRate.numerator,
          playbackRate.denominator,
          directionCycle,
        )
      ) {
        const error = recurrenceExports.motion_error();
        return freezeRecommendation({
          version: 1,
          kind: "indeterminate",
          durationMilliseconds: null,
          periodMilliseconds: null,
          periodRational: null,
          returnsToInitialState: null,
          confidence: "indeterminate",
          reason: {
            code: error === 5
              ? "shared-period-exceeds-maximum"
              : error === 4
              ? "shared-period-integer-overflow"
              : "shared-period-proof-failed",
            effectOrder: effect.effectOrder,
            animationName: effect.animationName || null,
            condition: error,
            maximumPeriodMilliseconds,
          },
          sampling: null,
        });
      }
    }
    const numerator = recurrenceExports.recurrence_period_numerator();
    const denominator = recurrenceExports.recurrence_period_denominator();
    periodMilliseconds = Number(numerator) / Number(denominator);
    periodRational = {
      numerator: numerator.toString(),
      denominator: denominator.toString(),
    };
    kind = "periodic";
    durationMilliseconds = periodMilliseconds;
    returnsToInitialState = true;
    confidence = "proven";
    reason = {
      code: "shared-period-structurally-proved",
      contributingEffectOrders: infiniteEffects.map((effect) =>
        effect.effectOrder
      ),
    };
  } else {
    durationMilliseconds = motionInspection.finiteDurationMilliseconds;
    if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0) {
      return freezeRecommendation({
        version: 1,
        kind: "indeterminate",
        durationMilliseconds: null,
        periodMilliseconds: null,
        periodRational: null,
        returnsToInitialState: null,
        confidence: "indeterminate",
        reason: {
          code: "finite-bound-not-provable",
          effectOrder: null,
          animationName: null,
          condition: motionInspection.classification,
        },
        sampling: null,
      });
    }

    returnsToInitialState = true;
    for (const effect of finiteEffects) {
      if (effect.kind === "transition") {
        returnsToInitialState = false;
        break;
      }
      const finalMembership = effect.fill === "forwards" ||
        effect.fill === "both";
      if (effect.effectMembershipAtInspection !== finalMembership) {
        returnsToInitialState = false;
        break;
      }
      if (!finalMembership) {
        if (effect.changesUnderlyingState === false) continue;
        returnsToInitialState = effect.changesUnderlyingState === true
          ? false
          : null;
        break;
      }
      if (
        !SUPPORTED_DIRECTIONS.has(effect.direction) ||
        !Number.isFinite(effect.iterationCount) || effect.iterationCount <= 0 ||
        !Number.isInteger(effect.iterationIndex) ||
        !Number.isFinite(effect.iterationProgress)
      ) {
        returnsToInitialState = null;
        break;
      }
      const initialProgress = directedProgress(
        effect.direction,
        effect.iterationIndex,
        effect.iterationProgress,
      );
      const terminalIterationIndex = Math.max(
        0,
        Math.ceil(effect.iterationCount) - 1,
      );
      const iterationFraction = effect.iterationCount % 1;
      const terminalProgress = directedProgress(
        effect.direction,
        terminalIterationIndex,
        iterationFraction === 0 ? 1 : iterationFraction,
      );
      const initialSignatures = keyframeSignaturesAtProgress(
        effect,
        initialProgress,
      );
      const finalSignatures = keyframeSignaturesAtProgress(
        effect,
        terminalProgress,
      );
      if (!initialSignatures || !finalSignatures) {
        returnsToInitialState = null;
        break;
      }
      if (effect.propertyNames.some((propertyName) =>
        initialSignatures[propertyName] !== finalSignatures[propertyName]
      )) {
        returnsToInitialState = false;
        break;
      }
    }
    kind = returnsToInitialState === false
      ? "bounded-but-not-returning"
      : "finite";
    confidence = returnsToInitialState === null ? "indeterminate" : "proven";
    reason = returnsToInitialState === true
      ? { code: "finite-bound-and-return-structurally-proved" }
      : returnsToInitialState === false
      ? { code: "finite-bound-proved-but-boundary-state-differs" }
      : { code: "finite-bound-proved-but-boundary-equality-unknown" };
  }

  const scheduleExports = instantiateMotionCapture({}).exports;
  scheduleExports.motion_reset();
  const scheduleEffects = [];
  for (const effect of progressingEffects) {
    const effectIndex = scheduleExports.motion_add_effect(
      1,
      effect.startTimeMilliseconds,
      effect.delayMilliseconds,
      effect.durationMilliseconds,
      effect.iterationCount,
      effect.playbackRate,
    );
    if (effectIndex < 0) {
      throw new Error(
        `Cannot normalize capture schedule: WebAssembly error ${scheduleExports.motion_error()}`,
      );
    }
    scheduleEffects.push({ effect, effectIndex });
  }
  const scheduleStart = motionInspection.inspectedAtMilliseconds;
  const scheduleEnd = scheduleStart + durationMilliseconds;
  if (
    !scheduleExports.schedule_prepare(
      scheduleStart,
      scheduleEnd,
      maximumFrameCount,
    )
  ) {
    throw new Error(
      `Cannot prepare capture schedule: WebAssembly error ${scheduleExports.motion_error()}`,
    );
  }
  for (const { effect, effectIndex } of scheduleEffects) {
    if (!scheduleExports.schedule_add_effect(effectIndex)) {
      throw new Error(
        `Cannot add capture effect: WebAssembly error ${scheduleExports.motion_error()}`,
      );
    }
    const discrete = effect.propertyNames.some((propertyName) =>
      propertyName === "visibility" || propertyName === "content"
    );
    for (const offset of effect.keyframeOffsets) {
      if (!scheduleExports.schedule_add_keyframe(
        effectIndex,
        offset,
        discrete ? 1 : 0,
      )) {
        throw new Error(
          `Cannot add capture boundary: WebAssembly error ${scheduleExports.motion_error()}`,
        );
      }
    }
  }
  const requiredSampleCount = scheduleExports.schedule_count();
  const mandatorySampleTimesMilliseconds = Array.from(
    { length: requiredSampleCount },
    (_, index) => scheduleExports.schedule_time(index) - scheduleStart,
  );
  if (requiredSampleCount > maximumFrameCount) {
    throw new RangeError(
      `maximumFrameCount ${maximumFrameCount} is below the ${requiredSampleCount} mandatory samples`,
    );
  }
  const preferredSampleCount = Math.ceil(
    durationMilliseconds * preferredFrameRate / 1000,
  ) + 1;
  const maximumDensitySampleCount = Math.ceil(
    durationMilliseconds * maximumFrameRate / 1000,
  ) + 1;
  const recommendedFrameBudget = Math.min(
    maximumFrameCount,
    Math.max(
      requiredSampleCount,
      Math.min(preferredSampleCount, maximumDensitySampleCount),
    ),
  );
  if (!scheduleExports.schedule_set_frame_budget(recommendedFrameBudget)) {
    throw new Error(
      `Cannot set capture frame budget: WebAssembly error ${scheduleExports.motion_error()}`,
    );
  }
  if (!scheduleExports.schedule_finalize()) {
    throw new Error(
      `Cannot finalize capture schedule: WebAssembly error ${scheduleExports.motion_error()}`,
    );
  }
  const recommendedSampleTimesMilliseconds = Array.from(
    { length: scheduleExports.schedule_count() },
    (_, index) => scheduleExports.schedule_time(index) - scheduleStart,
  );

  return freezeRecommendation({
    version: 1,
    kind,
    durationMilliseconds,
    periodMilliseconds,
    periodRational,
    returnsToInitialState,
    confidence,
    reason,
    sampling: {
      strategy: "adaptive",
      preferredFrameRate,
      maximumFrameRate,
      maximumFrameCount,
      requiredSampleCount,
      recommendedFrameBudget,
      mandatorySampleTimesMilliseconds,
      recommendedSampleTimesMilliseconds,
    },
  });
}
