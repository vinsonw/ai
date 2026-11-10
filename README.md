# 资产复利 Cursor Skill + CLI

可安装的 Cursor Skill 与 Node.js 20+ / TypeScript CLI，用于把真实项目材料沉淀为 `docs/可读化/` 下可增量、可追溯、可验收的资产。

## 能力与边界

- 强制至少两种不同、真实、非空的来源类型。
- 支持需求、设计、AI 产物等文件来源，以及 Git 历史。
- 生成稳定 SHA-256 ID、来源 revision、四维分析、增量 state、冲突报告和验收报告。
- 拒绝写入 `docs/可读化/**` 之外的路径，拒绝跟随输出目录中的符号链接。
- 检测人工编辑并生成冲突报告，不静默覆盖。
- 相同输入第二次运行不改业务产物，并输出 `secondRunZeroDiff: true` 证据。

内置分析是确定性基线。Cursor Agent 可使用 Skill 补充业务判断，但补充后的 JSON 必须通过随包提供的 schema。

## 安装

使用 pnpm：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm link --global

mkdir -p ~/.cursor/skills
cp -R skill/asset-compounding ~/.cursor/skills/asset-compounding
```

使用 npm：

```bash
npm install
npm run check
npm link
```

## 配置

在目标仓库之外，或目标仓库已有且受控的运维位置创建运行配置：

```yaml
outputRoot: docs/可读化
baseBranch: main
sourceSets:
  - type: requirement
    include:
      - docs/requirements/**/*.md
  - type: design
    include:
      - docs/design/**/*.md
  - type: git
    maxCommits: 20
exclude:
  - node_modules/**
  - dist/**
```

至少两种配置类型必须解析到真实、非空且有业务意义的内容。Git 历史可作为来源，但只有初始化提交时，不得把它包装成业务验收数据。

## 命令

```bash
asset-compound plan --repo /path/to/project --config /path/to/run.yaml
asset-compound scan --repo /path/to/project --config /path/to/run.yaml
asset-compound prepare --repo /path/to/project --config /path/to/run.yaml > prepared.json
asset-compound validate --input enriched.json
asset-compound render --repo /path/to/project --config /path/to/run.yaml --assets enriched.json
asset-compound verify --repo /path/to/project --config /path/to/run.yaml
asset-compound finalize --repo /path/to/project --config /path/to/run.yaml
```

`render`、`finalize` 和 `run` 执行完整确定性链路。`plan`、`scan`、`prepare` 和 `verify` 为只读检查阶段；`verify --config` 输出 V6 所需的 `secondRunZeroDiff` 证据，不修改报告或工作树。所有命令在 stdout 输出稳定 JSON，失败时返回非零退出码，因此中文帮助和错误信息不会影响自动化。

## 稳定字段中英映射

命令名、代码标识符和 JSON/schema 字段保留英文：

| 稳定字段/枚举 | 中文展示 |
|---|---|
| `requirement` / `design` / `ai-artifact` / `git` | 需求 / 设计 / AI 产物 / Git 历史 |
| `completeness` / `executability` | 完整性 / 可执行性 |
| `consistency` / `reuseValue` | 一致性 / 复用价值 |
| `ready` / `partial` / `missing` / `conflict` | 就绪 / 部分满足 / 缺失 / 冲突 |
| `high` / `medium` / `low` | 高 / 中 / 低 |
| `new` / `updated` / `unchanged` / `conflicts` | 新增 / 增量 / 未变 / 冲突 |
| `secondRunZeroDiff` | 第二次运行业务产物零差异 |

## 验收流程

1. 在独立分支运行 `plan`，确认至少两类真实非空来源。
2. 用 `scan` 和 `prepare` 检查来源、revision、稳定 ID 与四维基线。
3. 如需业务增强，修改导出的 JSON，运行 `validate` 后再传给 `render --assets`。
4. 检查 `docs/可读化/` 下的索引、资产页、冲突报告、state 与验收报告。
5. 使用相同输入运行 `verify --config` 和第二次 `finalize`；要求 `new=0`、`updated=0`、`secondRunZeroDiff=true`，且工作树业务产物零 diff。
6. 运行项目检查并提交到独立分支，通过 PR 评审回写。

`tests/fixtures/` 下的内容全部是合成测试数据，只用于验证工具行为，严禁作为 V1/V2 的真实验收证据。

## 开发与验证

```bash
pnpm run typecheck
pnpm run test
pnpm run build
node dist/cli.js --help
pnpm run smoke
pnpm audit --prod
```

## 输出

CLI 只写入：

```text
docs/可读化/
├── README.md
├── index.md
├── source-manifest.yaml
├── assets/
├── conflicts/
├── evidence/acceptance-report.md
├── runs/
└── state/
```

必须在目标仓库独立分支运行。CLI 负责验证写入范围，但不会自动创建分支、提交、推送或 PR。
