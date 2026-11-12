import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import writeFileAtomic from "write-file-atomic";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertSubstantiveAsset } from "./quality.js";
import {
  assertValid,
  validateAsset,
  validateConfig,
  validateState,
} from "./schema.js";
import {
  inputIsDirectory,
  loadShardedDirectory,
  prepareShards,
  type PrepareShardsOptions,
} from "./shards.js";
import type {
  AssetRecord,
  Conflict,
  DimensionFinding,
  PipelineResult,
  ReadState,
  RunConfig,
  ScanRecord,
  GitScanPolicy,
  SkippedGitCommit,
  SkippedGitFileWithinCommit,
  SourceSet,
  SourceType,
} from "./types.js";

const execFileAsync = promisify(execFile);
const GIT_PATCH_CAPTURE_BYTES = 128 * 1024;
export const DEFAULT_MAX_EFFECTIVE_COMMITS = 10;
export const DEFAULT_MAX_BUSINESS_FILES_PER_COMMIT = 5;
export const DEFAULT_MAX_CHARS = 6_000;
export const DEFAULT_MAX_ITEMS = 2;
export const GIT_SCAN_LOG_LIMIT = 500;
const GIT_PATCH_OUTPUT_CHARS = 16_000;
const GIT_POST_IMAGE_MAX_BYTES = 256 * 1024;
const GIT_POST_IMAGE_OUTPUT_CHARS = 6_000;
const OUTPUT_ROOT = "docs/可读化";
const STANDARD_DOC_OUTPUTS = [
  "docs/README.md",
  "docs/00-项目总览/",
  "docs/01-业务资产/",
  "docs/02-技术架构/",
  "docs/03-接口资产/",
  "docs/04-数据资产/",
  "docs/05-代码图谱/",
  "docs/06-开发规范/",
  "docs/07-AI资产/",
  "docs/08-其他上下文/",
];
const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  requirement: "需求",
  design: "设计",
  "ai-artifact": "AI 产物",
  git: "Git 历史",
};
const LEVEL_LABEL: Record<DimensionFinding["level"], string> = {
  ready: "就绪",
  partial: "部分满足",
  missing: "缺失",
  conflict: "冲突",
  high: "高",
  medium: "中",
  low: "低",
};

