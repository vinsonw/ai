import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initGenericWorkspace, installEditorSkill } from "../../src/setup.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("编辑器无关初始化", () => {
  it("生成配置、提示协议和 schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asset-init-"));
    temporary.push(root);
    const output = path.join(root, "workspace");
    const result = await initGenericWorkspace({
      output,
      baseBranch: "develop",
    });

    expect(result.mode).toBe("generic");
    expect(await readFile(result.config, "utf8")).toContain("baseBranch: develop");
    expect(await readFile(result.prompt, "utf8")).toContain("唯一输出");
    expect(await readFile(result.protocol, "utf8")).toContain("第一条 pending shard");
    expect(await readFile(result.readme, "utf8")).toContain("事实仅来自当前 sourceExcerpt");
    expect(JSON.parse(await readFile(result.outputSchema, "utf8"))).toHaveProperty(
      "$schema",
    );
    expect(JSON.parse(await readFile(result.shardSchema, "utf8"))).toHaveProperty(
      "$schema",
    );
    expect(await readFile(result.agentsAdapter, "utf8")).toContain("第一条 pending shard");

    await expect(initGenericWorkspace({ output })).rejects.toThrow("已存在");
    await expect(initGenericWorkspace({ output, force: true })).resolves.toBeDefined();
  });
});

describe("可选编辑器适配器", () => {
  it("按显式参数安装 Cursor Skill", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asset-skill-"));
    temporary.push(root);
    const target = path.join(root, "cursor-skill");
    const result = await installEditorSkill({ editor: "cursor", target });
    expect(await readFile(result.skillFile, "utf8")).toContain("# 资产复利");
    const unrelated = path.join(target, "notes.md");
    await writeFile(unrelated, "keep", "utf8");
    await expect(
      installEditorSkill({ editor: "cursor", target, force: true }),
    ).resolves.toBeDefined();
    expect(await readFile(unrelated, "utf8")).toBe("keep");
    await expect(
      installEditorSkill({ editor: "other", target: path.join(root, "other") }),
    ).rejects.toThrow("仅提供 Cursor");
  });
});
