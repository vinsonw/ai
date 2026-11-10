# 资产复利四维分析提示协议

你正在分析真实项目材料。输入文件是 `asset-compound prepare` 生成的 JSON 数组，输出必须仍是 JSON 数组，并通过随包提供的 `schemas/analysis-output.schema.json`。

## 不可修改字段

每条记录的以下字段是确定性来源契约，禁止修改：

- `assetId`
- `sourceType`
- `sourceRef`
- `sourceRevision`
- `contentHash`
- `writebackKind`

禁止增加、删除或复制数组元素。每个来源必须恰好对应一条资产。

## 可以增强的字段

- `title`
- `summary`
- `facts`
- `decisions`
- `actions`
- `relations`
- `analysis`

## 四维分析

对每条资产分别填写：

1. `analysis.completeness`：完整性。材料是否覆盖目标、范围、约束、边界、异常和验收条件。
2. `analysis.executability`：可执行性。是否有明确行动、负责人、前置条件、完成定义和验证办法。
3. `analysis.consistency`：一致性。与其他需求、设计、AI 产物和 Git 决策是否相容。
4. `analysis.reuseValue`：复用价值。是否可沉淀为检查表、模板、规则、ADR 或后续任务输入。

每个维度必须包含：

- `level`
- `evidence`
- `gaps`
- `recommendations`

`level` 的稳定枚举是：

- `ready`
- `partial`
- `missing`
- `conflict`
- `high`
- `medium`
- `low`

## 安全要求

- 不得写入密钥、令牌、邮箱或未经授权的私有标识。
- 不得编造来源中不存在的事实。
- 不确定内容必须放入 `gaps` 或 `recommendations`，不能伪装为已确认结论。
- 最终只输出 JSON，不添加 Markdown 代码围栏或解释文字。
