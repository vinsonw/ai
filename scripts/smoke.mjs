import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();
const repo = await mkdtemp(path.join(os.tmpdir(), "asset-compound-smoke-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "asset-compound-smoke-work-"));

async function run(command, args, cwd = repo) {
  return exec(command, args, { cwd, encoding: "utf8" });
}

async function enrich(file) {
  const shard = JSON.parse(await readFile(file, "utf8"));
  for (const item of shard.items) {
    item.asset.summary += " 本结论已完成小上下文人工增强并通过实质质量检查。";
    item.asset.analysis = {
      completeness: {
        level: "partial",
        evidence: ["来源摘录明确描述了目标范围和可核验约束。"],
        gaps: ["异常边界仍需材料负责人完成最终核对。"],
        recommendations: ["补充异常场景清单并关联验收用例。"],
      },
      executability: {
        level: "partial",
        evidence: ["来源摘录包含可执行动作和预期业务结果。"],
        gaps: ["负责人和完成日期尚未统一确认。"],
        recommendations: ["补充负责人、前置条件和完成定义。"],
      },
      consistency: {
        level: "partial",
        evidence: ["结论已按来源版本和内容指纹交叉定位。"],
        gaps: ["仍需与其他资产中的相关决策最终比对。"],
        recommendations: ["聚合后执行跨资产冲突检查并记录结果。"],
      },
      reuseValue: {
        level: "medium",
        evidence: ["材料包含可提炼为检查项的稳定规则。"],
        gaps: ["复用范围和不适用条件仍需明确。"],
        recommendations: ["沉淀为模板并记录适用边界。"],
      },
    };
    for (const finding of Object.values(item.asset.analysis)) {
      finding.evidence.unshift(`本资产来源证据：${item.sourceExcerpt.text}`);
    }
  }
  await writeFile(file, `${JSON.stringify(shard, null, 2)}\n`, "utf8");
}

try {
  await cp(path.join(root, "tests/fixtures/sample-project"), repo, { recursive: true });
  await run("git", ["init", "-b", "main"]);
  await run("git", ["config", "user.name", "Asset Smoke"]);
  await run("git", ["config", "user.email", "asset-smoke@example.invalid"]);
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "fixture: synthetic smoke baseline"]);
  await run("git", ["checkout", "-b", "asset-compounding/smoke"]);

  const cli = path.join(root, "dist/cli.js");
  const config = path.join(repo, "run.yaml");
  const prepared = JSON.parse(
    (
      await run(process.execPath, [
        cli,
        "prepare",
        "--repo",
        repo,
        "--config",
        config,
        "--output",
        workspace,
        "--max-chars",
        "96",
      ])
    ).stdout,
  );
  for (const shard of prepared.pendingShards) {
    await enrich(shard);
    await run(process.execPath, [cli, "validate", "--input", shard]);
  }
  const first = JSON.parse(
    (
      await run(process.execPath, [
        cli,
        "finalize",
        "--repo",
        repo,
        "--config",
        config,
        "--assets",
        workspace,
      ])
    ).stdout,
  );
  const statusAfterFirst = (await run("git", ["status", "--porcelain=v1"])).stdout;
  const verification = JSON.parse(
    (
      await run(process.execPath, [
        cli,
        "verify",
        "--repo",
        repo,
        "--config",
        config,
      ])
    ).stdout,
  );
  const second = JSON.parse(
    (
      await run(process.execPath, [
        cli,
        "finalize",
        "--repo",
        repo,
        "--config",
        config,
        "--assets",
        workspace,
      ])
    ).stdout,
  );
  const statusAfterSecond = (await run("git", ["status", "--porcelain=v1"])).stdout;

  if (first.counts.new < 2 || first.changedFiles.length === 0) {
    throw new Error("first run did not produce assets");
  }
  if (
    !verification.secondRunZeroDiff ||
    !second.noOp ||
    !second.secondRunZeroDiff ||
    second.counts.new !== 0 ||
    second.counts.updated !== 0
  ) {
    throw new Error("second run was not a no-op");
  }
  if (statusAfterFirst !== statusAfterSecond) {
    throw new Error("second run changed the worktree");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: "合成测试数据；不得作为验收数据",
        first: first.counts,
        second: second.counts,
        secondRunZeroDiff: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(repo, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}
