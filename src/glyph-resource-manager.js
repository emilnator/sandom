import { GLYPH_PERFORMANCE_PHASE_FIELDS, GlyphAtlas } from "./atlas.js";
import { createWebGpuMsdfGenerator } from "./msdf-webgpu/generator.js";

export const GLYPH_RESOURCE_FORMAT_VERSION = 1;
export const DEFAULT_GLYPH_RESOURCE_LIMITS = Object.freeze({
  maxEntries: 2048,
  maxBytes: 64 * 1024 * 1024,
});

const NATIVE_ATLAS_ENTRY_CAPACITY = 4096;
const NATIVE_GLYPH_ATLAS_FIXED_BYTE_LENGTH = 576 * 1024;
const MINIMUM_BYTE_LIMIT = 2 * 1024 * 1024;

function accumulateGlyphPerformance(
  glyphPerformance,
  ensured,
  descriptor,
  includeGeneratedGlyphs,
) {
  for (const field of GLYPH_PERFORMANCE_PHASE_FIELDS) {
    glyphPerformance.phaseMilliseconds[field] +=
      ensured.phaseMilliseconds[field];
  }
  if (!includeGeneratedGlyphs) return;
  for (const glyph of ensured.generatedGlyphs) {
    glyphPerformance.generatedGlyphs.push({
      requestIndex: descriptor.requestIndex,
      weight: descriptor.weight,
      opticalSize: descriptor.opticalSize,
      devicePixelSize: descriptor.devicePixelSize,
      ...glyph,
    });
  }
}

function compareBytes(first, second) {
  if (first.byteLength !== second.byteLength) return false;
  for (let index = 0; index < first.byteLength; index++) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}

// Whether a caller's view could have changed under us since we last saw it.
//
// A font handed in as a view over WebAssembly memory, over a resizable
// buffer, or over a SharedArrayBuffer is a window onto bytes somebody else
// owns: the same object can hold different content on a later call, so
// identity proves nothing and the content has to be compared. A view that
// owns an ordinary ArrayBuffer cannot — the only way its bytes change is a
// write through some view of it, and the registry that loads a face never
// writes to one.
//
// The distinction is what makes the identity cache in _fontRecord worth
// having. Measured on the landing page before this existed: every request
// took the identity-hit path, every one then walked the whole face a byte at
// a time, and that walk was 16% of a CPU profile with an animation running
// and 20% with none — about 99 MB/s of comparison to confirm what the
// WeakMap had already answered
// (plans/bugs/BUG-font-bytes-compared-every-glyph-request.md).
function viewCanChangeUnderUs(bytes) {
  const buffer = bytes.buffer;
  if (buffer.resizable || buffer.growable) return true;
  return typeof SharedArrayBuffer === "function" &&
    buffer instanceof SharedArrayBuffer;
}

function contentDigestString(digest) {
  return Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

function validateLimits(maxEntries, maxBytes) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(
      "glyph resource maxEntries must be a positive integer",
    );
  }
  if (maxEntries > NATIVE_ATLAS_ENTRY_CAPACITY) {
    throw new RangeError(
      `glyph resource maxEntries cannot exceed the native atlas capacity of ${NATIVE_ATLAS_ENTRY_CAPACITY}`,
    );
  }
  if (!Number.isInteger(maxBytes) || maxBytes < MINIMUM_BYTE_LIMIT) {
    throw new RangeError(
      `glyph resource maxBytes must be an integer of at least ${MINIMUM_BYTE_LIMIT}`,
    );
  }
}
function throwIfAborted(signal) {
  if (signal === null) return;
  if (
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.throwIfAborted !== "function"
  ) {
    throw new TypeError("glyph resource signal must be an AbortSignal or null");
  }
  signal.throwIfAborted();
}

function normalizeRequests(requests) {
  if (!Array.isArray(requests)) {
    throw new TypeError("glyph resource requests must be an array");
  }
  return requests.map((request, requestIndex) => {
    if (!(request?.fontBytes instanceof Uint8Array)) {
      throw new TypeError(
        `glyph resource request ${requestIndex} fontBytes must be a Uint8Array`,
      );
    }
    if (
      !request.glyphIds ||
      typeof request.glyphIds[Symbol.iterator] !== "function"
    ) {
      throw new TypeError(
        `glyph resource request ${requestIndex} glyphIds must be iterable`,
      );
    }
    const glyphIds = [...new Set(request.glyphIds)];
    for (const glyphId of glyphIds) {
      if (!Number.isInteger(glyphId) || glyphId < 0) {
        throw new RangeError(
          `glyph resource request ${requestIndex} has an invalid glyph identifier`,
        );
      }
    }
    if (!Number.isFinite(request.weight)) {
      throw new RangeError(
        `glyph resource request ${requestIndex} weight must be finite`,
      );
    }
    if (
      request.opticalSize !== null && request.opticalSize !== undefined &&
      !Number.isFinite(request.opticalSize)
    ) {
      throw new RangeError(
        `glyph resource request ${requestIndex} opticalSize must be finite or null`,
      );
    }
    if (
      request.devicePixelSize !== null &&
      request.devicePixelSize !== undefined &&
      !Number.isFinite(request.devicePixelSize)
    ) {
      throw new RangeError(
        `glyph resource request ${requestIndex} devicePixelSize must be finite or null`,
      );
    }
    return Object.freeze({
      fontBytes: request.fontBytes,
      glyphIds,
      weight: request.weight,
      opticalSize: request.opticalSize ?? null,
      devicePixelSize: request.devicePixelSize ?? null,
    });
  });
}

