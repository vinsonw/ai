import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();
const sandbox = await mkdtemp(path.join(os.tmpdir(), "asset-packed-smoke-"));
const repo = path.join(sandbox, "project");
const workspace = path.join(sandbox, "workspace");
const home = path.join(sandbox, "home");
let tarball;

async function run(command, args, cwd = sandbox) {
  return exec(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: home,
      npm_config_cache: path.join(sandbox, "npm-cache"),
    },
  });
}

async function npx(args) {
  return run(
    "npx",
    ["--yes", "--package", tarball, "asset-compound", ...args],
    sandbox,
  );
}

try {
  const packed = JSON.parse(
    (
      await exec("npm", ["pack", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
      })
    )
      .stdout,
  );
  tarball = path.join(root, packed[0].filename);

  await cp(path.join(root, "tests/fixtures/sample-project"), repo, {
    recursive: true,
  });
  await run("git", ["init", "-b", "main"], repo);
  await run("git", ["config", "user.name", "Packed Smoke"], repo);
  await run(
    "git",
    ["config", "user.email", "packed-smoke@example.invalid"],
    repo,
  );
  await run("git", ["add", "."], repo);
  await run("git", ["commit", "-m", "fixture: packed smoke baseline"], repo);
  await run("git", ["checkout", "-b", "asset-compounding/packed-smoke"], repo);

  const initResult = JSON.parse(
    (
      await npx([
        "init",
        "--output",
        workspace,
        "--base-branch",
        "main",
      ])
    ).stdout,
  );
  const config = initResult.config;
  const prepared = path.join(workspace, "prepared.json");
  const enriched = path.join(workspace, "enriched.json");

  await npx(["plan", "--repo", repo, "--config", config]);
  await npx(["scan", "--repo", repo, "--config", config]);
  const prepareResult = await npx([
    "prepare",
    "--repo",
    repo,
    "--config",
    config,
  ]);
  await writeFile(prepared, prepareResult.stdout, "utf8");
  await writeFile(enriched, prepareResult.stdout, "utf8");
  await npx(["validate", "--input", enriched]);

  const first = JSON.parse(
    (
      await npx([
        "finalize",
        "--repo",
        repo,
        "--config",
        config,
        "--assets",
        enriched,
      ])
    ).stdout,
  );
  const statusAfterFirst = (await run("git", ["status", "--porcelain=v1"], repo))
    .stdout;
  const verification = JSON.parse(
    (await npx(["verify", "--repo", repo, "--config", config])).stdout,
  );
  const second = JSON.parse(
    (
      await npx([
        "run",
        "--repo",
        repo,
        "--config",
        config,
        "--assets",
        enriched,
      ])
    ).stdout,
  );
  const statusAfterSecond = (
    await run("git", ["status", "--porcelain=v1"], repo)
  ).stdout;

  const skill = JSON.parse(
    (await npx(["install-skill", "--editor", "cursor"])).stdout,
  );
  const protocol = await readFile(initResult.protocol, "utf8");
  const prompt = await readFile(initResult.prompt, "utf8");
  const skillText = await readFile(skill.skillFile, "utf8");

  if (first.counts.new < 2 || first.changedFiles.length === 0) {
    throw new Error("packed first run did not produce assets");
  }
  if (
    !verification.secondRunZeroDiff ||
    !second.noOp ||
    !second.secondRunZeroDiff ||
    second.counts.new !== 0 ||
    second.counts.updated !== 0
  ) {
    throw new Error("packed second run was not a no-op");
  }
  if (statusAfterFirst !== statusAfterSecond) {
    throw new Error("packed second run changed the worktree");
  }
  if (
    !protocol.includes("编辑器无关") ||
    !prompt.includes("四维分析") ||
    !skillText.includes("# 资产复利")
  ) {
    throw new Error("packed resources are incomplete");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        package: "@vinsonw2/asset-compound",
        source: "npm pack tarball",
        npxOnly: true,
        genericInit: true,
        cursorAdapter: true,
        first: first.counts,
        second: second.counts,
        secondRunZeroDiff: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(sandbox, { recursive: true, force: true });
}
