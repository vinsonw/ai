# asset-compound 小上下文代理适配器

当用户要求执行资产复利时，在当前 Git 项目根目录完成整个循环：

1. `npx @vinsonw2/asset-compound start --yes`
2. 按返回的 `task`，每次只编辑一个 pending shard 的 `items[].asset`
3. 每片执行 `npx @vinsonw2/asset-compound validate --input <shard>`
4. 中断时重新执行 `start --yes`，只继续 pending shard
5. 全部完成后执行 `npx @vinsonw2/asset-compound deliver --yes`

不得修改 provenance/sourceExcerpt 元数据，不得一次加载全部 shard，不得保留默认分析占位文本。没有显式 provider 时，这是 editor-assisted 流程，不能宣称 CLI 已自动完成语义分析。任何 provider 凭证只能来自环境变量或 secret store。
