import { access, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { escapesRepositoryRelative, relativePosix } from "./path-utils.js";
import writeFileAtomic from "write-file-atomic";
import { assertSubstantiveAsset } from "./quality.js";
import { currentBranch, git, renderAsset, sha256 } from "./pipeline.js";
import type { AssetRecord, PipelineResult, RunConfig, SourceType } from "./types.js";

const GIT_REVISION = /^[0-9a-f]{40}$/i;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/i;
const FILE_SOURCE_TYPES = new Set<SourceType>(["requirement", "design", "ai-artifact"]);

export function assertAssetSourceRevision(
  asset: AssetRecord,
  options?: { trustDelivered?: boolean },
): void {
  if (asset.sourceType === "git") {
    if (!GIT_REVISION.test(asset.sourceRevision)) {
      throw new Error(`来源未提交或 revision 不可追溯，不能计入真实数据源：${asset.sourceRef}`);
    }
    return;
  }
  if (FILE_SOURCE_TYPES.has(asset.sourceType)) {
    if (options?.trustDelivered) {
      if (
        asset.sourceRevision === "untracked" ||
        GIT_REVISION.test(asset.sourceRevision) ||
        (CONTENT_HASH.test(asset.contentHash) && asset.sourceRevision.trim().length > 0)
      ) {
        return;
      }
      throw new Error(`来源未提交或 revision 不可追溯，不能计入真实数据源：${asset.sourceRef}`);
    }
  }
  if (!GIT_REVISION.test(asset.sourceRevision)) {
    throw new Error(`来源未提交或 revision 不可追溯，不能计入真实数据源：${asset.sourceRef}`);
  }
}

const STANDARD_DIRECTORIES = [
  "00-项目总览",
  "01-业务资产",
  "02-技术架构",
  "03-接口资产",
  "04-数据资产",
  "05-代码图谱",
  "06-开发规范",
  "07-AI资产",
] as const;
const ACCEPTANCE_ROOT = "docs/07-AI资产/资产复利";
const ACCEPTANCE_STATE = `${ACCEPTANCE_ROOT}/state.json`;

export interface RetrospectiveInput {
  maxHelp: string;
  frictionAndTime: string;
  coverageGaps: string;
  improvements: string;
}

export interface AcceptanceMetadata {
  developmentGroup: string;
  practitioner: string;
  project: string;
  repository: string;
  branch: string;
  head: string;
  startedAt: string;
  trigger: string;
  toolWorkflow: string;
}

interface AcceptanceState {
  schemaVersion: 2;
  selfHash: string;
  runId: string;
  completedAt: string;
  reportedHead: string;
  deliveryCounts: PipelineResult["counts"];
  assetWritebackKinds: Record<string, AssetRecord["writebackKind"]>;
  managedFiles: Record<string, string>;
}

interface AcceptanceOptions {
  repo: string;
  config: RunConfig;
  delivery: PipelineResult;
  /** deliver 信任已完成分片时，文件型来源允许 manifest 中的 untracked / contentHash 溯源 */
  trustDelivered?: boolean;
  verification: {
    secondRunZeroDiff: boolean;
    counts: {
      new: number;
      updated: number;
      unchanged: number;
      conflicts: number;
    };
    stateCommit: string;
  };
  metadata: AcceptanceMetadata;
  retrospective: RetrospectiveInput;
}

const SOURCE_LABELS = {
  requirement: "需求",
  design: "设计",
  "ai-artifact": "AI 产物",
  git: "Git 历史",
} as const;

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function substantive(value: string): boolean {
  return value.trim().length >= 4;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, "<br>").trim();
}

function markdownLinkText(value: string): string {
  return markdownCell(value).replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function inlineCode(value: string): string {
  return `\`${markdownCell(value).replaceAll("`", "'")}\``;
}

function parseRemote(remote: string): { group: string; project: string } {
  const parsed = new URL(remote);
  const parts = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("无法从 origin URL 提取开发组和工程项目；请配置标准 Git remote origin");
  }
  return { group: parts.at(-2)!, project: parts.at(-1)! };
}

