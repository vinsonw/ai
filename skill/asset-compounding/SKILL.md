---
name: asset-compounding
description: 在当前 Git 项目启动小上下文资产复利队列，逐片分析并交付标准 docs 分类目录和完整验收报告。
---

# 资产复利：小上下文逐片工作流

这是 `@vinsonw2/asset-compound` 的可选 Cursor 适配器。核心协议不依赖 Cursor。

## 单次触发目标

当用户要求执行资产复利时：

1. 在项目根目录运行 `npx @vinsonw2/asset-compound start --yes`。
2. 只读取返回的 `task`、manifest 和第一条 pending shard；不得猜测目录。
3. 每次只打开一个 shard，事实仅取自该片 `sourceExcerpt.text/provenance`。
4. 禁止修改 provenance、sourceExcerpt 元数据、稳定 ID/hash/revision、项数和顺序。
5. 每片保存后立即运行 `npx @vinsonw2/asset-compound validate --input <shard>`。
6. 单片失败只修复该片；中断后再次运行 `start --yes`，跳过 completed 片。
7. 按真实实践填写返回的 `retrospective` 文件；禁止空值、占位文本或推断内容。
8. 所有片完成后运行 `npx @vinsonw2/asset-compound deliver --yes`。
9. 保存 delivery 和 `secondRunZeroDiff` 证据；仅提交受管的标准 `docs/**`。

唯一输出是原地覆盖当前 shard 的纯 JSON，且只能修改 `items[].asset` 的语义字段。
不得改源码、原始 docs、配置、manifest 或其他 shard；不要把全部 shard 同时加载
到上下文。不要为了“完整”而读取被截断来源的全量正文；缺失信息写入 gaps。

Git 片必须先读 diff：先看 `GIT_FILE/GIT_STATUS` 和 `PATCH_BEGIN…PATCH_END`，逐个按
`@@ ... @@` hunk 提炼；提交消息不能替代代码证据。evidence 必须包含
`文件路径@commit + @@ hunk 定位`。patch 截断时写入 gaps，禁止打开全仓或完整大文件
补齐，也不得推断 diff 未显示的调用方或运行结果。
Git 来源默认仅最近 20 次提交（`maxCommits=20`），不是全历史；不得暗示已覆盖全部提交。

处理 shard 时只提炼业务/架构/接口/数据/可复用代码模式；忽略事务性提交及
eslint、webpack、babel、tsconfig、prettier、lockfile、纯依赖升级、CI/format-only、
editorconfig 等产物。`skippedGitCommits` 只是 R1/R6 跳过证据，不是资产；禁止补造。
确需纳入时以 `--include-transactional-commits` 新建 workspace 重跑。

## 零/低配置规则

- 自动识别当前 Git 根目录和基线分支。
- 自动发现常见 requirement 路径，默认与 git 组成两类来源。
- 默认至多 10 片并自动平衡资产；任一资产或证据无法在预算内完整容纳时会失败，
  必须按错误提示调整 `--max-shards/--max-chars/--max-items`，不得静默删减。
- 找到多个需求目录时，若用户允许全部使用，传 `--yes`；否则只询问一个最小选择并用 `--requirements <glob>`。
- 稳定 workspace 默认在 `.git/asset-compound/`，不能移动到应用源码目录。
- `run.yaml` 只作为高级覆盖；正常流程不要求用户编写。

## 实质分析门禁

每条资产的完整性、可执行性、一致性、复用价值都必须有：

- 具体 evidence；
- 明确 gaps；
- 可行动 recommendations。

`summary` 至少 20 字符；四维三类数组均至少一项、每项至少 4 字符。前三维 level
仅用 `ready/partial/missing/conflict`，复用价值仅用 `high/medium/low`。evidence
必须引用或紧密复述当前摘录的具体事实。禁止空数组、默认占位、泛化套话、编造事实，
或只有来源路径却标记为 ready/high。

validate exit 0 才能标记该片完成。失败时只按 stderr 修当前片并重试；不得跳过或
手改 manifest。证据不足、敏感信息或不可变字段异常时停止并报告，不能伪造通过。

## Provider 边界

默认是 editor-assisted，不得宣称纯 CLI 自动完成语义分析。

只有用户明确提供 `--provider <executable>` 时才可使用 provider 自动模式。provider 凭证只能来自进程环境或系统 secret store；禁止写入命令参数、配置、workspace、shard、日志或仓库。

## 安全与验收

- 至少两类真实非空来源；fixture 不能作为验收数据。
- CLI 只写标准 `docs/README.md`、`00-项目总览` 至 `07-AI资产` 分类目录以及
  `docs/可读化/**` 底层机器状态，并拒绝独立分支之外的交付。
- completed shard 的 hash 变化、provenance 篡改、重复或缺失资产都会阻止 finalize。
- 自动有效配置写入 `evidence/effective-config.yaml`，来源写入 `source-manifest.yaml`。
- 人工编辑受管输出时禁止静默覆盖，必须生成冲突报告。
- 最终必须同时满足 1.1 标准 docs、2.1 五类材料、2.2 完整报告、R1–R6 /
  V1–V8 和二次 zero diff；任一门禁失败必须停止，不能宣称验收成功。

## 旧流程

旧 `plan/scan/prepare/validate/finalize/verify/run` 和单 JSON 数组输入仍兼容。仅在维护旧自动化时使用 `prepare --legacy-stdout`；新任务优先 `start/deliver`。
