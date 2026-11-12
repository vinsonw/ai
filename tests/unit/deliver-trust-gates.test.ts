import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAcceptancePackage } from "../../src/acceptance.js";
import { git, prepare, readState } from "../../src/pipeline.js";
import {
  assertAllShardsCompleted,
  loadShardedAssetsDeliver,
  prepareShards,
  validateShardedInput,
} from "../../src/shards.js";
import type { AssetShard, ShardManifest } from "../../src/types.js";
import { enrichAssets } from "../helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((target) => rm(target, { recursive: true, force: true })),
  );
});

function shardHash(value: string): string {
  return `sha256:${createHash("sha256")
    .update(value.replace(/\r\n?/g, "\n").normalize("NFC"))
    .digest("hex")}`;
}

function manifestDigest(manifest: ShardManifest): string {
  return shardHash(JSON.stringify({ ...manifest, manifestHash: "" }, null, 2));
}

const gitSha = "c".repeat(40);

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "asset-deliver-trust-"));
  temporary.push(repo);
  await git(repo, ["init"]);
  await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(repo, ["config", "user.name", "Deliver Trust"]);
  await git(repo, ["config", "user.email", "deliver@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

async function enrichShardFile(file: string): Promise<void> {
  const shard = JSON.parse(await readFile(file, "utf8")) as AssetShard;
  shard.items = shard.items.map((item) => {
    const asset = enrichAssets([item.asset])[0]!;
    for (const finding of Object.values(asset.analysis)) {
      finding.evidence.unshift(`本资产来源证据：${item.sourceExcerpt.text}`);
    }
    return { ...item, asset };
  });
  await writeFile(file, `${JSON.stringify(shard, null, 2)}\n`, "utf8");
}

function sampleDelivery() {
  const asset = enrichAssets([
    {
      assetId: "asset:trust-gate",
      sourceType: "requirement",
      sourceRef: "docs/requirements/a.md",
      sourceRevision: gitSha,
      contentHash: `sha256:${"d".repeat(64)}`,
      title: "信任 deliver 单测",
      summary: "用于验证 deliver 信任聚合路径不重复 QA 门禁。",
      facts: [],
      decisions: [],
      actions: [],
      relations: [],
      analysis: {
        completeness: { level: "partial", evidence: [], gaps: [], recommendations: [] },
        executability: { level: "partial", evidence: [], gaps: [], recommendations: [] },
        consistency: { level: "partial", evidence: [], gaps: [], recommendations: [] },
        reuseValue: { level: "medium", evidence: [], gaps: [], recommendations: [] },
      },
      writebackKind: "新增",
    },
  ])[0]!;
  return {
    runId: "0123456789abcdef",
    counts: { new: 1, updated: 0, unchanged: 0, conflicts: 0 },
    assets: [asset],
    conflicts: [],
    changedFiles: [] as string[],
    noOp: false,
  };
}

describe("deliver 信任聚合门禁", () => {
  it("fromDeliver 时跳过 NOT-ACCEPTANCE-DATA 标记", async () => {
    const repo = await initRepo();
    await writeFile(
      path.join(repo, "NOT-ACCEPTANCE-DATA.md"),
      "# fixture\n仅用于 start 拒绝；deliver 信任模式不再阻断。\n",
      "utf8",
    );
    const result = await writeAcceptancePackage({
      repo,
      config: { outputRoot: "docs/可读化", sourceSets: [] },
      delivery: sampleDelivery(),
      verification: {
        secondRunZeroDiff: false,
        counts: { new: 1, updated: 0, unchanged: 0, conflicts: 0 },
        stateCommit: "",
      },
      metadata: {
        developmentGroup: "demo",
        practitioner: "tester",
        project: "demo",
        repository: "https://example.invalid/demo.git",
        branch: "main",
        head: gitSha,
        startedAt: "not-valid-iso",
        trigger: "test",
        toolWorkflow: "test",
      },
      retrospective: { maxHelp: "", frictionAndTime: "", coverageGaps: "", improvements: "" },
      fromDeliver: true,
      trustDelivered: true,
    });
    const report = await readFile(result.report, "utf8");
    expect(report).toContain("机器记录 0 秒");
    expect(report).toContain("deliver 信任聚合模式");
  });

  it("assertAllShardsCompleted 不因 manifest 完成计数与 total 不一致而失败", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "asset-shard-count-"));
    temporary.push(output);
    const records = [
      {
        sourceType: "requirement" as const,
        sourceRef: "docs/requirements/x.md",
        sourceRevision: gitSha,
        contentHash: `sha256:${"e".repeat(64)}`,
        content:
          "# X\n必须保留可核验的业务约束、成功路径与失败路径，供分片 validate 与 deliver 信任聚合单测使用。\n",
      },
    ];
    const assets = prepare(records, null);
    const prepared = await prepareShards(records, assets, output, { maxChars: 2_000, maxItems: 10 });
    for (const file of prepared.pendingShards) {
      await enrichShardFile(file);
      await validateShardedInput(file);
    }
    const manifestPath = path.join(output, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ShardManifest;
    manifest.completedAssets = 0;
    manifest.manifestHash = manifestDigest({ ...manifest, manifestHash: "" });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(assertAllShardsCompleted(output)).resolves.toMatchObject({
      format: "sharded-directory",
      completedAssets: 0,
      totalAssets: manifest.totalAssets,
    });
  });

  it("loadShardedAssetsDeliver 不因分片资产含敏感片段而 throw", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "asset-shard-sensitive-"));
    temporary.push(output);
    const records = [
      {
        sourceType: "requirement" as const,
        sourceRef: "docs/requirements/secret.md",
        sourceRevision: gitSha,
        contentHash: `sha256:${"f".repeat(64)}`,
        content:
          "# Secret\n必须保留可核验的业务约束、成功路径与失败路径，供敏感数据 deliver 跳过重检单测使用。\n",
      },
    ];
    const assets = prepare(records, null);
    const prepared = await prepareShards(records, assets, output, { maxChars: 2_000, maxItems: 10 });
    const file = prepared.pendingShards[0]!;
    await enrichShardFile(file);
    await validateShardedInput(file);
    const postValidate = JSON.parse(await readFile(file, "utf8")) as AssetShard;
    postValidate.items[0]!.asset.title = `含邮箱 contact@example.com 的资产标题`;
    await writeFile(file, `${JSON.stringify(postValidate, null, 2)}\n`, "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = await loadShardedAssetsDeliver(output);
    expect(loaded).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("deliver 信任聚合：跳过分片敏感数据重检"),
    );
    warn.mockRestore();
  });

  it("readState trustDeliver 时损坏 selfHash 不 throw", async () => {
    const repo = await initRepo();
    const stateDir = path.join(repo, "docs/可读化/state");
    await mkdir(stateDir, { recursive: true });
    const broken = {
      schemaVersion: 1,
      selfHash: "sha256:deadbeef",
      baseBranch: "main",
      baseCommit: "b".repeat(40),
      lastReadCommit: "c".repeat(40),
      sources: {},
      assets: {},
      managedFiles: {},
    };
    await writeFile(
      path.join(stateDir, "read-state.json"),
      `${JSON.stringify(broken, null, 2)}\n`,
      "utf8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readState(repo, { trustDeliver: true })).resolves.toBeNull();
    await expect(readState(repo)).rejects.toThrow("selfHash");
    warn.mockRestore();
  });
});
