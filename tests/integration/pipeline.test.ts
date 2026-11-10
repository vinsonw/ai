import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, loadConfig, runPipeline, scan } from "../../src/pipeline.js";

const temporary: string[] = [];
const fixture = path.resolve("tests/fixtures/sample-project");

async function createRepository(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "asset-integration-"));
  temporary.push(repo);
  await cp(fixture, repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Asset Test"]);
  await git(repo, ["config", "user.email", "asset-test@example.invalid"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture: synthetic baseline"]);
  await git(repo, ["checkout", "-b", "asset-compounding/test"]);
  return repo;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("incremental pipeline", () => {
  it("rejects source globs that escape the repository", async () => {
    const repo = await createRepository();
    const external = await mkdtemp(path.join(path.dirname(repo), "asset-external-"));
    temporary.push(external);
    await mkdir(path.join(external, "docs"), { recursive: true });
    await writeFile(path.join(external, "docs", "secret.md"), "# External\nsecret", "utf8");
    const relative = path.relative(repo, external).split(path.sep).join("/");
    const configPath = path.join(repo, "escape.yaml");
    await writeFile(
      configPath,
      `outputRoot: docs/可读化
baseBranch: main
sourceSets:
  - type: requirement
    include: ["${relative}/docs/*.md"]
  - type: design
    include: ["docs/design/**/*.md"]
`,
      "utf8",
    );
    await expect(scan(repo, await loadConfig(configPath))).rejects.toThrow(
      "仓库之外",
    );
  });

  it("writes only docs/可读化 and performs a zero-diff second run", async () => {
    const repo = await createRepository();
    const config = path.join(repo, "run.yaml");

    const first = await runPipeline(repo, config);
    expect(first.counts.new).toBeGreaterThan(0);
    expect(first.changedFiles.length).toBeGreaterThan(0);
    expect(first.changedFiles.every((file) => file.startsWith("docs/可读化/"))).toBe(true);
    expect(first.conflicts).toEqual([]);

    const statusAfterFirst = await git(repo, ["status", "--porcelain=v1"]);
    const second = await runPipeline(repo, config);
    const statusAfterSecond = await git(repo, ["status", "--porcelain=v1"]);

    expect(second.noOp).toBe(true);
    expect(second.secondRunZeroDiff).toBe(true);
    expect(second.counts.new).toBe(0);
    expect(second.counts.updated).toBe(0);
    expect(second.counts.unchanged).toBe(first.assets.length);
    expect(second.changedFiles).toEqual([]);
    expect(statusAfterSecond).toBe(statusAfterFirst);

    const report = await readFile(
      path.join(repo, "docs/可读化/evidence/acceptance-report.md"),
      "utf8",
    );
    const index = await readFile(path.join(repo, "docs/可读化/index.md"), "utf8");
    const firstAsset = await readFile(
      path.join(repo, `docs/可读化/assets/${first.assets[0]!.assetId.slice(7)}.md`),
      "utf8",
    );
    const runRecordPath = first.changedFiles.find((file) => file.includes("/runs/"));
    expect(runRecordPath).toBeDefined();
    const runRecord = await readFile(path.join(repo, runRecordPath!), "utf8");

    expect(report).toContain("资产复利验收报告");
    expect(report).toContain("R1–R6");
    expect(report).toContain("V1–V8");
    expect(index).toContain("资产复利索引");
    expect(index).toMatch(/需求|设计|Git 历史/);
    expect(firstAsset).toContain("## 四维分析");
    expect(firstAsset).toContain("### 完整性：");
    expect(firstAsset).toContain("来源版本（sourceRevision）");
    expect(firstAsset).toContain("内容指纹（contentHash）");
    expect(firstAsset).not.toMatch(/### 完整性：(ready|partial|missing|conflict)/);
    expect(runRecord).toContain("# 运行记录");
    expect(runRecord).toContain("- 当前提交：");
  });

  it("detects manual edits instead of overwriting them", async () => {
    const repo = await createRepository();
    const config = path.join(repo, "run.yaml");
    const first = await runPipeline(repo, config);
    await git(repo, ["add", "docs/可读化"]);
    await git(repo, ["commit", "-m", "docs: generated baseline"]);

    const target = first.assets.find((asset) => asset.sourceType === "requirement");
    expect(target).toBeDefined();
    const generated = path.join(repo, `docs/可读化/assets/${target!.assetId.slice(7)}.md`);
    const current = await readFile(generated, "utf8");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(generated, `${current}\nManual edit\n`, "utf8"),
    );

    const result = await runPipeline(repo, config);
    expect(result.conflicts.some((conflict) => conflict.assetId === target!.assetId)).toBe(true);
    expect(await readFile(generated, "utf8")).toContain("Manual edit");
  });

  it("protects manually edited managed index output", async () => {
    const repo = await createRepository();
    const config = path.join(repo, "run.yaml");
    await runPipeline(repo, config);
    await git(repo, ["add", "docs/可读化"]);
    await git(repo, ["commit", "-m", "docs: generated baseline"]);

    const index = path.join(repo, "docs/可读化/index.md");
    const current = await readFile(index, "utf8");
    await writeFile(index, `${current}\nManual index note\n`, "utf8");

    const result = await runPipeline(repo, config);
    expect(result.conflicts.some((conflict) => conflict.path.endsWith("index.md"))).toBe(true);
    expect(await readFile(index, "utf8")).toContain("Manual index note");
  });
});
