import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOutputPath, redactSensitive, sha256 } from "../../src/pipeline.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("sha256", () => {
  it("normalizes line endings and Unicode", () => {
    expect(sha256("café\r\n")).toBe(sha256("cafe\u0301\n"));
  });

  it("is stable and prefixed", () => {
    expect(sha256("asset")).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sha256("asset")).toBe(sha256("asset"));
  });
});

describe("redaction", () => {
  it("removes common tokens and email addresses", () => {
    const value = redactSensitive(
      "owner@example.com token=ghp_123456789012345678901234567890",
    );
    expect(value).not.toContain("owner@example.com");
    expect(value).not.toContain("ghp_");
    expect(value).toContain("[REDACTED");
  });
});

describe("output boundary", () => {
  it("accepts only docs/可读化 descendants", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "asset-boundary-"));
    temporary.push(repo);
    await expect(assertOutputPath(repo, "docs/可读化/index.md")).resolves.toContain("index.md");
    await expect(assertOutputPath(repo, "src/index.ts")).rejects.toThrow("之外");
    await expect(assertOutputPath(repo, "docs/可读化/../../package.json")).rejects.toThrow("之外");
  });

  it("accepts Windows-style relative segments from path.relative", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "asset-boundary-win-"));
    temporary.push(repo);
    const target = path.join(repo, "docs", "可读化", "README.md");
    await mkdir(path.dirname(target), { recursive: true });
    const relativeSpy = vi.spyOn(path, "relative").mockReturnValue("docs\\可读化\\README.md");
    try {
      await expect(assertOutputPath(repo, "docs/可读化/README.md")).resolves.toContain("README.md");
    } finally {
      relativeSpy.mockRestore();
    }
  });

  it("rejects a symlink inside the output path", async () => {
    const repo = path.join(os.tmpdir(), `asset-symlink-${process.pid}-${Date.now()}`);
    const external = path.join(os.tmpdir(), `asset-external-${process.pid}-${Date.now()}`);
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await mkdir(external, { recursive: true });
    await symlink(external, path.join(repo, "docs", "可读化"));
    temporary.push(repo, external);
    await expect(assertOutputPath(repo, "docs/可读化/index.md")).rejects.toThrow("符号链接");
  });
});
