---
name: asset-compounding
description: Read at least two real source types, extract traceable assets, analyze four dimensions, and incrementally write only docs/可读化.
---

# Asset Compounding

Use this Skill when a real project needs reusable documentation assets with incremental state and auditable evidence.

## Preconditions

1. Confirm the target repository, base branch, and allowed source globs.
2. Require at least two distinct, non-empty, real business source types. Fixtures and empty APIs are not acceptance data.
3. Keep the CLI package outside the target repository.
4. Create a dedicated branch from the current base branch before any write.

## Workflow

1. Run `asset-compound plan --repo <repo> --config <run.yaml>`.
2. Run `asset-compound scan` and inspect every source path and revision.
3. Run `asset-compound prepare ... > prepared.json`. Enrich its strict JSON records where domain judgment is needed; preserve IDs, hashes, and provenance.
4. Ensure each asset has separate completeness, executability, consistency, and reuse-value findings with evidence, gaps, and recommendations.
5. Run `asset-compound validate --input enriched.json`. Preview the write set, then run `asset-compound render ... --assets enriched.json` only after it is confined to `docs/可读化/**`.
6. Run `asset-compound verify --repo <repo> --config <run.yaml>` and retain its `secondRunZeroDiff` JSON as V6 evidence.
7. Run `asset-compound finalize` and capture the acceptance report.
8. Commit on the dedicated branch. Never push directly to the base branch.
9. Run a second time with identical inputs. Require zero business diff and `new=0 updated=0`.
10. If requested, apply one approved real source change and prove only that asset is incremental.

## Safety rules

- Never modify application source, package manifests, original product/design/AI materials, or paths outside `docs/可读化/**`.
- Never silently overwrite a generated asset whose current hash differs from state. Preserve it and emit a conflict report.
- Never advance state after a failed validation or an out-of-bound write.
- Treat model output as untrusted until it passes the shipped JSON Schemas.
- Use source content hashes, not model summaries, for incremental identity.
- Redact secrets and private identifiers from Markdown and screenshots.

## Required evidence

- Source manifest with at least two real non-empty types.
- Structured assets and complete four-dimension analysis.
- Dedicated branch, commits, and path-scope verification.
- State before/after, stable IDs, hashes, and Git revisions.
- Conflict report, including an explicit zero-conflict report.
- First-run and no-change second-run results.
- Acceptance report mapping R1–R6 and V1–V8.
