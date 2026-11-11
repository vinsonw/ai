import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  git,
  loadConfig,
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
  shard.items = shard.items.map((item) => {
    const asset = enrichAssets([item.asset])[0]!;
    for (const finding of Object.values(asset.analysis)) {
      finding.evidence.unshift(`本资产来源证据：${item.sourceExcerpt.text}`);
    }
    return { ...item, asset };
  });
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
    await git(repo, ["init"]);
    await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
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
  it("拒绝明确标记为非验收数据的 fixture", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "asset-marked-fixture-"));
    temporary.push(repo);
    await cp(fixture, repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(repo, ["config", "user.name", "Fixture Test"]);
    await git(repo, ["config", "user.email", "fixture@example.invalid"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "fixture: marked non-acceptance data"]);
    await expect(startWorkflow({ cwd: repo, yes: true })).rejects.toThrow(
      "非验收 fixture",
    );
  });

  it("显式 requirement patterns 任一零匹配时给出完整诊断", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "asset-requirement-patterns-"));
    temporary.push(repo);
    await mkdir(path.join(repo, "docs/requirements"), { recursive: true });
    await mkdir(path.join(repo, "specs"), { recursive: true });
    await writeFile(
      path.join(repo, "docs/requirements/checkout.md"),
      "# 结账需求\n必须保留成功和失败路径。\n",
      "utf8",
    );
    await writeFile(path.join(repo, "specs/cart.md"), "# 购物车\n总额必须稳定。\n", "utf8");
    await git(repo, ["init"]);
    await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(repo, ["config", "user.name", "Pattern Test"]);
    await git(repo, ["config", "user.email", "pattern@example.invalid"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "fixture: requirement pattern diagnostics"]);
    await git(repo, ["checkout", "-b", "asset-compounding/patterns"]);

    const requested = ["docs/requirements/**/*.md", "missing/**/*.md"];
    let failure: unknown;
    try {
      await startWorkflow({
        cwd: repo,
        workspace: path.join(repo, ".git/asset-compound-missing"),
        requirements: requested,
        maxChars: 6_000,
        maxItems: 2,
        yes: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("显式 requirement pattern 存在零匹配");
    expect(message).toContain(`调用 cwd：${repo}`);
    expect(message).toContain(`扫描 cwd（Git 根目录）：${repo}`);
    expect(message).toContain('传入 patterns："docs/requirements/**/*.md"、"missing/**/*.md"');
    expect(message).toContain('零匹配 patterns："missing/**/*.md"');

    const started = await startWorkflow({
      cwd: repo,
      workspace: path.join(repo, ".git/asset-compound-valid"),
      requirements: ["docs/requirements/**/*.md", "specs/**/*.md"],
      maxChars: 6_000,
      maxItems: 2,
      yes: true,
    });
    const config = await loadConfig(started.effectiveConfig);
    expect(config.sourceSets[0]?.include).toEqual([
      "docs/requirements/**/*.md",
      "specs/**/*.md",
    ]);
    expect(started.maxChars).toBe(6_000);
    expect(started.maxItems).toBe(2);
  });

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
    await git(repo, ["init"]);
    await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(repo, ["config", "user.name", "Zero Config"]);
    await git(repo, ["config", "user.email", "zero@example.invalid"]);
    await git(repo, ["remote", "add", "origin", "https://secret-token@example.invalid/demo/react-style-fixture.git"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "feat: realistic react baseline"]);
    await expect(startWorkflow({ cwd: repo, yes: true, maxChars: 64 })).rejects.toThrow(
      "必须先切换到独立分支",
    );
    await git(repo, ["checkout", "-b", "asset-compounding/zero-config"]);

    const started = await startWorkflow({ cwd: repo, yes: true, maxChars: 64 });
    expect(started.mode).toBe("editor-assisted");
    await expect(deliverWorkflow({ cwd: repo })).rejects.toThrow("--yes");
    expect(started.effectiveConfig).toContain(`${path.sep}.git${path.sep}`);
    const task = await readFile(started.task, "utf8");
    for (const constraint of [
      "本轮唯一输入边界",
      "第一条 `status=pending`",
      "事实只能来自该片",
      "禁止自行扫描仓库、猜测目录",
      "唯一输出路径就是当前 shard 原文件",
      "不修改项目源码",
      "summary` 至少 20 个字符",
      "evidence 必须引用或紧密复述",
      "先读 diff",
      "文件路径@commit + @@ hunk 定位",
      "提交消息只作意图线索",
      "禁止打开全仓或完整大文件",
      "PATCH_TRUNCATED",
      "exit 0 才表示该片完成",
      "2.1",
      "2.2",
      "R1–R6",
      "V1–V8",
    ]) {
      expect(task).toContain(constraint);
    }
    const effectiveBefore = await readFile(started.effectiveConfig, "utf8");
    await expect(
      startWorkflow({ cwd: repo, yes: true, baseBranch: "other" }),
    ).rejects.toThrow("resume 不能更改");
    expect(await readFile(started.effectiveConfig, "utf8")).toBe(effectiveBefore);
    for (const file of started.pendingShards) {
      await enrichShard(file);
      await validateShardedInput(file);
    }
    await expect(deliverWorkflow({ cwd: repo, yes: true })).rejects.toThrow(
      "复盘字段",
    );
    await writeFile(
      started.retrospective,
      `${JSON.stringify(
        {
          maxHelp: "TODO",
          frictionAndTime: "TODO",
          coverageGaps: "TODO",
          improvements: "TODO",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(deliverWorkflow({ cwd: repo, yes: true })).rejects.toThrow(
      "占位内容",
    );
    await writeFile(
      started.retrospective,
      `${JSON.stringify(
        {
          maxHelp: "分片让小上下文模型可以逐项完成分析并保留断点。",
          frictionAndTime: "测试实践主要耗时在逐片补充四维证据。",
          coverageGaps: "当前 fixture 未覆盖真实截图和外部设计平台。",
          improvements: "后续增加真实仓库截图采集和链接检查。",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

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
    const report = await readFile(
      path.join(repo, "docs/07-AI资产/资产复利/资产复利实践报告.md"),
      "utf8",
    );
    expect(report).toContain("# 资产复利实践报告");
    expect(report).toContain("## 环节对照表");
    expect(report).toContain("## 防重复验证");
    expect(report).toContain("证据：");
    expect(report).not.toContain("secret-token");
    expect(report).toContain("https://example.invalid/demo/react-style-fixture.git");
    for (const requirement of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
      const row = report.split("\n").find((line) => line.startsWith(`| ${requirement} `));
      expect(row?.split("|").slice(1, -1).every((cell) => cell.trim().length > 0)).toBe(true);
    }
    expect(await readFile(path.join(repo, "docs/README.md"), "utf8")).toContain(
      "00-项目总览",
    );
    const evidence = JSON.parse(
      await readFile(
        path.join(repo, "docs/07-AI资产/资产复利/验证证据/verification.json"),
        "utf8",
      ),
    ) as { contract: { task21FiveMaterials: boolean; task22CompleteReport: boolean } };
    expect(evidence.contract.task21FiveMaterials).toBe(true);
    expect(evidence.contract.task22CompleteReport).toBe(true);
    for (const directory of [
      "00-项目总览",
      "01-业务资产",
      "02-技术架构",
      "03-接口资产",
      "04-数据资产",
      "05-代码图谱",
      "06-开发规范",
      "07-AI资产",
    ]) {
      expect(await readFile(path.join(repo, "docs", directory, "README.md"), "utf8")).toContain(
        `# ${directory}`,
      );
    }

    const statusBeforeRepeat = await git(repo, ["status", "--porcelain=v1"]);
    const repeated = await deliverWorkflow({ cwd: repo, yes: true });
    expect(repeated.delivery.noOp).toBe(true);
    expect(await git(repo, ["status", "--porcelain=v1"])).toBe(statusBeforeRepeat);
    expect(
      await readFile(
        path.join(repo, "docs/07-AI资产/资产复利/资产复利实践报告.md"),
        "utf8",
      ),
    ).toBe(report);
    await git(repo, ["add", "docs"]);
    await git(repo, ["commit", "-m", "docs: commit generated acceptance package"]);
    await deliverWorkflow({ cwd: repo, yes: true });
    expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
    expect(
      await readFile(
        path.join(repo, "docs/07-AI资产/资产复利/资产复利实践报告.md"),
        "utf8",
      ),
    ).toBe(report);

    const navigation = path.join(repo, "docs/README.md");
    await writeFile(navigation, `${await readFile(navigation, "utf8")}\n人工修改\n`, "utf8");
    await expect(deliverWorkflow({ cwd: repo, yes: true })).rejects.toThrow(
      "标准 docs 受管文件被人工编辑",
    );
  });
});
