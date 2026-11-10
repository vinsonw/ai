# `asset-compound` 0.1.2 离线安装包

`asset-compound-0.1.2.tgz` 是从 PR #5 合并后的 `main` 构建的非递归 payload，
包含标准 docs、2.1/2.2、R1–R6、V1–V8 验收重构。它内置全部生产依赖，可在
没有 registry 网络访问、没有预热 npm cache 的干净目录中本地安装。

生成过程先用 `0.1.2` 的 npm packlist 建立不含 `artifacts/` 的干净 staging，
再仅向 staging 的 `package.json` 加入 `bundledDependencies` 并安装生产依赖。
外层 `0.1.3` 不参与内层生成，因此不会递归包含自身。

## 校验

同目录的 `SHA256SUMS` 记录了固定 SHA-256。Linux 或 macOS 可在本目录运行：

```bash
sha256sum -c SHA256SUMS
```

在 PowerShell 中可运行：

```powershell
(Get-FileHash .\asset-compound-0.1.2.tgz -Algorithm SHA256).Hash.ToLower()
```

结果必须与 `SHA256SUMS` 中的值完全一致。

## 同步到其他平台后安装

将 `asset-compound-0.1.2.tgz` 下载或同步到目标平台，校验 SHA-256 后，在
tarball 所在目录执行：

```bash
npm install --offline ./asset-compound-0.1.2.tgz
npx asset-compound --version
npx asset-compound --help
```

也可以直接执行本地包中的 CLI：

```bash
npx --offline --yes --package ./asset-compound-0.1.2.tgz asset-compound --help
```

在目标 Git 仓库创建独立分支并准备至少一个真实 requirement 文件后，可运行：

```bash
npx asset-compound start --yes
```

该文件固定为内层 `0.1.2` payload。外层 `0.1.3` pack 必须输出到仓库外的临时
目录，并验证只包含这一份内层 tgz 且 SHA-256 与 `SHA256SUMS` 一致。
