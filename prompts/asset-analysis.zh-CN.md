# 小上下文资产复利四维分析提示

一次只处理一个 `work/shards/NNNN.json`。不要请求、复制或拼接全部扫描内容。

## 允许修改

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

来源摘录可能因预算显示 `truncated: true`。只能基于可见摘录得出结论；信息不足应明确写入 gaps，不得猜测被省略内容。最终 CLI 会用 provenance 对完整来源重新核验。

## 四维分析

逐项填写：

1. `completeness`：完整性；
2. `executability`：可执行性；
3. `consistency`：一致性；
4. `reuseValue`：复用价值。

每维的 `evidence/gaps/recommendations` 都必须至少包含一条具体、可读、可行动的内容。禁止：

- 空数组或空白字符串；
- 保留 prepare 默认占位结论；
- 只把来源路径当成 evidence；
- 在没有具体证据时标记 `ready` 或 `high`；
- 编造摘录中不存在的事实。

完成后保存原 JSON 文件，再执行：

```bash
npx @vinsonw2/asset-compound validate --input <当前分片路径>
```

只有 validate 成功，manifest 才会持久化该片的完成标记。失败时只修复当前片，不重做已完成片。

## 安全

- 不得写入密钥、令牌、邮箱或未经授权的私有标识。
- provider 凭证只能通过进程环境或系统 secret store 注入，不能写入 shard、配置或仓库。
- 最终文件必须是纯 JSON，不添加 Markdown 围栏或解释文字。
