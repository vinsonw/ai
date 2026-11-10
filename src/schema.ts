import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import type { AssetRecord, ReadState, RunConfig } from "./types.js";

const dimension = {
  type: "object",
  additionalProperties: false,
  required: ["level", "evidence", "gaps", "recommendations"],
  properties: {
    level: {
      enum: ["ready", "partial", "missing", "conflict", "high", "medium", "low"],
    },
    evidence: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
  },
} as const;

export const assetSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "assetId",
    "sourceType",
    "sourceRef",
    "sourceRevision",
    "contentHash",
    "title",
    "summary",
    "facts",
    "decisions",
    "actions",
    "relations",
    "analysis",
    "writebackKind",
  ],
  properties: {
    assetId: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    sourceType: { enum: ["requirement", "design", "ai-artifact", "git"] },
    sourceRef: { type: "string", minLength: 1 },
    sourceRevision: { type: "string", minLength: 1 },
    contentHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    title: { type: "string", minLength: 1 },
    summary: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    actions: { type: "array", items: { type: "string" } },
    relations: { type: "array", items: { type: "string" } },
    analysis: {
      type: "object",
      additionalProperties: false,
      required: ["completeness", "executability", "consistency", "reuseValue"],
      properties: {
        completeness: dimension,
        executability: dimension,
        consistency: dimension,
        reuseValue: dimension,
      },
    },
    writebackKind: { enum: ["新增", "增量", "未变"] },
  },
} as const;

const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outputRoot", "sourceSets"],
  properties: {
    outputRoot: { const: "docs/可读化" },
    baseBranch: { type: "string", minLength: 1 },
    sourceSets: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { enum: ["requirement", "design", "ai-artifact", "git"] },
          include: { type: "array", items: { type: "string" } },
          maxCommits: { type: "integer", minimum: 1, maximum: 1000 },
        },
      },
    },
    exclude: { type: "array", items: { type: "string" } },
  },
} as const;

const stateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "selfHash",
    "baseBranch",
    "baseCommit",
    "lastReadCommit",
    "sources",
    "assets",
    "managedFiles",
  ],
  properties: {
    schemaVersion: { const: 1 },
    selfHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    baseBranch: { type: "string" },
    baseCommit: { type: "string" },
    lastReadCommit: { type: "string" },
    sources: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["contentHash", "sourceRevision", "assetIds", "status"],
        properties: {
          contentHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
          sourceRevision: { type: "string", minLength: 1 },
          assetIds: {
            type: "array",
            items: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
          },
          status: { enum: ["active", "stale"] },
        },
      },
    },
    assets: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["canonicalContentHash", "outputPath", "lastGeneratedHash"],
        properties: {
          canonicalContentHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
          outputPath: {
            type: "string",
            pattern: "^(?!.*(?:^|/)\\.\\.(?:/|$))docs/可读化/.+$",
          },
          lastGeneratedHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        },
      },
    },
    managedFiles: {
      type: "object",
      propertyNames: {
        pattern: "^(?!.*(?:^|/)\\.\\.(?:/|$))docs/可读化/.+$",
      },
      additionalProperties: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    },
  },
} as const;

const ajv = new Ajv2020({ strict: true, allErrors: true });
(formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020)(ajv);

function compile<T>(schema: object): ValidateFunction<T> {
  return ajv.compile<T>(schema);
}

export const validateAsset = compile<AssetRecord>(assetSchema);
export const validateConfig = compile<RunConfig>(configSchema);
export const validateState = compile<ReadState>(stateSchema);

export function assertValid<T>(
  validator: ValidateFunction<T>,
  value: unknown,
  label: string,
): asserts value is T {
  if (!validator(value)) {
    const details = (validator.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .sort()
      .join("; ");
    throw new Error(`${label} 未通过 schema 校验：${details}`);
  }
}