export class GlyphResourceManager {
  constructor({
    maxEntries = DEFAULT_GLYPH_RESOURCE_LIMITS.maxEntries,
    maxBytes = DEFAULT_GLYPH_RESOURCE_LIMITS.maxBytes,
    webGpuGeneratorFactory = createWebGpuMsdfGenerator,
    glyphAtlasFactory = (fontBytes) => new GlyphAtlas(fontBytes),
  } = {}) {
    validateLimits(maxEntries, maxBytes);
    this.maxEntries = maxEntries;
    if (typeof webGpuGeneratorFactory !== "function") {
      throw new TypeError("webGpuGeneratorFactory must be a function");
    }
    this._webGpuGeneratorFactory = webGpuGeneratorFactory;
    if (typeof glyphAtlasFactory !== "function") {
      throw new TypeError("glyphAtlasFactory must be a function");
    }
    this._glyphAtlasFactory = glyphAtlasFactory;
    this.maxBytes = maxBytes;
    this._fontRecordsByDigest = new Map();
    this._fontRecordsByObject = new WeakMap();
    this._fontObjectIdentities = new WeakMap();
    this._fontObjectIdentitySequence = 0;
    this._exclusiveTail = Promise.resolve();
    this._pendingAcquisitions = new Map();
    this._pinReleaseWaiters = new Set();
    this._requestSequence = 0;
    this._resourceSequence = 0;
    this._revisionSequence = 0;
    this._closing = false;
    this._shutDown = false;
    this._selectedGenerationBackend = Object.freeze({ kind: "cpu" });
    this._webGpuGenerators = new Map();
    this._webGpuDeviceIdentities = new WeakMap();
    this._webGpuDeviceIdentitySequence = 0;
    this._counters = {
      requestCount: 0,
      hitCount: 0,
      missCount: 0,
      generatedGlyphCount: 0,
      reusedGlyphCount: 0,
      evictionCount: 0,
      replacementCount: 0,
      coalescedRequestCount: 0,
    };
  }

  async selectGenerationBackend({ kind, device = null }) {
    if (kind === "cpu" || kind === "webgl2") {
      this._selectedGenerationBackend = Object.freeze({ kind: "cpu" });
      return;
    }
    if (kind !== "webgpu" || !device) {
      throw new TypeError(
        "glyph generation backend must be cpu, webgl2, or webgpu with a device",
      );
    }
    this._selectedGenerationBackend = Object.freeze({
      kind: "webgpu",
      device,
    });
  }

  async _selectedWebGpuGenerator(glyphPerformance) {
    const { device } = this._selectedGenerationBackend;
    let generator = this._webGpuGenerators.get(device);
    if (!generator) {
      generator = await this._webGpuGeneratorFactory({ device });
      this._webGpuGenerators.set(device, generator);
      glyphPerformance.phaseMilliseconds.webGpuPipelineCreationMilliseconds +=
        generator.pipelineCreationMilliseconds;
    }
    return generator;
  }

  _runExclusive(operation) {
    let releaseExclusive;
    const previous = this._exclusiveTail;
    this._exclusiveTail = new Promise((resolve) => {
      releaseExclusive = resolve;
    });
    return previous.then(operation).finally(releaseExclusive);
  }

  async _contentDigest(fontBytes) {
    return contentDigestString(
      await crypto.subtle.digest("SHA-256", fontBytes),
    );
  }

  async _fontRecord(fontBytes) {
    // The identity cache. A hit means this exact view object produced this
    // record already; whether that is enough depends on whether the bytes
    // behind it can have moved since (see viewCanChangeUnderUs). For the
    // ordinary case — a face the registry loaded into a buffer it owns — the
    // byteLength agreeing is the whole check, and this runs once per glyph
    // request on every frame, so it has to cost nothing.
    const cachedRecord = this._fontRecordsByObject.get(fontBytes);
    if (
      cachedRecord &&
      cachedRecord.fontBytes.byteLength === fontBytes.byteLength &&
      (!viewCanChangeUnderUs(fontBytes) ||
        compareBytes(cachedRecord.fontBytes, fontBytes))
    ) {
      return cachedRecord;
    }
    const ownedFontBytes = fontBytes.slice();
    const digest = await this._contentDigest(ownedFontBytes);
    let records = this._fontRecordsByDigest.get(digest);
    if (!records) {
      records = [];
      this._fontRecordsByDigest.set(digest, records);
    }
    for (const record of records) {
      if (!compareBytes(record.fontBytes, ownedFontBytes)) continue;
      this._fontRecordsByObject.set(fontBytes, record);
      return record;
    }
    const record = {
      contentDigest: digest,
      fontBytes: ownedFontBytes,
      revision: {
        atlas: this._glyphAtlasFactory(ownedFontBytes),
        resourcesBySlot: new Map(),
        pinCount: 0,
        revision: ++this._revisionSequence,
      },
      // Assembled request atlases, keyed on the source revision and the
      // exact descriptor set (see _requestAtlasFor). A lease shares one
      // with every other lease of the same key; an idle one stays until a
      // different key displaces it, so a frame loop that re-acquires the
      // same glyphs never rebuilds.
      requestAtlases: new Map(),
    };
    records.push(record);
    this._fontRecordsByObject.set(fontBytes, record);
    return record;
  }

  _allFontRecords() {
    return [...this._fontRecordsByDigest.values()].flat();
  }

