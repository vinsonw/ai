import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
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
  const text =
    available === 0
      ? safe.slice(0, maxChars)
      : `${safe.slice(0, start)}${OMITTED}${safe.slice(safe.length - end)}`;
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
  resumed: boolean;
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
    resumed,
  };
}

export async function prepareShards(
  records: ScanRecord[],
  assets: AssetRecord[],
  output: string,
  options: PrepareShardsOptions = {},
): Promise<PrepareShardsResult> {
  const directory = path.resolve(output);
  const maxChars = options.maxChars ?? 12_000;
  const maxItems = options.maxItems ?? 1;
  if (!Number.isInteger(maxChars) || maxChars < 32) {
    throw new Error("maxChars 必须是至少 32 的整数");
  }
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error("maxItems 必须是至少 1 的整数");
  }
  const runFingerprint = hash(
    JSON.stringify({
      maxChars,
      maxItems,
      sources: records.map(({ content: _content, ...record }) => record),
    }),
  );
  const manifestPath = path.join(directory, MANIFEST);
  if (await exists(manifestPath)) {
    if (!options.resume) {
      throw new Error(`分片目录已存在；中断续跑请使用 --resume：${directory}`);
    }
    const current = await readManifest(directory);
    if (current.runFingerprint !== runFingerprint) {
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
  const groups: typeof items[] = [];
  let current: typeof items = [];
  let currentChars = 0;
  for (const item of items) {
    if (
      current.length > 0 &&
      (current.length >= maxItems ||
        currentChars + item.sourceExcerpt.excerptChars > maxChars)
    ) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += item.sourceExcerpt.excerptChars;
  }
  if (current.length > 0) groups.push(current);

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
    runFingerprint,
    maxChars,
    maxItems,
    totalAssets: assets.length,
    completedAssets: 0,
    assets: assets.map(provenance),
    shards: entries,
  };
  manifest.manifestHash = manifestDigest(manifest);
  await writeJson(manifestPath, manifest);
  return resultFor(directory, manifest, false);
}

function assertShard(
  shard: AssetShard,
  entry: ShardManifestEntry,
  expected: Map<string, ShardProvenance>,
  maxChars: number,
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
  if (immutableInputHash(shard.items) !== entry.inputHash) {
    throw new Error(`分片来源摘录或 provenance 被修改：${entry.path}`);
  }
  const excerptChars = shard.items.reduce(
    (sum, item) => sum + item.sourceExcerpt.excerptChars,
    0,
  );
  if (excerptChars > maxChars) {
    throw new Error(`分片来源摘录超过 maxChars 预算：${entry.path}`);
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
    assertSubstantiveAsset(item.asset);
    return item.asset;
  });
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
  const assets = assertShard(shard, entry, expected, manifest.maxChars);
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
