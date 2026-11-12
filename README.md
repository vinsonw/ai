# @vinsonw2/asset-compound

编辑器无关的 Node.js 20+ / TypeScript 工具：将真实项目材料逐片分析，按标准
`docs/` 分类目录沉淀为可增量、可追溯、可验收的资产。

npm 公开版本 `0.1.19`；包内固定携带可离线安装的 `0.1.19` payload 与
`asset-compound-0.1.19-source.zip` 源码备份（单一 Windows
兼容 bundle：`assertOutputPath`、`verifyGitScope`、`safeTarget` 与 workflow session
仓库路径在 POSIX 前缀比较前统一分隔符；deliver 仅聚合写盘（QA 仅在 validate）；不再 rehydrate / verifySecondRun / 复盘或
实质重检；CLI finalize 仍可用 `freezeSources=manifest` 重验来源）。

## 最短路径：本地 tgz + 两步交付

在 React 项目根目录安装本地 tarball，不需要 `REPO` / `WORK` 环境变量，也不需要手写 `run.yaml`：

```bash
npm install --offline --no-save --package-lock=false /absolute/path/to/asset-compound-0.1.19.tgz
npx asset-compound start --yes
```

`start` 自动：

- 识别当前 Git 根目录和 `main` / `master` / `origin/HEAD` 基线；
- 在基线分支或 detached HEAD 上立即失败，避免完成分析后才发现无法独立回写；
- 发现常见 requirement 路径，默认组合为 `requirement + git` 两类真实来源；
- 将有效 `run.yaml`、session、manifest 和 shards 放入稳定且不污染工作树的 `.git/asset-compound/`；
- 默认总数至多 10 片，按来源摘录字符预算自动、确定性地平衡资产；
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

bin 仍为 `asset-compound`。Node.js 要求 `>=20`，Git 要求 `>=2.20.1`。

## 自动发现与最小选择

默认依次发现：

```text
docs/requirements/**/*.md
docs/product/**/*.md
requirements/**/*.md
specs/**/*.md
spec/**/*.md
```

- 只找到一组时直接使用。
- 找到多组且没有 `--yes` 时，提示使用 `--yes`（默认只纳入 1 份 requirement）或传 `--requirements <glob...>`。
- `--yes` 时默认只取 1 份 requirement（优先级 `spec/refactor.md` > `docs/requirements/**` 最新 > 其它），其余记入 manifest。
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
  --max-shards 10 \
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

不会把全量扫描内容放入 manifest。Git 来源默认最近 **10 次有效提交**（`maxCommits=10`，
跳过的事务提交不占名额；可用 `start --max-commits` 或 `run.yaml` 覆盖）。事务过滤在
`start` 阶段完成（提交信息 + 变更路径），AI 任务不再要求自行跳过 chore/依赖/eslint。
按 commit 的变更文件拆分；每条包含
commit、path、status、文件级 patch/hunk，以及按 hunk 行号截取的少量变更后源码
语境，不会把全仓、完整大文件或“全历史”暗示交给模型。超长 patch 先按安全上限截断并保留明确标记，
分片再按完整行、保留 hunk 定位执行确定性首尾摘录，设置 `truncated: true`、
`strategy: "head-tail"`；最终仍以 `contentHash/sourceRevision` 对当前来源重新核验。

处理 Git 片时必须先读 diff，按 `GIT_FILE/GIT_STATUS` 和逐个 `@@ ... @@` hunk
提炼；提交消息不能替代代码证据。evidence 应引用 `文件路径@commit + @@ hunk 定位`；
遇到截断必须写 gap，不能自行打开全仓或完整大文件补齐。

预算（默认 `maxShards=10`、`maxChars=6000`、`maxItems=2`）：

```bash
npx asset-compound prepare \
  --repo /path/to/repo \
  --config /path/to/run.yaml \
  --output /path/to/work \
  --max-chars 4000 \
  --max-items 2 \
  --max-shards 10
```

