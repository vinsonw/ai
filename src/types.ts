export type SourceType = "requirement" | "design" | "ai-artifact" | "git";
export type ChangeKind = "新增" | "增量" | "未变";

export interface SourceSet {
  type: SourceType;
  include?: string[];
  /** 计入资产的有效 Git 提交数上限；跳过的事务提交不占名额。 */
  maxCommits?: number;
  includeTransactionalCommits?: boolean;
  maxBusinessFilesPerCommit?: number;
}

export interface GitScanPolicy {
  maxEffectiveCommits: number;
  maxBusinessFilesPerCommit: number;
  messageFiltersEnabled: boolean;
  transactionalPathPatterns: string[];
}

export interface OmittedRequirementSource {
  path: string;
  reason: string;
}

export interface SkippedGitFileWithinCommit {
  commit: string;
  path: string;
  reasonCode: "per-commit-file-cap";
  reason: string;
}

export interface RunConfig {
  outputRoot: "docs/可读化";
  baseBranch?: string;
  maxShards?: number;
  sourceSets: SourceSet[];
  exclude?: string[];
}

export interface DimensionFinding {
  level: "ready" | "partial" | "missing" | "conflict" | "high" | "medium" | "low";
  evidence: string[];
  gaps: string[];
  recommendations: string[];
}

export interface AssetRecord {
  assetId: string;
  sourceType: SourceType;
  sourceRef: string;
  sourceRevision: string;
  contentHash: string;
  title: string;
  summary: string;
  facts: string[];
  decisions: string[];
  actions: string[];
  relations: string[];
  analysis: {
    completeness: DimensionFinding;
    executability: DimensionFinding;
    consistency: DimensionFinding;
    reuseValue: DimensionFinding;
  };
  writebackKind: ChangeKind;
}

export interface SourceState {
  contentHash: string;
  sourceRevision: string;
  assetIds: string[];
  status: "active" | "stale";
}

export interface AssetState {
  canonicalContentHash: string;
  outputPath: string;
  lastGeneratedHash: string;
}

export interface ReadState {
  schemaVersion: 1;
  selfHash: string;
  baseBranch: string;
  baseCommit: string;
  lastReadCommit: string;
  sources: Record<string, SourceState>;
  assets: Record<string, AssetState>;
  managedFiles: Record<string, string>;
}

export interface ScanRecord {
  sourceType: SourceType;
  sourceRef: string;
  sourceRevision: string;
  contentHash: string;
  content: string;
}

export interface SkippedGitCommit {
  commit: string;
  treeHash: string;
  contentHash: string;
  subject: string;
  reasonCode:
    | "dependency-lockfile-only"
    | "tool-config-only"
    | "formatting-only"
    | "message-transactional"
    | "transactional-paths-only"
    | "merge-noise"
    | "revert-noise";
  reason: string;
  files: string[];
}

export interface Conflict {
  assetId: string;
  path: string;
  reason: string;
  expectedHash?: string;
  actualHash?: string;
}

export interface PipelineResult {
  runId: string;
  counts: {
    new: number;
    updated: number;
    unchanged: number;
    conflicts: number;
  };
  assets: AssetRecord[];
  conflicts: Conflict[];
  changedFiles: string[];
  noOp: boolean;
  secondRunZeroDiff?: boolean;
  inputFormat?: "generated-baseline" | "legacy-single-file" | "sharded-directory";
  migrationNotice?: string;
}

export interface ShardProvenance {
  assetId: string;
  sourceType: SourceType;
  sourceRef: string;
  sourceRevision: string;
  contentHash: string;
  writebackKind: ChangeKind;
}

export interface ShardExcerpt {
  text: string;
  originalChars: number;
  excerptChars: number;
  truncated: boolean;
  strategy: "full" | "head-tail";
}

export interface ShardItem {
  provenance: ShardProvenance;
  sourceExcerpt: ShardExcerpt;
  asset: AssetRecord;
}

export interface AssetShard {
  schemaVersion: 1;
  shardId: string;
  items: ShardItem[];
}

export interface ShardManifestEntry {
  shardId: string;
  path: string;
  assetIds: string[];
  inputHash: string;
  status: "pending" | "completed";
  validatedHash?: string;
}

export interface ShardManifest {
  schemaVersion: 1;
  manifestHash: string;
  runFingerprint: string;
  maxChars: number;
  maxItems: number;
  maxItemsMode?: "auto" | "fixed";
  maxShards?: number;
  totalAssets: number;
  completedAssets: number;
  assets: ShardProvenance[];
  skippedGitCommits?: SkippedGitCommit[];
  skippedFilesWithinCommit?: SkippedGitFileWithinCommit[];
  gitScanPolicy?: GitScanPolicy;
  omittedRequirementSources?: OmittedRequirementSource[];
  shards: ShardManifestEntry[];
}
