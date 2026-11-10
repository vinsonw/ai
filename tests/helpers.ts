import { writeFile } from "node:fs/promises";
import type { AssetRecord } from "../src/types.js";

export function enrichAssets(assets: AssetRecord[]): AssetRecord[] {
  return assets.map((asset) => ({
    ...asset,
    summary: `${asset.summary} 本结论已由测试模拟人工分析，并用于验证实质质量门禁。`,
    analysis: {
      completeness: {
        level: "partial",
        evidence: ["来源摘录明确描述了目标范围和至少一个可核验约束。"],
        gaps: ["异常边界仍需由材料负责人进行最终核对。"],
        recommendations: ["补充异常场景清单并关联可执行的验收用例。"],
      },
      executability: {
        level: "partial",
        evidence: ["来源摘录包含可执行动作及其预期业务结果。"],
        gaps: ["负责人和完成日期尚未在来源中统一确认。"],
        recommendations: ["为每项动作补充负责人、前置条件和完成定义。"],
      },
      consistency: {
        level: "partial",
        evidence: ["当前结论已按来源版本和内容指纹进行交叉定位。"],
        gaps: ["仍需与其他分片中的相关决策进行最终比对。"],
        recommendations: ["聚合后执行跨资产关系和冲突检查并记录结果。"],
      },
      reuseValue: {
        level: "medium",
        evidence: ["该材料包含可提炼为检查项的稳定业务规则。"],
        gaps: ["复用范围和不适用条件仍需在项目中明确。"],
        recommendations: ["将稳定规则沉淀为模板并记录适用边界。"],
      },
    },
  }));
}

export async function writeLegacyAssets(
  target: string,
  assets: AssetRecord[],
): Promise<void> {
  await writeFile(target, `${JSON.stringify(enrichAssets(assets), null, 2)}\n`, "utf8");
}
