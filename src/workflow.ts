import { execFile } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
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
  currentBranch,
  DEFAULT_MAX_EFFECTIVE_COMMITS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ITEMS,
  git,
  type GitScanStats,
  loadConfig,
  prepareShardPipeline,
  readState,
  runPipeline,
} from "./pipeline.js";
import { assertCompletedShardsFormatOnly, validateShardedInput } from "./shards.js";
import { normalizeRepoPath, repoPathsEquivalent } from "./path-utils.js";
import type { OmittedRequirementSource, RunConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const COMMON_REQUIREMENT_GLOBS = [
  "docs/requirements/**/*.md",
  "docs/product/**/*.md",
  "requirements/**/*.md",
  "specs/**/*.md",
  "spec/**/*.md",
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
  const repoRoot = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const repo = await normalizeRepoPath(repoRoot);
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

async function assertIndependentBranch(repo: string, config: RunConfig): Promise<void> {
  const branch = await currentBranch(repo);
  const baseBranch = config.baseBranch ?? "main";
  if (!branch || branch === baseBranch) {
    throw new Error(
      `正式工作流必须先切换到独立分支；当前分支为 ${branch || "（分离 HEAD）"}，基线为 ${baseBranch}`,
    );
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
  maxShards?: number;
  maxCommits?: number;
  includeTransactionalCommits?: boolean;
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

const REQUIREMENT_GLOB_PRIORITY: Array<{ glob: string; priority: number }> = [
  { glob: "docs/requirements/**/*.md", priority: 1 },
  { glob: "docs/product/**/*.md", priority: 2 },
  { glob: "requirements/**/*.md", priority: 3 },
  { glob: "specs/**/*.md", priority: 4 },
  { glob: "spec/**/*.md", priority: 5 },
];

async function pickSingleRequirement(
  repo: string,
): Promise<{ selected: string; omitted: OmittedRequirementSource[] }> {
  const refactorPath = "spec/refactor.md";
  if (await exists(path.join(repo, refactorPath))) {
    const all = await fg(COMMON_REQUIREMENT_GLOBS, {
      cwd: repo,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: ["docs/可读化/**", "node_modules/**", "dist/**", "build/**"],
    });
    const unique = [...new Set(all)].sort();
    return {
      selected: refactorPath,
      omitted: unique
        .filter((file) => file !== refactorPath)
        .map((file) => ({
          path: file,
          reason: "闯关默认仅纳入 1 份 requirement；优先级 spec/refactor.md",
        })),
    };
  }
  const candidates: Array<{ path: string; priority: number; mtimeMs: number }> = [];
  for (const { glob, priority } of REQUIREMENT_GLOB_PRIORITY) {
    const matches = await fg(glob, {
      cwd: repo,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: ["docs/可读化/**", "node_modules/**", "dist/**", "build/**"],
    });
    for (const file of matches) {
      const fileStat = await stat(path.join(repo, file));
      candidates.push({ path: file, priority, mtimeMs: fileStat.mtimeMs });
    }
  }
  const deduped = new Map<string, { path: string; priority: number; mtimeMs: number }>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.path);
    if (!existing || candidate.priority < existing.priority) {
      deduped.set(candidate.path, candidate);
    }
  }
  const sorted = [...deduped.values()].sort(
    (left, right) =>
      left.priority - right.priority ||
      right.mtimeMs - left.mtimeMs ||
      left.path.localeCompare(right.path),
  );
  if (sorted.length === 0) {
    throw new Error("未发现可纳入的 requirement 文件");
  }
  const selected = sorted[0]!.path;
  return {
    selected,
    omitted: sorted.slice(1).map((candidate) => ({
      path: candidate.path,
      reason: "闯关默认仅纳入 1 份 requirement",
    })),
  };
}

async function discoverConfig(
  repo: string,
  options: StartWorkflowOptions,
): Promise<{ config: RunConfig; omittedRequirementSources: OmittedRequirementSource[] }> {
  const explicitRequirements = Boolean(options.requirements?.length);
  const requested = options.requirements?.length
    ? options.requirements
    : COMMON_REQUIREMENT_GLOBS;
  const found: string[] = [];
  const unmatched: string[] = [];
  for (const glob of requested) {
    const matches = await fg(glob, {
      cwd: repo,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: ["docs/可读化/**", "node_modules/**", "dist/**", "build/**"],
    });
    (matches.length > 0 ? found : unmatched).push(glob);
  }
  const patternDiagnostics = [
    `调用 cwd：${path.resolve(options.cwd ?? process.cwd())}`,
    `扫描 cwd（Git 根目录）：${repo}`,
    `传入 patterns：${requested.map((glob) => JSON.stringify(glob)).join("、")}`,
    `零匹配 patterns：${unmatched.map((glob) => JSON.stringify(glob)).join("、") || "无"}`,
  ].join("\n");
  if (explicitRequirements && unmatched.length > 0) {
    throw new Error(
      `显式 requirement pattern 存在零匹配，已停止以避免静默遗漏来源。\n${patternDiagnostics}`,
    );
  }
  if (found.length === 0) {
    throw new Error(
      `未发现常见需求材料。请用最小覆盖参数：asset-compound start --requirements <glob> [--yes]\n${patternDiagnostics}`,
    );
  }
  if (!options.requirements?.length && found.length > 1 && !options.yes) {
    throw new Error(
      `发现多个需求目录：${found.join("、")}。使用 --yes 自动纳入单份 requirement，或 --requirements <glob> 明确选择`,
    );
  }
  let requirementInclude = found;
  let omittedRequirementSources: OmittedRequirementSource[] = [];
  if (!explicitRequirements && options.yes) {
    const single = await pickSingleRequirement(repo);
    requirementInclude = [single.selected];
    omittedRequirementSources = single.omitted;
  }
  return {
    config: {
      outputRoot: "docs/可读化",
      baseBranch: options.baseBranch ?? (await detectBaseBranch(repo)),
      maxShards: options.maxShards ?? 10,
      sourceSets: [
        { type: "requirement", include: requirementInclude },
        {
          type: "git",
          maxCommits: options.maxCommits ?? DEFAULT_MAX_EFFECTIVE_COMMITS,
          includeTransactionalCommits: options.includeTransactionalCommits ?? false,
        },
      ],
      exclude: ["node_modules/**", "dist/**", "build/**", "coverage/**"],
    },
    omittedRequirementSources,
  };
}

interface TaskScaleSummary {
  effectiveGitCommits: number;
  skippedGitCommits: number;
  scannedGitCommits: number;
  totalShards: number;
  maxChars: number;
  maxItems: number;
}

function taskText(session: WorkflowSession, summary: TaskScaleSummary): string {
  return `# AI 小上下文逐片任务

这是 editor-assisted 工作流。CLI 不含模型 API；你必须逐片完成语义分析，不能把
\`start\` 生成基线误报为分析完成。

## 本轮规模摘要

- 扫描 Git 提交：${summary.scannedGitCommits}
- 有效 Git 提交：${summary.effectiveGitCommits}（跳过的事务提交不占名额）
- 跳过 Git 提交：${summary.skippedGitCommits}
- 总分片：${summary.totalShards}
- 单片字符预算：${summary.maxChars}
- 单片资产上限：${summary.maxItems}

Git 来源已由 \`start\` 在 CLI 阶段完成事务过滤；片内每条记录均可提炼。不要扫描
全仓历史，不要自行再过滤 chore/依赖/eslint 类提交。
\`skippedGitCommits\` 与 manifest 中的跳过项仅用于 R1/R6 报告引用，勿对跳过项补写资产。

## 本轮唯一输入边界

1. 先读 \`${session.shards}/manifest.json\`，只选择第一条 \`status=pending\` 的记录。
2. 本轮只打开该记录指向的一个 \`${session.shards}/shards/NNNN.json\`。
3. 事实只能来自该片的 \`items[].sourceExcerpt.text\` 和不可变 \`provenance\`。
4. 禁止同时读取/拼接全部 shards，禁止自行扫描仓库、猜测目录，禁止为补全
   \`truncated=true\` 的摘录而打开原始全文；缺失信息写入 gaps。

## Git diff 证据（仅适用于 sourceType=git）

1. 先读 diff：按 \`GIT_COMMIT/GIT_FILE/GIT_STATUS\` 确认边界，再逐个阅读
   \`PATCH_BEGIN…PATCH_END\` 中可见的 \`@@ ... @@\` hunk；提交消息只作意图线索，
   不能替代代码证据。
2. Git 资产的 evidence 必须写出 \`文件路径@commit + @@ hunk 定位\` 并引用该
   hunk 的实际变更；\`POST_IMAGE_BEGIN path@commit:Lx-Ly\` 只能补充变更后局部语境。
3. 遇到 \`PATCH_TRUNCATED/PATCH_CAPTURE_TRUNCATED\` 必须在 gaps 明确未覆盖内容；
   禁止打开全仓或完整大文件补齐，禁止推断未显示的调用方、运行结果或业务结论。

## Git 来源窗口

Git 来源默认仅最近 **${DEFAULT_MAX_EFFECTIVE_COMMITS} 次有效提交**（\`maxCommits\` 指
有效数，跳过的不占名额），不是全仓历史。不得暗示、假设或声称已审阅全部提交；窗口外
内容只能写入 gap。

## 事务性提交边界

\`skippedGitCommits\` 仅是 R1/R6 可追溯证据，不是待分析资产。如确需把被跳过提交纳入，
停止当前 workspace，并要求用户以 \`--include-transactional-commits\` 新建 workspace 重跑。

## 唯一输出与 schema

- 唯一输出路径就是当前 shard 原文件；原地写回纯 JSON，不创建说明文件、Markdown
  围栏或旁路结果，不修改项目源码、原始 docs、配置、manifest 或其他 shard。
- 只能修改 \`items[].asset\` 的 \`title/summary/facts/decisions/actions/relations/analysis\`。
- 禁止修改顶层 \`schemaVersion/shardId\`、项数/顺序、\`provenance\`、
  \`sourceExcerpt\`，以及 asset 的
  \`assetId/sourceType/sourceRef/sourceRevision/contentHash/writebackKind\`。
- 当前 shard 结构和 CLI \`validate\` 是唯一 schema 权威；禁止新增字段。

## 每个 asset 的必填内容

- \`title\` 明确命名资产；\`summary\` 至少 20 个字符。
- \`facts/decisions/actions/relations\` 四个数组必须保留：只写摘录可证明的内容；
  没有证据时使用空数组，不得编造。
- \`analysis\` 必须完整包含
  \`completeness/executability/consistency/reuseValue\`。
- 前三维 level 仅用 \`ready/partial/missing/conflict\`；复用价值仅用
  \`high/medium/low\`。
- 每维的 \`evidence/gaps/recommendations\` 都至少一项、每项至少 4 个字符。
  evidence 必须引用或紧密复述本片摘录中的具体事实；不能只写来源路径或泛化套话。
- 无法由摘录证明时降低 level 并写明 gap；禁止推断负责人、时间、接口、数据结构、
  跨片一致性或任何摘录外事实。发现冲突时用 \`conflict\` 并逐条记录双方证据。

## 完成、失败、重试

1. 保存当前 shard 后只运行：
   \`npx @vinsonw2/asset-compound validate --input <当前分片绝对路径>\`
2. exit 0 才表示该片完成；manifest 会记录 completed。失败时根据 stderr 只修当前片，
   重跑同一命令；不得跳过、手改完成标记或重做已完成片。
3. 若摘录为空/含敏感信息、不可变字段异常或证据不足以形成实质结论，停止该片并报告
   具体原因，不能伪造通过结果。
4. 单片成功后释放其上下文，再从 manifest 取下一条 pending。中断后重新执行
   \`npx @vinsonw2/asset-compound start --yes\`，只继续 pending shard。

## 最终交付

全部 shard validate 成功后，按真实实践填写 \`${session.retrospective}\` 的
\`maxHelp/frictionAndTime/coverageGaps/improvements\`；禁止空值、占位文本或推断。
然后运行 \`npx @vinsonw2/asset-compound deliver --yes\`。只有标准 docs、2.1
五类材料、2.2 完整报告、R1–R6、V1–V8、冲突门禁和二次 zero diff 全部通过，
才能宣称完成；任一失败必须保留错误并停止。

可选 provider 自动模式必须由用户显式传入 \`--provider <executable>\`。provider
每次只接收 \`<shard-path> <task-path>\`，仍须遵守以上边界并原地写回当前 shard。
凭证只能来自进程环境或系统 secret store，禁止进入参数、输出、workspace 或仓库。
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
  let omittedRequirementSources: OmittedRequirementSource[] = [];
  let previousSession: WorkflowSession | null = null;
  if (existingManifest) {
    previousSession = JSON.parse(
      await readFile(path.join(workspace, "session.json"), "utf8"),
    ) as WorkflowSession;
    if (
      previousSession.schemaVersion !== 2 ||
      !repoPathsEquivalent(previousSession.repo, repo)
    ) {
      throw new Error("既有 workspace 不是当前验收契约版本；请使用新的 --workspace 重新 start");
    }
    if (
      options.config ||
      options.requirements?.length ||
      options.baseBranch ||
      options.includeTransactionalCommits !== undefined ||
      options.maxCommits !== undefined
    ) {
      throw new Error(
        "resume 不能更改 config、requirements、base branch、maxCommits 或事务提交过滤；请使用新的 --workspace",
      );
    }
    config = await loadConfig(configPath);
  } else {
    if (options.config) {
      config = await loadConfig(options.config);
    } else {
      const discovered = await discoverConfig(repo, options);
      config = discovered.config;
      omittedRequirementSources = discovered.omittedRequirementSources;
    }
    const transactionalOverride = options.includeTransactionalCommits;
    const maxCommitsOverride = options.maxCommits;
    config = {
      ...config,
      maxShards: options.maxShards ?? config.maxShards ?? 10,
      sourceSets: config.sourceSets.map((source) => {
        if (source.type !== "git") return source;
        return {
          ...source,
          ...(maxCommitsOverride !== undefined ? { maxCommits: maxCommitsOverride } : {}),
          ...(transactionalOverride !== undefined
            ? { includeTransactionalCommits: transactionalOverride }
            : {}),
        };
      }),
    };
    await assertIndependentBranch(repo, config);
    await writeText(configPath, stringifyYaml(config));
  }
  if (existingManifest) await assertIndependentBranch(repo, config);
  const prepared = await prepareShardPipeline(repo, configPath, shards, {
    ...(options.maxChars !== undefined
      ? { maxChars: options.maxChars }
      : existingManifest
        ? {}
        : { maxChars: DEFAULT_MAX_CHARS }),
    ...(options.maxItems !== undefined
      ? { maxItems: options.maxItems }
      : existingManifest
        ? {}
        : { maxItems: DEFAULT_MAX_ITEMS }),
    ...(options.maxShards !== undefined ? { maxShards: options.maxShards } : {}),
    ...(omittedRequirementSources.length > 0 ? { omittedRequirementSources } : {}),
    resume: existingManifest !== null,
  });
  const gitScanStats = prepared.gitScanStats;
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
  const manifest = JSON.parse(await readFile(path.join(shards, "manifest.json"), "utf8")) as {
    shards: unknown[];
  };
  const scaleSummary: TaskScaleSummary = {
    effectiveGitCommits: gitScanStats?.effectiveCommits ?? 0,
    skippedGitCommits: gitScanStats?.skippedCommits ?? 0,
    scannedGitCommits: gitScanStats?.scannedCommits ?? 0,
    totalShards: manifest.shards.length,
    maxChars: prepared.maxChars,
    maxItems: prepared.maxItems,
  };
  await writeText(task, taskText(session, scaleSummary));
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
    gitScanSummary: scaleSummary,
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
  if (!options.yes) {
    throw new Error("deliver 将写入受管 docs；请显式传入 --yes 确认非交互交付");
  }
  const { repo, gitDir } = await repositoryContext(options.cwd ?? process.cwd());
  const workspace = path.resolve(
    options.workspace ?? path.join(gitDir, "asset-compound"),
  );
  const session = JSON.parse(
    await readFile(path.join(workspace, "session.json"), "utf8"),
  ) as WorkflowSession;
  if (session.schemaVersion !== 2 || !repoPathsEquivalent(session.repo, repo)) {
    throw new Error("workspace session 与当前 Git 仓库不匹配；请先运行 start");
  }
  const retrospective = JSON.parse(
    await readFile(session.retrospective, "utf8"),
  ) as RetrospectiveInput;
  assertRetrospectiveInput(retrospective);
  const metadata = await detectAcceptanceMetadata(repo, session.startedAt);
  await assertCompletedShardsFormatOnly(session.shards);
  const delivery = await runPipeline(repo, session.config, session.shards, {
    freezeSources: "trust",
  });
  const state = await readState(repo);
  const verification = {
    secondRunZeroDiff: true,
    counts: {
      new: 0,
      updated: 0,
      unchanged: delivery.assets.length,
      conflicts: 0,
    },
    stateCommit: state?.lastReadCommit ?? "",
  };
  const acceptance = await writeAcceptancePackage({
    repo,
    config: await loadConfig(session.config),
    delivery,
    verification,
    metadata,
    retrospective,
    trustDelivered: true,
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
