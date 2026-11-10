export type SourceType = "requirement" | "design" | "ai-artifact" | "git";
export type ChangeKind = "新增" | "增量" | "未变";

export interface SourceSet {
  type: SourceType;
  include?: string[];
  maxCommits?: number;
}

export interface RunConfig {
  outputRoot: "docs/可读化";
  baseBranch?: string;
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
}
