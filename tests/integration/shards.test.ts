import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  git,
  prepare,
  prepareShardPipeline,
  runPipeline,
} from "../../src/pipeline.js";
import {
  loadShardedDirectory,
  prepareShards,
  validateShardedInput,
} from "../../src/shards.js";
import type { AssetShard, ScanRecord, ShardManifest } from "../../src/types.js";
import { deliverWorkflow, startWorkflow } from "../../src/workflow.js";
import { enrichAssets, writeLegacyAssets } from "../helpers.js";

const temporary: string[] = [];
const fixture = path.resolve("tests/fixtures/sample-project");

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((target) => rm(target, { recursive: true, force: true })),
  );
});

function records(): ScanRecord[] {
  const long = Array.from(
    { length: 2_100 },
    (_, index) => `第 ${index + 1} 行：必须核对小上下文分片行为。`,
  ).join("\n");
  return [
    {
      sourceType: "requirement",
      sourceRef: "docs/requirements/large.md",
      sourceRevision: "rev-a",
      contentHash: "sha256:a".padEnd(71, "a"),
      content: long,
    },
    {
      sourceType: "design",
      sourceRef: "docs/design/one.md",
      sourceRevision: "rev-b",
      contentHash: "sha256:b".padEnd(71, "b"),
      content: "# 设计一\n需要明确稳定顺序和恢复流程。",
    },
    {
      sourceType: "design",
      sourceRef: "docs/design/two.md",
      sourceRevision: "rev-c",
      contentHash: "sha256:c".padEnd(71, "c"),
      content: "# 设计二\n需要验证失败分片不会标记完成。",
    },
  ];
}

async function enrichShard(file: string): Promise<void> {
  const shard = JSON.parse(await readFile(file, "utf8")) as AssetShard;
  shard.items = shard.items.map((item) => ({
    ...item,
    asset: enrichAssets([item.asset])[0]!,
  }));
  await writeFile(file, `${JSON.stringify(shard, null, 2)}\n`, "utf8");
}

describe("小上下文分片协议", () => {
  it("限制摘录预算、稳定排序，并可在单片失败后断点续跑", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "asset-shards-"));
    temporary.push(output);
    const sourceRecords = records();
    const assets = prepare(sourceRecords, null);
    const first = await prepareShards(sourceRecords, assets, output, {
      maxChars: 120,
      maxItems: 2,
    });

    expect(first.totalAssets).toBe(3);
    expect(first.pendingShards.length).toBeGreaterThan(1);
    const manifest = JSON.parse(
      await readFile(path.join(output, "manifest.json"), "utf8"),
    ) as ShardManifest;
    expect(manifest.assets.map((item) => item.assetId)).toEqual(
      assets.map((asset) => asset.assetId),
    );
    const largeShard = JSON.parse(
      await readFile(first.pendingShards[0]!, "utf8"),
    ) as AssetShard;
    expect(largeShard.items[0]!.sourceExcerpt.truncated).toBe(true);
    expect(largeShard.items[0]!.sourceExcerpt.strategy).toBe("head-tail");
    expect(largeShard.items[0]!.sourceExcerpt.text.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(largeShard)).not.toContain("第 1000 行");

    await enrichShard(first.pendingShards[0]!);
    const completed = await validateShardedInput(first.pendingShards[0]!);
    expect(completed.completedAssets).toBe(1);

    await expect(validateShardedInput(first.pendingShards[1]!)).rejects.toThrow(
      "实质质量门禁",
    );
    const resumed = await prepareShards(sourceRecords, assets, output, {
      maxChars: 120,
      maxItems: 2,
      resume: true,
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.completedAssets).toBe(1);
    expect(resumed.pendingShards).toEqual(first.pendingShards.slice(1));

    for (const file of resumed.pendingShards) await enrichShard(file);
    const validated = await validateShardedInput(output);
    expect(validated.pendingShards).toEqual([]);
    const aggregated = await loadShardedDirectory(output);
    expect(aggregated.map((asset) => asset.assetId)).toEqual(
      assets.map((asset) => asset.assetId),
    );

    const completedShard = JSON.parse(
      await readFile(first.pendingShards[0]!, "utf8"),
    ) as AssetShard;
    completedShard.items[0]!.asset.title += " 篡改";
    await writeFile(
      first.pendingShards[0]!,
      `${JSON.stringify(completedShard, null, 2)}\n`,
      "utf8",
    );
    await expect(validateShardedInput(output)).rejects.toThrow(
      "已完成分片在验证后被修改",
    );
  });

  it("在极小预算下明确截断超长单资产，并保留旧单文件输入", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asset-tiny-shards-"));
    temporary.push(root);
    const sourceRecords = records().slice(0, 2);
    const assets = prepare(sourceRecords, null);
    const output = path.join(root, "work");
    const result = await prepareShards(sourceRecords, assets, output, {
      maxChars: 32,
      maxItems: 10,
    });
    const shard = JSON.parse(
      await readFile(result.pendingShards[0]!, "utf8"),
    ) as AssetShard;
    expect(shard.items).toHaveLength(1);
    expect(shard.items[0]!.sourceExcerpt.text).toHaveLength(32);
    expect(shard.items[0]!.sourceExcerpt.truncated).toBe(true);

    shard.items[0]!.sourceExcerpt.text = "x".repeat(32);
    await writeFile(
      result.pendingShards[0]!,
      `${JSON.stringify(shard, null, 2)}\n`,
      "utf8",
    );
    await expect(validateShardedInput(result.pendingShards[0]!)).rejects.toThrow(
      "来源摘录或 provenance 被修改",
    );

    const legacy = path.join(root, "legacy.json");
    await writeLegacyAssets(legacy, assets);
    const { loadAssetsInput } = await import("../../src/pipeline.js");
    const loaded = await loadAssetsInput(legacy, sourceRecords);
    expect(loaded.format).toBe("legacy-single-file");
    expect(loaded.assets).toHaveLength(2);

    const empty = enrichAssets(assets);
    empty[0]!.analysis.completeness.evidence = [];
    await writeFile(
      path.join(root, "empty-analysis.json"),
      JSON.stringify(empty),
      "utf8",
    );
    await expect(
      loadAssetsInput(path.join(root, "empty-analysis.json"), sourceRecords),
    ).rejects.toThrow("schema 校验");
  });
});