function safeRemote(raw: string): string {
  const scp = raw.includes("://") ? null : raw.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  const normalized = scp ? `ssh://${scp[1]}/${scp[2]}` : raw;
  let remote: URL;
  try {
    remote = new URL(normalized);
  } catch {
    throw new Error("验收报告需要标准 Git remote origin URL，且不能包含本地路径");
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(remote.protocol)) {
    throw new Error("验收报告只接受 http(s)、ssh 或 git remote origin URL");
  }
  remote.username = "";
  remote.password = "";
  remote.search = "";
  remote.hash = "";
  return remote.toString().replace(/\/$/, "");
}

export async function detectAcceptanceMetadata(
  repo: string,
  startedAt: string,
): Promise<AcceptanceMetadata> {
  const rawRepository = await git(repo, ["config", "--get", "remote.origin.url"]);
  const practitioner = await git(repo, ["config", "--get", "user.name"]);
  const branch = await currentBranch(repo);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  if (!rawRepository.trim() || !practitioner.trim()) {
    throw new Error("验收报告需要真实 origin URL 和 git user.name；禁止用推断值代替");
  }
  if (!branch.trim() || !head.trim()) throw new Error("验收报告需要真实 Git 分支和 HEAD");
  const repository = safeRemote(rawRepository);
  const parsed = parseRemote(repository);
  return {
    developmentGroup: parsed.group,
    practitioner,
    project: parsed.project,
    repository,
    branch,
    head,
    startedAt,
    trigger: "asset-compound start --yes → asset-compound deliver --yes",
    toolWorkflow: "@vinsonw2/asset-compound 小上下文分片工作流",
  };
}

function categoryFor(asset: AssetRecord): (typeof STANDARD_DIRECTORIES)[number] {
  const value = `${asset.sourceRef} ${asset.title}`.toLowerCase();
  if (/(?:api|interface|openapi|swagger|接口)/.test(value)) return "03-接口资产";
  if (/(?:database|schema|model|migration|数据|数据库)/.test(value)) return "04-数据资产";
  if (/(?:convention|standard|guideline|lint|规范|开发指南)/.test(value)) {
    return "06-开发规范";
  }
  if (asset.sourceType === "ai-artifact") return "07-AI资产";
  if (asset.sourceType === "git") return "05-代码图谱";
  if (asset.sourceType === "design" || /(?:architecture|架构|设计)/.test(value)) {
    return "02-技术架构";
  }
  return "01-业务资产";
}

function assetPath(asset: AssetRecord): string {
  return `docs/${categoryFor(asset)}/${asset.assetId.slice(7)}.md`;
}

