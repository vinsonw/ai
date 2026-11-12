import { describe, expect, it } from "vitest";
import { assertAssetSourceRevision } from "../../src/acceptance.js";
import type { AssetRecord } from "../../src/types.js";
import { enrichAssets } from "../helpers.js";

function fileAsset(sourceRevision: string, contentHash?: string): AssetRecord {
  const base = enrichAssets([
    {
      assetId: "asset:req-untracked",
      sourceType: "requirement",
      sourceRef: "docs/requirements/untracked.md",
      sourceRevision,
      contentHash:
        contentHash ??
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "未提交需求",
      summary: "用于验证 deliver 信任分片时允许 untracked revision。",
      facts: [],
      decisions: [],
      actions: [],
      relations: [],
      analysis: {
        completeness: { level: "partial", evidence: [], gaps: [], recommendations: [] },
        executability: { level: "partial", evidence: [], gaps: [], recommendations: [] },
        consistency: { level: "partial", evidence: [], gaps: [], recommendations: [] },
        reuseValue: { level: "medium", evidence: [], gaps: [], recommendations: [] },
      },
      writebackKind: "新增",
    },
  ])[0]!;
  return base;
}

const gitSha = "a".repeat(40);

describe("writeAcceptancePackage 来源 revision 门控", () => {
  it("git 来源始终要求 40 位提交 SHA", () => {
    const gitAsset: AssetRecord = {
      ...fileAsset(gitSha),
      sourceType: "git",
      sourceRef: "src/App.tsx",
      sourceRevision: "untracked",
    };
    expect(() => assertAssetSourceRevision(gitAsset, { trustDelivered: true })).toThrow(
      "来源未提交或 revision 不可追溯",
    );
    expect(() =>
      assertAssetSourceRevision({ ...gitAsset, sourceRevision: gitSha }, { trustDelivered: true }),
    ).not.toThrow();
  });

  it("trustDelivered 时允许 requirement 使用 untracked", () => {
    expect(() =>
      assertAssetSourceRevision(fileAsset("untracked"), { trustDelivered: true }),
    ).not.toThrow();
  });

  it("trustDelivered 时允许 manifest 冻结的非 SHA revision（有 contentHash）", () => {
    expect(() =>
      assertAssetSourceRevision(fileAsset("manifest-frozen"), { trustDelivered: true }),
    ).not.toThrow();
  });

  it("非 trustDelivered 时文件来源仍要求 40 位 SHA", () => {
    expect(() => assertAssetSourceRevision(fileAsset("untracked"))).toThrow(
      "来源未提交或 revision 不可追溯",
    );
    expect(() => assertAssetSourceRevision(fileAsset(gitSha))).not.toThrow();
  });
});
