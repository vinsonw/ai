import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();

async function run(command, args, options = {}) {
  await exec(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

async function sha256File(file) {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const innerName = `asset-compound-${version}.tgz`;
const sourceName = `asset-compound-${version}-source.zip`;
const artifactsDir = path.join(root, "artifacts");

const EXCLUDE_DIR = new Set(["node_modules", ".git", "artifacts"]);
const EXCLUDE_FILE = new Set([innerName, sourceName]);

async function copySourceTree(dest) {
  await cp(root, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (parts.some((p) => EXCLUDE_DIR.has(p))) return false;
      const base = path.basename(src);
      if (parts[0] === "artifacts" && EXCLUDE_FILE.has(base)) return false;
      if (base === "node_modules" || base === ".git") return false;
      return true;
    },
  });
}

const staging = await mkdtemp(path.join(os.tmpdir(), "asset-compound-staging-"));

try {
  await copySourceTree(staging);

  const stagingPkgPath = path.join(staging, "package.json");
  const stagingPkg = JSON.parse(await readFile(stagingPkgPath, "utf8"));
  stagingPkg.files = (stagingPkg.files ?? []).filter((f) => f !== "artifacts");
  stagingPkg.bundledDependencies = Object.keys(stagingPkg.dependencies ?? {});
  delete stagingPkg.devDependencies;
  delete stagingPkg.packageManager;
  await writeFile(stagingPkgPath, `${JSON.stringify(stagingPkg, null, 2)}\n`);

  await run("npm", [
    "install",
    "--omit=dev",
    "--no-package-lock",
    "--ignore-scripts",
  ], { cwd: staging });

  const packOut = await exec(
    "npm",
    ["pack", "--json", "--ignore-scripts"],
    { cwd: staging, encoding: "utf8" },
  );
  const packed = JSON.parse(packOut.stdout)[0].filename;
  const packedPath = path.join(staging, packed);
  const innerPath = path.join(artifactsDir, innerName);
  await cp(packedPath, innerPath);

  await run("zip", [
    "-rq",
    path.join(artifactsDir, sourceName),
    ".",
    "-x",
    "node_modules/*",
    "node_modules/**/*",
    ".git/*",
    ".git/**/*",
    `artifacts/${innerName}`,
    `artifacts/${sourceName}`,
    "artifacts/asset-compound-*.tgz",
    "artifacts/asset-compound-*-source.zip",
  ], { cwd: root });

  const innerHash = await sha256File(innerPath);
  const sourceHash = await sha256File(path.join(artifactsDir, sourceName));
  const sums = `${innerHash}  ${innerName}\n${sourceHash}  ${sourceName}\n`;
  await writeFile(path.join(artifactsDir, "SHA256SUMS"), sums);

  for (const name of await readdir(artifactsDir)) {
    if (
      (name.startsWith("asset-compound-") && name.endsWith(".tgz") && name !== innerName) ||
      (name.endsWith("-source.zip") && name !== sourceName)
    ) {
      await rm(path.join(artifactsDir, name));
    }
  }

  process.stdout.write(
    `${JSON.stringify({ version, innerName, sourceName, innerHash, sourceHash }, null, 2)}\n`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
