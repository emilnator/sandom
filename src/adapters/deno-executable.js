import { constants as fileConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function executableFile(candidate) {
  try {
    await access(candidate, fileConstants.X_OK);
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export async function resolveDenoExecutable(
  candidate = "deno",
  {
    denoExecPath = typeof globalThis.Deno?.execPath === "function"
      ? () => globalThis.Deno.execPath()
      : null,
    pathValue = undefined,
    cwd = process.cwd(),
    platform = process.platform,
    isExecutable = executableFile,
  } = {},
) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new TypeError("denoExecutable must be a nonempty string");
  }
  if (candidate === "deno" && denoExecPath !== null) {
    return path.resolve(denoExecPath());
  }
  const hasPathSeparator = candidate.includes("/") || candidate.includes("\\");
  const candidates = [];
  if (path.isAbsolute(candidate) || hasPathSeparator) {
    candidates.push(path.resolve(cwd, candidate));
  } else {
    const hostPath = pathValue ?? process.env.PATH ?? "";
    const extensions = platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
    for (const directory of hostPath.split(path.delimiter)) {
      if (!directory) continue;
      for (const extension of extensions) {
        candidates.push(path.resolve(directory, `${candidate}${extension}`));
      }
    }
  }
  for (const executable of candidates) {
    if (await isExecutable(executable)) return executable;
  }
  throw new Error(
    `Cannot resolve Deno executable ${JSON.stringify(candidate)}. Searched: ${
      candidates.length > 0 ? candidates.join(", ") : "an empty host PATH"
    }. Supply an absolute denoExecutable path.`,
  );
}
