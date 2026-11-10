# @vinsonw2/asset-compound

编辑器无关的 Node.js 20+ / TypeScript 工具：将真实项目材料逐片分析，按标准
`docs/` 分类目录沉淀为可增量、可追溯、可验收的资产。

当前外层源码版本为 `0.1.3`（发布候选，先通过 PR 评审，不在本次工作中发布）。
包内固定携带可离线安装、具备本次验收重构功能的 `0.1.2` payload。

## 最短路径：本地 tgz + 两步交付

在 React 项目根目录安装本地 tarball，不需要 `REPO` / `WORK` 环境变量，也不需要手写 `run.yaml`：

```bash
npm install --offline --no-save --package-lock=false /absolute/path/to/asset-compound-0.1.2.tgz
npx asset-compound start --yes
```

`start` 自动：

- 识别当前 Git 根目录和 `main` / `master` / `origin/HEAD` 基线；
- 在基线分支或 detached HEAD 上立即失败，避免完成分析后才发现无法独立回写；
- 发现常见 requirement 路径，默认组合为 `requirement + git` 两类真实来源；
- 将有效 `run.yaml`、session、manifest 和 shards 放入稳定且不污染工作树的 `.git/asset-compound/`；
- 默认每片一个资产，来源摘录总预算为 12000 字符；
- 生成 `.git/asset-compound/AI-TASK.md` 和 `retrospective.json`，作为“交给任意
  AI 编辑器执行”的小上下文入口。

让任意 AI 编辑器打开 `AI-TASK.md`，逐个处理 pending shard。每片完成后：

```bash
npx asset-compound validate --input .git/asset-compound/work/shards/0001.json
```

中断后重新执行 `npx asset-compound start --yes` 即可恢复，只返回未完成片。全部完成后运行第二条交付命令：

```bash
npx asset-compound deliver --yes
```

`deliver` 自动聚合所有分片，核对全量来源一一对应、重复、顺序、provenance 和
逐维 evidence 与本片来源的具体关联，执行第二次运行零差异验证，再生成标准
`docs/` 分类目录和完整 2.2
报告。任何结构、内容、证据、复盘或防重复门禁失败都会返回非零退出码，不会生成
“看似成功”的验收结论。

`deliver` 必须显式传入 `--yes`；该确认不是装饰性参数。

> CLI 自身不含模型 API。没有外部 provider 时，语义分析必须由 AI 编辑器或人工完成；`start` 只准备确定性任务队列，不能宣称纯 CLI 自动完成分析。

## 强制交付契约

`deliver --yes` 成功必须同时满足 1.1、2.1、2.2、R1–R6 和 V1–V8：

```text
docs/
├── README.md
├── 00-项目总览/
├── 01-业务资产/
├── 02-技术架构/
├── 03-接口资产/
├── 04-数据资产/
├── 05-代码图谱/
├── 06-开发规范/
└── 07-AI资产/
    └── 资产复利/
        ├── 资产复利实践报告.md
        ├── 提取源清单.md
        ├── 回写记录.md
        ├── 冲突报告.md
        ├── state.json
        └── 验证证据/
```

`docs/README.md` 是分类导航。2.1 五类材料必须全部存在：完整 2.2 报告、至少两种
真实数据源的提取源清单、逐资产四维分析、回写结果、R1–R6/V1–V8 验证证据。

2.2 报告必须完整包含：基本信息、R1–R6 环节对照、提取源清单、四维分析、回写
记录、防重复验证和复盘。AI 或实践人必须按真实情况填写
`.git/asset-compound/retrospective.json`；空值、占位文本或推断值会使交付失败。

## 已发布包用法

发布后使用 scoped 包名：

```bash
npx @vinsonw2/asset-compound start --yes
npx @vinsonw2/asset-compound deliver --yes
```

bin 仍为 `asset-compound`。Node.js 要求 `>=20`。

## 自动发现与最小选择

默认依次发现：

```text
docs/requirements/**/*.md
docs/product/**/*.md
requirements/**/*.md
specs/**/*.md
```

- 只找到一组时直接使用。
- 找到多组且没有 `--yes` 时，只提示一个最小选择：使用 `--yes` 全部采用，或传 `--requirements <glob...>`。
- 没找到时，提示：

```bash
npx asset-compound start --requirements "path/to/requirements/**/*.md" --yes
```

高级用户可覆盖：

```bash
npx asset-compound start \
  --config /absolute/path/to/run.yaml \
  --workspace /absolute/path/to/stable-workspace \
  --max-chars 6000 \
  --max-items 2 \
  --yes
```

自动生成或高级覆盖后的有效配置会写入：

- workspace：`.git/asset-compound/run.yaml`
- 底层机器证据：`docs/可读化/evidence/effective-config.yaml`
- 底层来源 manifest：`docs/可读化/source-manifest.yaml`
- 标准验收入口：`docs/07-AI资产/资产复利/资产复利实践报告.md`

## 小上下文分片契约

默认 `prepare` 输出：

```text
work/
├── manifest.json
└── shards/
    ├── 0001.json
    ├── 0002.json
    └── ...
```

每片只包含：

- 不可变 `provenance`；
- 受 `maxChars` 限制的来源摘录；
- 待增强的结构化 `asset`。

