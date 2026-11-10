#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  inspectPipeline,
  loadAssetsInput,
  loadConfig,
  plan,
  prepareShardPipeline,
  runPipeline,
  scan,
  verifyGitScope,
  verifySecondRun,
} from "./pipeline.js";
import { inputIsDirectory, validateShardedInput } from "./shards.js";
import { initGenericWorkspace, installEditorSkill } from "./setup.js";
import { deliverWorkflow, startWorkflow } from "./workflow.js";

interface CommonOptions {
  repo: string;
  config: string;
  assets?: string;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function withCommonOptions(command: Command): Command {
  return command
    .requiredOption("--repo <path>", "目标 Git 仓库")
    .requiredOption("--config <path>", "YAML 运行配置");
}

function parseBudget(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`预算必须是正整数：${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const titleMap: Record<string, string> = {
    "Usage:": "用法：",
    "Arguments:": "参数：",
    "Options:": "选项：",
    "Global Options:": "全局选项：",
    "Commands:": "命令：",
  };
  const program = new Command()
    .name("asset-compound")
    .description("生成标准 docs 分类目录和可增量、可追溯的验收资产")
    .usage("[选项] <命令>")
    .version("0.1.3", "-V, --version", "显示版本")
    .helpOption("-h, --help", "显示帮助")
    .addHelpCommand("help [command]", "显示指定命令的帮助")
    .showHelpAfterError("（使用 --help 查看帮助）")
    .configureHelp({
      styleTitle: (title) => titleMap[title] ?? title,
      subcommandTerm: (command) =>
        command.name() === "help" ? "help [命令]" : `${command.name()} [选项]`,
    })
    .configureOutput({
      outputError: (text, write) =>
        write(
          text
            .replace(/^error:/gm, "错误：")
            .replace(/required option '([^']+)' not specified/g, "缺少必填选项 '$1'")
            .replace(/unknown command '([^']+)'/g, "未知命令 '$1'")
            .replace(/unknown option '([^']+)'/g, "未知选项 '$1'"),
        ),
    });

  program
    .command("init")
    .description("初始化编辑器无关的配置、中文提示协议和 schema")
    .option("--output <path>", "输出目录；默认 ~/.asset-compound")
    .option("--base-branch <name>", "目标仓库基线分支", "main")
    .option("--mode <mode>", "初始化模式；当前支持 generic", "generic")
    .option("--force", "覆盖已存在的初始化文件")
    .action(
      async (options: {
        output?: string;
        baseBranch: string;
        mode: string;
        force?: boolean;
      }) => {
        if (options.mode !== "generic") {
          throw new Error(`init 当前仅支持 generic 模式；收到 mode=${options.mode}`);
        }
        print(
          await initGenericWorkspace({
            baseBranch: options.baseBranch,
            force: options.force ?? false,
            ...(options.output ? { output: options.output } : {}),
          }),
        );
      },
    );

  program
    .command("install-skill")
    .description("安装可选编辑器适配器；当前支持 Cursor")
    .requiredOption("--editor <name>", "编辑器名称；当前为 cursor")
    .option("--target <path>", "自定义 Skill 安装目录")
    .option("--force", "覆盖已存在的 Skill")
    .action(
      async (options: {
        editor: string;
        target?: string;
        force?: boolean;
      }) =>
        print(
          await installEditorSkill({
            editor: options.editor,
            force: options.force ?? false,
            ...(options.target ? { target: options.target } : {}),
          }),
        ),
    );

  program
    .command("start")
    .description("在当前 Git 项目零/低配置生成小上下文任务队列")
    .option("--workspace <path>", "稳定工作区；默认 .git/asset-compound")
    .option("--config <path>", "高级覆盖：使用既有 run.yaml")
    .option("--requirements <globs...>", "需求来源 glob；自动发现歧义时用于最小选择")
    .option("--base-branch <name>", "覆盖自动发现的基线分支")
    .option("--max-chars <number>", "每片来源摘录字符预算；首次默认 12000", parseBudget)
    .option("--max-items <number>", "每片最多资产数；首次默认 1", parseBudget)
    .option("--provider <executable>", "可选外部 provider 适配器；凭证仅从环境变量读取")
    .option("--yes", "接受无歧义默认值，或接受全部自动发现的需求目录")
    .action(
      async (options: {
        workspace?: string;
        config?: string;
        requirements?: string[];
        baseBranch?: string;
        maxChars?: number;
        maxItems?: number;
        provider?: string;
        yes?: boolean;
      }) =>
        print(
          await startWorkflow({
            ...options,
            cwd: process.cwd(),
            yes: options.yes ?? false,
          }),
        ),
    );

  program
    .command("deliver")
    .description("聚合已完成分片、执行质量门禁并验证二次零差异")
    .option("--workspace <path>", "稳定工作区；默认 .git/asset-compound")
    .option("--yes", "非交互执行")
    .action(async (options: { workspace?: string; yes?: boolean }) =>
      print(
        await deliverWorkflow({
          cwd: process.cwd(),
          yes: options.yes ?? false,
          ...(options.workspace ? { workspace: options.workspace } : {}),
        }),
      ),
    );

  withCommonOptions(
    program.command("plan").description("校验输入并输出执行计划"),
  ).action(async (options: CommonOptions) => print(await plan(options.repo, options.config)));

  withCommonOptions(
    program.command("scan").description("发现配置来源并计算内容指纹"),
  ).action(async (options: CommonOptions) => {
    const config = await loadConfig(options.config);
    print(await scan(options.repo, config));
  });

  withCommonOptions(
    program
      .command("prepare")
      .description("生成小上下文 manifest 与待分析分片，不写入目标仓库")
      .option("--output <directory>", "分片工作目录；默认必须显式指定")
      .option("--max-chars <number>", "每片来源摘录字符预算", parseBudget, 12_000)
      .option("--max-items <number>", "每片最多资产数", parseBudget, 1)
      .option("--resume", "续跑同一 manifest，仅列出未完成分片")
      .option("--legacy-stdout", "兼容旧流程：向 stdout 输出单一 JSON 数组"),
  ).action(
    async (
      options: CommonOptions & {
        output?: string;
        maxChars: number;
        maxItems: number;
        resume?: boolean;
        legacyStdout?: boolean;
      },
    ) => {
      if (options.legacyStdout) {
        const prepared = await inspectPipeline(options.repo, options.config);
        print(prepared.assets);
        return;
      }
      if (!options.output) {
        throw new Error(
          "prepare 分片模式需要 --output <目录>；旧版单文件输出请显式使用 --legacy-stdout",
        );
      }
      print(
        await prepareShardPipeline(options.repo, options.config, options.output, {
          maxChars: options.maxChars,
          maxItems: options.maxItems,
          resume: options.resume ?? false,
        }),
      );
    },
  );

  program
    .command("validate")
    .description("逐片或整目录校验四维资产，并持久化完成标记")
    .requiredOption("--input <path>", "分片 JSON、分片目录或旧版 JSON 数组")
    .action(async (options: { input: string }) => {
      const directory = await inputIsDirectory(options.input);
      const legacy =
        !directory &&
        Array.isArray(JSON.parse(await readFile(options.input, "utf8")) as unknown);
      if (!legacy) {
        const result = await validateShardedInput(options.input);
        print({ valid: true, ...result });
        return;
      }
      const loaded = await loadAssetsInput(options.input);
      print({
        valid: true,
        count: loaded.assets.length,
        format: loaded.format,
        migrationNotice:
          "旧版单文件 JSON 仍受支持；建议迁移到 prepare --output <目录> 的分片工作流",
      });
    });

  withCommonOptions(
    program
      .command("render")
      .description("执行完整管线并渲染文档")
      .option("--assets <path>", "已校验的补充资产 JSON"),
  ).action(async (options: CommonOptions) =>
    print(await runPipeline(options.repo, options.config, options.assets)),
  );

  program
    .command("verify")
    .description("验证工作树改动仅位于受管 docs 目录")
    .requiredOption("--repo <path>", "目标 Git 仓库")
    .option("--config <path>", "同时证明无变化二次运行")
    .action(async (options: Pick<CommonOptions, "repo"> & { config?: string }) => {
      if (options.config) {
        print(await verifySecondRun(options.repo, options.config));
        return;
      }
      print({ valid: true, changedFiles: await verifyGitScope(options.repo) });
    });

  withCommonOptions(
    program
      .command("finalize")
      .description("执行、验证并输出最终结果")
      .option("--assets <path>", "已校验的补充资产 JSON"),
  ).action(async (options: CommonOptions) =>
    print(await runPipeline(options.repo, options.config, options.assets)),
  );

  withCommonOptions(
    program
      .command("run")
      .description("finalize 的别名")
      .option("--assets <path>", "已校验的补充资产 JSON"),
  ).action(async (options: CommonOptions) =>
    print(await runPipeline(options.repo, options.config, options.assets)),
  );

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`asset-compound：${message}\n`);
  process.exitCode = 1;
});
