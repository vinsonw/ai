# `asset-compound` 0.1.0 离线安装包

`asset-compound-0.1.0.tgz` 来自 npm 官方 registry 已公开发布的
`@vinsonw2/asset-compound@0.1.0`。本仓库通过以下命令下载原始 tarball，
没有从工作树重新打包旧版本：

```bash
npm pack @vinsonw2/asset-compound@0.1.0 \
  --registry=https://registry.npmjs.org/
```

## 校验

同目录的 `SHA256SUMS` 记录了固定 SHA-256。Linux 或 macOS 可在本目录运行：

```bash
sha256sum -c SHA256SUMS
```

在 PowerShell 中可运行：

```powershell
(Get-FileHash .\asset-compound-0.1.0.tgz -Algorithm SHA256).Hash.ToLower()
```

结果必须与 `SHA256SUMS` 中的值完全一致。

## 同步到其他平台后安装

将 `asset-compound-0.1.0.tgz` 下载或同步到目标平台，校验 SHA-256 后，在
tarball 所在目录执行：

```bash
npm install ./asset-compound-0.1.0.tgz
npx asset-compound --version
npx asset-compound --help
```

也可以直接执行本地包中的 CLI：

```bash
npx --yes --package ./asset-compound-0.1.0.tgz asset-compound --help
```

该文件固定保存已发布的 `0.1.0`，外层 npm 包版本升级不会改变其内容。生成外层
tarball 时必须把输出写到仓库外的临时目录，禁止把外层包复制进 `artifacts/`，
以免递归打包。
