// Host file-access seam.
//
// Sandom runs on Deno, Node, Bun (all of which expose the file system
// through the `node:fs` compatibility modules), and browsers (which have
// no file system and load every asset over fetch). This module is the one
// place that knows the difference. No other sandom module may branch on
// the runtime for file access.
// The dynamic imports below resolve on Deno, Node, and Bun. A browser
// gets no import attempt at all: an unconditional import("node:fs")
// would be caught and resolved to null just the same, but Chrome logs a
// console error for the failed request that no catch can suppress, so
// the attempt is gated on the host advertising node compatibility.
// This module is the single place allowed to inspect the runtime.

const hostProvidesNodeModules = globalThis.Deno !== undefined ||
  globalThis.process?.versions !== undefined;

// Note the statement shape: `await import(...)` at statement start.
// Node's CJS/ESM detection for extensionless-package .js files accepts
// this form but misparses the same await inside a ternary expression as
// CommonJS and fails the import (verified on Node 24.4).
let nodeFileSystemPromises = null;
let nodeFileSystem = null;
let nodeModule = null;
if (hostProvidesNodeModules) {
  nodeFileSystemPromises = await import("node:fs/promises");
  nodeFileSystem = await import("node:fs");
  nodeModule = await import("node:module");
}

// True when the host can read local files (Deno, Node, Bun). False in a
// browser, where callers must resolve sources to fetchable URLs instead.
export const hasFileSystem = nodeFileSystemPromises !== null;

// Resolves a package export to its installed file on file-backed hosts. This is
// the asset equivalent of module resolution; browsers instead use their import
// map through import.meta.resolve and fetch the resulting URL.
export function resolvePackageFile(specifier, parentURL) {
  if (nodeModule === null) {
    throw new Error(`resolvePackageFile: this host has no package filesystem for ${specifier}`);
  }
  return nodeModule.createRequire(parentURL).resolve(specifier);
}

function toUint8Array(buffer) {
  return buffer instanceof Uint8Array && buffer.constructor === Uint8Array
    ? buffer
    : new Uint8Array(
      buffer.buffer ?? buffer,
      buffer.byteOffset ?? 0,
      buffer.byteLength,
    );
}

// Reads binary bytes from a URL object, an absolute URL string, or a bare
// file path. file: URLs and bare paths use the file system; every other
// URL uses fetch and throws on a non-OK response.
export async function readBinaryFile(source) {
  let url = source instanceof URL ? source : null;
  if (url === null && typeof source === "string") {
    try {
      url = new URL(source);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      // Bare path: no scheme. Only a file system can serve it.
    }
  }

  if (url === null || url.protocol === "file:") {
    if (!hasFileSystem) {
      throw new Error(
        `readBinaryFile: this host has no file system access for ${source}`,
      );
    }
    return toUint8Array(await nodeFileSystemPromises.readFile(url ?? source));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `readBinaryFile: HTTP ${response.status} for ${url}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

let freshModuleSequence = 0;

// Imports one module instance without sharing top-level evaluation with a
// prior operation. File-backed hosts evaluate a short-lived sibling copy from
// the supplied bytes. The sibling preserves static relative imports and
// import.meta.url resource resolution while preventing source drift.
export async function importFreshModule(source, bytes) {
  const sourceURL = source instanceof URL
    ? new URL(source.href)
    : new URL(source);
  const identifier =
    `${Date.now()}-${++freshModuleSequence}-${crypto.randomUUID()}`;
  if (!hasFileSystem) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("importFreshModule requires Uint8Array bytes");
    }
    const moduleURL = URL.createObjectURL(
      new Blob([bytes], {
        type: "text/javascript",
      }),
    );
    try {
      return await import(moduleURL);
    } finally {
      URL.revokeObjectURL(moduleURL);
    }
  }
  if (sourceURL.protocol === "file:") {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("importFreshModule requires Uint8Array bytes");
    }
    const extensionIndex = sourceURL.pathname.lastIndexOf(".");
    const slashIndex = sourceURL.pathname.lastIndexOf("/");
    const extension = extensionIndex > slashIndex
      ? sourceURL.pathname.slice(extensionIndex)
      : ".js";
    const temporaryURL = new URL(
      `.sandom-module-${identifier}${extension}`,
      new URL(".", sourceURL),
    );
    await nodeFileSystemPromises.writeFile(temporaryURL, bytes);
    let evaluationError = null;
    try {
      return await import(temporaryURL.href);
    } catch (error) {
      evaluationError = error;
      throw error;
    } finally {
      try {
        await nodeFileSystemPromises.unlink(temporaryURL);
      } catch (cleanupError) {
        if (evaluationError) {
          throw new AggregateError(
            [evaluationError, cleanupError],
            `Module evaluation and temporary module cleanup failed for ${sourceURL.href}`,
          );
        }
        throw cleanupError;
      }
    }
  }
  sourceURL.searchParams.set("sandom-preparation", identifier);
  return await import(sourceURL.href);
}

// Synchronous variant for the built-in-font fast path. Only valid on a
// host with a file system and only for file: URLs.
export function readBinaryFileSync(url) {
  if (!hasFileSystem || url.protocol !== "file:") {
    throw new Error(
      `readBinaryFileSync: no synchronous file access for ${url}`,
    );
  }
  return toUint8Array(nodeFileSystem.readFileSync(url));
}