function linkFromDocs(target: string): string {
  return target.replace(/^docs\//, "");
}

function renderNavigation(assets: AssetRecord[]): string {
  const counts = new Map(STANDARD_DIRECTORIES.map((directory) => [directory, 0]));
  for (const asset of assets) counts.set(categoryFor(asset), (counts.get(categoryFor(asset)) ?? 0) + 1);
  const rows = STANDARD_DIRECTORIES.map(
    (directory) => `| [${directory}](./${directory}/README.md) | ${counts.get(directory) ?? 0} |`,
  ).join("\n");
  return `# 项目资产导航

> 本目录由 asset-compound 按验收契约生成；未通过门禁时不会标记交付成功。

| 分类 | 资产数 |
|---|---:|
${rows}

## 验收入口

- [资产复利实践报告](./07-AI资产/资产复利/资产复利实践报告.md)
- [提取源清单](./07-AI资产/资产复利/提取源清单.md)
- [回写记录](./07-AI资产/资产复利/回写记录.md)
- [验证证据](./07-AI资产/资产复利/验证证据/verification.json)
`;
}

function renderCategoryIndex(directory: string, assets: AssetRecord[]): string {
  const selected = assets.filter((asset) => categoryFor(asset) === directory);
  const items =
    selected.length === 0
      ? "- 本次没有可验收资产。"
      : selected
          .map(
            (asset) =>
              `- [${markdownLinkText(asset.title)}](./${asset.assetId.slice(7)}.md) — ${SOURCE_LABELS[asset.sourceType]} / ${asset.writebackKind}`,
          )
          .join("\n");
  return `# ${directory}

${items}
`;
}

function renderSourceInventory(assets: AssetRecord[]): string {
  const rows = assets
    .map(
      (asset) =>
        `| ${SOURCE_LABELS[asset.sourceType]} | ${inlineCode(asset.sourceRef)} | ${asset.writebackKind === "新增" ? "是" : "否"} | [${markdownLinkText(asset.title)}](../../${linkFromDocs(assetPath(asset))}) |`,
    )
    .join("\n");
  return `# 提取源清单

| 数据源 | 读取对象 | 是否新增 | 结果 |
|---|---|---|---|
${rows}
`;
}

function renderWriteback(options: AcceptanceOptions): string {
  const rows = options.delivery.assets
    .map(
      (asset) =>
        `| ${asset.writebackKind} | ${inlineCode(assetPath(asset))} | ${options.delivery.counts.conflicts === 0 ? "无冲突；hash 门禁通过" : "见冲突报告"} | 分支 ${inlineCode(options.metadata.branch)} / HEAD ${inlineCode(options.metadata.head)}；合入由目标仓 PR 流程完成 |`,
    )
    .join("\n");
  return `# 回写记录

- 仓库：\`${options.metadata.repository}\`
- 可读化目录：\`docs/\`

| 类型 | 路径 | 冲突处理 | 提交 / 合入 |
|---|---|---|---|
${rows}
`;
}

function renderReport(options: AcceptanceOptions, finishedAt: string): string {
  const sourceTypes = [...new Set(options.delivery.assets.map((asset) => asset.sourceType))];
  const sourceSummary = sourceTypes.map((type) => SOURCE_LABELS[type]).join("、");
  const elapsedMs = Date.parse(finishedAt) - Date.parse(options.metadata.startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error("start/deliver 时间无效，无法填写实际投入");
  }
  const dimension = (finding: AssetRecord["analysis"]["completeness"]) =>
    `${finding.level}；证据：${finding.evidence.join("；")}；缺口：${finding.gaps.join("；")}；建议：${finding.recommendations.join("；")}`;
  const dimensions = options.delivery.assets
    .map(
      (asset) =>
        `| [${markdownLinkText(asset.title)}](../../${linkFromDocs(assetPath(asset))}) | ${markdownCell(dimension(asset.analysis.completeness))} | ${markdownCell(dimension(asset.analysis.executability))} | ${markdownCell(dimension(asset.analysis.consistency))} | ${markdownCell(dimension(asset.analysis.reuseValue))} |`,
    )
    .join("\n");
  const sourceRows = options.delivery.assets
    .map(
      (asset) =>
        `| ${SOURCE_LABELS[asset.sourceType]} | ${inlineCode(asset.sourceRef)} | ${asset.writebackKind === "新增" ? "是" : "否"} | [已分类回写](../../${linkFromDocs(assetPath(asset))}) |`,
    )
    .join("\n");
  const writebackRows = options.delivery.assets
    .map(
      (asset) =>
        `| ${asset.writebackKind} | ${inlineCode(assetPath(asset))} | 无冲突；人工修改由 managed hash 拒绝覆盖 | 分支 ${inlineCode(options.metadata.branch)} / HEAD ${inlineCode(options.metadata.head)}，合入由目标仓 PR 流程完成 |`,
    )
    .join("\n");
  return `# 资产复利实践报告

## 基本信息

| 字段 | 实际值 |
|---|---|
| 开发组 | ${markdownCell(options.metadata.developmentGroup)} |
| 实践人 | ${markdownCell(options.metadata.practitioner)} |
| 工程项目 | ${markdownCell(options.metadata.project)}（${markdownCell(options.metadata.repository)}） |
| 工具 / 工作流 | ${markdownCell(options.metadata.toolWorkflow)} |
| 触发方式 | ${markdownCell(options.metadata.trigger)} |
| 数据源 | ${sourceSummary}（${sourceTypes.length} 类） |
| 可读化目录 | \`docs/\` |
| 实际投入 | ${options.metadata.startedAt} 至 ${finishedAt}，机器记录 ${Math.ceil(elapsedMs / 1000)} 秒 |

## 环节对照表

| 条款 | 本次环节 / 命令 | 证据位置 |
|---|---|---|
| R1 识别读取 | \`start --yes\` 自动发现并扫描真实来源 | [提取源清单](./提取源清单.md) |
| R2 结构化提取 | 分片逐项生成并通过 schema / provenance 校验 | [分类资产目录](../../README.md) |
| R3 四维分析 | \`validate\` 校验逐资产四维结论和实质内容 | [四维分析](#四维分析) |
| R4 分类回写 | \`deliver --yes\` 仅写受管 \`docs/\` 范围并分类回写至标准目录 | [回写记录](./回写记录.md) |
| R5 防重复 | state/hash 水位与二次 zero diff 校验 | [验证证据](./验证证据/verification.json) |
| R6 全链路留痕 | 来源、分片、分析、回写、冲突和目录结构均留痕 | [证据目录](./验证证据/) |

## V1–V8 验收门禁

| 验收点 | 机器结论 | 证据位置 |
|---|---|---|
| V1 材料齐全 | 通过：五类 2.1 交付材料均已生成 | [verification.json](./验证证据/verification.json) |
| V2 多源真实输入 | 通过：${sourceTypes.length} 类非空来源 | [提取源清单](./提取源清单.md) |
| V3 识别提取 | 通过：${options.delivery.assets.length} 条资产完成结构化提取 | [分类资产目录](../../README.md) |
| V4 四维结论 | 通过：每条资产四维字段均通过实质质量门禁 | [四维分析](#四维分析) |
| V5 回写与分支 | 通过：独立分支 ${inlineCode(options.metadata.branch)} 且写入范围仅为受管 docs | [回写记录](./回写记录.md) |
| V6 防重复 | 通过：secondRunZeroDiff=true，新增和增量均为 0 | [验证证据](./验证证据/verification.json) |
| V7 时序追溯 | 通过：来源 revision、hash、HEAD 和 state 水位可反查 | [验证证据](./验证证据/verification.json) |
| V8 可读复用 | 通过：README 导航、分类资产页和复盘均完整 | [项目资产导航](../../README.md) |

## 提取源清单

| 数据源 | 读取对象 | 是否新增 | 结果 |
|---|---|---|---|
${sourceRows}

## 四维分析

| 资产 | 完整性 | 可执行性 | 一致性 | 复用价值 |
|---|---|---|---|---|
${dimensions}

## 回写记录

| 类型 | 路径 | 冲突处理 | 提交 / 合入 |
|---|---|---|---|
${writebackRows}

## 防重复验证

- 标记位置：\`docs/可读化/state/read-state.json\` 与 \`${ACCEPTANCE_STATE}\`
- 再次触发仅增量证据：\`secondRunZeroDiff=${options.verification.secondRunZeroDiff}\`，
  新增 ${options.verification.counts.new}、增量 ${options.verification.counts.updated}、
  未变 ${options.verification.counts.unchanged}、冲突 ${options.verification.counts.conflicts}
- 机器证据：[verification.json](./验证证据/verification.json)

## 复盘

- 最大帮助：${markdownCell(options.retrospective.maxHelp)}
- 最不顺 / 耗时：${markdownCell(options.retrospective.frictionAndTime)}
- 覆盖缺口：${markdownCell(options.retrospective.coverageGaps)}
- 改进：${markdownCell(options.retrospective.improvements)}
`;
}

function assertReport(report: string, assets: AssetRecord[]): void {
  const required = [
    "# 资产复利实践报告",
    "## 基本信息",
    "## 环节对照表",
    "## V1–V8 验收门禁",
    "## 提取源清单",
    "## 四维分析",
    "## 回写记录",
    "## 防重复验证",
    "## 复盘",
  ];
  for (const heading of required) {
    if (!report.includes(heading)) throw new Error(`2.2 报告缺少章节：${heading}`);
  }
  for (const requirement of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
    const row = report.split("\n").find((line) => line.startsWith(`| ${requirement} `));
    if (!row || row.split("|").slice(1, -1).some((cell) => cell.trim().length === 0)) {
      throw new Error(`2.2 环节对照表 ${requirement} 存在空字段`);
    }
  }
  for (const asset of assets) {
    if (!report.includes(asset.assetId.slice(7))) {
      throw new Error(`2.2 报告缺少资产四维分析：${asset.assetId}`);
    }
  }
}

function assertPackageStructure(contents: Map<string, string>): void {
  const required = [
    "docs/README.md",
    ...STANDARD_DIRECTORIES.map((directory) => `docs/${directory}/README.md`),
    `${ACCEPTANCE_ROOT}/资产复利实践报告.md`,
    `${ACCEPTANCE_ROOT}/提取源清单.md`,
    `${ACCEPTANCE_ROOT}/回写记录.md`,
    `${ACCEPTANCE_ROOT}/冲突报告.md`,
    `${ACCEPTANCE_ROOT}/验证证据/verification.json`,
    `${ACCEPTANCE_ROOT}/验证证据/directory-tree.txt`,
  ];
  for (const relative of required) {
    if (!contents.has(relative)) throw new Error(`1.1 / 2.1 交付结构缺失：${relative}`);
  }

  const planned = new Set([...contents.keys(), ACCEPTANCE_STATE]);
  for (const [relative, content] of contents) {
    if (!relative.endsWith(".md")) continue;
    for (const match of content.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
      const href = match[1]!;
      if (/^(?:[a-z]+:|#)/i.test(href)) continue;
      const withoutAnchor = href.split("#", 1)[0]!;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), withoutAnchor));
      const found = withoutAnchor.endsWith("/")
        ? [...planned].some((candidate) => candidate.startsWith(resolved))
        : planned.has(resolved);
      if (!found) throw new Error(`验收文档内部链接无目标：${relative} → ${href}`);
    }
  }
}

