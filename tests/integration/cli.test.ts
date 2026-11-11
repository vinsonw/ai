import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cli = path.resolve("src/cli.ts");

function invoke(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("中文 CLI", () => {
  it("显示中文帮助且保留稳定命令名", () => {
    const result = invoke(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("用法：");
    expect(result.stdout).toContain("选项：");
    expect(result.stdout).toContain("命令：");
    expect(result.stdout).toContain("plan [选项]");
    expect(result.stdout).not.toContain("[options]");
    expect(result.stdout).toContain("标准 docs 分类目录");
    expect(result.stdout).toContain("prepare");
    expect(result.stdout).toContain("finalize");
    expect(result.stdout).toContain("start");
    expect(result.stdout).toContain("deliver");
  });

  it("将 Commander 参数错误本地化且保持非零退出码", () => {
    const result = invoke(["plan", "--repo", "."]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("错误：");
    expect(result.stderr).toContain("缺少必填选项");
  });

  it("说明分片预算、断点续跑和旧格式兼容", () => {
    const result = invoke(["prepare", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--max-chars");
    expect(result.stdout).toContain("--max-items");
    expect(result.stdout).toContain("--max-shards");
    expect(result.stdout).toContain("--resume");
    expect(result.stdout).toContain("--legacy-stdout");
  });

  it("暴露事务提交覆盖和默认总分片预算", () => {
    const result = invoke(["start", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--max-shards");
    expect(result.stdout).toContain("默认 10");
    expect(result.stdout).toContain("--include-transactional-commits");
  });
});
