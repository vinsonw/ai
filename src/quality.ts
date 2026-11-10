import type { AssetRecord, DimensionFinding } from "./types.js";

const PLACEHOLDERS = [
  "需要人工确认范围、约束与验收边界",
  "由 Skill 基于业务上下文补全完整性分析",
  "行动项负责人和完成条件待确认",
  "未识别到明确行动项",
  "补充负责人、前置条件和可验证完成标准",
  "需要跨资产对照后确认一致性",
  "将相关需求、设计和历史决策进行交叉核验",
  "复用场景与适用边界待确认",
  "提炼可复制的决策、检查表或模板",
];

function substantive(items: string[]): boolean {
  return items.length > 0 && items.every((item) => item.trim().length >= 4);
}

function validateDimension(
  asset: AssetRecord,
  name: string,
  finding: DimensionFinding,
): string[] {
  const problems: string[] = [];
  if (!substantive(finding.evidence)) problems.push(`${name}.evidence 不能为空且每项至少 4 字符`);
  if (!substantive(finding.gaps)) problems.push(`${name}.gaps 不能为空且每项至少 4 字符`);
  if (!substantive(finding.recommendations)) {
    problems.push(`${name}.recommendations 不能为空且每项至少 4 字符`);
  }
  const text = [...finding.evidence, ...finding.gaps, ...finding.recommendations];
  if (text.some((item) => PLACEHOLDERS.includes(item.trim()))) {
    problems.push(`${name} 仍包含 prepare 默认占位结论`);
  }
  if (
    (finding.level === "ready" || finding.level === "high") &&
    finding.evidence.every((item) => item.includes(asset.sourceRef))
  ) {
    problems.push(`${name} 标记为高质量但只有来源定位，没有实质证据摘录`);
  }
  return problems;
}

export function assertSubstantiveAsset(asset: AssetRecord): void {
  const problems = [
    ...(asset.summary.trim().length >= 20 ? [] : ["summary 至少需要 20 个字符"]),
    ...validateDimension(asset, "completeness", asset.analysis.completeness),
    ...validateDimension(asset, "executability", asset.analysis.executability),
    ...validateDimension(asset, "consistency", asset.analysis.consistency),
    ...validateDimension(asset, "reuseValue", asset.analysis.reuseValue),
  ];
  if (problems.length > 0) {
    throw new Error(`资产 ${asset.assetId} 未通过实质质量门禁：${problems.join("；")}`);
  }
}
