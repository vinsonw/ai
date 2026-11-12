import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { GitScanStats } from "./pipeline.js";
import { assertSubstantiveAsset } from "./quality.js";
import { assertValid, validateAsset } from "./schema.js";
import type {
  AssetRecord,
  AssetShard,
  ScanRecord,
  ShardExcerpt,
  ShardManifest,
  ShardManifestEntry,
  ShardProvenance,
  GitScanPolicy,
  OmittedRequirementSource,
  SkippedGitCommit,
  SkippedGitFileWithinCommit,
} from "./types.js";

const MANIFEST = "manifest.json";
const SHARDS_DIR = "shards";
const OMITTED = "\n…[中间内容已省略；以 provenance 重新扫描核验]…\n";

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value.replace(/\r\n?/g, "\n").normalize("NFC")).digest("hex")}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function redact(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED_SECRET]")
    .replace(
      /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"'`]+/gi,
      "$1=[REDACTED_SECRET]",
    );
}

function provenance(asset: AssetRecord): ShardProvenance {
  return {
    assetId: asset.assetId,
    sourceType: asset.sourceType,
    sourceRef: asset.sourceRef,
    sourceRevision: asset.sourceRevision,
    contentHash: asset.contentHash,
    writebackKind: asset.writebackKind,
  };
}

function stableProvenance(value: ShardProvenance): string {
  return JSON.stringify(value);
}

function immutableInputHash(items: AssetShard["items"]): string {
  return hash(
    JSON.stringify(
      items.map((item) => ({
        provenance: item.provenance,
        sourceExcerpt: item.sourceExcerpt,
      })),
    ),
  );
}

function excerpt(content: string, maxChars: number): ShardExcerpt {
  const safe = redact(content.replace(/\r\n?/g, "\n").normalize("NFC"));
  if (safe.length <= maxChars) {
    return {
      text: safe,
      originalChars: safe.length,
      excerptChars: safe.length,
      truncated: false,
      strategy: "full",
    };
  }
  const available = Math.max(0, maxChars - OMITTED.length);
  const start = Math.ceil(available / 2);
  const end = Math.floor(available / 2);
  const headCut = safe.lastIndexOf("\n", start);
  const head = safe.slice(0, headCut > 0 ? headCut : start);
  const lastGitHunk = safe.lastIndexOf("\n@@ ");
  let tail: string;
  if (lastGitHunk > head.length && /^GIT_COMMIT\t/mu.test(safe)) {
    const candidate = safe.slice(lastGitHunk + 1, lastGitHunk + 1 + end);
    const tailCut = candidate.lastIndexOf("\n");
    tail = candidate.slice(0, tailCut > 0 ? tailCut : end);
  } else {
    const tailStart = safe.indexOf("\n", Math.max(0, safe.length - end));
    tail = safe.slice(tailStart >= 0 ? tailStart + 1 : safe.length - end);
  }
  const text = available === 0 ? safe.slice(0, maxChars) : `${head}${OMITTED}${tail}`;
  return {
    text: text.slice(0, maxChars),
    originalChars: safe.length,
    excerptChars: Math.min(text.length, maxChars),
    truncated: true,
    strategy: "head-tail",
  };
}

function manifestDigest(manifest: ShardManifest): string {
  return hash(JSON.stringify({ ...manifest, manifestHash: "" }, null, 2));
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    fsync: true,
  });
}

async function readManifest(directory: string): Promise<ShardManifest> {
  const manifestPath = path.join(directory, MANIFEST);
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as ShardManifest;
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.assets) ||
    !Array.isArray(value.shards) ||
    (value.maxShards !== undefined &&
      (!Number.isInteger(value.maxShards) ||
        value.maxShards < 1 ||
        value.maxShards > 1_000)) ||
    (value.maxItemsMode !== undefined &&
      !["auto", "fixed"].includes(value.maxItemsMode)) ||
    (value.skippedGitCommits !== undefined &&
      !Array.isArray(value.skippedGitCommits)) ||
    value.manifestHash !== manifestDigest(value)
  ) {
    throw new Error(`分片 manifest 无效或已被手工修改：${manifestPath}`);
  }
  return value;
}

