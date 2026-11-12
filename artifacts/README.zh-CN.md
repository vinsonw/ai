# `asset-compound` 0.1.17 离线安装包

`asset-compound-0.1.17.tgz` 为 **单一 Windows 兼容 bundle**，并落实 **deliver 仅聚合写盘**：
质量门禁只在 `validate`；`deliver --yes` 仅确认分片 completed、匹配 session 仓库、
POSIX 安全写路径，然后聚合生成 `docs/可读化` 与标准 `docs/` 验收树（不重复 QA）。

包含 0.1.16 起的 manifest `untracked` 文件来源信任、路径分隔符统一、deliver 信任分片
冻结来源等能力。包内置全部生产依赖；运行要求 Node.js `>=20`、Git `>=2.20.1`。

从 `0.1.16` / `0.1.15` 升级：删除旧内层 tgz，仅保留本文件；校验 SHA-256 后
`npm install --offline`。

生成过程先用 `0.1.17` 的 npm packlist 建立不含 `artifacts/` 的干净 staging，
再向 staging 的 `package.json` 加入 `bundledDependencies` 并安装生产依赖。
内层与 npm 发布版本同为 `0.1.17`，因此不会递归包含自身。

## 校验

```bash
sha256sum -c SHA256SUMS
```

PowerShell：

```powershell
(Get-FileHash .\asset-compound-0.1.17.tgz -Algorithm SHA256).Hash.ToLower()
```

## 安装

```bash
npm install --offline ./asset-compound-0.1.17.tgz
npx asset-compound deliver --yes
```

该文件固定为内层 `0.1.17` payload。