不会把全量扫描内容放入 manifest。超长单资产采用确定性的首尾摘录策略，设置 `truncated: true`、`strategy: "head-tail"`，原始字符数保留在元数据中；最终仍以 `contentHash/sourceRevision` 对当前来源重新核验。

预算：

```bash
npx asset-compound prepare \
  --repo /path/to/repo \
  --config /path/to/run.yaml \
  --output /path/to/work \
  --max-chars 4000 \
  --max-items 1
```

断点续跑：

```bash
npx asset-compound prepare \
  --repo /path/to/repo \
  --config /path/to/run.yaml \
  --output /path/to/work \
  --resume
```

完成标记写入 `manifest.json`。只有成功通过 schema、敏感信息和实质质量门禁的 shard 才会变成 `completed`；单片失败不会推进该片。验证后修改 completed shard 会使 `resume/finalize` 拒绝继续。

## 实质质量门禁

每条资产四个维度都必须有具体的：

- `evidence`
- `gaps`
- `recommendations`

空数组、空白短语、prepare 默认占位结论、过短摘要，以及“ready/high 但只有来源路径而无实质证据”的结果都会被拒绝。schema 合法不等于语义质量合格。

## Editor-assisted 与 provider 自动模式

推荐默认：

```bash
npx asset-compound start --yes
# 任意 AI 编辑器按 AI-TASK.md 逐片循环
npx asset-compound deliver --yes
```

可选 provider 模式：

```bash
MODEL_PROVIDER_TOKEN="<只在当前进程环境或 secret store 中设置>" \
  npx asset-compound start --yes --provider /absolute/path/to/provider-adapter
npx asset-compound deliver --yes
```

provider adapter 是用户显式提供的可执行文件。CLI 对每片调用：

```text
provider-adapter <shard-path> <task-path>
```

adapter 必须原地更新 shard。包本身不捆绑模型供应商，不读取或保存 provider 凭证；凭证不得写进 `run.yaml`、workspace、仓库或命令参数。

## 可选 Cursor Skill

```bash
npx @vinsonw2/asset-compound install-skill --editor cursor
```

Skill 指向同一 `start → 逐片循环 → deliver` 工作流。其他编辑器直接读取 `AI-TASK.md` 和通用 protocol；本项目不宣称存在跨编辑器统一 Skill 标准。

## 旧命令兼容与迁移

`plan/scan/prepare/validate/render/finalize/verify/run` 保留。

旧版单文件输出：

```bash
npx asset-compound prepare \
  --repo /path/to/repo \
  --config /path/to/run.yaml \
  --legacy-stdout > prepared.json
```

旧版 `--assets enriched.json` 输入继续兼容，并在结果中返回迁移提示。新流程建议使用目录：

```bash
npx asset-compound finalize \
  --repo /path/to/repo \
  --config /path/to/run.yaml \
  --assets /path/to/work
```

`finalize/render/run` 不再接受未完成的默认基线，必须提供通过质量门禁的 shard 目录或旧版 JSON。

## 安全边界

- 至少两种真实非空来源；自动模式默认 `requirement + git`。
- 只写目标仓库的受管标准 `docs/` 分类目录和底层 `docs/可读化/**` 机器状态；
  workspace 位于 `.git/asset-compound/`。
- 拒绝 provenance 篡改、重复/缺失资产、路径逃逸、输出符号链接和人工编辑静默覆盖。
- fixture 只验证工具，不得作为真实验收数据；存在根级
  `NOT-ACCEPTANCE-DATA.md` 标记时正式工作流直接失败。
- CLI 不创建业务分支、不 commit、不 push、不创建 PR。
- scan 原文和模型凭证不得进入仓库、日志或配置。

## npm 包内容

外层 `0.1.3` tarball 包含 `dist/`、类型声明、`schemas/`、`templates/`、
`prompts/`、`protocol/`、可选 Cursor Skill 和 `artifacts/`。`artifacts/` 中只
包含一份 `asset-compound-0.1.2.tgz`；该 payload bundle 了全部生产依赖，可在
空 npm cache、无 registry 网络的干净目录中安装。

ESM：

```js
import {
  startWorkflow,
  deliverWorkflow,
  prepareShards,
  loadShardedDirectory,
} from "@vinsonw2/asset-compound";
```

内层 payload 从 `0.1.2` 干净 packlist 生成，不包含 `artifacts/`。外层 pack
始终写到仓库外的临时目录，因此不会把 `0.1.3` 递归打入自身。内层文件的
SHA-256 记录在 `artifacts/SHA256SUMS`，中文离线步骤见
`artifacts/README.zh-CN.md`。

## 开发与发布检查

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run smoke
pnpm run smoke:packed
pnpm audit --prod
npm pack --dry-run
```

`smoke:packed` 从全新 React 风格 fixture 在项目根目录本地安装 packed tgz，不使用手写 YAML 或 REPO/WORK 环境变量，执行 `start --yes`、模拟 AI 逐片输出、resume 和 `deliver --yes`，并验证二次 zero diff。

本 PR 不执行发布。评审通过后由有 `@vinsonw2` scope 权限的账号执行：

```bash
npm publish --access public --registry=https://registry.npmjs.org/
```
