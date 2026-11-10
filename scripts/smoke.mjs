import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();
const repo = await mkdtemp(path.join(os.tmpdir(), "asset-compound-smoke-"));

async function run(command, args, cwd = repo) {
  return exec(command, args, { cwd, encoding: "utf8" });
}

try {
  await cp(path.join(root, "tests/fixtures/sample-project"), repo, { recursive: true });
  await run("git", ["init", "-b", "main"]);
  await run("git", ["config", "user.name", "Asset Smoke"]);
  await run("git", ["config", "user.email", "asset-smoke@example.invalid"]);
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "fixture: synthetic smoke baseline"]);
  await run("git", ["checkout", "-b", "asset-compounding/smoke"]);

  const cli = path.join(root, "dist/cli.js");
  const config = path.join(repo, "run.yaml");
  const first = JSON.parse(
    (await run(process.execPath, [cli, "finalize", "--repo", repo, "--config", config])).stdout,
  );
  const statusAfterFirst = (await run("git", ["status", "--porcelain=v1"])).stdout;
  const verification = JSON.parse(
    (
      await run(process.execPath, [
        cli,
        "verify",
        "--repo",
        repo,
        "--config",
        config,
      ])
    ).stdout,
  );
  const second = JSON.parse(
    (await run(process.execPath, [cli, "finalize", "--repo", repo, "--config", config])).stdout,
  );
  const statusAfterSecond = (await run("git", ["status", "--porcelain=v1"])).stdout;

  if (first.counts.new < 2 || first.changedFiles.length === 0) {
    throw new Error("first run did not produce assets");
  }
  if (
    !verification.secondRunZeroDiff ||
    !second.noOp ||
    !second.secondRunZeroDiff ||
    second.counts.new !== 0 ||
    second.counts.updated !== 0
  ) {
    throw new Error("second run was not a no-op");
  }
  if (statusAfterFirst !== statusAfterSecond) {
    throw new Error("second run changed the worktree");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: "synthetic; not acceptance data",
        first: first.counts,
        second: second.counts,
        secondRunZeroDiff: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(repo, { recursive: true, force: true });
}
