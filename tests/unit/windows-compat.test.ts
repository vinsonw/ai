import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeTarget } from "../../src/acceptance.js";
import { assertOutputPath, isAllowedDeliverGitChange } from "../../src/pipeline.js";

const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("verifyGitScope path normalization", () => {
  it("allows docs/可读化 changes reported with backslashes", () => {
    expect(isAllowedDeliverGitChange("docs\\可读化\\index.md")).toBe(true);
  });

  it("rejects unmanaged paths even when backslash-separated", () => {
    expect(isAllowedDeliverGitChange("src\\index.ts")).toBe(false);
  });

  it("allows standard managed docs with Windows separators", () => {
    expect(isAllowedDeliverGitChange("docs\\01-业务资产\\README.md")).toBe(true);
  });
});

describe("safeTarget Windows-style relative", () => {
  it("accepts standard docs paths when path.relative uses backslashes", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "safe-target-win-"));
    temporary.push(repo);
    await mkdir(path.join(repo, "docs", "01-业务资产"), { recursive: true });
    const relativeSpy = vi.spyOn(path, "relative").mockReturnValue("docs\\01-业务资产\\README.md");
    try {
      await expect(safeTarget(repo, "docs/01-业务资产/README.md")).resolves.toContain("README.md");
    } finally {
      relativeSpy.mockRestore();
    }
  });

  it("rejects paths outside standard docs prefixes with backslash relatives", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "safe-target-reject-"));
    temporary.push(repo);
    const relativeSpy = vi.spyOn(path, "relative").mockReturnValue("src\\index.ts");
    try {
      await expect(safeTarget(repo, "src/index.ts")).rejects.toThrow("越界");
    } finally {
      relativeSpy.mockRestore();
    }
  });
});

describe("assertOutputPath", () => {
  it("still accepts Windows-style relative from path.relative", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "assert-win-"));
    temporary.push(repo);
    await mkdir(path.join(repo, "docs", "可读化"), { recursive: true });
    const relativeSpy = vi.spyOn(path, "relative").mockReturnValue("docs\\可读化\\asset.md");
    try {
      await expect(assertOutputPath(repo, "docs/可读化/asset.md")).resolves.toContain("asset.md");
    } finally {
      relativeSpy.mockRestore();
    }
  });
});
