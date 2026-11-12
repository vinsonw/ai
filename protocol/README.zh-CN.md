# 编辑器无关的小上下文资产复利协议

本协议不假设统一 AI Skill 标准。任何能读写文件的 AI 编辑器，都可以通过稳定 workspace 逐片参与。

## 推荐两步模式

在 React 项目根目录：

```bash
npx @vinsonw2/asset-compound start --yes
```

打开命令返回的 `.git/asset-compound/AI-TASK.md`，逐片处理 pending shard。每片保存后执行 `validate --input <shard>`。全部完成后：

```bash
npx @vinsonw2/asset-compound deliver --yes
```

不需要 REPO/WORK 环境变量，不需要手写 YAML。自动模式默认发现 requirement 并加入 git 来源；有效配置和来源清单会进入验收证据。

## 文件流

```text
.git/asset-compound/
├── AI-TASK.md
├── retrospective.json
├── run.yaml
├── session.json
└── work/
    ├── manifest.json
    └── shards/
        ├── 0001.json
        └── ...
```

- manifest 不含全量来源正文，只保存 provenance、稳定顺序、预算和完成状态。
- shard 只含必要来源摘录、不可变 provenance 和待增强 asset。
- AI 每轮只读 manifest 和第一条 pending shard；不得加载全量、猜目录或补读被截断全文。
- 唯一输出是原地覆盖当前 shard 的纯 JSON，只能修改 `items[].asset` 语义字段；
  禁止改源码、原始 docs、manifest、配置或其他 shard。
- `maxChars` 默认 **6000**，`maxItems` 默认 **2**，`maxShards=10`；按资产字符预算做
  确定性平衡聚合。预算不足时 fail-closed，提示调整 maxShards/maxChars/maxItems。
- Git 默认 **10 次有效提交**（跳过的事务提交不占名额）；事务过滤在 `start` 完成。
  按 commit 的非事务变更文件拆成资产；
  摘录包含结构化 `GIT_COMMIT/GIT_FILE/GIT_STATUS`、文件级 patch/hunk 和受控的变更后
  源码片段；不向模型灌入全仓、完整大文件，也不暗示已扫描全历史。
- 超长单资产采用确定性、按完整行且保留 Git hunk 定位的首尾摘录，不把完整
  2000+ 行材料塞入上下文。
- validate 成功后才原子更新完成标记和分片 hash。
- resume 只返回未完成片；完成片被修改后会拒绝继续。
- deliver 要求全量一一对应、无重复、顺序稳定、所有片已完成。
- retrospective 的四个字段必须来自真实实践，不允许空值、占位文本或推断。

## 实质质量

schema 通过只是第一层。每条资产还必须通过质量门禁：

- summary 至少 20 个字符；
- 四维各自的 evidence、gaps、recommendations 非空且具体；
- evidence 引用或紧密复述当前 sourceExcerpt；证据不足写入 gap，不得编造；
- 前三维 level 仅用 `ready/partial/missing/conflict`，复用价值仅用 `high/medium/low`；
- 不保留默认占位结论；
- `ready/high` 必须有来源路径之外的具体证据。

Git 片必须先读 diff，再逐个 `@@ ... @@` hunk 提炼。提交消息只能作意图线索；
evidence 必须包含 `文件路径@commit + @@ hunk 定位`。patch 截断时把未覆盖范围
写入 gaps，不得打开全仓或完整大文件补齐，也不得推断 diff 外事实。
依赖/锁文件、eslint/webpack/babel/tsconfig/prettier/editorconfig、CI/format-only、
纯依赖升级或纯格式化等事务性提交会保守排除；AI 只应提炼业务/架构/接口/数据/可复用
代码模式。manifest 和最终报告以 commit/tree/content hash、文件和原因保留
`skippedGitCommits` 证据。它们不是 AI 资产，模型不得补造；需要纳入时用
`--include-transactional-commits` 新建 workspace。

## Editor-assisted 与 provider

默认 `start` 是 editor-assisted：CLI 准备任务，但没有模型 API 时不会自动完成语义分析。

可选：

```bash
npx @vinsonw2/asset-compound start --yes --provider /path/to/provider-adapter
```

provider 对每片接收 `<shard-path> <task-path>`，原地更新后由 CLI 立即 validate。provider 和凭证由用户管理；凭证只能来自进程环境或系统 secret store，禁止写入配置、workspace、shard 或仓库。

## 旧流程

旧版 JSON 数组输入继续支持，并返回迁移提示。`prepare --legacy-stdout` 保留旧输出。新流程以分片目录作为 `--assets`。

## 验收边界

- 至少两种真实非空来源，默认 requirement + git。
- CLI 输出标准 `docs/README.md`、`00-项目总览` 至 `07-AI资产` 分类目录；
  底层机器 state 保留在 `docs/可读化/**`，workspace 位于 `.git`。
- 示例和 fixture 不能作为真实验收数据。
- `deliver` 只有在 1.1、2.1、2.2、R1–R6、V1–V8、结构/内容/证据门禁和
  `secondRunZeroDiff` 全部通过时才成功。

2.1 五类材料为：完整 2.2 报告、至少两种真实数据源的提取源清单、逐资产四维
分析、回写结果、验证证据。2.2 报告必须包含基本信息、R1–R6 环节对照、提取源
清单、四维分析、回写记录、防重复验证和复盘，不允许空字段。
