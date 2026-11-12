# `asset-compound` 0.1.19 离线安装包与源码备份

## 内层 CLI（离线 npm）

`asset-compound-0.1.19.tgz` 为 **单一 Windows 兼容 bundle**，行为与
`@vinsonw2/asset-compound@0.1.19` 一致：**deliver 仅聚合写盘**（QA 仅在
`validate`）；内层 bundle 全部生产依赖，可在无 registry 的目录中
`npm install --offline`。

生成过程先用 `0.1.19` 的 npm packlist 建立不含 `artifacts/` 的干净 staging，
再向 staging 的 `package.json` 加入 `bundledDependencies` 并安装生产依赖。
内层与 npm 发布版本同为 `0.1.19`，因此不会递归包含自身。

### 校验

同目录的 `SHA256SUMS` 记录内层 tgz 与源码 zip 的固定 SHA-256：

```bash
sha256sum -c SHA256SUMS
```

PowerShell（内层 tgz）：

```powershell
(Get-FileHash .\asset-compound-0.1.19.tgz -Algorithm SHA256).Hash.ToLower()
```

### 安装

```bash
npm install --offline --no-save --package-lock=false ./asset-compound-0.1.19.tgz
npx asset-compound --version
```

目标 Git 仓库中：

```bash
npx asset-compound start --yes
# 逐片 validate 后
npx asset-compound deliver --yes
```

## 源码 zip（内网备份）

`asset-compound-0.1.19-source.zip` 为本版本完整源码树（不含 `node_modules/`、
`.git/` 及已生成的内层 tgz/旧版 zip）。用于内网归档与离线重建：

```bash
unzip asset-compound-0.1.19-source.zip -d asset-compound-0.1.19-src
cd asset-compound-0.1.19-src
yarn install --frozen-lockfile
yarn run check
```

校验 zip：

```bash
sha256sum -c SHA256SUMS
```
