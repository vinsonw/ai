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
    .requiredOption("--repo <path>", "target Git repository")
    .requiredOption("--config <path>", "YAML run configuration");
}

async function main(): Promise<void> {
  const program = new Command()
    .name("asset-compound")
    .description("Build incremental, traceable assets under docs/可读化")
    .version("0.1.0");

  withCommonOptions(
    program.command("plan").description("validate inputs and print the execution plan"),
  ).action(async (options: CommonOptions) => print(await plan(options.repo, options.config)));

  withCommonOptions(
    program.command("scan").description("discover and fingerprint configured sources"),
  ).action(async (options: CommonOptions) => {
    const config = await loadConfig(options.config);
    print(await scan(options.repo, config));
  });

  withCommonOptions(
    program.command("prepare").description("emit schema-valid assets without writing"),
  ).action(async (options: CommonOptions) => {
    const prepared = await inspectPipeline(options.repo, options.config);
    print(prepared.assets);
  });

  program
    .command("validate")
    .description("validate enriched four-dimension asset JSON")
    .requiredOption("--input <path>", "JSON array produced from prepare")
    .action(async (options: { input: string }) =>
      print({ valid: true, count: (await loadAssetsFile(options.input)).length }),
    );

  withCommonOptions(
    program
      .command("render")
      .description("run the complete pipeline and render docs")
      .option("--assets <path>", "validated enriched asset JSON"),
  ).action(async (options: CommonOptions) =>
    print(await runPipeline(options.repo, options.config, options.assets)),
  );

  program
    .command("verify")
    .description("verify that worktree changes stay under docs/可读化")
    .requiredOption("--repo <path>", "target Git repository")
    .option("--config <path>", "also prove an unchanged second run")
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
      .description("run, verify, and print the final result")
      .option("--assets <path>", "validated enriched asset JSON"),
  ).action(async (options: CommonOptions) =>
    print(await runPipeline(options.repo, options.config, options.assets)),
  );

  withCommonOptions(
    program
      .command("run")
      .description("alias for finalize")
      .option("--assets <path>", "validated enriched asset JSON"),
  ).action(async (options: CommonOptions) =>
    print(await runPipeline(options.repo, options.config, options.assets)),
  );

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`asset-compound: ${message}\n`);
  process.exitCode = 1;
});
