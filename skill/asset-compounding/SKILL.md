---
name: asset-compounding
description: 在当前 Git 项目启动小上下文资产复利队列，逐片分析并交付标准 docs 分类目录和完整验收报告。
---

# 资产复利：小上下文逐片工作流

这是 `@vinsonw2/asset-compound` 的可选 Cursor 适配器。核心协议不依赖 Cursor。

## 单次触发目标

当用户要求执行资产复利时：

1. 在项目根目录运行 `npx @vinsonw2/asset-compound start --yes`。
2. 读取返回的 `task` 和 `pendingShards`。
3. 每次只打开一个 shard，按 prompt 增强 `items[].asset`。
4. 禁止修改 provenance、sourceExcerpt 元数据、稳定 ID/hash/revision、项数和顺序。
5. 每片保存后立即运行 `npx @vinsonw2/asset-compound validate --input <shard>`。
6. 单片失败只修复该片；中断后再次运行 `start --yes`，跳过 completed 片。
7. 按真实实践填写返回的 `retrospective` 文件；禁止空值、占位文本或推断内容。
8. 所有片完成后运行 `npx @vinsonw2/asset-compound deliver --yes`。
9. 保存 delivery 和 `secondRunZeroDiff` 证据；仅提交受管的标准 `docs/**`。

不要把全部 shard 同时加载到上下文。不要为了“完整”而读取被截断来源的全量正文；缺失信息写入 gaps。

## 零/低配置规则

- 自动识别当前 Git 根目录和基线分支。
- 自动发现常见 requirement 路径，默认与 git 组成两类来源。
- 找到多个需求目录时，若用户允许全部使用，传 `--yes`；否则只询问一个最小选择并用 `--requirements <glob>`。
- 稳定 workspace 默认在 `.git/asset-compound/`，不能移动到应用源码目录。
- `run.yaml` 只作为高级覆盖；正常流程不要求用户编写。

## 实质分析门禁

每条资产的完整性、可执行性、一致性、复用价值都必须有：

- 具体 evidence；
- 明确 gaps；
- 可行动 recommendations。

禁止空数组、空白短语、默认占位结论、编造事实，或只有来源路径却标记为 ready/high。

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