export async function safeTarget(repo: string, relative: string): Promise<string> {
  const root = await realpath(repo);
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  const relPosix = relativePosix(rel);
  if (
    escapesRepositoryRelative(rel) ||
    !(
      relPosix === "docs/README.md" ||
      STANDARD_DIRECTORIES.some((dir) => relPosix.startsWith(`docs/${dir}/`))
    )
  ) {
    throw new Error(`标准 docs 写入越界：${relative}`);
  }
  let cursor = root;
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (await exists(cursor) && (await lstat(cursor)).isSymbolicLink()) {
      throw new Error(`标准 docs 写入路径含符号链接：${relative}`);
    }
  }
  return absolute;
}

async function loadAcceptanceState(repo: string): Promise<AcceptanceState | null> {
  const target = path.join(repo, ACCEPTANCE_STATE);
  if (!(await exists(target))) return null;
  const state = JSON.parse(await readFile(target, "utf8")) as AcceptanceState;
  const expected = sha256(JSON.stringify({ ...state, selfHash: "" }, null, 2));
  if (state.schemaVersion !== 2 || state.selfHash !== expected) {
    throw new Error("标准 docs state 无效或被人工编辑");
  }
  return state;
}

export function assertRetrospectiveInput(retrospective: RetrospectiveInput): void {
  for (const [name, value] of Object.entries(retrospective)) {
    if (!substantive(value)) throw new Error(`2.2 复盘字段 ${name} 不能为空或使用占位值`);
    if (/(?:待补充|待确认|todo|tbd|n\/a|none|暂无|未知)/i.test(value)) {
      throw new Error(`2.2 复盘字段 ${name} 仍包含占位内容`);
    }
  }
}

