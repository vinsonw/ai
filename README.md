# @vinsonw2/asset-compound

编辑器无关的 Node.js 20+ / TypeScript npm 包：把真实项目材料沉淀为 `docs/可读化/` 下可增量、可追溯、可验收的资产。

核心 CLI、schema、templates、中文 prompts 和通用 protocol 不依赖 Cursor，也不读取 `~/.cursor`。Cursor Skill 是显式安装的可选适配器。

## 包名

公开发布名为 `@vinsonw2/asset-compound`，bin 保持 `asset-compound`：

```bash
npx @vinsonw2/asset-compound --help
```

2026-11-10 查询 npm registry 时，该 scoped 名称返回 404，表示当时尚未注册；发布前必须再次执行：

```bash
npm view @vinsonw2/asset-compound name version
```

包名可被其他账户抢先注册。发布 scoped public package 要求发布账号拥有 `@vinsonw2` scope 权限，且 `publishConfig.access` 为 `public`。

## npx 快速开始

初始化编辑器无关工作区（默认 `~/.asset-compound`）：

```bash
npx @vinsonw2/asset-compound init
```

建议为每个真实项目指定仓库外目录：

```bash
npx @vinsonw2/asset-compound init \
  --output "$HOME/.asset-compound/my-react-project" \
  --base-branch main
```

生成：

```text
<output>/
├── README.md
├── run.yaml
├── prompts/asset-analysis.zh-CN.md
├── protocol/README.zh-CN.md
└── schemas/
    ├── analysis-input.schema.json
    └── analysis-output.schema.json
```

这些文件构成任意 AI 编辑器都能读取的文件协议；本项目不宣称存在跨编辑器统一 Skill 标准。

## 通用编辑器模式

假设：

```bash
export REPO="/absolute/path/to/real-react-project"
export WORK="$HOME/.asset-compound/my-react-project"
```

在目标仓库独立分支上运行：

```bash
npx @vinsonw2/asset-compound plan --repo "$REPO" --config "$WORK/run.yaml"
npx @vinsonw2/asset-compound scan --repo "$REPO" --config "$WORK/run.yaml" > "$WORK/scan.json"
npx @vinsonw2/asset-compound prepare --repo "$REPO" --config "$WORK/run.yaml" > "$WORK/prepared.json"
cp "$WORK/prepared.json" "$WORK/enriched.json"
```

让任意 AI 编辑器按以下文件编辑 `enriched.json`：

- `$WORK/prompts/asset-analysis.zh-CN.md`
- `$WORK/protocol/README.zh-CN.md`
- `$WORK/schemas/analysis-output.schema.json`

然后：

```bash
npx @vinsonw2/asset-compound validate --input "$WORK/enriched.json"
npx @vinsonw2/asset-compound finalize \
  --repo "$REPO" \
  --config "$WORK/run.yaml" \
  --assets "$WORK/enriched.json"
npx @vinsonw2/asset-compound verify --repo "$REPO" --config "$WORK/run.yaml"
```

命令名、代码标识符和 JSON/schema 字段保持英文稳定契约；面向验收者的文档和 CLI 提示为中文。

## 可选 Cursor 适配器

只有显式执行下列命令时才访问 Cursor Skill 目录：

```bash
npx @vinsonw2/asset-compound install-skill --editor cursor
```

默认安装到：

```text
~/.cursor/skills/asset-compounding/SKILL.md
```

覆盖已有安装：

```bash
npx @vinsonw2/asset-compound install-skill --editor cursor --force
```

自定义目录：

```bash
npx @vinsonw2/asset-compound install-skill \
  --editor cursor \
  --target /custom/path/asset-compounding
```

## 命令

```text
init           初始化通用配置、提示协议和 schema
install-skill  安装可选编辑器适配器
plan           校验输入并输出执行计划
scan           发现来源并计算内容指纹
prepare        输出 schema 合法的四维分析基线
validate       校验增强资产 JSON
render         执行完整管线并渲染文档
finalize       与 render 等价：执行、验证并输出最终结果
run            finalize 的别名
verify         验证写入范围；带 --config 时验证二次零差异
```