export function sha256(value: string | Buffer): string {
  const normalized =
    typeof value === "string"
      ? value.replace(/\r\n?/g, "\n").normalize("NFC")
      : value;
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

export async function currentBranch(repo: string): Promise<string> {
  try {
    return await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch (error) {
    try {
      await git(repo, ["rev-parse", "--verify", "HEAD"]);
      return "";
    } catch {
      throw error;
    }
  }
}

async function gitBounded(
  repo: string,
  args: string[],
  maxBytes: number,
): Promise<{ output: string; truncated: boolean; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    const half = Math.floor(maxBytes / 2);
    let prefix = Buffer.alloc(0);
    let suffix = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let totalBytes = 0;
    let truncated = false;
    child.stdout.on("data", (value: Buffer) => {
      totalBytes += value.length;
      if (!truncated) {
        const combined = Buffer.concat([prefix, value]);
        if (combined.length <= maxBytes) {
          prefix = combined;
          return;
        }
        truncated = true;
        prefix = combined.subarray(0, half);
        suffix = combined.subarray(combined.length - half);
        return;
      }
      suffix = Buffer.concat([suffix, value]);
      if (suffix.length > half) suffix = suffix.subarray(suffix.length - half);
    });
    child.stderr.on("data", (value: Buffer) => {
      stderr = Buffer.concat([stderr, value]).subarray(-16_384);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args[0] ?? ""} 失败：${stderr.toString("utf8").trim()}`));
        return;
      }
      const marker = truncated
        ? `\n[PATCH_CAPTURE_TRUNCATED totalBytes=${totalBytes}]\n`
        : "";
      resolve({
        output: truncated
          ? `${prefix.toString("utf8")}${marker}${suffix.toString("utf8")}`
          : prefix.toString("utf8"),
        truncated,
        totalBytes,
      });
    });
  });
}

interface GitFileChange {
  status: string;
  path: string;
  oldPath?: string;
}

function parseGitNameStatus(raw: string): GitFileChange[] {
  const fields = raw.split("\0");
  const changes: GitFileChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (oldPath && path) changes.push({ status, oldPath, path });
      continue;
    }
    const path = fields[index++];
    if (path) changes.push({ status, path });
  }
  return changes;
}

function generatedDocumentationPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return (
    normalized === "docs/README.md" ||
    normalized.startsWith(`${OUTPUT_ROOT}/`) ||
    /^docs\/(?:0[0-8])-[^/]+(?:\/|$)/u.test(normalized)
  );
}

const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|Pipfile\.lock|poetry\.lock|uv\.lock)$/u;
const DEPENDENCY_MANIFEST = /(?:^|\/)(?:package\.json|pyproject\.toml|composer\.json|Cargo\.toml|Gemfile)$/u;
const TOOL_CONFIG =
  /(?:^|\/)(?:\.editorconfig|\.eslintrc(?:\..+)?|eslint\.config\.[cm]?[jt]s|\.prettierrc(?:\..+)?|prettier\.config\.[cm]?[jt]s|biome\.jsonc?|\.stylelintrc(?:\..+)?|stylelint\.config\.[cm]?[jt]s|\.commitlintrc(?:\..+)?|commitlint\.config\.[cm]?[jt]s|\.lintstagedrc(?:\..+)?|lint-staged\.config\.[cm]?[jt]s|renovate\.json|\.github\/dependabot\.ya?ml|\.babelrc(?:\..+)?|babel\.config\.[cm]?[jt]s|tsconfig(?:\..+)?\.json|jsconfig\.json|webpack(?:\..+)?\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|tsup\.config\.[cm]?[jt]s|\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml|\.circleci\/config\.ya?ml)$/u;
const DEPENDENCY_SUBJECT = /(?:^|[\s:(])(?:deps?|dependencies|dependabot|renovate|bump|upgrade)(?:[\s:)]|$)/iu;
const FORMATTING_SUBJECT = /(?:^|[\s:(])(?:format|formatting|prettier|eslint(?:\s+--fix)?|lint\s*fix)(?:[\s:)]|$)/iu;
const EDITOR_SETTINGS = /(?:^|\/)\.vscode\/settings\.json$/u;
const BUSINESS_SUBJECT =
  /(?:^|[\s:(])(?:feat|fix|feature|bugfix|refactor|hotfix|perf)(?:[\s(:]|$)/iu;
const TEST_SOURCE =
  /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const GIT_SCAN_POLICY: GitScanPolicy = {
  maxEffectiveCommits: DEFAULT_MAX_EFFECTIVE_COMMITS,
  maxBusinessFilesPerCommit: DEFAULT_MAX_BUSINESS_FILES_PER_COMMIT,
  messageFiltersEnabled: true,
  transactionalPathPatterns: [
    "dependency lockfiles",
    "dependency manifests (package.json only commits)",
    "lint/format/build tool configs",
    "CI/workflow definitions",
    "editor-only settings (.editorconfig, .vscode/settings.json)",
  ],
};

function isTransactionalOnlyPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return (
    LOCKFILE.test(normalized) ||
    TOOL_CONFIG.test(normalized) ||
    EDITOR_SETTINGS.test(normalized)
  );
}

function classifyMessageTransactional(
  subject: string,
  body: string,
): Omit<SkippedGitCommit, "treeHash" | "contentHash" | "files" | "commit"> | null {
  if (BUSINESS_SUBJECT.test(subject)) return null;
  const text = `${subject}\n${body}`.toLowerCase();
  const rules: Array<{
    test: (value: string) => boolean;
    reasonCode: SkippedGitCommit["reasonCode"];
    reason: string;
  }> = [
    {
      test: (value) => /^chore(\(|:|\s)/.test(subject) || /^build(\(|:|\s)/.test(subject),
      reasonCode: "message-transactional",
      reason: "提交信息符合 Conventional chore/build 前缀，且无业务 feat/fix 信号",
    },
    {
      test: (value) =>
        /\bdependabot\b/.test(value) ||
        /\bbump\b/.test(value) ||
        /\bupgrade\b.*\bdeps?\b/.test(value) ||
        /\bupdate\b.*\block\b/.test(value),
      reasonCode: "message-transactional",
      reason: "提交信息表明依赖/锁文件意图",
    },
    {
      test: (value) =>
        /^ci(\(|:|\s)/.test(subject) ||
        /\bworkflow\b/.test(value) ||
        /\bgithub actions\b/.test(value),
      reasonCode: "message-transactional",
      reason: "提交信息表明 CI/workflow 事务",
    },
    {
      test: () => /^merge branch/i.test(subject),
      reasonCode: "merge-noise",
      reason: "合并分支提交且无业务 feat/fix 信号",
    },
    {
      test: () => /^revert/i.test(subject),
      reasonCode: "revert-noise",
      reason: "回滚提交且无业务 feat/fix 信号",
    },
  ];
  for (const rule of rules) {
    if (rule.test(text) || rule.test(subject.toLowerCase())) {
      return {
        subject,
        reasonCode: rule.reasonCode,
        reason: rule.reason,
      };
    }
  }
  return null;
}

function rankBusinessFile(change: GitFileChange): number {
  const file = change.path.replaceAll("\\", "/");
  if (generatedDocumentationPath(file)) return 40;
  if (TEST_SOURCE.test(file)) return 20;
  if (isTransactionalOnlyPath(file)) return 90;
  if (DEPENDENCY_MANIFEST.test(file)) return 60;
  return 0;
}

function selectBusinessFileChanges(
  commit: string,
  changes: GitFileChange[],
  maxFiles: number,
): { kept: GitFileChange[]; skipped: SkippedGitFileWithinCommit[] } {
  const ranked = [...changes].sort(
    (left, right) =>
      rankBusinessFile(left) - rankBusinessFile(right) ||
      left.path.localeCompare(right.path),
  );
  const kept = ranked.slice(0, maxFiles);
  const skipped = ranked.slice(maxFiles).map((change) => ({
    commit,
    path: change.path,
    reasonCode: "per-commit-file-cap" as const,
    reason: `单 commit 业务文件上限为 ${maxFiles}，该路径未纳入分片`,
  }));
  return { kept, skipped };
}

interface GitCommitMeta {
  commit: string;
  subject: string;
  body: string;
  authoredEpoch: string;
}

async function listRecentGitCommits(repo: string, limit: number): Promise<GitCommitMeta[]> {
  const output = await git(repo, [
    "log",
    `-${limit}`,
    "--format=%H%x1f%s%x1f%b%x1f%at%x00",
    "--",
    ".",
    `:(exclude)${OUTPUT_ROOT}/**`,
    ...STANDARD_DOC_OUTPUTS.map((entry) =>
      `:(exclude)${entry.endsWith("/") ? `${entry}**` : entry}`),
  ]);
  return output
    .split("\0")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [commit = "", subject = "", body = "", authoredEpoch = ""] = record.split("\x1f");
      return { commit, subject, body, authoredEpoch };
    });
}

async function classifyTransactionalCommit(
  repo: string,
  commit: string,
  firstParent: string | undefined,
  subject: string,
  body: string,
  changes: GitFileChange[],
): Promise<Omit<SkippedGitCommit, "treeHash" | "contentHash" | "subject" | "files"> | null> {
  const messageSkip = classifyMessageTransactional(subject, body);
  if (messageSkip) {
    return {
      commit,
      reasonCode: messageSkip.reasonCode,
      reason: messageSkip.reason,
    };
  }
  const files = changes.flatMap((change) => [change.oldPath, change.path].filter(Boolean)) as string[];
  if (files.length === 0) return null;
  if (files.length === 1 && DEPENDENCY_MANIFEST.test(files[0]!)) {
    return {
      commit,
      reasonCode: "dependency-lockfile-only",
      reason: "仅变更 package 清单，未包含其它业务文件",
    };
  }
  const businessPaths = files.filter((file) => !isTransactionalOnlyPath(file));
  if (businessPaths.length === 0) {
    return {
      commit,
      reasonCode: "transactional-paths-only",
      reason: "变更文件全部落在事务路径集合内，不包含业务源码或业务文档",
    };
  }
  if (files.every((file) => LOCKFILE.test(file))) {
    return {
      commit,
      reasonCode: "dependency-lockfile-only",
      reason: "仅变更依赖锁文件，不包含业务代码或业务文档",
    };
  }
  if (
    files.some((file) => LOCKFILE.test(file)) &&
    files.every((file) => LOCKFILE.test(file) || DEPENDENCY_MANIFEST.test(file)) &&
    DEPENDENCY_SUBJECT.test(subject)
  ) {
    return {
      commit,
      reasonCode: "dependency-lockfile-only",
      reason: "依赖意图提交仅变更依赖清单与锁文件，不包含业务代码",
    };
  }
  if (files.every((file) => TOOL_CONFIG.test(file))) {
    return {
      commit,
      reasonCode: "tool-config-only",
      reason:
        "仅变更已知 lint/format/build/webpack/babel/tsconfig/CI 工具配置，不包含业务代码",
    };
  }
  if (firstParent && FORMATTING_SUBJECT.test(subject)) {
    const pathspecs = files.map((file) => `:(literal)${file}`);
    try {
      await git(repo, [
        "diff",
        "--quiet",
        "-w",
        firstParent,
        commit,
        "--",
        ...pathspecs,
      ]);
      return {
        commit,
        reasonCode: "formatting-only",
        reason: "提交标题表明格式化，且忽略空白后的文件 diff 为零",
      };
    } catch {
      // 非纯空白变更或 Git 检查失败时保守保留。
    }
  }
  return null;
}

function truncateGitPatch(
  patch: string,
  capture: { truncated: boolean; totalBytes: number },
  maxChars = GIT_PATCH_OUTPUT_CHARS,
): string {
  if (patch.length <= maxChars && !capture.truncated) return patch.trimEnd();
  const firstBudget = Math.floor(maxChars * 0.62);
  const firstCut = patch.lastIndexOf("\n", firstBudget);
  const head = patch.slice(0, firstCut > 0 ? firstCut : firstBudget).trimEnd();
  const remaining = Math.max(1_000, maxChars - head.length - 160);
  const lastHunk = patch.lastIndexOf("\n@@ ");
  let tail = "";
  if (lastHunk >= head.length) {
    tail = patch.slice(lastHunk + 1);
    if (tail.length > remaining) {
      const cut = tail.lastIndexOf("\n", remaining);
      tail = tail.slice(0, cut > 0 ? cut : remaining);
    }
  }
  const marker =
    `[PATCH_TRUNCATED originalChars=${patch.length}` +
    ` capturedBytes=${capture.totalBytes} completeCapture=${String(!capture.truncated)}]`;
  return [head, marker, tail.trimEnd()].filter(Boolean).join("\n");
}

function postImageRanges(patch: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const line = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(line) || !Number.isFinite(count) || count === 0) continue;
    ranges.push({ start: Math.max(1, line - 3), end: line + Math.min(count, 20) + 2 });
  }
  return ranges;
}

async function gitPostImage(
  repo: string,
  commit: string,
  file: string,
  patch: string,
  status: string,
): Promise<string> {
  if (status.startsWith("D")) return "POST_IMAGE_SKIPPED reason=deleted";
  let size: number;
  try {
    size = Number((await git(repo, ["cat-file", "-s", `${commit}:${file}`])).trim());
  } catch {
    return "POST_IMAGE_SKIPPED reason=missing-or-non-blob";
  }
  if (!Number.isFinite(size) || size > GIT_POST_IMAGE_MAX_BYTES) {
    return `POST_IMAGE_SKIPPED reason=blob-too-large bytes=${Number.isFinite(size) ? size : "unknown"}`;
  }
  const source = await git(repo, ["show", `${commit}:${file}`]);
  if (source.includes("\0")) return "POST_IMAGE_SKIPPED reason=binary";
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const ranges = postImageRanges(patch).slice(0, 8);
  if (ranges.length === 0) return "POST_IMAGE_SKIPPED reason=no-text-hunk";
  const snippets: string[] = [];
  let used = 0;
  for (const range of ranges) {
    const start = Math.min(range.start, lines.length);
    const end = Math.min(range.end, lines.length);
    const body = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n");
    const block = `POST_IMAGE_BEGIN ${file}@${commit}:L${start}-L${end}\n${body}\nPOST_IMAGE_END`;
    if (used + block.length > GIT_POST_IMAGE_OUTPUT_CHARS) break;
    snippets.push(block);
    used += block.length;
  }
  return snippets.length > 0
    ? snippets.join("\n")
    : "POST_IMAGE_SKIPPED reason=snippet-budget-exhausted";
}

export async function assertOutputPath(repo: string, target: string): Promise<string> {
  const root = await realpath(repo);
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    !(relative === OUTPUT_ROOT || relative.startsWith(`${OUTPUT_ROOT}${path.sep}`))
  ) {
    throw new Error(`拒绝写入 ${OUTPUT_ROOT} 之外的路径：${target}`);
  }

  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (await exists(cursor)) {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`拒绝输出路径中的符号链接：${cursor}`);
      }
    }
  }
  return absolute;
}

export async function atomicWriteIfChanged(
  repo: string,
  relativePath: string,
  content: string,
): Promise<boolean> {
  const target = await assertOutputPath(repo, relativePath);
  const normalized = `${content.replace(/\r\n?/g, "\n").trimEnd()}\n`;
  if (await exists(target)) {
    const current = await readFile(target, "utf8");
    if (current === normalized) return false;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, normalized, { encoding: "utf8", fsync: true });
  return true;
}

export async function loadConfig(configPath: string): Promise<RunConfig> {
  const value = parseYaml(await readFile(configPath, "utf8")) as unknown;
  assertValid(validateConfig, value, "运行配置");
  const types = new Set(value.sourceSets.map((source) => source.type));
  if (types.size < 2) {
    throw new Error("V2 要求至少两种不同的来源类型");
  }
  return value;
}

export async function plan(repo: string, configPath: string) {
  const repoRoot = await realpath(repo);
  const config = await loadConfig(configPath);
  const inside = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") throw new Error("目标路径不是 Git 工作树");
  return {
    repoRoot,
    outputRoot: config.outputRoot,
    sourceTypes: [...new Set(config.sourceSets.map((source) => source.type))].sort(),
    baseCommit: await git(repoRoot, ["rev-parse", "HEAD"]),
  };
}

async function fileRevision(repo: string, file: string): Promise<string> {
  try {
    return (await git(repo, ["log", "-1", "--format=%H", "--", file])) || "untracked";
  } catch {
    return "untracked";
  }
}

async function scanFileSet(
  repo: string,
  source: SourceSet,
  excludes: string[],
): Promise<ScanRecord[]> {
  if (!source.include?.length) {
    throw new Error(`${SOURCE_TYPE_LABEL[source.type]}来源必须配置 include glob`);
  }
  const files = await fg(source.include, {
    cwd: repo,
    onlyFiles: true,
    unique: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: excludes,
  });
  files.sort();
  if (files.length === 0) {
    throw new Error(`${SOURCE_TYPE_LABEL[source.type]}来源为空`);
  }
  return Promise.all(
    files.map(async (file) => {
      if (redactSensitive(file) !== file) {
        throw new Error(`拒绝包含敏感信息的来源路径：${file}`);
      }
      const root = await realpath(repo);
      const absolute = path.resolve(root, file);
      const relative = path.relative(root, absolute);
      if (
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      ) {
        throw new Error(`拒绝读取仓库之外的来源：${file}`);
      }
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`拒绝符号链接来源：${file}`);
      const resolvedSource = await realpath(absolute);
      if (resolvedSource !== absolute) {
        throw new Error(`拒绝通过符号链接逃逸仓库的来源：${file}`);
      }
      const buffer = await readFile(absolute);
      const text = buffer.toString("utf8");
      const isText = /\.(?:md|mdx|txt|json|ya?ml|tsx?|jsx?|css|html)$/i.test(file);
      return {
        sourceType: source.type,
        sourceRef: file.split(path.sep).join("/"),
        sourceRevision: await fileRevision(repo, file),
        contentHash: sha256(isText ? text : buffer),
        content: text,
      };
    }),
  );
}

async function loadCommitFileChanges(
  repo: string,
  commit: string,
): Promise<{ firstParent?: string; changes: GitFileChange[] }> {
  const ancestry = (await git(repo, ["rev-list", "--parents", "-n", "1", commit])).split(" ");
  const firstParent = ancestry[1];
  const nameStatus = firstParent
    ? await git(repo, [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        firstParent,
        commit,
        "--",
      ])
    : await git(repo, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "--find-renames",
        commit,
      ]);
  const changes = parseGitNameStatus(nameStatus).filter(
    (change) =>
      !generatedDocumentationPath(change.path) ||
      (change.oldPath !== undefined && !generatedDocumentationPath(change.oldPath)),
  );
  return {
    ...(firstParent ? { firstParent } : {}),
    changes,
  };
}

export interface GitScanStats {
  scannedCommits: number;
  effectiveCommits: number;
  skippedCommits: number;
  maxEffectiveCommits: number;
}

async function scanGitSet(
  repo: string,
  source: SourceSet,
): Promise<{
  records: ScanRecord[];
  skippedGitCommits: SkippedGitCommit[];
  skippedFilesWithinCommit: SkippedGitFileWithinCommit[];
  gitScanStats: GitScanStats;
}> {
  const maxEffective = source.maxCommits ?? DEFAULT_MAX_EFFECTIVE_COMMITS;
  const maxFilesPerCommit =
    source.maxBusinessFilesPerCommit ?? DEFAULT_MAX_BUSINESS_FILES_PER_COMMIT;
  const candidates = await listRecentGitCommits(repo, GIT_SCAN_LOG_LIMIT);
  const records: ScanRecord[] = [];
  const skippedGitCommits: SkippedGitCommit[] = [];
  const skippedFilesWithinCommit: SkippedGitFileWithinCommit[] = [];
  const effectiveCommits: Array<{
    meta: GitCommitMeta;
    firstParent?: string;
    changes: GitFileChange[];
  }> = [];
  let scannedCommits = 0;
  for (const meta of candidates) {
    scannedCommits += 1;
    if (effectiveCommits.length >= maxEffective) break;
    const { commit, subject, body } = meta;
    const { firstParent, changes } = await loadCommitFileChanges(repo, commit);
    if (!source.includeTransactionalCommits) {
      const classification = await classifyTransactionalCommit(
        repo,
        commit,
        firstParent,
        subject,
        body,
        changes,
      );
      if (classification) {
        const files = [
          ...new Set(
            changes.flatMap((change) =>
              [change.oldPath, change.path].filter((file): file is string => file !== undefined),
            ),
          ),
        ].sort();
        const treeHash = await git(repo, ["rev-parse", `${commit}^{tree}`]);
        const evidence = {
          commit,
          treeHash,
          subject,
          reasonCode: classification.reasonCode,
          reason: classification.reason,
          files,
        };
        skippedGitCommits.push({
          ...evidence,
          contentHash: sha256(JSON.stringify(evidence)),
        });
        continue;
      }
    }
    effectiveCommits.push({
      meta,
      ...(firstParent ? { firstParent } : {}),
      changes,
    });
  }
  const gitScanStats: GitScanStats = {
    scannedCommits,
    effectiveCommits: effectiveCommits.length,
    skippedCommits: skippedGitCommits.length,
    maxEffectiveCommits: maxEffective,
  };
  for (const { meta, firstParent, changes } of effectiveCommits) {
    const { commit, subject, body, authoredEpoch } = meta;
    const { kept, skipped } = selectBusinessFileChanges(commit, changes, maxFilesPerCommit);
    skippedFilesWithinCommit.push(...skipped);
    for (const change of kept) {
      if (
        redactSensitive(change.path) !== change.path ||
        (change.oldPath !== undefined && redactSensitive(change.oldPath) !== change.oldPath)
      ) {
        throw new Error(`拒绝包含敏感信息的 Git 来源路径：${change.path}`);
      }
      const pathspecs = [change.oldPath, change.path]
        .filter((file): file is string => file !== undefined)
        .map((file) => `:(literal)${file}`);
      const patchArgs = firstParent
        ? [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
            "--unified=3",
            firstParent,
            commit,
            "--",
            ...pathspecs,
          ]
        : [
            "show",
            "--format=",
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
            "--unified=3",
            commit,
            "--",
            ...pathspecs,
          ];
      const capture = await gitBounded(repo, patchArgs, GIT_PATCH_CAPTURE_BYTES);
      const patch = truncateGitPatch(capture.output, capture);
      const postImage = await gitPostImage(repo, commit, change.path, capture.output, change.status);
      const content = [
        `GIT_COMMIT\t${commit}`,
        `GIT_FILE\t${change.path}`,
        ...(change.oldPath ? [`GIT_OLD_PATH\t${change.oldPath}`] : []),
        `GIT_STATUS\t${change.status}`,
        `GIT_SUBJECT\t${subject}`,
        "GIT_BODY_BEGIN",
        body,
        "GIT_BODY_END",
        `GIT_AUTHORED_EPOCH\t${authoredEpoch}`,
        "PATCH_BEGIN",
        patch,
        "PATCH_END",
        postImage,
      ].join("\n");
      records.push({
        sourceType: "git",
        sourceRef: `git:${commit}:${change.path}`,
        sourceRevision: commit,
        contentHash: sha256(content),
        content,
      });
    }
  }
  if (records.length === 0) {
    const detail =
      skippedGitCommits.length > 0
        ? `；${skippedGitCommits.length} 个提交均被判定为事务性内容。若确认它们应作为资产，请用 --include-transactional-commits 在新 workspace 重跑`
        : "";
    throw new Error(`Git 历史来源为空${detail}`);
  }
  return { records, skippedGitCommits, skippedFilesWithinCommit, gitScanStats };
}

async function scanDetailed(
  repo: string,
  config: RunConfig,
): Promise<{
  records: ScanRecord[];
  skippedGitCommits: SkippedGitCommit[];
  skippedFilesWithinCommit: SkippedGitFileWithinCommit[];
  gitScanStats?: GitScanStats;
  gitScanPolicy?: GitScanPolicy;
}> {
  const excludes = [
    `${OUTPUT_ROOT}/**`,
    ...STANDARD_DOC_OUTPUTS.filter((entry) => entry.endsWith("/")).map((entry) => `${entry}**`),
    "docs/README.md",
    "node_modules/**",
    "dist/**",
    ...(config.exclude ?? []),
  ];
  const groups = await Promise.all(
    config.sourceSets.map((source) =>
      source.type === "git"
        ? scanGitSet(repo, source).then((value) => ({
            ...value,
            gitScanPolicy: {
              ...GIT_SCAN_POLICY,
              maxEffectiveCommits: source.maxCommits ?? DEFAULT_MAX_EFFECTIVE_COMMITS,
              maxBusinessFilesPerCommit:
                source.maxBusinessFilesPerCommit ?? DEFAULT_MAX_BUSINESS_FILES_PER_COMMIT,
            },
          }))
        : scanFileSet(repo, source, excludes).then((records) => ({
            records,
            skippedGitCommits: [],
            skippedFilesWithinCommit: [],
          })),
    ),
  );
  const records = groups.flatMap((group) => group.records).sort((a, b) =>
    `${a.sourceType}:${a.sourceRef}`.localeCompare(`${b.sourceType}:${b.sourceRef}`),
  );
  const skippedGitCommits = groups
    .flatMap((group) => group.skippedGitCommits)
    .sort((left, right) => left.commit.localeCompare(right.commit));
  const skippedFilesWithinCommit = groups
    .flatMap((group) => group.skippedFilesWithinCommit)
    .sort(
      (left, right) =>
        left.commit.localeCompare(right.commit) || left.path.localeCompare(right.path),
    );
  const gitGroup = groups.find(
    (group): group is (typeof groups)[number] & {
      gitScanStats: GitScanStats;
      gitScanPolicy: GitScanPolicy;
    } => "gitScanStats" in group && group.gitScanStats !== undefined,
  );
  const nonEmptyTypes = new Set(records.map((record) => record.sourceType));
  if (nonEmptyTypes.size < 2) {
    throw new Error("V2 要求至少两类真实且非空的来源");
  }
  return {
    records,
    skippedGitCommits,
    skippedFilesWithinCommit,
    ...(gitGroup?.gitScanStats ? { gitScanStats: gitGroup.gitScanStats } : {}),
    ...(gitGroup?.gitScanPolicy ? { gitScanPolicy: gitGroup.gitScanPolicy } : {}),
  };
}

export async function scan(repo: string, config: RunConfig): Promise<ScanRecord[]> {
  return (await scanDetailed(repo, config)).records;
}

function titleFor(record: ScanRecord): string {
  const content = redactSensitive(record.content);
  if (record.sourceType === "git") {
    return content.match(/^GIT_SUBJECT\t(.+)$/m)?.[1]?.trim() || record.sourceRevision.slice(0, 12);
  }
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(record.sourceRef, path.extname(record.sourceRef));
}

function compactLines(content: string): string[] {
  return content
    .replace(/^#{1,6}\s+/gm, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function redactSensitive(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED_SECRET]")
    .replace(
      /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"'`]+/gi,
      "$1=[REDACTED_SECRET]",
    );
}

export function prepare(records: ScanRecord[], previous: ReadState | null): AssetRecord[] {
  return records.map((record) => {
    const sourceKey = `${record.sourceType}:${record.sourceRef}`;
    const old = previous?.sources[sourceKey];
    const writebackKind =
      old?.contentHash === record.contentHash ? "未变" : old ? "增量" : "新增";
    const lines = compactLines(redactSensitive(record.content));
    const evidence = [`${record.sourceRef}@${record.sourceRevision}`];
    const hasActions = lines.some((line) => /(^|\s)(must|should|todo|需要|必须|应当)/i.test(line));
    const summary = lines.join(" ").slice(0, 280);
    const asset: AssetRecord = {
      assetId: sha256(sourceKey),
      sourceType: record.sourceType,
      sourceRef: record.sourceRef,
      sourceRevision: record.sourceRevision,
      contentHash: record.contentHash,
      title: titleFor(record),
      summary,
      facts: lines.slice(0, 5).map((line) => line.slice(0, 500)),
      decisions: [],
      actions: hasActions
        ? lines
            .filter((line) => /must|should|todo|需要|必须|应当/i.test(line))
            .slice(0, 5)
            .map((line) => line.slice(0, 500))
        : [],
      relations: [],
      analysis: {
        completeness: {
          level: summary.length >= 80 ? "partial" : "missing",
          evidence,
          gaps: ["需要人工确认范围、约束与验收边界"],
          recommendations: ["由 Skill 基于业务上下文补全完整性分析"],
        },
        executability: {
          level: hasActions ? "partial" : "missing",
          evidence,
          gaps: hasActions ? ["行动项负责人和完成条件待确认"] : ["未识别到明确行动项"],
          recommendations: ["补充负责人、前置条件和可验证完成标准"],
        },
        consistency: {
          level: "partial",
          evidence,
          gaps: ["需要跨资产对照后确认一致性"],
          recommendations: ["将相关需求、设计和历史决策进行交叉核验"],
        },
        reuseValue: {
          level: lines.length >= 3 ? "medium" : "low",
          evidence,
          gaps: ["复用场景与适用边界待确认"],
          recommendations: ["提炼可复制的决策、检查表或模板"],
        },
      },
      writebackKind,
    };
    assertValid(validateAsset, asset, `资产 ${asset.assetId}`);
    return asset;
  });
}

export async function loadAssetsFile(
  file: string,
  records?: ScanRecord[],
): Promise<AssetRecord[]> {
  return (await loadAssetsInput(file, records)).assets;
}

export async function loadAssetsInput(
  file: string,
  records?: ScanRecord[],
): Promise<{
  assets: AssetRecord[];
  format: "legacy-single-file" | "sharded-directory";
}> {
  const sharded = await inputIsDirectory(file);
  const value: unknown = sharded
    ? await loadShardedDirectory(file)
    : JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(value)) {
    throw new Error(
      "增强资产输入必须是旧版 JSON 数组或已完成的分片目录；建议运行 prepare --output <目录>",
    );
  }
  const assets = value.map((candidate, index) => {
    assertValid(validateAsset, candidate, `资产输入 ${index}`);
    const serialized = JSON.stringify(candidate);
    if (redactSensitive(serialized) !== serialized) {
      throw new Error(`资产输入 ${index} 包含敏感数据`);
    }
    assertSubstantiveAsset(candidate);
    return candidate;
  });
  const sourceKeys = assets.map((asset) => `${asset.sourceType}:${asset.sourceRef}`);
  if (
    new Set(sourceKeys).size !== assets.length ||
    new Set(assets.map((asset) => asset.assetId)).size !== assets.length
  ) {
    throw new Error("增强资产输入包含重复来源或重复资产 ID");
  }
  if (records) {
    const bySource = new Map(
      records.map((record) => [`${record.sourceType}:${record.sourceRef}`, record]),
    );
    for (const asset of assets) {
      const record = bySource.get(`${asset.sourceType}:${asset.sourceRef}`);
      if (!record) throw new Error(`资产来源不在本次扫描中：${asset.sourceRef}`);
      if (
        asset.assetId !== sha256(`${record.sourceType}:${record.sourceRef}`) ||
        asset.contentHash !== record.contentHash ||
        asset.sourceRevision !== record.sourceRevision
      ) {
        throw new Error(`资产来源追踪字段被修改：${asset.sourceRef}`);
      }
    }
    if (assets.length !== records.length) {
      throw new Error("增强资产输入必须为每个扫描来源提供且仅提供一条资产");
    }
    const expectedSources = new Set(bySource.keys());
    if (sourceKeys.some((key) => !expectedSources.has(key))) {
      throw new Error("增强资产输入与本次扫描不匹配");
    }
  }
  return {
    assets,
    format: sharded ? "sharded-directory" : "legacy-single-file",
  };
}

function renderDimension(label: string, finding: AssetRecord["analysis"]["completeness"]): string {
  const bullets = (items: string[]) =>
    items.length ? items.map((item) => `- ${redactSensitive(item)}`).join("\n") : "- 无";
  return `### ${label}：${LEVEL_LABEL[finding.level]}\n\n**证据**\n${bullets(finding.evidence)}\n\n**缺口**\n${bullets(finding.gaps)}\n\n**建议**\n${bullets(finding.recommendations)}`;
}

export function renderAsset(asset: AssetRecord): string {
  return `# ${redactSensitive(asset.title)}

- 标记：${asset.writebackKind}
- 类型：${SOURCE_TYPE_LABEL[asset.sourceType]}
- 来源：\`${redactSensitive(asset.sourceRef)}\`
- 来源版本（sourceRevision）：\`${asset.sourceRevision}\`
- 内容指纹（contentHash）：\`${asset.contentHash}\`
- 资产 ID（assetId）：\`${asset.assetId}\`

## 摘要

${redactSensitive(asset.summary) || "无可提取摘要。"}

## 四维分析

${renderDimension("完整性", asset.analysis.completeness)}

${renderDimension("可执行性", asset.analysis.executability)}

${renderDimension("一致性", asset.analysis.consistency)}

${renderDimension("复用价值", asset.analysis.reuseValue)}
`;
}

async function readState(repo: string): Promise<ReadState | null> {
  const statePath = path.join(repo, OUTPUT_ROOT, "state/read-state.json");
  if (!(await exists(statePath))) return null;
  const value = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  assertValid(validateState, value, "读取状态");
  const expected = sha256(JSON.stringify({ ...value, selfHash: "" }, null, 2));
  if (value.selfHash !== expected) {
    throw new Error("读取状态的 selfHash 不匹配；拒绝覆盖已编辑的 state");
  }
  return value;
}

function renderIndex(assets: AssetRecord[]): string {
  const rows = assets
    .map(
      (asset) =>
        `| [${redactSensitive(asset.title)}](assets/${asset.assetId.slice(7)}.md) | ${SOURCE_TYPE_LABEL[asset.sourceType]} | ${asset.writebackKind} | \`${redactSensitive(asset.sourceRef)}\` |`,
    )
    .join("\n");
  return `# 资产复利索引

> 本目录由 asset-compound 管理。示例 fixture 不能作为真实验收数据。

| 资产 | 类型 | 标记 | 来源 |
|---|---|---|---|
${rows}
`;
}

async function loadTemplate(name: string): Promise<string> {
  return readFile(new URL(`../templates/${name}`, import.meta.url), "utf8");
}

async function renderConflicts(runId: string, conflicts: Conflict[]): Promise<string> {
  const details =
    conflicts.length === 0
      ? "本次检查发现 0 个冲突。"
      : conflicts
    .map(
      (conflict) =>
        `## ${conflict.assetId}\n\n- 路径：\`${conflict.path}\`\n- 原因：${conflict.reason}\n- 期望内容指纹（hash）：\`${conflict.expectedHash ?? "无"}\`\n- 当前内容指纹（hash）：\`${conflict.actualHash ?? "无"}\``,
    )
    .join("\n\n");
  return (await loadTemplate("conflict-report.md"))
    .replaceAll("{{run_id}}", runId)
    .replaceAll("{{conflict_count}}", String(conflicts.length))
    .replaceAll("{{conflicts}}", details);
}

async function renderAcceptance(
  branch: string,
  base: string,
  head: string,
  result: Omit<PipelineResult, "changedFiles">,
  skippedGitCommits: SkippedGitCommit[],
): Promise<string> {
  const requirements = [
    "| 条款 | 结果 |",
    "|---|---|",
    `| R1 识别读取 | 已生成 manifest；保守排除 ${skippedGitCommits.length} 个事务性 Git 提交并保留 hash/reason |`,
    "| R2 结构化提取 | 已通过 JSON Schema |",
    "| R3 四维分析 | 已生成四维基线，业务结论需人工抽检 |",
    "| R4 增量回写 | 已限制 docs/可读化 并输出冲突报告 |",
    "| R5 增量状态 | 已保存文件 hash 与 commit；需二次运行验证 |",
    "| R6 全链路留痕 | 已建立来源、revision、asset 与输出映射；事务提交见 source-manifest |",
  ].join("\n");
  const verification = [
    "| 验收点 | 结果 |",
    "|---|---|",
    "| V1–V4 | 已产出机器证据；真实材料与四维结论仍需人工验收 |",
    "| V5 | 已验证非基线分支与 Git scope；提交/PR 待外部流程确认 |",
    "| V6 | 待相同输入二次运行证明零业务 diff |",
    "| V7 | 已记录 revision 与 hash；回写 commit 待提交后补齐 |",
    "| V8 | 已生成索引与资产详情；可读复用需人工抽检 |",
  ].join("\n");
  return (await loadTemplate("acceptance-report.md"))
    .replaceAll("{{run_id}}", result.runId)
    .replaceAll("{{branch}}", branch)
    .replaceAll("{{base_sha}}", base)
    .replaceAll("{{head_sha}}", head)
    .replaceAll(
      "{{source_type_summary}}",
      [...new Set(result.assets.map((asset) => SOURCE_TYPE_LABEL[asset.sourceType]))]
        .sort()
        .join("、"),
    )
    .replaceAll("{{new_count}}", String(result.counts.new))
    .replaceAll("{{updated_count}}", String(result.counts.updated))
    .replaceAll("{{unchanged_count}}", String(result.counts.unchanged))
    .replaceAll("{{conflict_count}}", String(result.counts.conflicts))
    .replaceAll("{{requirements_matrix}}", requirements)
    .replaceAll("{{verification_matrix}}", verification)
    .replaceAll(
      "{{four_dimension_summary}}",
      `${result.assets.length} 条资产均包含完整性、可执行性、一致性、复用价值四项结构化结论。`,
    )
    .replaceAll(
      "{{conflict_and_evidence_links}}",
      `- [冲突报告](../conflicts/${result.runId}.md)\n- [来源清单](../source-manifest.yaml)\n- [本次有效配置](effective-config.yaml)`,
    );
}

export async function render(
  repo: string,
  config: RunConfig,
  records: ScanRecord[],
  assets: AssetRecord[],
  previous: ReadState | null,
  skippedGitCommits: SkippedGitCommit[] = [],
): Promise<PipelineResult> {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const branch = await currentBranch(repo);
  const baseBranch = config.baseBranch ?? "main";
  const baseCommit = await git(repo, ["merge-base", "HEAD", baseBranch]);
  const changedAssets = assets.filter((asset) => asset.writebackKind !== "未变");
  const sourceHead =
    previous && changedAssets.length === 0 ? previous.lastReadCommit : head;
  const conflicts: Conflict[] = [];
  const contentByAsset = new Map<string, string>();

  for (const asset of assets) {
    const content = renderAsset(asset);
    contentByAsset.set(asset.assetId, content);
    const old = previous?.assets[asset.assetId];
    const expectedPath = `${OUTPUT_ROOT}/assets/${asset.assetId.slice(7)}.md`;
    if (old) {
      const oldPath = await assertOutputPath(repo, old.outputPath);
      if (await exists(oldPath)) {
        const actualHash = sha256(await readFile(oldPath, "utf8"));
        if (actualHash !== old.lastGeneratedHash) {
          conflicts.push({
            assetId: asset.assetId,
            path: old.outputPath,
            reason: "人工编辑与生成内容冲突，已拒绝覆盖",
            expectedHash: old.lastGeneratedHash,
            actualHash,
          });
        }
      } else {
        conflicts.push({
          assetId: asset.assetId,
          path: old.outputPath,
          reason: "state 引用的生成文件缺失，已拒绝静默重建",
          expectedHash: old.lastGeneratedHash,
        });
      }
    } else if (await exists(path.join(repo, expectedPath))) {
      conflicts.push({
        assetId: asset.assetId,
        path: expectedPath,
        reason: "发现无 state 归属的既有资产文件，已拒绝覆盖",
        actualHash: sha256(await readFile(path.join(repo, expectedPath), "utf8")),
      });
    }
  }
  for (const [managedPath, expectedHash] of Object.entries(previous?.managedFiles ?? {})) {
    const absolute = await assertOutputPath(repo, managedPath);
    if (!(await exists(absolute))) {
      conflicts.push({
        assetId: `managed:${managedPath}`,
        path: managedPath,
        reason: "受管输出文件缺失，已拒绝静默重建",
        expectedHash,
      });
      continue;
    }
    const actualHash = sha256(await readFile(absolute));
    if (actualHash !== expectedHash) {
      conflicts.push({
        assetId: `managed:${managedPath}`,
        path: managedPath,
        reason: "受管输出被人工编辑，已拒绝覆盖",
        expectedHash,
        actualHash,
      });
    }
  }

  const runId = sha256(
    [
      ...records.map((record) => `${record.sourceRef}:${record.contentHash}`),
      ...skippedGitCommits.map((commit) => `skipped:${commit.commit}:${commit.contentHash}`),
    ].join("\n"),
  ).slice(7, 23);
  if (!previous) {
    const firstRunManagedPaths = [
      `${OUTPUT_ROOT}/README.md`,
      `${OUTPUT_ROOT}/index.md`,
      `${OUTPUT_ROOT}/source-manifest.yaml`,
      `${OUTPUT_ROOT}/evidence/effective-config.yaml`,
      `${OUTPUT_ROOT}/conflicts/${runId}.md`,
      `${OUTPUT_ROOT}/evidence/acceptance-report.md`,
      `${OUTPUT_ROOT}/runs/${runId}.md`,
      `${OUTPUT_ROOT}/state/asset-index.jsonl`,
    ];
    for (const managedPath of firstRunManagedPaths) {
      const absolute = await assertOutputPath(repo, managedPath);
      if (await exists(absolute)) {
        conflicts.push({
          assetId: `managed:${managedPath}`,
          path: managedPath,
          reason: "首次运行发现无 state 归属的既有受管文件，已拒绝覆盖",
          actualHash: sha256(await readFile(absolute)),
        });
      }
    }
  }
  const conflictIds = new Set(conflicts.map((conflict) => conflict.assetId));
  const writableAssets = changedAssets.filter((asset) => !conflictIds.has(asset.assetId));
  const currentSourceKeys = new Set(
    records.map((record) => `${record.sourceType}:${record.sourceRef}`),
  );
  const hasStaleTransition = Object.entries(previous?.sources ?? {}).some(
    ([key, value]) => value.status === "active" && !currentSourceKeys.has(key),
  );
  const resultBase = {
    runId,
    counts: {
      new: assets.filter((asset) => asset.writebackKind === "新增").length,
      updated: assets.filter((asset) => asset.writebackKind === "增量").length,
      unchanged: assets.filter((asset) => asset.writebackKind === "未变").length,
      conflicts: conflicts.length,
    },
    assets,
    conflicts,
    noOp: changedAssets.length === 0 && conflicts.length === 0 && !hasStaleTransition,
  };

  const manifest = {
    sourceTypes: [...new Set(records.map((record) => record.sourceType))].sort(),
    sources: records.map(({ content: _content, ...record }) => record),
    skippedGitCommits,
  };
  const manifestContent = stringifyYaml(manifest);
  const previousManifestHash = previous?.managedFiles[`${OUTPUT_ROOT}/source-manifest.yaml`];
  const skippedEvidenceChanged =
    previousManifestHash !== undefined &&
    previousManifestHash !== sha256(`${manifestContent.trimEnd()}\n`);
  resultBase.noOp = resultBase.noOp && !skippedEvidenceChanged;

  if (resultBase.noOp) {
    return { ...resultBase, changedFiles: [], secondRunZeroDiff: true };
  }

  if (conflicts.length > 0) {
    const conflictKey = sha256(JSON.stringify(conflicts)).slice(7, 19);
    const conflictPath = `${OUTPUT_ROOT}/conflicts/${runId}-${conflictKey}.md`;
    const changed = await atomicWriteIfChanged(
      repo,
      conflictPath,
      await renderConflicts(runId, conflicts),
    );
    return {
      ...resultBase,
      changedFiles: changed ? [conflictPath] : [],
    };
  }

  const changedFiles: string[] = [];
  const write = async (file: string, content: string) => {
    if (await atomicWriteIfChanged(repo, file, content)) changedFiles.push(file);
  };

  for (const asset of writableAssets) {
    const file = `${OUTPUT_ROOT}/assets/${asset.assetId.slice(7)}.md`;
    await write(file, contentByAsset.get(asset.assetId) ?? renderAsset(asset));
  }

  const sources: ReadState["sources"] = {};
  for (const [key, value] of Object.entries(previous?.sources ?? {})) {
    sources[key] = { ...value, status: "stale" };
  }
  for (const record of records) {
    const sourceKey = `${record.sourceType}:${record.sourceRef}`;
    const asset = assets.find(
      (candidate) =>
        candidate.sourceType === record.sourceType && candidate.sourceRef === record.sourceRef,
    );
    if (!asset || conflictIds.has(asset.assetId)) continue;
    sources[sourceKey] = {
      contentHash: record.contentHash,
      sourceRevision: record.sourceRevision,
      assetIds: [asset.assetId],
      status: "active",
    };
  }

  const stateAssets: ReadState["assets"] = { ...(previous?.assets ?? {}) };
  for (const asset of writableAssets) {
    const outputPath = `${OUTPUT_ROOT}/assets/${asset.assetId.slice(7)}.md`;
    const content = contentByAsset.get(asset.assetId) ?? renderAsset(asset);
    stateAssets[asset.assetId] = {
      canonicalContentHash: asset.contentHash,
      outputPath,
      lastGeneratedHash: sha256(`${content.trimEnd()}\n`),
    };
  }
  const managedContents: Record<string, string> = {
    [`${OUTPUT_ROOT}/README.md`]:
      "# 可读化资产\n\n从 `index.md` 开始阅读。所有内容均保留来源和来源版本（revision）。\n",
    [`${OUTPUT_ROOT}/index.md`]: renderIndex(assets),
    [`${OUTPUT_ROOT}/source-manifest.yaml`]: manifestContent,
    [`${OUTPUT_ROOT}/evidence/effective-config.yaml`]: stringifyYaml(config),
    [`${OUTPUT_ROOT}/conflicts/${runId}.md`]: await renderConflicts(runId, conflicts),
    [`${OUTPUT_ROOT}/evidence/acceptance-report.md`]: await renderAcceptance(
      branch,
      baseCommit,
      sourceHead,
      resultBase,
      skippedGitCommits,
    ),
    [`${OUTPUT_ROOT}/runs/${runId}.md`]:
      `# 运行记录 ${runId}\n\n- 来源提交：\`${sourceHead}\`\n- 来源数：${records.length}\n- 跳过事务性 Git 提交：${skippedGitCommits.length}\n- 新增：${resultBase.counts.new}\n- 增量：${resultBase.counts.updated}\n- 未变：${resultBase.counts.unchanged}\n- 冲突：${conflicts.length}\n\n## 跳过提交证据\n\n${skippedGitCommits.length === 0 ? "- 无" : skippedGitCommits.map((commit) => `- \`${commit.commit}\` / \`${commit.treeHash}\` / \`${commit.contentHash}\`：${commit.reason}（${commit.files.join("、")}）`).join("\n")}\n`,
    [`${OUTPUT_ROOT}/state/asset-index.jsonl`]:
      `${assets.map((asset) => JSON.stringify(asset)).join("\n")}\n`,
  };
  const managedFiles = {
    ...(previous?.managedFiles ?? {}),
    ...Object.fromEntries(
      Object.entries(managedContents).map(([file, content]) => [
        file,
        sha256(`${content.trimEnd()}\n`),
      ]),
    ),
  };
  const nextState: ReadState = {
    schemaVersion: 1,
    selfHash: "",
    baseBranch,
    baseCommit: previous?.baseCommit ?? baseCommit,
    lastReadCommit: sourceHead,
    sources,
    assets: stateAssets,
    managedFiles,
  };
  nextState.selfHash = sha256(JSON.stringify({ ...nextState, selfHash: "" }, null, 2));
  assertValid(validateState, nextState, "下一版状态");

  for (const [file, content] of Object.entries(managedContents)) {
    await write(file, content);
  }
  await write(`${OUTPUT_ROOT}/state/read-state.json`, JSON.stringify(nextState, null, 2));

  changedFiles.sort();
  return { ...resultBase, changedFiles };
}

export async function verifyGitScope(repo: string): Promise<string[]> {
  const output = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    paths.push(entry.slice(3));
    const status = entry.slice(0, 2);
    if (status.includes("R") || status.includes("C")) {
      const original = entries[index + 1];
      if (original) paths.push(original);
      index += 1;
    }
  }
  const outside = paths.filter(
    (file) =>
      file !== OUTPUT_ROOT &&
      !file.startsWith(`${OUTPUT_ROOT}/`) &&
      !isStandardManagedOutput(file),
  );
  if (outside.length) {
    throw new Error(`检测到 ${OUTPUT_ROOT} 之外的改动：${outside.join("、")}`);
  }
  return paths.sort();
}

function isStandardManagedOutput(file: string): boolean {
  if (file === "docs/README.md") return true;
  if (/^docs\/(?:0[0-7]-[^/]+)\/README\.md$/u.test(file)) return true;
  if (/^docs\/(?:0[1-7]-[^/]+)\/[0-9a-f]{64}\.md$/u.test(file)) return true;
  return /^docs\/07-AI资产\/资产复利\/(?:资产复利实践报告\.md|提取源清单\.md|回写记录\.md|冲突报告\.md|state\.json|验证证据\/(?:verification\.json|directory-tree\.txt))$/u.test(file);
}

export async function runPipeline(
  repoInput: string,
  configPath: string,
  assetsFile?: string,
): Promise<PipelineResult> {
  const repo = await realpath(repoInput);
  const config = await loadConfig(configPath);
  const branch = await currentBranch(repo);
  const baseBranch = config.baseBranch ?? "main";
  if (!branch || branch === baseBranch) {
    throw new Error(`写入必须使用独立分支；当前分支为 ${branch || "（分离 HEAD）"}`);
  }
  await verifyGitScope(repo);
  const previous = await readState(repo);
  const scanned = await scanDetailed(repo, config);
  const records = scanned.records;
  const baselineAssets = prepare(records, previous);
  if (!assetsFile) {
    throw new Error(
      "finalize/render/run 需要 --assets；请先使用 prepare --output <目录> 逐片分析，旧版 JSON 数组仍兼容",
    );
  }
  const loaded = await loadAssetsInput(assetsFile, records);
  const assets = loaded.assets.map((asset) => ({
        ...asset,
        writebackKind:
          baselineAssets.find((baseline) => baseline.assetId === asset.assetId)?.writebackKind ??
          asset.writebackKind,
      }));
  const result = await render(
    repo,
    config,
    records,
    assets,
    previous,
    scanned.skippedGitCommits,
  );
  await verifyGitScope(repo);
  return {
    ...result,
    inputFormat: loaded.format,
    ...(loaded.format === "legacy-single-file"
      ? {
          migrationNotice:
            "旧版单文件 JSON 仍受支持；建议迁移到 prepare --output <目录> 的分片工作流",
        }
      : {}),
  };
}

export async function inspectPipeline(repoInput: string, configPath: string) {
  const repo = await realpath(repoInput);
  const config = await loadConfig(configPath);
  const previous = await readState(repo);
  const scanned = await scanDetailed(repo, config);
  return {
    records: scanned.records,
    assets: prepare(scanned.records, previous),
    skippedGitCommits: scanned.skippedGitCommits,
    skippedFilesWithinCommit: scanned.skippedFilesWithinCommit,
    gitScanStats: scanned.gitScanStats,
    gitScanPolicy: scanned.gitScanPolicy,
  };
}

export async function prepareShardPipeline(
  repoInput: string,
  configPath: string,
  output: string,
  options: PrepareShardsOptions = {},
) {
  const config = await loadConfig(configPath);
  const inspected = await inspectPipeline(repoInput, configPath);
  const prepared = await prepareShards(inspected.records, inspected.assets, output, {
    ...options,
    ...(!options.resume && options.maxChars === undefined
      ? { maxChars: DEFAULT_MAX_CHARS }
      : {}),
    ...(!options.resume && options.maxItems === undefined
      ? { maxItems: DEFAULT_MAX_ITEMS }
      : {}),
    ...(!options.resume && options.maxShards === undefined
      ? { maxShards: config.maxShards ?? 10 }
      : {}),
    skippedGitCommits: inspected.skippedGitCommits,
    skippedFilesWithinCommit: inspected.skippedFilesWithinCommit,
    ...(inspected.gitScanPolicy ? { gitScanPolicy: inspected.gitScanPolicy } : {}),
    ...(options.omittedRequirementSources !== undefined
      ? { omittedRequirementSources: options.omittedRequirementSources }
      : {}),
  });
  return { ...prepared, gitScanStats: inspected.gitScanStats };
}

export async function verifySecondRun(repoInput: string, configPath: string) {
  const repo = await realpath(repoInput);
  const config = await loadConfig(configPath);
  const previous = await readState(repo);
  if (!previous) throw new Error("二次运行验证需要已有 state");
  const records = await scan(repo, config);
  const assets = prepare(records, previous);
  const changed = assets.filter((asset) => asset.writebackKind !== "未变");
  if (changed.length) {
    throw new Error(`第二次运行仍有 ${changed.length} 条新增或增量资产`);
  }
  for (const asset of assets) {
    const state = previous.assets[asset.assetId];
    if (!state) throw new Error(`缺少资产状态：${asset.assetId}`);
    const target = await assertOutputPath(repo, state.outputPath);
    if (!(await exists(target)) || sha256(await readFile(target)) !== state.lastGeneratedHash) {
      throw new Error(`生成资产与 state 不一致：${state.outputPath}`);
    }
  }
  for (const [managedPath, expectedHash] of Object.entries(previous.managedFiles)) {
    const target = await assertOutputPath(repo, managedPath);
    if (!(await exists(target)) || sha256(await readFile(target)) !== expectedHash) {
      throw new Error(`受管输出与 state 不一致：${managedPath}`);
    }
  }
  await verifyGitScope(repo);
  return {
    secondRunZeroDiff: true,
    counts: { new: 0, updated: 0, unchanged: assets.length, conflicts: 0 },
    stateCommit: previous.lastReadCommit,
  };
}
