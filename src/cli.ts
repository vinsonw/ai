#!/usr/bin/env node
import { Command } from "commander";
import {
  inspectPipeline,
  loadAssetsFile,
  loadConfig,
  plan,
  runPipeline,
  scan,
  verifyGitScope,
  verifySecondRun,
} from "./pipeline.js";
import { initGenericWorkspace, installEditorSkill } from "./setup.js";

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
    .description("在 docs/可读化 下生成可增量、可追溯的资产")
    .usage("[选项] <命令>")
    .version("0.1.0", "-V, --version", "显示版本")
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
    program.command("prepare").description("输出通过 schema 的资产，不写入目标仓库"),
  ).action(async (options: CommonOptions) => {
    const prepared = await inspectPipeline(options.repo, options.config);
    print(prepared.assets);
  });

  program
    .command("validate")
    .description("校验补充后的四维资产 JSON")
    .requiredOption("--input <path>", "由 prepare 生成并补充的 JSON 数组")
    .action(async (options: { input: string }) =>
      print({ valid: true, count: (await loadAssetsFile(options.input)).length }),
    );

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
    .description("验证工作树改动仅位于 docs/可读化")
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
