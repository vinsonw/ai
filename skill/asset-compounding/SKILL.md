---
name: asset-compounding
description: 读取至少两类真实来源，提取可追溯资产，执行四维分析，并仅向 docs/可读化 增量回写。
---

# 资产复利

这是 `asset-compound` npm 包的**可选 Cursor 适配器**。核心 CLI、schema、templates、prompts 和通用 protocol 不依赖 Cursor。任意 AI 编辑器应使用 `npx asset-compound init` 生成的编辑器无关文件协议；本项目不假装存在跨编辑器统一 Skill 标准。

当 Cursor 中的真实项目需要把需求、设计、AI 产物和 Git 历史沉淀为可复用、可增量、可审计的文档资产时，使用此适配器。

## 前置条件

1. 确认目标仓库、基线分支和允许读取的来源 glob。
2. 至少提供两种不同类型、真实、非空且有业务意义的来源；fixture 和空 API 不能作为验收数据。
3. CLI 工具包必须放在目标仓库之外。
4. 任何写入前，必须从当前基线创建独立分支。

## 执行流程

1. 运行 `npx asset-compound plan --repo <仓库> --config <run.yaml>`。
2. 运行 `npx asset-compound scan`，检查每个来源路径和 revision。
3. 运行 `npx asset-compound prepare ... > prepared.json`。需要业务判断时补充严格 JSON；不得修改 ID、hash 和来源追踪字段。
4. 确保每条资产分别包含完整性、可执行性、一致性、复用价值四项结论，每项均有证据、缺口和建议。
5. 运行 `npx asset-compound validate --input enriched.json`。预览写入集合；只有全部路径都位于 `docs/可读化/**` 时，才运行 `npx asset-compound render ... --assets enriched.json`。
6. 运行 `npx asset-compound verify --repo <仓库> --config <run.yaml>`，保存其中的 `secondRunZeroDiff` JSON 作为 V6 证据。
7. 运行 `npx asset-compound finalize`，保存验收报告。
8. 在独立分支提交；禁止直接推送基线分支。
9. 使用完全相同的输入执行第二次运行，要求业务产物零 diff，且 `new=0 updated=0`。
10. 如需证明受控增量，只能使用一份已批准的真实来源变更，并证明仅对应资产发生增量。

## 安全规则

- 禁止修改应用源码、包清单、原始需求/设计/AI 材料，以及 `docs/可读化/**` 之外的路径。
- 当前文件 hash 与 state 不一致时，禁止静默覆盖；必须保留原文件并生成冲突报告。
- schema 校验失败或检测到越界写入后，禁止推进 state。
- 模型输出属于不可信输入，只有通过随包提供的 JSON Schema 后才能渲染。
- 增量身份必须使用来源内容 hash，禁止使用模型摘要。
- Markdown 和截图必须移除密钥、令牌、邮箱等隐私标识。

## 稳定契约中英映射

代码标识符、命令名和 JSON/schema 字段保持英文，以保障自动化兼容：

| 稳定字段 | 中文含义 |
|---|---|
| `sourceType` / `sourceRef` / `sourceRevision` | 来源类型 / 来源定位 / 来源版本 |
| `contentHash` / `assetId` | 内容指纹 / 稳定资产 ID |
| `analysis.completeness` | 完整性 |
| `analysis.executability` | 可执行性 |
| `analysis.consistency` | 一致性 |
| `analysis.reuseValue` | 复用价值 |
| `writebackKind` | 回写标记 |
| `new` / `updated` / `unchanged` / `conflicts` | 新增 / 增量 / 未变 / 冲突 |
| `secondRunZeroDiff` | 第二次运行业务产物零差异 |

## 必备证据

- 至少两类真实非空来源的来源清单。
- 结构化资产与完整的四维分析。
- 独立分支、提交记录和路径边界验证。
- state 前后版本、稳定 ID、hash 和 Git revision。
- 冲突报告；无冲突时也必须明确记录“0 个冲突”。
- 首次运行结果与无变化二次运行结果。
- 覆盖 R1–R6 和 V1–V8 的验收报告。