完整参数：

```bash
npx @vinsonw2/asset-compound <command> --help
```

## 能力与安全边界

- 强制至少两种不同、真实、非空的来源类型。
- 支持 `requirement`、`design`、`ai-artifact` 文件来源和 `git` 历史。
- 生成稳定 SHA-256 ID、来源 revision、四维分析、增量 state、冲突报告和验收报告。
- 只写目标仓库 `docs/可读化/**`。
- 拒绝路径穿越、输出符号链接、敏感信息和人工编辑静默覆盖。
- 相同输入第二次运行输出 `secondRunZeroDiff: true`，业务产物零 diff。
- CLI 不创建分支、不提交、不 push、不创建 PR。
- fixture 只能验证工具，不能作为 V1/V2 真实验收数据。

## npm 包内容和库导出

tarball 包含：

- `dist/`：CLI、库入口和 `.d.ts`
- `schemas/`
- `templates/`
- `prompts/`
- `protocol/`
- `skill/asset-compounding/`：可选 Cursor 适配器
- `artifacts/`：从 npm 官方 registry 获取的 `0.1.0` tarball、SHA-256 清单和中文说明

## 0.1.0 离线 tarball

`artifacts/asset-compound-0.1.0.tgz` 是 npm 官方 registry 已发布
`@vinsonw2/asset-compound@0.1.0` 的原始 tarball，不是从当前工作树重新打包的。
固定 SHA-256 记录在 `artifacts/SHA256SUMS`。

在其他平台完成文件同步或下载后，先核对 SHA-256，再在 tarball 所在目录安装：

```bash
npm install ./asset-compound-0.1.0.tgz
npx asset-compound --version
npx asset-compound --help
```

完整来源、校验和离线使用方式见 `artifacts/README.zh-CN.md`。生成当前外层包时应将
`npm pack` 输出到仓库外的临时目录，不得把 `0.1.1` tarball 放入 `artifacts/`，
以免递归打包。

ESM 库入口：

```js
import {
  runPipeline,
  verifySecondRun,
  initGenericWorkspace,
} from "@vinsonw2/asset-compound";
```

资源子路径通过 `exports` 暴露，例如：

```text
@vinsonw2/asset-compound/prompts/asset-analysis.zh-CN.md
@vinsonw2/asset-compound/protocol/README.zh-CN.md
@vinsonw2/asset-compound/schemas/analysis-output.schema.json
@vinsonw2/asset-compound/cursor-skill
```

## 本地开发

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run smoke
pnpm run smoke:packed
pnpm audit --prod
```

`smoke:packed` 会：

1. 从 `npm pack` tarball 创建全新 npx 环境；
2. 不使用源码目录的 bin 或 node_modules link；
3. 执行 `init`、`plan`、`scan`、`prepare`、`validate`、`finalize`、`verify`、`run`；
4. 安装可选 Cursor adapter；
5. 证明第二次运行零增量。

## npm 发布

发布前：

```bash
npm login
npm whoami
npm view @vinsonw2/asset-compound name version
pnpm install --frozen-lockfile
npm run check
npm run smoke
npm run smoke:packed
npm audit --prod
npm pack --dry-run
```

`prepack` 会自动执行 `npm run check`。确认 tarball 含 `dist`、schemas、templates、prompts、protocol 和可选 adapter 后，由有权限的用户执行：

```bash
npm publish
```

本 PR 不执行真实发布，也不需要 npm token。建议在受保护 CI 中使用 npm trusted publishing；需要 provenance 时由支持的 CI 执行 `npm publish --provenance`。不在 `publishConfig` 中强制 provenance，以免本地凭证发布在不支持的环境中失败。

`package.json.name` 固定为 `@vinsonw2/asset-compound`，`publishConfig.access` 为 `public`，registry 为 `https://registry.npmjs.org/`。bin 仍为 `asset-compound`。