  _entryCount() {
    let count = 0;
    for (const fontRecord of this._allFontRecords()) {
      count += fontRecord.revision.resourcesBySlot.size;
    }
    return count;
  }

  _byteLength() {
    let byteLength = 0;
    for (const fontRecord of this._allFontRecords()) {
      const { atlas, resourcesBySlot } = fontRecord.revision;
      if (resourcesBySlot.size > 0) {
        byteLength += NATIVE_GLYPH_ATLAS_FIXED_BYTE_LENGTH +
          fontRecord.fontBytes.byteLength;
      }
      for (const resource of resourcesBySlot.values()) {
        byteLength += resource.pixelByteLength;
      }
      byteLength += atlas.atlasWidth * atlas.atlasHeight * 4;
    }
    return byteLength;
  }

  _pinnedRevisionCount() {
    let count = 0;
    for (const fontRecord of this._allFontRecords()) {
      if (fontRecord.revision.pinCount > 0) count++;
    }
    return count;
  }

  _waitForPinRelease() {
    return new Promise((resolve) => this._pinReleaseWaiters.add(resolve));
  }

  _notifyPinRelease() {
    const waiters = [...this._pinReleaseWaiters];
    this._pinReleaseWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  _leastRecentlyUsedResource(excludedResources) {
    let selected = null;
    for (const fontRecord of this._allFontRecords()) {
      const revision = fontRecord.revision;
      if (revision.pinCount > 0) continue;
      for (const resource of revision.resourcesBySlot.values()) {
        if (excludedResources.has(resource)) continue;
        if (
          selected === null || resource.lastUsed < selected.resource.lastUsed ||
          (resource.lastUsed === selected.resource.lastUsed &&
            resource.creationSequence < selected.resource.creationSequence)
        ) {
          selected = { fontRecord, resource };
        }
      }
    }
    return selected;
  }

  async _replaceRevision(
    fontRecord,
    retainedResources,
    addedDescriptors = [],
    glyphPerformance = null,
  ) {
    const previousRevision = fontRecord.revision;
    if (previousRevision.pinCount > 0) {
      throw new Error("cannot replace a pinned glyph atlas revision");
    }
    const atlas = this._glyphAtlasFactory(fontRecord.fontBytes);
    const resourcesBySlot = new Map();
    const replacementRevision = {
      atlas,
      resourcesBySlot,
      pinCount: 0,
      revision: ++this._revisionSequence,
    };
    const generationCountBefore = atlas.generationCount;
    try {
      for (const resource of retainedResources) {
        const descriptor = resource.descriptor;
        const sourceSlot = previousRevision.atlas.glyphSlot(
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        await atlas.copyGlyphFrom(
          previousRevision.atlas,
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        const destinationSlot = atlas.glyphSlot(
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        if (destinationSlot < 0) {
          throw new Error("retained glyph resource is not readable");
        }
        const retained = { ...resource, sourceSlot };
        resourcesBySlot.set(destinationSlot, retained);
        if (
          this._selectedGenerationBackend.kind === "cpu" &&
          retained.preparedGeometry
        ) {
          atlas.hydratePreparedGlyphForCpu({
            ...descriptor,
            preparedGeometry: retained.preparedGeometry,
            advance: retained.advance,
          });
        }
      }
      fontRecord.revision = replacementRevision;
      if (addedDescriptors.length > 0) {
        await this._ensureDescriptors(
          fontRecord,
          addedDescriptors,
          glyphPerformance,
          addedDescriptors[0].lastUsed,
          previousRevision.atlas,
        );
      } else {
        glyphPerformance.phaseMilliseconds
          .atlasRebuildAndPackingMilliseconds += atlas.rebuildAtlas();
        if (
          this._selectedGenerationBackend.kind === "webgpu" &&
          previousRevision.atlas.webGpuTexture(
            this._selectedGenerationBackend.device,
          )
        ) {
          const descriptors = [...resourcesBySlot.values()].map((resource) => ({
            ...resource.descriptor,
            resourceSlot: resource.sourceSlot,
          }));
          const generator = await this._selectedWebGpuGenerator(
            glyphPerformance,
          );
          const { copyMilliseconds } = await atlas.rebuildWebGpuTexture(
            generator,
            [],
            descriptors,
            previousRevision.atlas,
          );
          glyphPerformance.phaseMilliseconds.directAtlasCopyMilliseconds +=
            copyMilliseconds;
        }
        replacementRevision.revision = ++this._revisionSequence;
        this._counters.generatedGlyphCount += atlas.generationCount -
          generationCountBefore;
      }
    } catch (error) {
      fontRecord.revision = previousRevision;
      atlas.destroy();
      throw error;
    }
    previousRevision.atlas.destroy();
    this._counters.replacementCount++;
    if (resourcesBySlot.size === 0) {
      atlas.destroy();
      this._forgetRequestAtlases(fontRecord);
      const records = this._fontRecordsByDigest.get(fontRecord.contentDigest);
      const index = records.indexOf(fontRecord);
      records.splice(index, 1);
      if (records.length === 0) {
        this._fontRecordsByDigest.delete(fontRecord.contentDigest);
      }
    }
  }

  // Destroy every cached request atlas of the record that no lease holds,
  // except `keep`: a new key displaces the idle one. A held atlas is
  // destroyed by its last release.
  _destroyIdleRequestAtlases(fontRecord, keep) {
    for (const [key, entry] of fontRecord.requestAtlases) {
      if (entry === keep || entry.leaseCount > 0) continue;
      fontRecord.requestAtlases.delete(key);
      entry.atlas.destroy();
    }
  }

  // The record goes away (or the manager shuts down): idle atlases are
  // destroyed now, held ones are detached so their last release destroys
  // them (_releaseRequestAtlas).
  _forgetRequestAtlases(fontRecord) {
    this._destroyIdleRequestAtlases(fontRecord, null);
    fontRecord.requestAtlases = new Map();
  }

  // The request atlas for one font record and one sorted descriptor list:
  // the cached one when the source revision and descriptors match, else a
  // fresh assembly (a copy of every glyph from the source, one repack, and
  // on the WebGPU generation backend one texture assembled by copies).
  // Before this cache every acquire assembled anew, so a full command
  // publication paid the copies, the repack and one upload per atlas per
  // frame for a glyph set that had not changed
  // (plans/dom/PLAN-raster-frame-costs.md, item 1).
  async _requestAtlasFor(fontRecord, descriptors, glyphPerformance) {
    // The backend is part of the key: a WebGPU-generated request atlas
    // carries its pixels on the device only, a CPU one in wasm memory.
    const backend = this._selectedGenerationBackend;
    let key = backend.kind === "webgpu"
      ? `webgpu:${this._webGpuDeviceIdentities.get(backend.device)}`
      : backend.kind;
    key += `@${fontRecord.revision.revision}`;
    for (const descriptor of descriptors) {
      key += `|${descriptor.glyphId}:${descriptor.weight}:${
        descriptor.opticalSize ?? ""
      }:${descriptor.devicePixelSize ?? ""}`;
    }
    const cached = fontRecord.requestAtlases.get(key);
    if (cached) {
      cached.leaseCount++;
      return cached;
    }
    const atlas = this._glyphAtlasFactory(fontRecord.fontBytes);
    try {
      for (const descriptor of descriptors) {
        await atlas.copyGlyphFrom(
          fontRecord.revision.atlas,
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
      }
      glyphPerformance.phaseMilliseconds.atlasRebuildAndPackingMilliseconds +=
        atlas.rebuildAtlas();
      if (this._selectedGenerationBackend.kind === "webgpu") {
        const { copyMilliseconds } = atlas.createRequestWebGpuTexture(
          this._selectedGenerationBackend.device,
          fontRecord.revision.atlas,
          descriptors,
        );
        glyphPerformance.phaseMilliseconds.directAtlasCopyMilliseconds +=
          copyMilliseconds;
      }
    } catch (error) {
      atlas.destroy();
      throw error;
    }
    const entry = { atlas, leaseCount: 1, fontRecord, key };
    this._destroyIdleRequestAtlases(fontRecord, entry);
    fontRecord.requestAtlases.set(key, entry);
    return entry;
  }

  _releaseRequestAtlas(entry) {
    entry.leaseCount--;
    // Kept while it is the record's current assembly; displaced or torn
    // down by _destroyIdleRequestAtlases. A record that already went away
    // (or a manager that shut down) has nothing holding it: destroy now.
    if (
      entry.leaseCount === 0 &&
      entry.fontRecord.requestAtlases.get(entry.key) !== entry
    ) {
      entry.atlas.destroy();
    }
  }

  async _evictResources(victimsByFontRecord, glyphPerformance) {
    for (const [fontRecord, victims] of victimsByFontRecord) {
      const retainedResources = [
        ...fontRecord.revision.resourcesBySlot.values(),
      ]
        .filter((resource) => !victims.has(resource))
        .sort((first, second) =>
          first.creationSequence - second.creationSequence
        );
      await this._replaceRevision(
        fontRecord,
        retainedResources,
        [],
        glyphPerformance,
      );
      this._counters.evictionCount += victims.size;
    }
  }

  async _ensureDescriptors(
    fontRecord,
    descriptors,
    glyphPerformance,
    requestSequence,
    sourceAtlas = fontRecord.revision.atlas,
  ) {
    const revision = fontRecord.revision;
    const atlas = revision.atlas;
    const generationCountBefore = atlas.generationCount;
    const useWebGpu = this._selectedGenerationBackend.kind === "webgpu" &&
      descriptors.length >= 2;
    const generatedByGlyphId = new Map();

    if (useWebGpu) {
      const groups = new Map();
      for (const descriptor of descriptors) {
        const identity = JSON.stringify([
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        ]);
        let group = groups.get(identity);
        if (!group) {
          group = [];
          groups.set(identity, group);
        }
        group.push(descriptor);
      }
      for (const group of groups.values()) {
        const first = group[0];
        const ensured = await atlas.prepareGlyphsForWebGpu(
          group.map((descriptor) => descriptor.glyphId),
          first.weight,
          first.opticalSize,
          first.devicePixelSize,
        );
        accumulateGlyphPerformance(
          glyphPerformance,
          ensured,
          first,
          true,
        );
        for (const glyph of ensured.generatedGlyphs) {
          generatedByGlyphId.set(glyph.glyphId, glyph);
        }
      }
    } else {
      for (const descriptor of descriptors) {
        const ensured = await atlas.ensureGlyphs(
          [descriptor.glyphId],
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        accumulateGlyphPerformance(
          glyphPerformance,
          ensured,
          descriptor,
          true,
        );
      }
    }

    for (const descriptor of descriptors) {
      const slot = atlas.glyphSlot(
        descriptor.glyphId,
        descriptor.weight,
        descriptor.opticalSize,
        descriptor.devicePixelSize,
      );
      if (slot < 0) {
        throw new Error("generated glyph resource is not readable");
      }
      let resource = revision.resourcesBySlot.get(slot);
      if (!resource) {
        const glyphInformation = atlas.glyphInfo(
          descriptor.glyphId,
          descriptor.weight,
          descriptor.opticalSize,
          descriptor.devicePixelSize,
        );
        const prepared = generatedByGlyphId.get(descriptor.glyphId);
        resource = {
          descriptor,
          creationSequence: ++this._resourceSequence,
          lastUsed: requestSequence,
          pixelByteLength: glyphInformation.w * glyphInformation.h * 3,
          preparedGeometry: prepared?.preparedGeometry ?? null,
          advance: prepared?.advance ?? null,
        };
        revision.resourcesBySlot.set(slot, resource);
      } else {
        resource.lastUsed = requestSequence;
      }
    }

    glyphPerformance.phaseMilliseconds.atlasRebuildAndPackingMilliseconds +=
      atlas.rebuildAtlas();
    if (useWebGpu) {
      const allDescriptors = [...revision.resourcesBySlot.entries()].map(
        ([slot, resource]) => ({
          ...resource.descriptor,
          resourceSlot: resource.sourceSlot ?? slot,
        }),
      );
      const generator = await this._selectedWebGpuGenerator(glyphPerformance);
      const { generationTimings, copyMilliseconds } = await atlas
        .rebuildWebGpuTexture(
          generator,
          [...generatedByGlyphId.values()],
          allDescriptors,
          sourceAtlas,
        );
      glyphPerformance.phaseMilliseconds.directAtlasCopyMilliseconds +=
        copyMilliseconds;
      if (generationTimings) {
        glyphPerformance.phaseMilliseconds.webGpuCpuPackingMilliseconds +=
          generationTimings.cpuPackMilliseconds;
        glyphPerformance.phaseMilliseconds.webGpuUploadMilliseconds +=
          generationTimings.uploadMilliseconds;
        glyphPerformance.phaseMilliseconds.webGpuEncodeMilliseconds += Math.max(
          0,
          generationTimings.encodeMilliseconds -
            generationTimings.directAtlasPopulationMilliseconds,
        );
        glyphPerformance.phaseMilliseconds.webGpuSubmitMilliseconds +=
          generationTimings.submitMilliseconds;
        glyphPerformance.phaseMilliseconds.webGpuCompletionMilliseconds +=
          generationTimings.completionMilliseconds;
        glyphPerformance.phaseMilliseconds.directAtlasPopulationMilliseconds +=
          generationTimings.directAtlasPopulationMilliseconds;
      }
    }
    revision.revision = ++this._revisionSequence;
    this._counters.generatedGlyphCount += atlas.generationCount -
      generationCountBefore;
  }
  async _acquireNormalized(normalizedRequests, acquisitionStartedAt) {
    if (this._closing || this._shutDown) {
      throw new Error("glyph resource manager is shut down");
    }
    const glyphPerformance = {
      requestedGlyphCount: normalizedRequests.reduce(
        (count, request) => count + request.glyphIds.length,
        0,
      ),
      generatedGlyphs: [],
      phaseMilliseconds: Object.fromEntries(
        GLYPH_PERFORMANCE_PHASE_FIELDS.map((field) => [field, 0]),
      ),
    };
    this._counters.requestCount++;
    const requestSequence = ++this._requestSequence;
    const resolvedRequests = [];
    for (const [requestIndex, request] of normalizedRequests.entries()) {
      resolvedRequests.push({
        request,
        requestIndex,
        fontRecord: await this._fontRecord(request.fontBytes),
      });
    }

    while (true) {
      const missingDescriptors = [];
      const requestedResources = new Set();
      const modifyingFontRecords = new Set();
      let hitCount = 0;
      let missCount = 0;

      for (const { request, requestIndex, fontRecord } of resolvedRequests) {
        const revision = fontRecord.revision;
        const slots = revision.atlas.glyphResidency(
          request.glyphIds,
          request.weight,
          request.opticalSize,
          request.devicePixelSize,
        );
        for (
          let glyphIndex = 0;
          glyphIndex < request.glyphIds.length;
          glyphIndex++
        ) {
          const glyphId = request.glyphIds[glyphIndex];
          const slot = slots[glyphIndex];
          const resource = slot < 0 ? null : revision.resourcesBySlot.get(slot);
          if (resource) {
            resource.lastUsed = requestSequence;
            requestedResources.add(resource);
            hitCount++;
          } else {
            missingDescriptors.push({
              fontRecord,
              requestIndex,
              glyphId,
              weight: request.weight,
              opticalSize: request.opticalSize,
              devicePixelSize: request.devicePixelSize,
              lastUsed: requestSequence,
            });
            modifyingFontRecords.add(fontRecord);
            missCount++;
          }
        }
      }

      const pinnedModification = [...modifyingFontRecords].some((fontRecord) =>
        fontRecord.revision.pinCount > 0
      );
      if (pinnedModification) {
        await this._waitForPinRelease();
        continue;
      }

      const victimsByFontRecord = new Map();
      let excessEntries = this._entryCount() + missingDescriptors.length -
        this.maxEntries;
      while (excessEntries > 0) {
        const selected = this._leastRecentlyUsedResource(requestedResources);
        if (!selected) {
          if (this._pinnedRevisionCount() > 0) {
            await this._waitForPinRelease();
            break;
          }
          throw new RangeError(
            "one glyph resource request exceeds the configured entry limit",
          );
        }
        requestedResources.add(selected.resource);
        let victims = victimsByFontRecord.get(selected.fontRecord);
        if (!victims) {
          victims = new Set();
          victimsByFontRecord.set(selected.fontRecord, victims);
        }
        victims.add(selected.resource);
        excessEntries--;
      }
      if (excessEntries > 0) continue;

      for (const [fontRecord, victims] of victimsByFontRecord) {
        const descriptors = missingDescriptors.filter((descriptor) =>
          descriptor.fontRecord === fontRecord
        );
        const retainedResources = [
          ...fontRecord.revision.resourcesBySlot.values(),
        ]
          .filter((resource) => !victims.has(resource))
          .sort((first, second) =>
            first.creationSequence - second.creationSequence
          );
        await this._replaceRevision(
          fontRecord,
          retainedResources,
          descriptors,
          glyphPerformance,
        );
        this._counters.evictionCount += victims.size;
      }

      const replacedFontRecords = new Set(victimsByFontRecord.keys());
      for (const fontRecord of modifyingFontRecords) {
        if (replacedFontRecords.has(fontRecord)) continue;
        const descriptors = missingDescriptors.filter((descriptor) =>
          descriptor.fontRecord === fontRecord
        );
        await this._ensureDescriptors(
          fontRecord,
          descriptors,
          glyphPerformance,
          requestSequence,
        );
      }

      for (const { request, fontRecord } of resolvedRequests) {
        const slots = fontRecord.revision.atlas.glyphResidency(
          request.glyphIds,
          request.weight,
          request.opticalSize,
          request.devicePixelSize,
        );
        for (
          let glyphIndex = 0;
          glyphIndex < request.glyphIds.length;
          glyphIndex++
        ) {
          const resource = fontRecord.revision.resourcesBySlot.get(
            slots[glyphIndex],
          );
          if (!resource) {
            throw new Error("requested glyph resource was evicted");
          }
          resource.lastUsed = requestSequence;
          requestedResources.add(resource);
        }
      }

      if (this._selectedGenerationBackend.kind === "cpu") {
        for (
          const fontRecord of new Set(
            resolvedRequests.map(({ fontRecord }) => fontRecord),
          )
        ) {
          const generationCountBefore =
            fontRecord.revision.atlas.generationCount;
          let hydrated = false;
          for (const resource of requestedResources) {
            if (
              resource.descriptor.fontRecord !== fontRecord ||
              !resource.preparedGeometry ||
              resource.cpuHydrated
            ) continue;
            const result = fontRecord.revision.atlas
              .hydratePreparedGlyphForCpu({
                ...resource.descriptor,
                preparedGeometry: resource.preparedGeometry,
                advance: resource.advance,
              });
            for (const field of GLYPH_PERFORMANCE_PHASE_FIELDS) {
              glyphPerformance.phaseMilliseconds[field] +=
                result.phaseMilliseconds[field];
            }
            resource.cpuHydrated = true;
            hydrated = true;
          }
          if (hydrated) {
            glyphPerformance.phaseMilliseconds
              .atlasRebuildAndPackingMilliseconds += fontRecord.revision.atlas
                .rebuildAtlas();
            this._counters.generatedGlyphCount +=
              fontRecord.revision.atlas.generationCount -
              generationCountBefore;
          }
        }
      }

      while (this._byteLength() > this.maxBytes) {
        const selected = this._leastRecentlyUsedResource(requestedResources);
        if (!selected) {
          if (this._pinnedRevisionCount() > 0) {
            await this._waitForPinRelease();
            continue;
          }
          throw new RangeError(
            "one glyph resource request exceeds the configured byte limit",
          );
        }
        await this._evictResources(
          new Map([[selected.fontRecord, new Set([selected.resource])]]),
          glyphPerformance,
        );
      }

      if (this._selectedGenerationBackend.kind === "webgpu") {
        for (
          const fontRecord of new Set(
            resolvedRequests.map(({ fontRecord }) => fontRecord),
          )
        ) {
          const atlas = fontRecord.revision.atlas;
          if (
            ![...fontRecord.revision.resourcesBySlot.values()].some(
              (resource) => resource.preparedGeometry,
            )
          ) continue;
          if (atlas.webGpuTexture(this._selectedGenerationBackend.device)) {
            continue;
          }
          const generatedGlyphs = [];
          const descriptors = [];
          for (const [slot, resource] of fontRecord.revision.resourcesBySlot) {
            descriptors.push({
              ...resource.descriptor,
              resourceSlot: slot,
            });
            if (!resource.preparedGeometry) continue;
            const information = atlas.glyphInfo(
              resource.descriptor.glyphId,
              resource.descriptor.weight,
              resource.descriptor.opticalSize,
              resource.descriptor.devicePixelSize,
            );
            generatedGlyphs.push({
              ...resource.descriptor,
              width: information.w,
              height: information.h,
              preparedGeometry: resource.preparedGeometry,
            });
          }
          const generator = await this._selectedWebGpuGenerator(
            glyphPerformance,
          );
          const { generationTimings, copyMilliseconds } = await atlas
            .rebuildWebGpuTexture(
              generator,
              generatedGlyphs,
              descriptors,
            );
          glyphPerformance.phaseMilliseconds.directAtlasCopyMilliseconds +=
            copyMilliseconds;
          if (generationTimings) {
            glyphPerformance.phaseMilliseconds.webGpuCpuPackingMilliseconds +=
              generationTimings.cpuPackMilliseconds;
            glyphPerformance.phaseMilliseconds.webGpuUploadMilliseconds +=
              generationTimings.uploadMilliseconds;
            glyphPerformance.phaseMilliseconds.webGpuEncodeMilliseconds += Math
              .max(
                0,
                generationTimings.encodeMilliseconds -
                  generationTimings.directAtlasPopulationMilliseconds,
              );
            glyphPerformance.phaseMilliseconds.webGpuSubmitMilliseconds +=
              generationTimings.submitMilliseconds;
            glyphPerformance.phaseMilliseconds.webGpuCompletionMilliseconds +=
              generationTimings.completionMilliseconds;
            glyphPerformance.phaseMilliseconds
              .directAtlasPopulationMilliseconds +=
                generationTimings.directAtlasPopulationMilliseconds;
          }
        }
      }

      const requestAtlasesByFontRecord = new Map();
      try {
        for (
          const fontRecord of new Set(
            resolvedRequests.map(({ fontRecord }) => fontRecord),
          )
        ) {
          const descriptors = [];
          const includedResources = new Set();
          for (
            const { request, fontRecord: requestedFontRecord }
              of resolvedRequests
          ) {
            if (requestedFontRecord !== fontRecord) continue;
            const slots = fontRecord.revision.atlas.glyphResidency(
              request.glyphIds,
              request.weight,
              request.opticalSize,
              request.devicePixelSize,
            );
            for (
              let glyphIndex = 0;
              glyphIndex < request.glyphIds.length;
              glyphIndex++
            ) {
              const glyphId = request.glyphIds[glyphIndex];
              const resource = fontRecord.revision.resourcesBySlot.get(
                slots[glyphIndex],
              );
              if (!resource) {
                throw new Error(
                  "requested glyph resource is not available for assembly",
                );
              }
              if (includedResources.has(resource)) continue;
              includedResources.add(resource);
              descriptors.push({
                glyphId,
                weight: request.weight,
                opticalSize: request.opticalSize,
                devicePixelSize: request.devicePixelSize,
              });
            }
          }
          descriptors.sort((first, second) =>
            first.glyphId - second.glyphId ||
            first.weight - second.weight ||
            (first.opticalSize ?? Number.NEGATIVE_INFINITY) -
              (second.opticalSize ?? Number.NEGATIVE_INFINITY) ||
            (first.devicePixelSize ?? Number.NEGATIVE_INFINITY) -
              (second.devicePixelSize ?? Number.NEGATIVE_INFINITY)
          );
          requestAtlasesByFontRecord.set(
            fontRecord,
            await this._requestAtlasFor(
              fontRecord,
              descriptors,
              glyphPerformance,
            ),
          );
        }
      } catch (error) {
        for (const entry of requestAtlasesByFontRecord.values()) {
          this._releaseRequestAtlas(entry);
        }
        throw error;
      }

      const pinnedRevisions = new Set();
      const atlases = resolvedRequests.map(({ fontRecord }) => {
        const revision = fontRecord.revision;
        if (!pinnedRevisions.has(revision)) {
          revision.pinCount++;
          pinnedRevisions.add(revision);
        }
        return requestAtlasesByFontRecord.get(fontRecord).atlas;
      });
      this._counters.hitCount += hitCount;
      this._counters.reusedGlyphCount += hitCount;
      this._counters.missCount += missCount;

      const measuredMilliseconds = Object.values(
        glyphPerformance.phaseMilliseconds,
      ).reduce((total, milliseconds) => total + milliseconds, 0);
      const unmeasuredMilliseconds = Math.max(
        0,
        performance.now() - acquisitionStartedAt - measuredMilliseconds,
      );
      if (missCount === 0 && hitCount > 0) {
        glyphPerformance.phaseMilliseconds.cacheReuseMilliseconds +=
          unmeasuredMilliseconds;
      } else {
        glyphPerformance.phaseMilliseconds.otherPreparationMilliseconds +=
          unmeasuredMilliseconds;
      }
      const phaseMilliseconds = Object.freeze({
        ...glyphPerformance.phaseMilliseconds,
      });
      const generatedGlyphs = Object.freeze(
        glyphPerformance.generatedGlyphs.map((glyph) => Object.freeze(glyph)),
      );
      const acquisitionPerformance = Object.freeze({
        requestedGlyphCount: glyphPerformance.requestedGlyphCount,
        cacheHitGlyphCount: glyphPerformance.requestedGlyphCount -
          generatedGlyphs.length,
        generatedGlyphCount: generatedGlyphs.length,
        outputTexelCount: generatedGlyphs.reduce(
          (total, glyph) => total + glyph.texelCount,
          0,
        ),
        generatedGlyphs,
        phaseMilliseconds,
        generationBackend: phaseMilliseconds.webGpuCompletionMilliseconds > 0
          ? "webgpu-batch"
          : generatedGlyphs.length === 1
          ? "cpu-single"
          : generatedGlyphs.length > 1
          ? "cpu-batch"
          : "cache-reuse",
        directAtlasPopulation:
          phaseMilliseconds.directAtlasPopulationMilliseconds > 0,
        totalMilliseconds: Object.values(phaseMilliseconds).reduce(
          (total, milliseconds) => total + milliseconds,
          0,
        ),
      });

      let released = false;
      let sourcePinsReleased = false;
      // Request atlases own copies of every glyph/texture they expose. A
      // completed renderer may retain those snapshots without blocking a
      // different surface from extending or evicting the shared source atlas.
      const releaseSourcePins = () => {
        if (sourcePinsReleased) return;
        sourcePinsReleased = true;
        for (const revision of pinnedRevisions) revision.pinCount--;
        this._notifyPinRelease();
      };
      return Object.freeze({
        atlases: Object.freeze(atlases),
        revisions: Object.freeze(
          [...pinnedRevisions].map((revision) => revision.revision),
        ),
        glyphPerformance: acquisitionPerformance,
        releaseSourcePins,
        release: () => {
          if (released) return;
          released = true;
          const errors = [];
          for (const entry of requestAtlasesByFontRecord.values()) {
            try {
              this._releaseRequestAtlas(entry);
            } catch (error) {
              errors.push(error);
            }
          }
          releaseSourcePins();
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              "glyph request atlas graphics resource release failed",
            );
          }
        },
      });
    }
  }

  async acquire(
    requests,
    { generationBackend = null, signal = null } = {},
  ) {
    throwIfAborted(signal);
    const acquisitionStartedAt = performance.now();
    const normalizedRequests = normalizeRequests(requests);
    const backend = generationBackend ?? this._selectedGenerationBackend;
    let backendIdentity = backend.kind;
    if (backend.kind === "webgpu") {
      let deviceIdentity = this._webGpuDeviceIdentities.get(backend.device);
      if (deviceIdentity === undefined) {
        deviceIdentity = ++this._webGpuDeviceIdentitySequence;
        this._webGpuDeviceIdentities.set(backend.device, deviceIdentity);
      }
      backendIdentity += `:${deviceIdentity}`;
    }
    const requestIdentity = normalizedRequests.map((request) => {
      let fontObjectIdentity = this._fontObjectIdentities.get(
        request.fontBytes,
      );
      if (fontObjectIdentity === undefined) {
        fontObjectIdentity = ++this._fontObjectIdentitySequence;
        this._fontObjectIdentities.set(request.fontBytes, fontObjectIdentity);
      }
      return [
        GLYPH_RESOURCE_FORMAT_VERSION,
        backendIdentity,
        fontObjectIdentity,
        request.weight,
        request.opticalSize,
        request.devicePixelSize,
        request.glyphIds,
      ];
    });
    const identity = JSON.stringify(requestIdentity);
    const pending = this._pendingAcquisitions.get(identity);
    if (pending) {
      this._counters.coalescedRequestCount++;
      await pending;
      throwIfAborted(signal);
    }
    const operation = this._runExclusive(async () => {
      await this.selectGenerationBackend(backend);
      return await this._acquireNormalized(
        normalizedRequests,
        acquisitionStartedAt,
      );
    });
    this._pendingAcquisitions.set(identity, operation);
    try {
      const lease = await operation;
      try {
        throwIfAborted(signal);
      } catch (abortReason) {
        try {
          lease.release();
        } catch (releaseError) {
          throw new AggregateError(
            [abortReason, releaseError],
            "aborted glyph acquisition failed to release its lease",
          );
        }
        throw abortReason;
      }
      return lease;
    } finally {
      if (this._pendingAcquisitions.get(identity) === operation) {
        this._pendingAcquisitions.delete(identity);
      }
    }
  }

  async prewarm(requests, options = {}) {
    const lease = await this.acquire(requests, options);
    const glyphPerformance = lease.glyphPerformance;
    lease.release();
    return Object.freeze({
      glyphPerformance,
      cache: this.snapshot(),
    });
  }

  snapshot() {
    return Object.freeze({
      formatVersion: GLYPH_RESOURCE_FORMAT_VERSION,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      entryCount: this._entryCount(),
      byteLength: this._byteLength(),
      fontContentCount: this._allFontRecords().length,
      pinnedRevisionCount: this._pinnedRevisionCount(),
      shutDown: this._shutDown,
      ...this._counters,
    });
  }

  async shutdown() {
    if (this._shutDown) return;
    this._closing = true;
    await this._runExclusive(async () => {
      while (this._pinnedRevisionCount() > 0) await this._waitForPinRelease();
      const errors = [];
      for (const fontRecord of this._allFontRecords()) {
        try {
          fontRecord.revision.atlas.destroy();
          this._forgetRequestAtlases(fontRecord);
        } catch (error) {
          errors.push(error);
        }
        fontRecord.revision.resourcesBySlot.clear();
      }
      for (const generator of this._webGpuGenerators.values()) {
        try {
          generator.shutdown();
        } catch (error) {
          errors.push(error);
        }
      }
      this._webGpuGenerators.clear();
      this._fontRecordsByDigest.clear();
      this._shutDown = true;
      if (errors.length > 0) {
        throw new AggregateError(errors, "glyph resource shutdown failed");
      }
    });
  }
}

let defaultGlyphResourceManager = null;

export function getDefaultGlyphResourceManager() {
  if (
    !defaultGlyphResourceManager ||
    defaultGlyphResourceManager.snapshot().shutDown
  ) {
    defaultGlyphResourceManager = new GlyphResourceManager();
  }
  return defaultGlyphResourceManager;
}

export async function shutdownDefaultGlyphResourceManager() {
  const manager = defaultGlyphResourceManager;
  defaultGlyphResourceManager = null;
  if (manager) await manager.shutdown();
}