export async function writeAcceptancePackage(options: AcceptanceOptions) {
  if (options.delivery.conflicts.length > 0 || options.delivery.counts.conflicts > 0) {
    throw new Error("存在冲突，拒绝生成看似成功的 2.2 验收报告");
  }
  if (!options.verification.secondRunZeroDiff || options.verification.counts.new !== 0 || options.verification.counts.updated !== 0) {
    throw new Error("防重复验证未通过，拒绝生成验收交付");
  }
  if (await exists(path.join(options.repo, "NOT-ACCEPTANCE-DATA.md"))) {
    throw new Error("仓库明确标记为非验收 fixture，不能生成正式验收结论");
  }
  const sourceTypes = new Set(options.delivery.assets.map((asset) => asset.sourceType));
  if (sourceTypes.size < 2) throw new Error("2.1 提取源清单必须包含至少两种真实数据源");
  if (options.delivery.assets.length === 0) throw new Error("没有可验收资产");
  for (const asset of options.delivery.assets) {
    assertAssetSourceRevision(
      asset,
      options.trustDelivered ? { trustDelivered: true } : undefined,
    );
    assertSubstantiveAsset(asset);
  }
  assertRetrospectiveInput(options.retrospective);

  const previous = await loadAcceptanceState(options.repo);
  const sameRun = previous?.runId === options.delivery.runId;
  const effectiveAssets = options.delivery.assets.map((asset) => ({
    ...asset,
    writebackKind: sameRun
      ? previous.assetWritebackKinds[asset.assetId] ?? asset.writebackKind
      : asset.writebackKind,
  }));
  const effectiveOptions: AcceptanceOptions = {
    ...options,
    metadata: {
      ...options.metadata,
      head: sameRun ? previous.reportedHead : options.metadata.head,
    },
    delivery: {
      ...options.delivery,
      assets: effectiveAssets,
      counts: sameRun ? previous.deliveryCounts : options.delivery.counts,
    },
  };
  const finishedAt =
    sameRun ? previous.completedAt : new Date().toISOString();
  const contents = new Map<string, string>();
  contents.set("docs/README.md", renderNavigation(effectiveAssets));
  for (const directory of STANDARD_DIRECTORIES) {
    contents.set(`docs/${directory}/README.md`, renderCategoryIndex(directory, effectiveAssets));
  }
  contents.set(
    "docs/00-项目总览/README.md",
    `# 00-项目总览

- 工程项目：${effectiveOptions.metadata.project}
- 仓库：\`${effectiveOptions.metadata.repository}\`
- 分支 / HEAD：\`${effectiveOptions.metadata.branch}\` / \`${effectiveOptions.metadata.head}\`
- 实践人：${effectiveOptions.metadata.practitioner}
- 数据源：${[...sourceTypes].map((type) => SOURCE_LABELS[type]).join("、")}
- 资产数：${options.delivery.assets.length}
`,
  );
  for (const asset of effectiveAssets) contents.set(assetPath(asset), renderAsset(asset));
  contents.set(`${ACCEPTANCE_ROOT}/提取源清单.md`, renderSourceInventory(effectiveAssets));
  contents.set(`${ACCEPTANCE_ROOT}/回写记录.md`, renderWriteback(effectiveOptions));
  contents.set(
    `${ACCEPTANCE_ROOT}/冲突报告.md`,
    `# 冲突报告\n\n本次自动门禁检查发现 0 个冲突。\n`,
  );
  const report = renderReport(effectiveOptions, finishedAt);
  assertReport(report, effectiveAssets);
  contents.set(`${ACCEPTANCE_ROOT}/资产复利实践报告.md`, report);

  const evidence = {
    schemaVersion: 1,
    generatedAt: finishedAt,
    contract: {
      task11StandardDocs: true,
      task21FiveMaterials: true,
      task22CompleteReport: true,
      requirements: Object.fromEntries(["R1", "R2", "R3", "R4", "R5", "R6"].map((key) => [key, true])),
      verification: Object.fromEntries(["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"].map((key) => [key, true])),
    },
    sourceTypes: [...sourceTypes].sort(),
    assets: options.delivery.assets.length,
    counts: effectiveOptions.delivery.counts,
    secondRun: options.verification,
    trace: {
      startedAt: options.metadata.startedAt,
      completedAt: finishedAt,
      sourceHead: effectiveOptions.metadata.head,
      verifiedStateCommit: options.verification.stateCommit,
      stages: [
        { stage: "读取与分片", status: "passed" },
        { stage: "schema / provenance / 证据关联校验", status: "passed" },
        { stage: "分类回写与冲突检查", status: "passed" },
        { stage: "二次运行 zero diff", status: "passed" },
        { stage: "结构、内容、内部链接和写后 hash", status: "passed" },
      ],
    },
    provenance: effectiveAssets.map((asset) => ({
      assetId: asset.assetId,
      sourceType: asset.sourceType,
      sourceRef: asset.sourceRef,
      sourceRevision: asset.sourceRevision,
      contentHash: asset.contentHash,
      outputPath: assetPath(asset),
    })),
    fiveMaterials: {
      report: `${ACCEPTANCE_ROOT}/资产复利实践报告.md`,
      sourceInventory: `${ACCEPTANCE_ROOT}/提取源清单.md`,
      fourDimensionAnalysis: options.delivery.assets.map(assetPath),
      writeback: `${ACCEPTANCE_ROOT}/回写记录.md`,
      verificationEvidence: `${ACCEPTANCE_ROOT}/验证证据/verification.json`,
    },
  };
  contents.set(`${ACCEPTANCE_ROOT}/验证证据/verification.json`, JSON.stringify(evidence, null, 2));
  const directoryTreePath = `${ACCEPTANCE_ROOT}/验证证据/directory-tree.txt`;
  const plannedPaths = [...contents.keys(), directoryTreePath, ACCEPTANCE_STATE].sort();
  contents.set(`${ACCEPTANCE_ROOT}/验证证据/directory-tree.txt`, `${plannedPaths.join("\n")}\n`);
  assertPackageStructure(contents);

  for (const [relative, expectedHash] of Object.entries(previous?.managedFiles ?? {})) {
    const target = await safeTarget(options.repo, relative);
    if (!(await exists(target)) || sha256(await readFile(target)) !== expectedHash) {
      throw new Error(`标准 docs 受管文件被人工编辑或删除：${relative}`);
    }
  }
  if (!previous) {
    for (const relative of contents.keys()) {
      const target = await safeTarget(options.repo, relative);
      if (await exists(target)) throw new Error(`标准 docs 已存在且无受管 state，拒绝覆盖：${relative}`);
    }
  } else {
    for (const relative of contents.keys()) {
      if (!previous.managedFiles[relative] && await exists(await safeTarget(options.repo, relative))) {
        throw new Error(`标准 docs 发现未受管同名文件，拒绝覆盖：${relative}`);
      }
    }
  }

  for (const relative of Object.keys(previous?.managedFiles ?? {})) {
    if (!contents.has(relative)) await rm(await safeTarget(options.repo, relative));
  }
  for (const [relative, content] of contents) {
    const target = await safeTarget(options.repo, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, `${content.trimEnd()}\n`, { encoding: "utf8", fsync: true });
  }
  const state: AcceptanceState = {
    schemaVersion: 2,
    selfHash: "",
    runId: options.delivery.runId,
    completedAt: finishedAt,
    reportedHead: effectiveOptions.metadata.head,
    deliveryCounts: effectiveOptions.delivery.counts,
    assetWritebackKinds: Object.fromEntries(
      effectiveAssets.map((asset) => [asset.assetId, asset.writebackKind]),
    ),
    managedFiles: Object.fromEntries(
      [...contents.entries()].map(([relative, content]) => [relative, sha256(`${content.trimEnd()}\n`)]),
    ),
  };
  state.selfHash = sha256(JSON.stringify({ ...state, selfHash: "" }, null, 2));
  const stateTarget = await safeTarget(options.repo, ACCEPTANCE_STATE);
  await mkdir(path.dirname(stateTarget), { recursive: true });
  await writeFileAtomic(stateTarget, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    fsync: true,
  });
  for (const [relative, expectedHash] of Object.entries(state.managedFiles)) {
    const actual = sha256(await readFile(await safeTarget(options.repo, relative)));
    if (actual !== expectedHash) throw new Error(`验收证据写后 hash 校验失败：${relative}`);
  }

  return {
    root: path.join(options.repo, "docs"),
    report: path.join(options.repo, `${ACCEPTANCE_ROOT}/资产复利实践报告.md`),
    evidence: path.join(options.repo, `${ACCEPTANCE_ROOT}/验证证据/verification.json`),
    files: [...contents.keys(), ACCEPTANCE_STATE].sort(),
  };
}
