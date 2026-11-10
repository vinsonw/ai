import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();
const sandbox = await mkdtemp(path.join(os.tmpdir(), "asset-packed-smoke-"));
const repo = path.join(sandbox, "react-project");
const home = path.join(sandbox, "home");
let tarball;

async function run(command, args, cwd = repo) {
  return exec(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: home,
      npm_config_cache: path.join(sandbox, "npm-cache"),
    },
  });
}

async function cli(args) {
  return run("npx", ["--no-install", "asset-compound", ...args]);
}

async function enrich(file) {
  const shard = JSON.parse(await readFile(file, "utf8"));
  for (const item of shard.items) {
    item.asset.summary += " 本结论由 packed smoke 模拟 AI 逐片增强并完成质量核验。";
    item.asset.analysis = {
      completeness: {
        level: "partial",
        evidence: ["来源摘录明确给出目标、范围和至少一项约束。"],
        gaps: ["异常路径的完整边界仍需材料负责人最终确认。"],
        recommendations: ["补充异常场景清单并关联验收用例。"],
      },
      executability: {
        level: "partial",
        evidence: ["来源摘录包含可执行动作和预期业务结果。"],
        gaps: ["负责人和完成日期尚未在来源中统一确认。"],
        recommendations: ["补充负责人、前置条件和完成定义。"],
      },
      consistency: {
        level: "partial",
        evidence: ["结论已按来源版本和内容指纹进行定位。"],
        gaps: ["仍需与其他分片中的相关决策进行最终比对。"],
        recommendations: ["聚合后执行跨资产冲突检查并记录结果。"],
      },
      reuseValue: {
        level: "medium",
        evidence: ["材料包含可提炼为检查项的稳定业务规则。"],
        gaps: ["复用范围和不适用条件仍需进一步明确。"],
        recommendations: ["将稳定规则沉淀为模板并记录适用边界。"],
      },
    };
    for (const finding of Object.values(item.asset.analysis)) {
      finding.evidence.unshift(`本资产来源证据：${item.sourceExcerpt.text}`);
    }
  }
  await writeFile(file, `${JSON.stringify(shard, null, 2)}\n`, "utf8");
}

try {
  const packed = JSON.parse(
    (
      await exec("npm", ["pack", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
      })
    ).stdout,
  );
  tarball = path.join(root, packed[0].filename);

  await cp(path.join(root, "tests/fixtures/sample-project"), repo, {
    recursive: true,
  });
  await rm(path.join(repo, "run.yaml"), { force: true });
  await rm(path.join(repo, "NOT-ACCEPTANCE-DATA.md"), { force: true });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(
    path.join(repo, "src", "App.tsx"),
    "export function App() { return <main>Asset compound smoke</main>; }\n",
    "utf8",
  );
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "packed-react-fixture", private: true }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n", "utf8");
  await run("git", ["init", "-b", "main"]);
  await run("git", ["config", "user.name", "Packed Smoke"]);
  await run("git", ["config", "user.email", "packed-smoke@example.invalid"]);
  await run("git", [
    "remote",
    "add",
    "origin",
    "https://example.invalid/demo/packed-react-fixture.git",
  ]);
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "fixture: realistic React baseline"]);
  await run("git", ["checkout", "-b", "asset-compounding/packed-smoke"]);

  await run("npm", [
    "install",
    "--no-save",
    "--package-lock=false",
    tarball,
  ]);

  const started = JSON.parse(
    (await cli(["start", "--yes", "--max-chars", "64"])).stdout,
  );
  for (const shard of started.pendingShards) {
    await enrich(shard);
    await cli(["validate", "--input", shard]);
  }
  await writeFile(
    started.retrospective,
    `${JSON.stringify(
      {
        maxHelp: "分片让小上下文模型逐项完成真实材料分析。",
        frictionAndTime: "主要耗时在逐片核对来源证据和补充四维结论。",
        coverageGaps: "合成 fixture 不包含真实截图和外部设计平台。",
        improvements: "后续在真实 React 仓库补充截图和链接证据。",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const resumed = JSON.parse((await cli(["start", "--yes"])).stdout);
  const delivered = JSON.parse((await cli(["deliver", "--yes"])).stdout);
  const skill = JSON.parse(
    (
      await cli([
        "install-skill",
        "--editor",
        "cursor",
        "--target",
        path.join(home, "cursor-skill"),
      ])
    ).stdout,
  );

  if (resumed.pendingShards.length !== 0 || resumed.completedAssets < 2) {
    throw new Error("packed resume did not preserve completed shard markers");
  }
  if (
    delivered.delivery.counts.new < 2 ||
    !delivered.verification.secondRunZeroDiff
  ) {
    throw new Error("packed deliver did not complete or verify zero diff");
  }
  if (!(await readFile(started.task, "utf8")).includes("任意 AI 编辑器")) {
    throw new Error("packed editor task entry is missing");
  }
  if (!(await readFile(skill.skillFile, "utf8")).includes("# 资产复利")) {
    throw new Error("packed Cursor adapter is incomplete");
  }
  if (
    !(await readFile(
      path.join(repo, "docs/07-AI资产/资产复利/资产复利实践报告.md"),
      "utf8",
    )).includes("# 资产复利实践报告")
  ) {
    throw new Error("packed acceptance report is incomplete");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: "合成 React 风格仓，仅验证工具行为，不作为真实 V2 验收证据",
        package: "@vinsonw2/asset-compound",
        source: "locally installed npm pack tarball",
        manualYaml: false,
        environmentVariables: false,
        commands: ["asset-compound start --yes", "asset-compound deliver --yes"],
        shardedResume: true,
        standardDocs: true,
        acceptanceContractBehavior: "1.1 / 2.1 / 2.2 / R1-R6 / V1-V8",
        internalPerShardValidation: true,
        cursorAdapter: true,
        first: delivered.delivery.counts,
        secondRunZeroDiff: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(sandbox, { recursive: true, force: true });
}
