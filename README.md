# Asset Compounding Skill + CLI

Installable Cursor Skill and Node.js 20+ / TypeScript CLI for turning real project materials into incremental, traceable assets under `docs/可读化/`.

## What it guarantees

- Requires at least two distinct, non-empty source types.
- Supports requirement, design, AI-artifact files and Git history.
- Produces stable SHA-256 IDs, source revisions, four-dimension analysis, incremental state, conflict reports, and an acceptance report.
- Refuses writes outside `docs/可读化/**` and refuses to follow output symlinks.
- Detects manual edits to generated assets instead of overwriting them.
- A second run with unchanged inputs performs zero business writes.

The built-in analysis is a deterministic baseline. A Cursor agent using the Skill can enrich it with domain judgment, but the enriched JSON must satisfy the shipped schemas.

## Install

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm link --global

mkdir -p ~/.cursor/skills
cp -R skill/asset-compounding ~/.cursor/skills/asset-compounding
```

For npm:

```bash
npm install
npm run check
npm link
```

## Configuration

Create a run file outside the target repository or in an already tracked operational location:

```yaml
outputRoot: docs/可读化
baseBranch: main
sourceSets:
  - type: requirement
    include:
      - docs/requirements/**/*.md
  - type: design
    include:
      - docs/design/**/*.md
  - type: git
    maxCommits: 20
exclude:
  - node_modules/**
  - dist/**
```

At least two configured types must resolve to real non-empty content. Git history is supported, but an initialization-only commit should not be presented as business acceptance evidence.

## Commands

```bash
asset-compound plan --repo /path/to/project --config /path/to/run.yaml
asset-compound scan --repo /path/to/project --config /path/to/run.yaml
asset-compound prepare --repo /path/to/project --config /path/to/run.yaml > prepared.json
asset-compound validate --input enriched.json
asset-compound render --repo /path/to/project --config /path/to/run.yaml --assets enriched.json
asset-compound verify --repo /path/to/project --config /path/to/run.yaml
asset-compound finalize --repo /path/to/project --config /path/to/run.yaml
```

`render`, `finalize`, and `run` execute the complete deterministic chain. `plan`, `scan`, `prepare`, and `verify` are read-only inspection stages; `verify --config` emits the V6 `secondRunZeroDiff` evidence without changing the report or worktree. All commands return JSON on stdout and non-zero on failure.

## Development

```bash
pnpm run typecheck
pnpm run test
pnpm run build
node dist/cli.js --help
```

Tests use synthetic fixtures only. Files under `tests/fixtures/` demonstrate behavior and must never be cited as real V1/V2 acceptance data.

## Output

The CLI writes only:

```text
docs/可读化/
├── README.md
├── index.md
├── source-manifest.yaml
├── assets/
├── conflicts/
├── evidence/acceptance-report.md
├── runs/
└── state/
```

Use a dedicated branch in the target repository. The CLI validates scope but intentionally does not create branches, commits, pushes, or pull requests.
