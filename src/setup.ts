import { mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";

const PACKAGE_ROOT = new URL("../", import.meta.url);

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function packageText(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, PACKAGE_ROOT), "utf8");
}

async function writeGenerated(
  target: string,
  content: string,
  force: boolean,
): Promise<void> {
  if (!force && (await exists(target))) {
    throw new Error(`目标文件已存在；如需覆盖请使用 --force：${target}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, `${content.trimEnd()}\n`, {
    encoding: "utf8",
    fsync: true,
  });
}

export interface InitOptions {
  output?: string;
  baseBranch?: string;
  force?: boolean;
}

export async function initGenericWorkspace(options: InitOptions = {}) {
  const outputDir = path.resolve(
    options.output ?? path.join(os.homedir(), ".asset-compound"),
  );
  const baseBranch = options.baseBranch ?? "main";
  const files = {
    readme: path.join(outputDir, "README.md"),
    config: path.join(outputDir, "run.yaml"),
    prompt: path.join(outputDir, "prompts", "asset-analysis.zh-CN.md"),
    protocol: path.join(outputDir, "protocol", "README.zh-CN.md"),
    inputSchema: path.join(outputDir, "schemas", "analysis-input.schema.json"),
    outputSchema: path.join(outputDir, "schemas", "analysis-output.schema.json"),
    shardSchema: path.join(outputDir, "schemas", "shard.schema.json"),
    manifestSchema: path.join(outputDir, "schemas", "shard-manifest.schema.json"),
    agentsAdapter: path.join(outputDir, "adapters", "AGENTS.md"),
  };
  const config = `outputRoot: docs/可读化
baseBranch: ${baseBranch}
maxShards: 10
sourceSets:
  - type: requirement
    include:
      - docs/requirements/**/*.md
  - type: design
    include:
      - docs/design/**/*.md
exclude:
  - node_modules/**
  - dist/**
  - build/**
  - coverage/**
`;
  const readme = `# 资产复利通用工作区

本目录由 \`asset-compound init\` 生成，不依赖特定编辑器。

1. 修改 \`run.yaml\`，使用至少两类真实非空来源。
2. 执行 \`npx @vinsonw2/asset-compound prepare --repo <仓库> --config "${files.config}" --output "${path.join(outputDir, "work")}"\`。
3. 让 AI 编辑器先读生成的单片提示和 manifest，只打开第一条 pending shard；
   事实仅来自当前 sourceExcerpt，唯一输出为原地修改当前 \`items[].asset\`，不得改源码或其他文件。
4. 每片执行 \`npx @vinsonw2/asset-compound validate --input <shard.json>\`，中断后用 \`prepare ... --resume\` 只列出未完成片。
5. 全部完成后，在独立分支执行 \`npx @vinsonw2/asset-compound finalize --repo <仓库> --config "${files.config}" --assets "${path.join(outputDir, "work")}"\`。

命令名、JSON 字段和枚举保持英文；中文含义见提示协议。
`;
  const force = options.force ?? false;
  await writeGenerated(files.readme, readme, force);
  await writeGenerated(files.config, config, force);
  await writeGenerated(
    files.prompt,
    await packageText("prompts/asset-analysis.zh-CN.md"),
    force,
  );
  await writeGenerated(
    files.protocol,
    await packageText("protocol/README.zh-CN.md"),
    force,
  );
  await writeGenerated(
    files.inputSchema,
    await packageText("schemas/analysis-input.schema.json"),
    force,
  );
  await writeGenerated(
    files.outputSchema,
    await packageText("schemas/analysis-output.schema.json"),
    force,
  );
  await writeGenerated(
    files.shardSchema,
    await packageText("schemas/shard.schema.json"),
    force,
  );
  await writeGenerated(
    files.manifestSchema,
    await packageText("schemas/shard-manifest.schema.json"),
    force,
  );
  await writeGenerated(
    files.agentsAdapter,
    await packageText("adapters/AGENTS.md"),
    force,
  );
  return {
    mode: "generic",
    outputDir,
    ...files,
  };
}

export interface InstallSkillOptions {
  editor: string;
  target?: string;
  force?: boolean;
}

export async function installEditorSkill(options: InstallSkillOptions) {
  if (options.editor !== "cursor") {
    throw new Error(
      `当前仅提供 Cursor 适配器；通用模式请使用 init。收到 editor=${options.editor}`,
    );
  }
  const target = path.resolve(
    options.target ??
      path.join(os.homedir(), ".cursor", "skills", "asset-compounding"),
  );
  const skillFile = path.join(target, "SKILL.md");
  await writeGenerated(
    skillFile,
    await packageText("skill/asset-compounding/SKILL.md"),
    options.force ?? false,
  );
  return {
    editor: "cursor",
    target,
    skillFile,
  };
}
