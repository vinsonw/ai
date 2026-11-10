# 编辑器无关的小上下文资产复利协议

本协议不假设统一 AI Skill 标准。任何能读写文件的 AI 编辑器，都可以通过稳定 workspace 逐片参与。

## 推荐两步模式

在 React 项目根目录：

```bash
npx @vinsonw2/asset-compound start --yes
```

打开命令返回的 `.git/asset-compound/AI-TASK.md`，逐片处理 pending shard。每片保存后执行 `validate --input <shard>`。全部完成后：

```bash
npx @vinsonw2/asset-compound deliver --yes
```

不需要 REPO/WORK 环境变量，不需要手写 YAML。自动模式默认发现 requirement 并加入 git 来源；有效配置和来源清单会进入验收证据。

## 文件流

```text
.git/asset-compound/
├── AI-TASK.md
├── run.yaml
├── session.json
└── work/
    ├── manifest.json
    └── shards/
        ├── 0001.json
        └── ...
```

- manifest 不含全量来源正文，只保存 provenance、稳定顺序、预算和完成状态。
- shard 只含必要来源摘录、不可变 provenance 和待增强 asset。
- `maxChars` 是每片来源摘录总字符预算，`maxItems` 是每片最大资产数。
- 超长单资产采用确定性首尾摘录，不把完整 2000+ 行材料塞入上下文。
- validate 成功后才原子更新完成标记和分片 hash。
- resume 只返回未完成片；完成片被修改后会拒绝继续。
- deliver 要求全量一一对应、无重复、顺序稳定、所有片已完成。

## 实质质量

schema 通过只是第一层。每条资产还必须通过质量门禁：

- summary 具有实质内容；
- 四维各自的 evidence、gaps、recommendations 非空且具体；
- 不保留默认占位结论；
- `ready/high` 必须有来源路径之外的具体证据。

## Editor-assisted 与 provider

默认 `start` 是 editor-assisted：CLI 准备任务，但没有模型 API 时不会自动完成语义分析。

可选：

```bash
npx @vinsonw2/asset-compound start --yes --provider /path/to/provider-adapter
```

provider 对每片接收 `<shard-path> <task-path>`，原地更新后由 CLI 立即 validate。provider 和凭证由用户管理；凭证只能来自进程环境或系统 secret store，禁止写入配置、workspace、shard 或仓库。

## 旧流程

旧版 JSON 数组输入继续支持，并返回迁移提示。`prepare --legacy-stdout` 保留旧输出。新流程以分片目录作为 `--assets`。

## 验收边界

- 至少两种真实非空来源，默认 requirement + git。
- CLI 只写 `docs/可读化/**`；workspace 位于 `.git`。
- 示例和 fixture 不能作为真实验收数据。
- `deliver` 产出完整验收目录并返回 `secondRunZeroDiff: true`。
