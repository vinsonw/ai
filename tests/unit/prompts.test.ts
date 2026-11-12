import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function text(relative: string): Promise<string> {
  return readFile(path.resolve(relative), "utf8");
}

describe("AI 小上下文提示契约", () => {
  it("keeps the canonical shard prompt fail-closed and unambiguous", async () => {
    const prompt = await text("prompts/asset-analysis.zh-CN.md");
    for (const constraint of [
      "status=pending",
      "本轮事实输入仅限当前片",
      "不得打开原始全文",
      "唯一输出是原地覆盖当前 shard 的纯 JSON",
      "不得修改项目源码",
      "当前 shard 结构与 CLI `validate` 是唯一 schema 权威",
      "`summary`：至少 20 个字符",
      "evidence 必须引用或紧密复述",
      "先读 diff",
      "文件路径@commit + @@ hunk 定位",
      "提交消息只能提示意图",
      "禁止打开全仓或完整大文件",
      "PATCH_TRUNCATED",
      "10 次有效提交",
      "不是全仓历史",
      "start` 预筛",
      "skippedGitCommits",
      "勿对跳过项补写资产",
      "--include-transactional-commits",
      "只有 exit 0",
      "2.1、2.2、R1–R6、V1–V8",
    ]) {
      expect(prompt).toContain(constraint);
    }
  });

  it("keeps editor adapters aligned with validation and delivery gates", async () => {
    const [skill, adapter] = await Promise.all([
      text("skill/asset-compounding/SKILL.md"),
      text("adapters/AGENTS.md"),
    ]);
    for (const prompt of [skill, adapter]) {
      expect(prompt).toContain("第一条 pending shard");
      expect(prompt).toContain("不得改源码");
      expect(prompt).toContain("evidence");
      expect(prompt).toContain("validate exit 0");
      expect(prompt).toContain("2.1");
      expect(prompt).toContain("2.2");
      expect(prompt).toContain("R1–R6");
      expect(prompt).toContain("V1–V8");
      expect(prompt).toContain("zero diff");
      expect(prompt).toContain("提交消息不能替代代码证据");
      expect(prompt).toContain("文件路径@commit + @@ hunk 定位");
      expect(prompt).toContain("禁止打开全仓或完整大文件");
      expect(prompt).toContain("10 次有效提交");
      expect(prompt).toContain("skippedGitCommits");
      expect(prompt).toContain("--include-transactional-commits");
      expect(prompt).toContain("start` 预筛");
    }
  });

  it("keeps the editor-neutral protocol within the same single-shard boundary", async () => {
    const protocol = await text("protocol/README.zh-CN.md");
    expect(protocol).toContain("第一条 pending shard");
    expect(protocol).toContain("不得加载全量、猜目录");
    expect(protocol).toContain("唯一输出");
    expect(protocol).toContain("禁止改源码");
    expect(protocol).toContain("sourceExcerpt");
    expect(protocol).toContain("先读 diff");
    expect(protocol).toContain("文件路径@commit + @@ hunk 定位");
    expect(protocol).toContain("不向模型灌入全仓、完整大文件");
    expect(protocol).toContain("10 次有效提交");
    expect(protocol).toContain("maxShards=10");
    expect(protocol).toContain("webpack");
    expect(protocol).toContain("skippedGitCommits");
    expect(protocol).toContain("不是 AI");
    expect(protocol).toContain("R1–R6");
    expect(protocol).toContain("V1–V8");
  });

  it("prevents model-written acceptance and conflict conclusions", async () => {
    const [acceptance, conflict] = await Promise.all([
      text("templates/acceptance-report.md"),
      text("templates/conflict-report.md"),
    ]);
    expect(acceptance).toContain("AI 不得手工填充占位符");
    expect(acceptance).toContain("中间报告");
    expect(conflict).toContain("AI 不得修改本模板");
    expect(conflict).toContain("证据不足");
  });
});