describe("分片目录 finalize", () => {
  it("聚合全量来源并保持二次运行 zero diff", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "asset-shard-repo-"));
    temporary.push(repo);
    await cp(fixture, repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Shard Test"]);
    await git(repo, ["config", "user.email", "shard@example.invalid"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "fixture: shard baseline"]);
    await git(repo, ["checkout", "-b", "asset-compounding/shards"]);
    const config = path.join(repo, "run.yaml");
    const work = path.join(path.dirname(repo), `${path.basename(repo)}-work`);
    temporary.push(work);

    const prepared = await prepareShardPipeline(repo, config, work, {
      maxChars: 80,
      maxItems: 1,
    });
    for (const file of prepared.pendingShards) await enrichShard(file);
    await validateShardedInput(work);

    const first = await runPipeline(repo, config, work);
    expect(first.inputFormat).toBe("sharded-directory");
    expect(first.counts.new).toBeGreaterThan(0);
    const status = await git(repo, ["status", "--porcelain=v1"]);
    const second = await runPipeline(repo, config, work);
    expect(second.noOp).toBe(true);
    expect(second.secondRunZeroDiff).toBe(true);
    expect(await git(repo, ["status", "--porcelain=v1"])).toBe(status);
  });
});

describe("零配置 start/deliver", () => {
  it("从 React 风格仓库用两条短命令完成 editor-assisted 交付", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "asset-zero-config-"));
    temporary.push(repo);
    await mkdir(path.join(repo, "docs/requirements"), { recursive: true });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "react-style-fixture", private: true }),
      "utf8",
    );
    await writeFile(path.join(repo, "src/App.tsx"), "export const App = () => null;\n", "utf8");
    await writeFile(
      path.join(repo, "docs/requirements/checkout.md"),
      "# 结账需求\n必须支持明确的成功和失败验收路径。\n",
      "utf8",
    );
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Zero Config"]);
    await git(repo, ["config", "user.email", "zero@example.invalid"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "feat: realistic react baseline"]);
    await git(repo, ["checkout", "-b", "asset-compounding/zero-config"]);

    const started = await startWorkflow({ cwd: repo, yes: true, maxChars: 64 });
    expect(started.mode).toBe("editor-assisted");
    expect(started.effectiveConfig).toContain(`${path.sep}.git${path.sep}`);
    expect(await readFile(started.task, "utf8")).toContain("交给任意 AI 编辑器执行");
    const effectiveBefore = await readFile(started.effectiveConfig, "utf8");
    await expect(
      startWorkflow({ cwd: repo, yes: true, baseBranch: "other" }),
    ).rejects.toThrow("resume 不能更改");
    expect(await readFile(started.effectiveConfig, "utf8")).toBe(effectiveBefore);
    for (const file of started.pendingShards) {
      await enrichShard(file);
      await validateShardedInput(file);
    }

    const delivered = await deliverWorkflow({ cwd: repo, yes: true });
    expect(delivered.verification.secondRunZeroDiff).toBe(true);
    expect(
      await readFile(
        path.join(repo, "docs/可读化/evidence/effective-config.yaml"),
        "utf8",
      ),
    ).toContain("type: requirement");
    expect(
      await readFile(path.join(repo, "docs/可读化/source-manifest.yaml"), "utf8"),
    ).toContain("sourceTypes");
  });
});
