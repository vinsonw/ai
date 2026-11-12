# 小上下文资产复利：单片执行契约

一次只处理 manifest 中第一条 `status=pending` 的 `work/shards/NNNN.json`。
本轮事实输入仅限当前片的 `sourceExcerpt.text` 和 `provenance`。不要读取、请求、
复制或拼接全部 shards，不要自行扫描仓库或猜测来源目录；`truncated=true` 时也
不得打开原始全文，缺失信息写入 gaps。

## Git diff 证据（仅适用于 sourceType=git）

先读 diff：先用 `GIT_COMMIT/GIT_FILE/GIT_STATUS` 确认单文件边界，再逐个阅读
`PATCH_BEGIN…PATCH_END` 内可见的 `@@ ... @@` hunk。提交消息只能提示意图，
不能替代代码证据。Git evidence 必须包含 `文件路径@commit + @@ hunk 定位` 并
引用实际变更；`POST_IMAGE_BEGIN path@commit:Lx-Ly` 只能补充变更后局部语境。
出现 `PATCH_TRUNCATED/PATCH_CAPTURE_TRUNCATED` 时必须在 gaps 写明未覆盖内容；
禁止打开全仓或完整大文件补齐，禁止推断未显示的调用方、运行结果或业务结论。

## Git 来源窗口

Git 来源已由 `start` 预筛，默认仅覆盖最近 **10 次有效提交**（`maxCommits` 指
有效数，跳过的不占名额），不是全仓历史。片内每条记录均可提炼；不得暗示已审阅全
部提交。`skippedGitCommits` 仅用于 R1/R6 报告引用，勿对跳过项补写资产。确需纳入
被跳过提交时，要求用户以 `--include-transactional-commits` 新建 workspace 重跑。

## 唯一输出与 schema

唯一输出是原地覆盖当前 shard 的纯 JSON。不得创建旁路文件、Markdown 围栏或解释
文字，不得修改项目源码、原始 docs、配置、manifest 或其他 shard。

只修改 `items[].asset` 中的语义字段：

- `title`
- `summary`
- `facts`
- `decisions`
- `actions`
- `relations`
- `analysis`

## 禁止修改

- 顶层 `schemaVersion`、`shardId`
- `items[].provenance`
- `items[].sourceExcerpt` 及其截断元数据
- asset 中的 `assetId/sourceType/sourceRef/sourceRevision/contentHash/writebackKind`
- 数组项数量和顺序
- schema 未声明的任何新字段

当前 shard 结构与 CLI `validate` 是唯一 schema 权威。

## 必填资产字段

- `title`：明确命名资产。
- `summary`：至少 20 个字符。
- `facts/decisions/actions/relations`：四个数组必须存在；只填摘录可证明的内容，
  没有证据时用空数组，禁止编造。
- `analysis`：必须包含以下四维，不能缺项。

## 四维分析

1. `completeness`：完整性，level 仅用 `ready/partial/missing/conflict`；
2. `executability`：可执行性，level 仅用 `ready/partial/missing/conflict`；
3. `consistency`：一致性，level 仅用 `ready/partial/missing/conflict`；
4. `reuseValue`：复用价值，level 仅用 `high/medium/low`。

每维的 `evidence/gaps/recommendations` 都必须至少一项，每项至少 4 个字符。
evidence 必须引用或紧密复述 `sourceExcerpt.text` 的具体事实。禁止：

- 空数组或空白字符串；
- 保留 prepare 默认占位结论；
- 只把来源路径当成 evidence；
- 四维复用同一套泛化套话；
- 在没有具体证据时标记 `ready` 或 `high`；
- 编造负责人、时间、接口、数据结构、跨片一致性或任何摘录外事实。

信息不足时降低 level 并写明 gap；发现冲突时使用 `conflict` 并记录双方可见证据。

## 完成、失败与续跑

保存当前 shard 后只执行：

```bash
npx @vinsonw2/asset-compound validate --input <当前分片路径>
```

只有 exit 0，manifest 才会持久化该片的 completed 标记。失败时根据 stderr 只修
当前片并重试同一命令；不得跳过、手改完成标记或重做已完成片。摘录为空、含敏感
信息、不可变字段异常或无法形成实质结论时，停止并报告原因，禁止伪造通过。

单片成功后释放上下文，再取下一条 pending。中断后重新运行 `start --yes`，只继续
pending shard。全部完成后如实填写 retrospective，再运行 `deliver --yes`。只有
2.1、2.2、R1–R6、V1–V8、冲突门禁和二次 zero diff 全通过，才能宣称完成。

## 安全

- 不得写入密钥、令牌、邮箱或未经授权的私有标识。
- provider 凭证只能通过进程环境或系统 secret store 注入，不能写入 shard、配置或仓库。
- 最终文件必须是纯 JSON，不添加 Markdown 围栏或解释文字。
