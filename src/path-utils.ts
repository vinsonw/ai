import { realpath } from "node:fs/promises";
import path from "node:path";

/** Normalize `path.relative()` or git path output for prefix checks against POSIX constants. */
export function relativePosix(relative: string): string {
  return relative.split(/[/\\]/).join("/");
}

export function posixifyRepoRelativePath(file: string): string {
  return file.replaceAll("\\", "/");
}

export function escapesRepositoryRelative(relative: string): boolean {
  const posix = relativePosix(relative);
  return path.isAbsolute(relative) || posix === ".." || posix.startsWith("../");
}

/** Canonical repo root for session equality (resolve + realpath when available). */
export async function normalizeRepoPath(repoInput: string): Promise<string> {
  const resolved = path.resolve(repoInput);
  try {
    return path.normalize(await realpath(resolved));
  } catch {
    return path.normalize(resolved);
  }
}

export function repoPathsEquivalent(a: string, b: string): boolean {
  const left = path.normalize(a).replaceAll("\\", "/");
  const right = path.normalize(b).replaceAll("\\", "/");
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
