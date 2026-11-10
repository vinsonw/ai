# 编辑器无关资产复利协议

本协议不假设存在统一的 AI 编辑器 Skill 标准。任何能够读取和编辑文件的 AI 工具，都可以按下列文件契约参与。

## 角色分工

- `asset-compound`：确定性扫描、hash、增量 state、schema 校验、安全回写。
- AI 编辑器：在禁止修改来源契约字段的前提下，补充语义资产和四维分析。
- 人工验收者：确认真实来源范围、结论质量、冲突、分支和证据。

## 文件流

1. 用户在目标仓库之外保存 `run.yaml`。
2. `asset-compound prepare ... > prepared.json` 生成 AI 输入。
3. AI 按 `asset-analysis.zh-CN.md` 将结果写为 `enriched.json`。
4. `asset-compound validate --input enriched.json` 做独立 schema 校验。
5. `asset-compound finalize ... --assets enriched.json` 再核对当前扫描的 provenance，并只写 `docs/可读化/**`。
6. `asset-compound verify --repo ... --config ...` 证明无变化二次运行。

## 初始化目录

`npx @vinsonw2/asset-compound init --output <目录>` 会生成：

```text
<目录>/
├── README.md
├── run.yaml
├── prompts/
│   └── asset-analysis.zh-CN.md
├── protocol/
│   └── README.zh-CN.md
└── schemas/
    ├── analysis-input.schema.json
    └── analysis-output.schema.json
```

该目录应位于目标仓库之外。若必须放入目标仓库，应先提交为受控配置；否则 CLI 的工作树边界检查会拒绝写入。

## 稳定契约

命令名、JSON 字段和枚举保持英文。中文提示只负责解释，不得改名。完整字段以 `schemas/*.json` 为准。

## 验收边界

- 至少两种不同、真实、非空的来源类型。
- 示例和 fixture 不能作为真实验收数据。
- AI 输出必须经过 `validate`。
- CLI 输出仅允许位于 `docs/可读化/**`。
- 二次运行必须输出 `secondRunZeroDiff: true`。
