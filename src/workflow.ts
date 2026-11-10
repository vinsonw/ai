import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import writeFileAtomic from "write-file-atomic";
import { stringify as stringifyYaml } from "yaml";
import {
  assertRetrospectiveInput,
  detectAcceptanceMetadata,
  writeAcceptancePackage,
  type RetrospectiveInput,
} from "./acceptance.js";
import {
  git,
  loadConfig,
  prepareShardPipeline,
  runPipeline,
  verifySecondRun,
} from "./pipeline.js";
import { validateShardedInput } from "./shards.js";
import type { RunConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const COMMON_REQUIREMENT_GLOBS = [
  "docs/requirements/**/*.md",
  "docs/product/**/*.md",
  "requirements/**/*.md",
  "specs/**/*.md",
];

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeText(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, `${content.trimEnd()}\n`, {
    encoding: "utf8",
    fsync: true,
  });
}

async function repositoryContext(cwd: string) {
  const repo = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = await git(repo, ["rev-parse", "--absolute-git-dir"]);
  return { repo, gitDir };
}

async function detectBaseBranch(repo: string): Promise<string> {
  try {
    const remoteHead = await git(repo, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    return remoteHead.replace(/^origin\//, "");
  } catch {
    for (const candidate of ["main", "master"]) {
      try {
        await git(repo, ["show-ref", "--verify", `refs/heads/${candidate}`]);
        return candidate;
      } catch {
        // Continue to the deterministic fallback.
      }
    }
    return "main";
  }
}

export interface StartWorkflowOptions {
  cwd?: string;
  workspace?: string;
  config?: string;
  requirements?: string[];
  baseBranch?: string;
  maxChars?: number;
  maxItems?: number;
  yes?: boolean;
  provider?: string;
}

interface WorkflowSession {
  schemaVersion: 2;
  repo: string;
  workspace: string;
  config: string;
  shards: string;
  task: string;
  retrospective: string;
  startedAt: string;
  mode: "editor-assisted" | "provider-automatic";
}

async function discoverConfig(
  repo: string,
  options: StartWorkflowOptions,
): Promise<RunConfig> {
  const requested = options.requirements?.length
    ? options.requirements
    : COMMON_REQUIREMENT_GLOBS;
  const found: string[] = [];
  for (const glob of requested) {
    if (
      (
        await fg(glob, {
          cwd: repo,
          onlyFiles: true,
          followSymbolicLinks: false,
          ignore: ["docs/可读化/**", "node_modules/**", "dist/**", "build/**"],
        })
      ).length > 0
    ) {
      found.push(glob);
    }
  }
  if (found.length === 0) {
    throw new Error(
      "未发现常见需求材料。请用最小覆盖参数：asset-compound start --requirements <glob> [--yes]",
    );
  }
  if (!options.requirements?.length && found.length > 1 && !options.yes) {
    throw new Error(
      `发现多个需求目录：${found.join("、")}。使用 --yes 全部采用，或 --requirements <glob> 明确选择`,
    );
  }
  return {
    outputRoot: "docs/可读化",
    baseBranch: options.baseBranch ?? (await detectBaseBranch(repo)),
    sourceSets: [
      { type: "requirement", include: found },
      { type: "git", maxCommits: 20 },
    ],
    exclude: ["node_modules/**", "dist/**", "build/**", "coverage/**"],
  };
}

function taskText(session: WorkflowSession): string {
  return `# 交给任意 AI 编辑器执行

这是 editor-assisted 工作流。CLI 没有模型 API 时不会自动完成语义分析。

1. 打开 \`${session.shards}/manifest.json\`，只处理 status 为 \`pending\` 的分片。
2. 每次只打开一个 \`${session.shards}/shards/*.json\`。
3. 只增强 \`items[].asset\`；禁止修改 \`provenance\`、来源摘录元数据、assetId、sourceRevision、contentHash。
4. 四个分析维度的 evidence、gaps、recommendations 都必须包含具体内容，禁止保留默认占位文本。
5. 每片完成后执行：
   \`npx @vinsonw2/asset-compound validate --input <该分片路径>\`
6. 按真实实践填写 \`${session.retrospective}\` 的四个复盘字段；禁止用推断、空值或占位文本。
7. 中断后重新执行 \`npx @vinsonw2/asset-compound start --yes\`，只会返回未完成片。
8. 全部完成后执行 \`npx @vinsonw2/asset-compound deliver --yes\`。

可选 provider 自动模式需要显式传入 \`--provider <可执行文件>\`。provider 每次接收
\`<shard-path> <task-path>\` 两个参数，并须原地更新 shard。凭证只能来自环境变量或系统 secret store，
不得写入配置、workspace 或仓库。
`;
}

export async function startWorkflow(options: StartWorkflowOptions = {}) {
  const { repo, gitDir } = await repositoryContext(options.cwd ?? process.cwd());
  if (await exists(path.join(repo, "NOT-ACCEPTANCE-DATA.md"))) {
    throw new Error("仓库明确标记为非验收 fixture，不能启动正式验收工作流");
  }
  const workspace = path.resolve(
    options.workspace ?? path.join(gitDir, "asset-compound"),
  );
  const configPath = path.join(workspace, "run.yaml");
  const shards = path.join(workspace, "work");
  const task = path.join(workspace, "AI-TASK.md");
  const retrospective = path.join(workspace, "retrospective.json");
  const manifestPath = path.join(shards, "manifest.json");
  const existingManifest = (await exists(manifestPath))
    ? (JSON.parse(await readFile(manifestPath, "utf8")) as {
        maxChars: number;
        maxItems: number;
      })
    : null;
  let config: RunConfig;
  let previousSession: WorkflowSession | null = null;
  if (existingManifest) {
    previousSession = JSON.parse(
      await readFile(path.join(workspace, "session.json"), "utf8"),
    ) as WorkflowSession;
    if (previousSession.schemaVersion !== 2 || previousSession.repo !== repo) {
      throw new Error("既有 workspace 不是当前验收契约版本；请使用新的 --workspace 重新 start");
    }
    if (options.config || options.requirements?.length || options.baseBranch) {
      throw new Error(
        "resume 不能更改 config、requirements 或 base branch；请使用新的 --workspace",
      );
    }
    config = await loadConfig(configPath);
  } else {
    config = options.config
      ? await loadConfig(options.config)
      : await discoverConfig(repo, options);
    await writeText(configPath, stringifyYaml(config));
  }
  const prepared = await prepareShardPipeline(repo, configPath, shards, {
    maxChars: options.maxChars ?? existingManifest?.maxChars ?? 12_000,
    maxItems: options.maxItems ?? existingManifest?.maxItems ?? 1,
    resume: existingManifest !== null,
  });
  const session: WorkflowSession = {
    schemaVersion: 2,
    repo,
    workspace,
    config: configPath,
    shards,
    task,
    retrospective,
    startedAt: previousSession?.startedAt ?? new Date().toISOString(),
    mode: options.provider ? "provider-automatic" : "editor-assisted",
  };
  if (!(await exists(retrospective))) {
    await writeText(
      retrospective,
      JSON.stringify(
        {
          maxHelp: "",
          frictionAndTime: "",
          coverageGaps: "",
          improvements: "",
        } satisfies RetrospectiveInput,
        null,
        2,
      ),
    );
  }
  await writeText(task, taskText(session));
  await writeText(path.join(workspace, "session.json"), JSON.stringify(session, null, 2));

  let providerValidation:
    | Awaited<ReturnType<typeof validateShardedInput>>
    | undefined;
  if (options.provider) {
    for (const shard of prepared.pendingShards) {
      await execFileAsync(options.provider, [shard, task], {
        cwd: repo,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });
      await validateShardedInput(shard);
    }
    providerValidation = await validateShardedInput(shards);
  }
  return {
    mode: session.mode,
    repo,
    workspace,
    effectiveConfig: configPath,
    task,
    retrospective,
    ...prepared,
    ...(providerValidation
      ? {
          completedAssets: providerValidation.completedAssets,
          pendingShards: providerValidation.pendingShards,
        }
      : {}),
    ...(options.provider
      ? {
          providerNotice:
            "provider 已逐片运行；凭证仅从进程环境继承，未写入配置或仓库",
        }
      : {
          next:
            "让任意 AI 编辑器执行 task 文件中的逐片循环；全部完成后运行 asset-compound deliver --yes",
        }),
  };
}

export interface DeliverWorkflowOptions {
  cwd?: string;
  workspace?: string;
  yes?: boolean;
}

export async function deliverWorkflow(options: DeliverWorkflowOptions = {}) {
  const { repo, gitDir } = await repositoryContext(options.cwd ?? process.cwd());
  const workspace = path.resolve(
    options.workspace ?? path.join(gitDir, "asset-compound"),
  );
  const session = JSON.parse(
    await readFile(path.join(workspace, "session.json"), "utf8"),
  ) as WorkflowSession;
  if (session.schemaVersion !== 2 || session.repo !== repo) {
    throw new Error("workspace session 与当前 Git 仓库不匹配；请先运行 start");
  }
  const retrospective = JSON.parse(
    await readFile(session.retrospective, "utf8"),
  ) as RetrospectiveInput;
  assertRetrospectiveInput(retrospective);
  const metadata = await detectAcceptanceMetadata(repo, session.startedAt);
  const validation = await validateShardedInput(session.shards);
  if (validation.pendingShards.length > 0) {
    throw new Error(`仍有 ${validation.pendingShards.length} 个未完成分片`);
  }
  const delivery = await runPipeline(repo, session.config, session.shards);
  const verification = await verifySecondRun(repo, session.config);
  const acceptance = await writeAcceptancePackage({
    repo,
    config: await loadConfig(session.config),
    delivery,
    verification,
    metadata,
    retrospective,
  });
  return {
    mode: session.mode,
    repo,
    workspace,
    delivery,
    verification,
    acceptance,
    acceptanceRoot: path.join(repo, "docs"),
  };
}
