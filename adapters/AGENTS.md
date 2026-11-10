# asset-compound 小上下文代理适配器

当用户要求执行资产复利时，在当前 Git 项目根目录完成整个循环：

1. `npx @vinsonw2/asset-compound start --yes`
2. 只读返回的 `task`、manifest 和第一条 pending shard，不猜目录或加载全量
3. 事实仅来自当前片 `sourceExcerpt.text/provenance`；原地只改 `items[].asset`
4. 每片执行 `npx @vinsonw2/asset-compound validate --input <shard>`
5. 按真实实践填写返回的 `retrospective` 文件
6. 中断时重新执行 `start --yes`，只继续 pending shard
7. 全部完成后执行 `npx @vinsonw2/asset-compound deliver --yes`

唯一输出是当前 shard 原路径的纯 JSON；不得改源码、原始 docs、manifest、配置或
其他 shard。不得修改 provenance/sourceExcerpt、稳定 ID/hash/revision、项数和
顺序。summary 至少 20 字符；四维均须具体 evidence/gaps/recommendations，evidence
必须关联当前摘录；证据不足写 gap，禁止编造或泛化套话。validate exit 0 才算单片
完成，失败只修当前片并重试。没有显式 provider 时这是 editor-assisted 流程，不能
宣称 CLI 已自动分析。只有标准 docs、2.1、2.2、R1–R6/V1–V8 和 zero diff 全通过
才能宣称交付成功。provider 凭证只能来自环境变量或 secret store。

Git 片必须先读 diff：先看 `GIT_FILE/GIT_STATUS` 与 `PATCH_BEGIN…PATCH_END`，逐个处理
`@@ ... @@` hunk；提交消息不能替代代码证据。evidence 必须包含
`文件路径@commit + @@ hunk 定位`。patch 截断时写 gap，禁止打开全仓或完整大文件补齐，
也禁止推断 diff 未显示的调用方、运行结果或业务事实。