分组保持全量资产顺序，并在预算内平衡每片大小。若总片数上限、单片字符上限或显式
单片资产上限无法无损容纳所有资产，命令会 fail-closed，不会丢弃资产/证据；按错误
提示调整 `--max-shards`、`--max-chars` 或 `--max-items` 后在新 workspace 重试。

默认在 CLI 阶段保守排除 chore/build/ci 提交信息、仅事务路径变更、依赖锁文件、
eslint/webpack/babel/tsconfig/prettier/editorconfig、CI/workflow 等；跳过项记入
`skippedGitCommits`（不占有效 commit 名额）。每有效 commit 最多 **5** 个业务文件，
超出记入 `skippedFilesWithinCommit`。`manifest.json` 含 `gitScanPolicy` 与未纳入的
requirement 清单。混有业务代码的提交不会被排除。确需把事务提交作为资产时使用
`start --include-transactional-commits --yes` 新建 workspace。

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

## 本地构建

要求 **Node.js 20+**、**Yarn Classic 1.x**（`yarn -v` 应为 1.22.x）、Git。

```bash
yarn install --frozen-lockfile
yarn run typecheck
yarn test
yarn build
yarn smoke
yarn smoke:packed
yarn artifacts
```

`yarn artifacts` 在 `artifacts/` 生成内层 `asset-compound-<version>.tgz`、源码
`asset-compound-<version>-source.zip` 并刷新 `SHA256SUMS`。发布前须先
`yarn run check` 再执行 `yarn artifacts`。

## 本地发布后本地使用

### 方式 A：内层离线 tgz（推荐，无 registry）

从已发布的**外层**包取出内层 payload，或直接使用仓库 `artifacts/`：

```bash
npm pack @vinsonw2/asset-compound@0.1.19
tar -xzf vinsonw2-asset-compound-0.1.19.tgz
cd package/artifacts && sha256sum -c SHA256SUMS
npm install --offline --no-save --package-lock=false ./asset-compound-0.1.19.tgz
```

在目标 React 仓库根目录：

```bash
npx asset-compound start --yes
npx asset-compound deliver --yes
```

### 方式 B：yarn link / path 指向源码构建

内网从 `asset-compound-0.1.19-source.zip` 解压后：

```bash
unzip asset-compound-0.1.19-source.zip -d asset-compound-src
cd asset-compound-src
yarn install --frozen-lockfile && yarn build
yarn link
```

在目标项目：

```bash
yarn link @vinsonw2/asset-compound
npx asset-compound start --yes
```

或使用 `file:` 依赖（不污染全局 link）：

```bash
npm install --no-save file:/absolute/path/to/asset-compound-src
```

> 生产验收仍建议以内层 tgz 的 `npm install --offline` 为准；link/path 仅用于联调。

## npm 外层 artifacts 结构

`npm pack @vinsonw2/asset-compound@0.1.19` 的外层 tarball 在
`package/artifacts/` 固定携带三类文件：

```text
package/artifacts/
├── asset-compound-0.1.19.tgz          # 内层 CLI，bundledDependencies，可离线安装
├── asset-compound-0.1.19-source.zip     # 源码备份（无 node_modules / .git）
├── SHA256SUMS                           # 上述两文件的 SHA-256
└── README.zh-CN.md                      # 离线安装与解压说明
```

外层包主体仍含 `dist/`、`schemas/`、`templates/`、`prompts/`、`protocol/`、
Skill 与 adapters。内层 payload 从不包含 `artifacts/`，避免递归打进自身。

ESM：

```js
import {
  startWorkflow,
  deliverWorkflow,
  prepareShards,
  loadShardedDirectory,
} from "@vinsonw2/asset-compound";
```

## 发布检查

```bash
yarn install --frozen-lockfile
yarn run check
yarn smoke:packed
yarn artifacts
npm pack --dry-run
npm audit --production
```

`smoke:packed` 从全新 React 风格 fixture 本地安装 packed tgz，执行
`start --yes`、模拟 AI 逐片、`deliver --yes` 并验证 zero diff。

由有 `@vinsonw2` scope 权限的账号发布：

```bash
npm publish --access public --registry=https://registry.npmjs.org/
```