function shardPath(directory: string, entry: ShardManifestEntry): string {
  const resolved = path.resolve(directory, entry.path);
  const relative = path.relative(directory, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`分片路径逃逸工作目录：${entry.path}`);
  }
  return resolved;
}

export interface PrepareShardsOptions {
  maxChars?: number;
  maxItems?: number;
  maxShards?: number;
  skippedGitCommits?: SkippedGitCommit[];
  skippedFilesWithinCommit?: SkippedGitFileWithinCommit[];
  gitScanPolicy?: GitScanPolicy;
  omittedRequirementSources?: OmittedRequirementSource[];
  resume?: boolean;
}

export interface PrepareShardsResult {
  format: "sharded-directory";
  directory: string;
  manifest: string;
  totalAssets: number;
  completedAssets: number;
  pendingShards: string[];
  maxChars: number;
  maxItems: number;
  maxItemsMode: "auto" | "fixed";
  maxShards: number;
  resumed: boolean;
  gitScanStats?: GitScanStats;
}

function resultFor(
  directory: string,
  manifest: ShardManifest,
  resumed: boolean,
): PrepareShardsResult {
  return {
    format: "sharded-directory",
    directory,
    manifest: path.join(directory, MANIFEST),
    totalAssets: manifest.totalAssets,
    completedAssets: manifest.completedAssets,
    pendingShards: manifest.shards
      .filter((entry) => entry.status === "pending")
      .map((entry) => shardPath(directory, entry)),
    maxChars: manifest.maxChars,
    maxItems: manifest.maxItems,
    maxItemsMode: manifest.maxItemsMode ?? "fixed",
    maxShards: manifest.maxShards ?? manifest.shards.length,
    resumed,
  };
}

function runFingerprint(
  records: ScanRecord[],
  settings: {
    maxChars: number;
    maxItems: number;
    maxItemsMode: "auto" | "fixed";
    maxShards: number;
    skippedGitCommits: SkippedGitCommit[];
  },
): string {
  return hash(
    JSON.stringify({
      ...settings,
      sources: records.map(({ content: _content, ...record }) => record),
    }),
  );
}

function legacyRunFingerprint(
  records: ScanRecord[],
  maxChars: number,
  maxItems: number,
): string {
  return hash(
    JSON.stringify({
      maxChars,
      maxItems,
      sources: records.map(({ content: _content, ...record }) => record),
    }),
  );
}

