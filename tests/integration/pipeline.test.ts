import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  git,
  currentBranch,
  inspectPipeline,
  loadConfig,
  prepare,
  runPipeline,
  scan,
  verifyGitScope,
} from "../../src/pipeline.js";
import { prepareShards } from "../../src/shards.js";
import type { AssetShard } from "../../src/types.js";
import { writeLegacyAssets } from "../helpers.js";

const temporary: string[] = [];
const fixture = path.resolve("tests/fixtures/sample-project");

async function createRepository(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "asset-integration-"));
  temporary.push(repo);
  await cp(fixture, repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(repo, ["config", "user.name", "Asset Test"]);
  await git(repo, ["config", "user.email", "asset-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture: synthetic baseline"]);
  await git(repo, ["checkout", "-b", "asset-compounding/test"]);
  return repo;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("incremental pipeline", () => {
  async function assetsFile(repo: string, config: string): Promise<string> {
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-assets.json`);
    temporary.push(target);
    const inspected = await inspectPipeline(repo, config);
    await writeLegacyAssets(target, inspected.assets);
    return target;
  }

  it("detects named and detached HEAD without branch --show-current", async () => {
    const repo = await createRepository();
    expect(await currentBranch(repo)).toBe("asset-compounding/test");
    await git(repo, ["checkout", "--detach", "HEAD"]);
    expect(await currentBranch(repo)).toBe("");
  });

  it("uses epoch seconds for stable Git source timestamps", async () => {
    const repo = await createRepository();
    const records = await scan(repo, await loadConfig(path.join(repo, "run.yaml")));
    const gitRecords = records.filter((record) => record.sourceType === "git");
    expect(gitRecords.length).toBeGreaterThan(0);
    for (const record of gitRecords) {
      const commit = record.content.match(/^GIT_COMMIT\t(.+)$/m)?.[1];
      const authoredEpoch = record.content.match(/^GIT_AUTHORED_EPOCH\t(.+)$/m)?.[1];
      expect(commit).toBeDefined();
      if (!commit) throw new Error("Git record is missing GIT_COMMIT");
      const expected = await git(repo, ["log", "-1", "--format=%at", commit]);
      expect(authoredEpoch).toBe(expected);
      expect(expected).toMatch(/^\d+$/);
    }
  });

  it("captures real file-level Git patches, hunks, bounded post-images, and truncation", async () => {
    const repo = await createRepository();
    await mkdir(path.join(repo, "src"), { recursive: true });
    const first = Array.from({ length: 32 }, (_, index) => `export const line${index + 1} = ${index + 1};`);
    await writeFile(path.join(repo, "src/alpha.ts"), `${first.join("\n")}\n`, "utf8");
    await writeFile(path.join(repo, "src/beta.ts"), "export const beta = 'before';\n", "utf8");
    await git(repo, ["add", "src"]);
    await git(repo, ["commit", "-m", "test: add source baseline"]);

    first[3] = "export const line4 = 'changed-near-start';";
    first[27] = "export const line28 = 'changed-near-end';";
    await writeFile(path.join(repo, "src/alpha.ts"), `${first.join("\n")}\n`, "utf8");
    await writeFile(path.join(repo, "src/beta.ts"), "export const beta = 'after';\n", "utf8");
    await writeFile(
      path.join(repo, "src/large.ts"),
      `${Array.from({ length: 8_000 }, (_, index) => `export const generated${index} = ${index};`).join("\n")}\n`,
      "utf8",
    );
    await git(repo, ["add", "src"]);
    await git(repo, ["commit", "-m", "feat: change two files and add a large source"]);
    const commit = await git(repo, ["rev-parse", "HEAD"]);

    const records = await scan(repo, await loadConfig(path.join(repo, "run.yaml")));
    const changed = records.filter(
      (record) => record.sourceType === "git" && record.sourceRevision === commit,
    );
    expect(changed.map((record) => record.content.match(/^GIT_FILE\t(.+)$/m)?.[1]).sort()).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
      "src/large.ts",
    ]);
    const alpha = changed.find((record) => record.sourceRef.endsWith(":src/alpha.ts"));
    expect(alpha?.content).toContain(`GIT_COMMIT\t${commit}`);
    expect(alpha?.content).toContain("GIT_STATUS\tM");
    expect(alpha?.content).toContain("PATCH_BEGIN");
    expect(alpha?.content).toContain("@@ -1,7 +1,7 @@");
    expect(alpha?.content).toContain("@@ -25,7 +25,7 @@");
    expect(alpha?.content).toContain(`POST_IMAGE_BEGIN src/alpha.ts@${commit}:L1-L10`);
    expect(alpha?.content).toContain("4: export const line4 = 'changed-near-start';");
    expect(alpha?.content).not.toContain("GIT_SUBJECT\tfixture: synthetic baseline");

    const large = changed.find((record) => record.sourceRef.endsWith(":src/large.ts"));
    expect(large?.content).toContain("PATCH_TRUNCATED");
    expect(large?.content).toContain("completeCapture=false");
    expect(large?.content).toContain("@@ -0,0 +1,8000 @@");
    expect(large!.content.length).toBeLessThan(40_000);

    const work = path.join(path.dirname(repo), `${path.basename(repo)}-git-shards`);
    temporary.push(work);
    const prepared = await prepareShards(records, prepare(records, null), work, {
      maxChars: 1_200,
      maxItems: 1,
      maxShards: 20,
    });
    const shards = await Promise.all(
      prepared.pendingShards.map(async (file) =>
        JSON.parse(await readFile(file, "utf8")) as AssetShard,
      ),
    );
    const largeShard = shards.find((shard) =>
      shard.items[0]?.provenance.sourceRef.endsWith(":src/large.ts"),
    );
    expect(largeShard?.items[0]?.sourceExcerpt.truncated).toBe(true);
    expect(largeShard?.items[0]?.sourceExcerpt.text).toContain("GIT_FILE\tsrc/large.ts");
    expect(largeShard?.items[0]?.sourceExcerpt.text).toContain("@@ -0,0 +1,8000 @@");
    expect(largeShard?.items[0]?.sourceExcerpt.text.length).toBeLessThanOrEqual(1_200);
  });

  it("conservatively filters transactional commits and preserves explainable evidence", async () => {
    const repo = await createRepository();
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/format.ts"), "export const value = 1;\n", "utf8");
    await git(repo, ["add", "src/format.ts"]);
    await git(repo, ["commit", "-m", "feat: add formatting fixture"]);

    await writeFile(path.join(repo, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
    await git(repo, ["add", "package-lock.json"]);
    await git(repo, ["commit", "-m", "chore(deps): refresh lockfile"]);
    const dependencyCommit = await git(repo, ["rev-parse", "HEAD"]);

    await writeFile(path.join(repo, "eslint.config.js"), "export default [];\n", "utf8");
    await git(repo, ["add", "eslint.config.js"]);
    await git(repo, ["commit", "-m", "chore: configure eslint"]);
    const eslintCommit = await git(repo, ["rev-parse", "HEAD"]);

    await writeFile(
      path.join(repo, "webpack.config.js"),
      "export default { entry: './src/index.ts' };\n",
      "utf8",
    );
    await git(repo, ["add", "webpack.config.js"]);
    await git(repo, ["commit", "-m", "chore: configure webpack"]);
    const toolCommit = await git(repo, ["rev-parse", "HEAD"]);

    await writeFile(path.join(repo, "src/format.ts"), "export   const   value = 1;\n", "utf8");
    await git(repo, ["add", "src/format.ts"]);
    await git(repo, ["commit", "-m", "format: normalize whitespace"]);
    const formatCommit = await git(repo, ["rev-parse", "HEAD"]);

    await writeFile(path.join(repo, "src/checkout.ts"), "export const checkout = true;\n", "utf8");
    await writeFile(
      path.join(repo, "package-lock.json"),
      '{"lockfileVersion":3,"packages":{"checkout":{}}}\n',
      "utf8",
    );
    await git(repo, ["add", "src/checkout.ts", "package-lock.json"]);
    await git(repo, ["commit", "-m", "feat: add checkout with dependency update"]);
    const businessCommit = await git(repo, ["rev-parse", "HEAD"]);

    await writeFile(path.join(repo, "src/checkout.ts"), "export const checkout = false;\n", "utf8");
    await git(repo, ["add", "src/checkout.ts"]);
    await git(repo, ["commit", "-m", "format: change checkout behavior"]);
    const semanticFormatCommit = await git(repo, ["rev-parse", "HEAD"]);

    const configPath = path.join(repo, "run.yaml");
    const inspected = await inspectPipeline(repo, configPath);
    expect(inspected.skippedGitCommits.map((commit) => commit.commit).sort()).toEqual(
      [dependencyCommit, eslintCommit, formatCommit, toolCommit].sort(),
    );
    for (const skipped of inspected.skippedGitCommits) {
      expect(skipped.treeHash).toMatch(/^[0-9a-f]{40}$/);
      expect(skipped.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(skipped.reason.length).toBeGreaterThan(8);
      expect(skipped.files.length).toBeGreaterThan(0);
    }
    expect(
      inspected.records.some(
        (record) =>
          record.sourceType === "git" &&
          record.sourceRevision === businessCommit &&
          record.sourceRef.endsWith(":src/checkout.ts"),
      ),
    ).toBe(true);
    expect(
      inspected.records.some(
        (record) =>
          record.sourceType === "git" &&
          record.sourceRevision === semanticFormatCommit &&
          record.sourceRef.endsWith(":src/checkout.ts"),
      ),
    ).toBe(true);

    const work = path.join(path.dirname(repo), `${path.basename(repo)}-transaction-shards`);
    temporary.push(work);
    await prepareShards(inspected.records, inspected.assets, work, {
      maxShards: 20,
      skippedGitCommits: inspected.skippedGitCommits,
    });
    const manifest = JSON.parse(
      await readFile(path.join(work, "manifest.json"), "utf8"),
    ) as { skippedGitCommits: Array<{ commit: string; reason: string }> };
    expect(manifest.skippedGitCommits).toHaveLength(4);

    const assets = await assetsFile(repo, configPath);
    const result = await runPipeline(repo, configPath, assets);
    const sourceManifest = await readFile(
      path.join(repo, "docs/可读化/source-manifest.yaml"),
      "utf8",
    );
    const runPath = result.changedFiles.find((file) => file.includes("/runs/"));
    expect(runPath).toBeDefined();
    const runRecord = await readFile(path.join(repo, runPath!), "utf8");
    expect(sourceManifest).toContain("skippedGitCommits:");
    expect(sourceManifest).toContain(dependencyCommit);
    expect(sourceManifest).toContain("dependency-lockfile-only");
    expect(runRecord).toContain("跳过事务性 Git 提交：4");
    expect(runRecord).toContain(formatCommit);

    const config = await loadConfig(configPath);
    const override = {
      ...config,
      sourceSets: config.sourceSets.map((source) =>
        source.type === "git"
          ? { ...source, includeTransactionalCommits: true }
          : source,
      ),
    };
    const unfiltered = await scan(repo, override);
    for (const commit of [dependencyCommit, eslintCommit, formatCommit, toolCommit]) {
      expect(
        unfiltered.some(
          (record) => record.sourceType === "git" && record.sourceRevision === commit,
        ),
      ).toBe(true);
    }
  });

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
    const assets = await assetsFile(repo, config);

    const first = await runPipeline(repo, config, assets);
    expect(first.counts.new).toBeGreaterThan(0);
    expect(first.changedFiles.length).toBeGreaterThan(0);
    expect(first.changedFiles.every((file) => file.startsWith("docs/可读化/"))).toBe(true);
    expect(first.conflicts).toEqual([]);

    const statusAfterFirst = await git(repo, ["status", "--porcelain=v1"]);
    const second = await runPipeline(repo, config, assets);
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

    expect(report).toContain("非 2.2 验收报告");
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
    expect(runRecord).toContain("- 来源提交：");
  });

  it("rejects unrelated changes hidden inside standard docs categories", async () => {
    const repo = await createRepository();
    await mkdir(path.join(repo, "docs/08-其他上下文"), { recursive: true });
    await writeFile(path.join(repo, "docs/08-其他上下文/manual.md"), "# Manual\n", "utf8");
    await expect(verifyGitScope(repo)).rejects.toThrow("之外的改动");
  });

  it("detects manual edits instead of overwriting them", async () => {
    const repo = await createRepository();
    const config = path.join(repo, "run.yaml");
    const assets = await assetsFile(repo, config);
    const first = await runPipeline(repo, config, assets);
    await git(repo, ["add", "docs/可读化"]);
    await git(repo, ["commit", "-m", "docs: generated baseline"]);
    const nextAssets = await assetsFile(repo, config);

    const target = first.assets.find((asset) => asset.sourceType === "requirement");
    expect(target).toBeDefined();
    const generated = path.join(repo, `docs/可读化/assets/${target!.assetId.slice(7)}.md`);
    const current = await readFile(generated, "utf8");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(generated, `${current}\nManual edit\n`, "utf8"),
    );

    const result = await runPipeline(repo, config, nextAssets);
    expect(result.conflicts.some((conflict) => conflict.assetId === target!.assetId)).toBe(true);
    expect(await readFile(generated, "utf8")).toContain("Manual edit");
  });

  it("protects manually edited managed index output", async () => {
    const repo = await createRepository();
    const config = path.join(repo, "run.yaml");
    const assets = await assetsFile(repo, config);
    await runPipeline(repo, config, assets);
    await git(repo, ["add", "docs/可读化"]);
    await git(repo, ["commit", "-m", "docs: generated baseline"]);
    const nextAssets = await assetsFile(repo, config);

    const index = path.join(repo, "docs/可读化/index.md");
    const current = await readFile(index, "utf8");
    await writeFile(index, `${current}\nManual index note\n`, "utf8");

    const result = await runPipeline(repo, config, nextAssets);
    expect(result.conflicts.some((conflict) => conflict.path.endsWith("index.md"))).toBe(true);
    expect(await readFile(index, "utf8")).toContain("Manual index note");
  });
});
