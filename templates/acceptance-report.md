# 资产复利中间运行报告（非 2.2 验收报告）

> 本文件只记录底层管线结果，不能作为验收成功证明。只有
> `asset-compound deliver --yes` 全部硬门禁通过后生成的
> `docs/07-AI资产/资产复利/资产复利实践报告.md` 才是完整 2.2 报告。
> 本模板及其生成结果均由 CLI 管理；AI 不得手工填充占位符、改写 R/V 状态或把
> 中间报告包装成成功结论。

- 运行 ID：`{{run_id}}`
- 分支：`{{branch}}`
- 基线提交 / 当前提交：`{{base_sha}}` / `{{head_sha}}`
- 来源：{{source_type_summary}}
- 统计：新增 {{new_count}}，增量 {{updated_count}}，未变 {{unchanged_count}}，冲突 {{conflict_count}}

## R1–R6

{{requirements_matrix}}

## V1–V8

{{verification_matrix}}

## 四维结论摘要

{{four_dimension_summary}}

## 冲突与证据

{{conflict_and_evidence_links}}