function balancedGroups(
  items: AssetShard["items"],
  maxChars: number,
  requestedMaxItems: number | undefined,
  maxShards: number,
): { groups: AssetShard["items"][]; maxItems: number; maxItemsMode: "auto" | "fixed" } {
  if (items.length === 0) {
    return {
      groups: [],
      maxItems: requestedMaxItems ?? 1,
      maxItemsMode: requestedMaxItems === undefined ? "auto" : "fixed",
    };
  }
  const weights = items.map((item) =>
    item.sourceExcerpt.truncated ? maxChars : item.sourceExcerpt.excerptChars,
  );
  const itemLimit = requestedMaxItems ?? items.length;
  const targetGroups = Math.min(maxShards, items.length);
  const prefix = [0];
  for (const weight of weights) prefix.push((prefix.at(-1) ?? 0) + weight);
  const chars = (start: number, end: number) => (prefix[end] ?? 0) - (prefix[start] ?? 0);
  const memo = new Map<string, boolean>();
  const canPartition = (start: number, groupsLeft: number): boolean => {
    const key = `${start}:${groupsLeft}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const remaining = items.length - start;
    if (groupsLeft === 0) return remaining === 0;
    if (remaining < groupsLeft || remaining > groupsLeft * itemLimit) {
      memo.set(key, false);
      return false;
    }
    const maxEnd = Math.min(items.length, start + itemLimit);
    for (let end = start + 1; end <= maxEnd; end += 1) {
      if (chars(start, end) > maxChars) break;
      if (canPartition(end, groupsLeft - 1)) {
        memo.set(key, true);
        return true;
      }
    }
    memo.set(key, false);
    return false;
  };
  if (!canPartition(0, targetGroups)) {
    const totalChars = weights.reduce((sum, weight) => sum + weight, 0);
    throw new Error(
      [
        `无法在 maxShards=${maxShards}、maxChars=${maxChars}` +
          `${requestedMaxItems === undefined ? "" : `、maxItems=${requestedMaxItems}`} 内容纳 ${items.length} 条资产（预算字符 ${totalChars}）。`,
        "未丢弃任何资产或证据；已拒绝生成不完整分片。",
        "请提高 --max-shards / 配置 maxShards，或提高 --max-chars；若设置了 --max-items，也可适当提高。",
      ].join("\n"),
    );
  }
  const groups: AssetShard["items"][] = [];
  let start = 0;
  for (let groupsLeft = targetGroups; groupsLeft > 0; groupsLeft -= 1) {
    const remainingChars = chars(start, items.length);
    const targetChars = remainingChars / groupsLeft;
    const targetItems = (items.length - start) / groupsLeft;
    const candidates: Array<{ end: number; score: number }> = [];
    const maxEnd = Math.min(items.length, start + itemLimit);
    for (let end = start + 1; end <= maxEnd; end += 1) {
      const groupChars = chars(start, end);
      if (groupChars > maxChars) break;
      if (!canPartition(end, groupsLeft - 1)) continue;
      const score =
        Math.abs(groupChars - targetChars) / Math.max(1, targetChars) +
        Math.abs(end - start - targetItems) / Math.max(1, targetItems);
      candidates.push({ end, score });
    }
    candidates.sort((left, right) => left.score - right.score || left.end - right.end);
    const end = candidates[0]?.end;
    if (end === undefined) throw new Error("内部错误：分片平衡结果不可达");
    groups.push(items.slice(start, end));
    start = end;
  }
  const effectiveMaxItems =
    requestedMaxItems ?? Math.max(...groups.map((group) => group.length));
  return {
    groups,
    maxItems: effectiveMaxItems,
    maxItemsMode: requestedMaxItems === undefined ? "auto" : "fixed",
  };
}

export async function prepareShards(
  records: ScanRecord[],
  assets: AssetRecord[],
  output: string,
  options: PrepareShardsOptions = {},
): Promise<PrepareShardsResult> {
  const directory = path.resolve(output);
  const maxChars = options.maxChars ?? 6_000;
  const maxShards = options.maxShards ?? 10;
  const skippedGitCommits = options.skippedGitCommits ?? [];
  if (!Number.isInteger(maxChars) || maxChars < 32) {
    throw new Error("maxChars 必须是至少 32 的整数");
  }
  if (
    options.maxItems !== undefined &&
    (!Number.isInteger(options.maxItems) || options.maxItems < 1)
  ) {
    throw new Error("maxItems 必须是至少 1 的整数");
  }
  if (!Number.isInteger(maxShards) || maxShards < 1 || maxShards > 1_000) {
    throw new Error("maxShards 必须是 1 到 1000 的整数");
  }
  const manifestPath = path.join(directory, MANIFEST);
  if (await exists(manifestPath)) {
    if (!options.resume) {
      throw new Error(`分片目录已存在；中断续跑请使用 --resume：${directory}`);
    }
    const current = await readManifest(directory);
    if (
      (options.maxChars !== undefined && options.maxChars !== current.maxChars) ||
      (options.maxItems !== undefined && options.maxItems !== current.maxItems) ||
      (options.maxShards !== undefined &&
        options.maxShards !== (current.maxShards ?? current.shards.length))
    ) {
      throw new Error("resume 不能更改 maxChars、maxItems 或 maxShards；请使用新的输出目录");
    }
    const expectedFingerprint =
      current.maxShards === undefined
        ? legacyRunFingerprint(records, current.maxChars, current.maxItems)
        : runFingerprint(records, {
            maxChars: current.maxChars,
            maxItems: current.maxItems,
            maxItemsMode: current.maxItemsMode ?? "fixed",
            maxShards: current.maxShards,
            skippedGitCommits,
          });
    if (current.runFingerprint !== expectedFingerprint) {
      throw new Error("来源或预算已变化，不能 resume；请使用新的输出目录重新 prepare");
    }
    for (const entry of current.shards) {
      const file = shardPath(directory, entry);
      if (!(await exists(file))) throw new Error(`分片文件缺失：${file}`);
      if (
        entry.status === "completed" &&
        entry.validatedHash !== hash(await readFile(file, "utf8"))
      ) {
        throw new Error(`已完成分片在验证后被修改：${file}`);
      }
    }
    return resultFor(directory, current, true);
  }

  const recordBySource = new Map(
    records.map((record) => [`${record.sourceType}:${record.sourceRef}`, record]),
  );
  const items = assets.map((asset) => {
    const record = recordBySource.get(`${asset.sourceType}:${asset.sourceRef}`);
    if (!record) throw new Error(`找不到资产来源：${asset.sourceRef}`);
    return {
      provenance: provenance(asset),
      sourceExcerpt: excerpt(record.content, maxChars),
      asset,
    };
  });
  const balanced = balancedGroups(items, maxChars, options.maxItems, maxShards);
  const groups = balanced.groups;
  const fingerprint = runFingerprint(records, {
    maxChars,
    maxItems: balanced.maxItems,
    maxItemsMode: balanced.maxItemsMode,
    maxShards,
    skippedGitCommits,
  });

  await mkdir(path.join(directory, SHARDS_DIR), { recursive: true });
  const entries: ShardManifestEntry[] = [];
  for (const [index, group] of groups.entries()) {
    const shardId = String(index + 1).padStart(4, "0");
    const relative = `${SHARDS_DIR}/${shardId}.json`;
    const target = path.join(directory, relative);
    if (await exists(target)) throw new Error(`拒绝覆盖既有分片：${target}`);
    const shard: AssetShard = { schemaVersion: 1, shardId, items: group };
    await writeJson(target, shard);
    entries.push({
      shardId,
      path: relative,
      assetIds: group.map((item) => item.asset.assetId),
      inputHash: immutableInputHash(group),
      status: "pending",
    });
  }
  const manifest: ShardManifest = {
    schemaVersion: 1,
    manifestHash: "",
    runFingerprint: fingerprint,
    maxChars,
    maxItems: balanced.maxItems,
    maxItemsMode: balanced.maxItemsMode,
    maxShards,
    totalAssets: assets.length,
    completedAssets: 0,
    assets: assets.map(provenance),
    skippedGitCommits,
    ...(options.skippedFilesWithinCommit?.length
      ? { skippedFilesWithinCommit: options.skippedFilesWithinCommit }
      : {}),
    ...(options.gitScanPolicy ? { gitScanPolicy: options.gitScanPolicy } : {}),
    ...(options.omittedRequirementSources?.length
      ? { omittedRequirementSources: options.omittedRequirementSources }
      : {}),
    shards: entries,
  };
  manifest.manifestHash = manifestDigest(manifest);
  await writeJson(manifestPath, manifest);
  return resultFor(directory, manifest, false);
}

function assertShardFormat(
  shard: AssetShard,
  entry: ShardManifestEntry,
  expected: Map<string, ShardProvenance>,
  maxChars: number,
  maxItems: number,
): AssetRecord[] {
  if (
    shard.schemaVersion !== 1 ||
    shard.shardId !== entry.shardId ||
    !Array.isArray(shard.items) ||
    shard.items.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        !item.provenance ||
        !item.sourceExcerpt ||
        !item.asset,
    )
  ) {
    throw new Error(`分片结构或 shardId 不匹配：${entry.path}`);
  }
  const ids = shard.items.map((item) => item.asset?.assetId);
  if (
    ids.length !== entry.assetIds.length ||
    ids.some((id, index) => id !== entry.assetIds[index])
  ) {
    throw new Error(`分片资产顺序或数量被修改：${entry.path}`);
  }
  const excerptChars = shard.items.reduce(
    (sum, item) => sum + item.sourceExcerpt.excerptChars,
    0,
  );
  if (excerptChars > maxChars) {
    throw new Error(`分片来源摘录超过 maxChars 预算：${entry.path}`);
  }
  if (shard.items.length > maxItems) {
    throw new Error(`分片资产数超过 maxItems 预算：${entry.path}`);
  }
  return shard.items.map((item) => {
    const excerpt = item.sourceExcerpt;
    if (
      typeof excerpt?.text !== "string" ||
      !Number.isInteger(excerpt.originalChars) ||
      !Number.isInteger(excerpt.excerptChars) ||
      excerpt.excerptChars !== excerpt.text.length ||
      excerpt.originalChars < excerpt.excerptChars ||
      typeof excerpt.truncated !== "boolean" ||
      !["full", "head-tail"].includes(excerpt.strategy) ||
      (excerpt.truncated && excerpt.strategy !== "head-tail") ||
      (!excerpt.truncated && excerpt.strategy !== "full") ||
      redact(excerpt.text) !== excerpt.text
    ) {
      throw new Error(`分片来源摘录结构无效或包含敏感数据：${entry.path}`);
    }
    const expectedProvenance = expected.get(item.asset.assetId);
    if (
      !expectedProvenance ||
      stableProvenance(item.provenance) !== stableProvenance(expectedProvenance) ||
      stableProvenance(provenance(item.asset)) !== stableProvenance(expectedProvenance)
    ) {
      throw new Error(`分片 provenance 被修改：${item.asset?.assetId ?? "unknown"}`);
    }
    assertValid(validateAsset, item.asset, `分片资产 ${item.asset.assetId}`);
    if (redact(JSON.stringify(item.asset)) !== JSON.stringify(item.asset)) {
      throw new Error(`分片资产包含敏感数据：${item.asset.assetId}`);
    }
    return item.asset;
  });
}

function assertShard(
  shard: AssetShard,
  entry: ShardManifestEntry,
  expected: Map<string, ShardProvenance>,
  maxChars: number,
  maxItems: number,
): AssetRecord[] {
  if (immutableInputHash(shard.items) !== entry.inputHash) {
    throw new Error(`分片来源摘录或 provenance 被修改：${entry.path}`);
  }
  const assets = assertShardFormat(shard, entry, expected, maxChars, maxItems);
  for (const item of shard.items) {
    assertSubstantiveAsset(item.asset);
    const sourceTokens = groundingTokens(item.sourceExcerpt.text);
    if (sourceTokens.length < 2) {
      throw new Error(`资产 ${item.asset.assetId} 的来源摘录缺少可核验的实质内容`);
    }
    for (const [dimension, finding] of Object.entries(item.asset.analysis)) {
      const evidence = finding.evidence.join(" ").toLowerCase();
      const matched = sourceTokens.filter((token) => evidence.includes(token));
      if (matched.length < Math.min(2, sourceTokens.length)) {
        throw new Error(
          `资产 ${item.asset.assetId} 的 ${dimension} 证据未与本片来源内容具体关联`,
        );
      }
    }
  }
  return assets;
}

function groundingTokens(value: string): string[] {
  const tokens = new Set<string>();
  const stop = new Set(["需要", "必须", "支持", "明确", "需求", "来源", "内容", "验证"]);
  for (const word of value.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? []) tokens.add(word);
  for (const sequence of value.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const token = sequence.slice(index, index + 2);
      if (!stop.has(token)) tokens.add(token);
    }
  }
  return [...tokens];
}

async function validateEntry(
  directory: string,
  manifest: ShardManifest,
  entry: ShardManifestEntry,
): Promise<AssetRecord[]> {
  const file = shardPath(directory, entry);
  const raw = await readFile(file, "utf8");
  if (entry.status === "completed") {
    if (entry.validatedHash !== hash(raw)) {
      throw new Error(`已完成分片在验证后被修改：${file}`);
    }
  }
  const shard = JSON.parse(raw) as AssetShard;
  const expected = new Map(manifest.assets.map((item) => [item.assetId, item]));
  const assets = assertShard(
    shard,
    entry,
    expected,
    manifest.maxChars,
    manifest.maxItems,
  );
  entry.status = "completed";
  entry.validatedHash = hash(raw);
  return assets;
}

async function persistManifest(directory: string, manifest: ShardManifest): Promise<void> {
  manifest.completedAssets = manifest.shards
    .filter((entry) => entry.status === "completed")
    .reduce((sum, entry) => sum + entry.assetIds.length, 0);
  manifest.manifestHash = manifestDigest({ ...manifest, manifestHash: "" });
  await writeJson(path.join(directory, MANIFEST), manifest);
}

/** deliver 前置：仅确认 manifest 可读且全部分片 status=completed（质量门禁在 validate）。 */
export async function assertAllShardsCompleted(directoryInput: string): Promise<{
  format: "sharded-directory";
  completedAssets: number;
  totalAssets: number;
}> {
  const directory = path.resolve(directoryInput);
  const manifest = await readManifest(directory);
  const pending = manifest.shards.filter((entry) => entry.status !== "completed");
  if (pending.length > 0) {
    throw new Error(`仍有 ${pending.length} 个未完成分片；请先 validate`);
  }
  if (manifest.completedAssets !== manifest.totalAssets) {
    throw new Error(
      `manifest 完成计数不一致：${manifest.completedAssets}/${manifest.totalAssets}`,
    );
  }
  return {
    format: "sharded-directory",
    completedAssets: manifest.totalAssets,
    totalAssets: manifest.totalAssets,
  };
}

export async function loadShardedAssetsDeliver(directoryInput: string): Promise<AssetRecord[]> {
  const directory = path.resolve(directoryInput);
  const manifest = await readManifest(directory);
  if (manifest.shards.some((entry) => entry.status !== "completed")) {
    throw new Error(
      `分片尚未全部完成：${manifest.completedAssets}/${manifest.totalAssets}`,
    );
  }
  const assets: AssetRecord[] = [];
  for (const entry of manifest.shards) {
    const shard = JSON.parse(
      await readFile(shardPath(directory, entry), "utf8"),
    ) as AssetShard;
    for (const item of shard.items) {
      const serialized = JSON.stringify(item.asset);
      if (redact(serialized) !== serialized) {
        throw new Error(`分片资产包含敏感数据：${shardPath(directory, entry)}`);
      }
      assets.push(item.asset);
    }
  }
  return assets;
}

export async function assertCompletedShardsFormatOnly(directoryInput: string): Promise<{
  format: "sharded-directory";
  completedAssets: number;
  totalAssets: number;
}> {
  const directory = path.resolve(directoryInput);
  const manifest = await readManifest(directory);
  const pending = manifest.shards.filter((entry) => entry.status !== "completed");
  if (pending.length > 0) {
    throw new Error(`仍有 ${pending.length} 个未完成分片`);
  }
  if (manifest.completedAssets !== manifest.totalAssets) {
    throw new Error(
      `manifest 完成计数不一致：${manifest.completedAssets}/${manifest.totalAssets}`,
    );
  }
  const expected = new Map(manifest.assets.map((item) => [item.assetId, item]));
  for (const entry of manifest.shards) {
    const file = shardPath(directory, entry);
    const raw = await readFile(file, "utf8");
    if (!entry.validatedHash || entry.validatedHash !== hash(raw)) {
      throw new Error(`已完成分片缺少或已变更 validatedHash：${file}`);
    }
    const shard = JSON.parse(raw) as AssetShard;
    assertShardFormat(shard, entry, expected, manifest.maxChars, manifest.maxItems);
  }
  return {
    format: "sharded-directory",
    completedAssets: manifest.totalAssets,
    totalAssets: manifest.totalAssets,
  };
}

async function loadShardedDirectoryTrust(directory: string): Promise<AssetRecord[]> {
  const manifest = await readManifest(directory);
  if (manifest.shards.some((entry) => entry.status !== "completed")) {
    throw new Error(
      `分片尚未全部完成：${manifest.completedAssets}/${manifest.totalAssets}；请逐片 validate 后再 deliver`,
    );
  }
  const assets: AssetRecord[] = [];
  const expected = new Map(manifest.assets.map((item) => [item.assetId, item]));
  for (const entry of manifest.shards) {
    const file = shardPath(directory, entry);
    const raw = await readFile(file, "utf8");
    if (entry.validatedHash !== hash(raw)) {
      throw new Error(`已完成分片在验证后被修改：${file}`);
    }
    const shard = JSON.parse(raw) as AssetShard;
    assets.push(...assertShardFormat(shard, entry, expected, manifest.maxChars, manifest.maxItems));
  }
  const ids = assets.map((asset) => asset.assetId);
  if (
    ids.length !== manifest.totalAssets ||
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => id !== manifest.assets[index]?.assetId)
  ) {
    throw new Error("分片聚合未通过全量一一对应、去重或稳定顺序校验");
  }
  return assets;
}

export async function syntheticRecordsFromShards(directoryInput: string): Promise<{
  records: ScanRecord[];
  skippedGitCommits: SkippedGitCommit[];
  skippedFilesWithinCommit?: SkippedGitFileWithinCommit[];
  gitScanPolicy?: GitScanPolicy;
}> {
  const directory = path.resolve(directoryInput);
  const manifest = await readManifest(directory);
  const records: ScanRecord[] = [];
  for (const entry of manifest.shards) {
    const shard = JSON.parse(
      await readFile(shardPath(directory, entry), "utf8"),
    ) as AssetShard;
    for (const item of shard.items) {
      records.push({
        sourceType: item.provenance.sourceType,
        sourceRef: item.provenance.sourceRef,
        sourceRevision: item.provenance.sourceRevision,
        contentHash: item.provenance.contentHash,
        content: item.sourceExcerpt.text,
      });
    }
  }
  const ordered = manifest.assets.map((item) => {
    const record = records.find(
      (candidate) =>
        candidate.sourceType === item.sourceType && candidate.sourceRef === item.sourceRef,
    );
    if (!record) {
      throw new Error(`manifest 来源缺少分片记录：${item.sourceRef}`);
    }
    return record;
  });
  return {
    records: ordered,
    skippedGitCommits: manifest.skippedGitCommits ?? [],
    ...(manifest.skippedFilesWithinCommit?.length
      ? { skippedFilesWithinCommit: manifest.skippedFilesWithinCommit }
      : {}),
    ...(manifest.gitScanPolicy ? { gitScanPolicy: manifest.gitScanPolicy } : {}),
  };
}

export async function loadShardedAssetsTrust(directoryInput: string): Promise<AssetRecord[]> {
  return loadShardedDirectoryTrust(path.resolve(directoryInput));
}

export async function validateShardedInput(input: string): Promise<{
  format: "sharded-directory";
  validatedShards: string[];
  completedAssets: number;
  totalAssets: number;
  pendingShards: string[];
}> {
  const absolute = path.resolve(input);
  const info = await stat(absolute);
  const directory = info.isDirectory() ? absolute : path.dirname(path.dirname(absolute));
  const manifest = await readManifest(directory);
  const selected = info.isDirectory()
    ? manifest.shards
    : manifest.shards.filter((entry) => shardPath(directory, entry) === absolute);
  if (selected.length === 0) throw new Error(`输入不是 manifest 中的分片：${input}`);
  const validatedShards: string[] = [];
  for (const entry of selected) {
    await validateEntry(directory, manifest, entry);
    validatedShards.push(entry.shardId);
    await persistManifest(directory, manifest);
  }
  return {
    format: "sharded-directory",
    validatedShards,
    completedAssets: manifest.completedAssets,
    totalAssets: manifest.totalAssets,
    pendingShards: manifest.shards
      .filter((entry) => entry.status === "pending")
      .map((entry) => shardPath(directory, entry)),
  };
}

export async function loadShardedDirectory(directoryInput: string): Promise<AssetRecord[]> {
  const directory = path.resolve(directoryInput);
  const manifest = await readManifest(directory);
  if (manifest.shards.some((entry) => entry.status !== "completed")) {
    throw new Error(
      `分片尚未全部完成：${manifest.completedAssets}/${manifest.totalAssets}；请逐片 validate 后再 finalize`,
    );
  }
  const assets: AssetRecord[] = [];
  for (const entry of manifest.shards) {
    const file = shardPath(directory, entry);
    const raw = await readFile(file, "utf8");
    if (entry.validatedHash !== hash(raw)) {
      throw new Error(`已完成分片在验证后被修改：${file}`);
    }
    const shard = JSON.parse(raw) as AssetShard;
    assets.push(
      ...assertShard(
        shard,
        entry,
        new Map(manifest.assets.map((item) => [item.assetId, item])),
        manifest.maxChars,
        manifest.maxItems,
      ),
    );
  }
  const ids = assets.map((asset) => asset.assetId);
  if (
    ids.length !== manifest.totalAssets ||
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => id !== manifest.assets[index]?.assetId)
  ) {
    throw new Error("分片聚合未通过全量一一对应、去重或稳定顺序校验");
  }
  return assets;
}

export async function inputIsDirectory(input: string): Promise<boolean> {
  return (await stat(input)).isDirectory();
}

export async function readShardManifest(directory: string): Promise<ShardManifest> {
  return readManifest(directory);
}
