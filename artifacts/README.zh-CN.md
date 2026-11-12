# `asset-compound` 0.1.7 离线安装包

`asset-compound-0.1.7.tgz` 以本 PR 合并后的 `main` 为唯一源码基线，包含强化后的
中文 AI-TASK/分片/SKILL 契约（事务性产物忽略、仅提炼业务/架构/接口/数据/模式、
`maxCommits=20` 非全历史提示）、扩展的 webpack/eslint/babel/tsconfig/CI 事务过滤、
默认 `spec/**/*.md` 发现、默认最多 10 片的无损平衡，以及 `skippedGitCommits` 留痕。
它同时保留文件级 diff/hunk、受控 post-image 和标准 docs、2.1/2.2、R1–R6、
V1–V8 验收能力。包内置全部生产依赖，可在没有 registry 网络访问、没有预热 npm
cache 的干净目录中本地安装；运行要求 Node.js `>=20`、Git `>=2.20.1`。

生成过程先用 `0.1.7` 的 npm packlist 建立不含 `artifacts/` 的干净 staging，
再仅向 staging 的 `package.json` 加入 `bundledDependencies` 并安装生产依赖。
外层 `0.1.8` 不参与内层生成，因此不会递归包含自身。`0.1.7` 专用于本次离线
payload；不得向 npm registry 发布不同内容的同版本包。

## 校验

同目录的 `SHA256SUMS` 记录了固定 SHA-256。Linux 或 macOS 可在本目录运行：

```bash
sha256sum -c SHA256SUMS
```

在 PowerShell 中可运行：

```powershell
(Get-FileHash .\asset-compound-0.1.7.tgz -Algorithm SHA256).Hash.ToLower()
```

结果必须与 `SHA256SUMS` 中的值完全一致。

## 同步到其他平台后安装

将 `asset-compound-0.1.7.tgz` 下载或同步到目标平台，校验 SHA-256 后，在
tarball 所在目录执行：

```bash
npm install --offline ./asset-compound-0.1.7.tgz
npx asset-compound --version
npx asset-compound --help
```

也可以直接执行本地包中的 CLI：

```bash
npx --offline --yes --package ./asset-compound-0.1.7.tgz asset-compound --help
```

在目标 Git 仓库创建独立分支并准备至少一个真实 requirement 文件后，可运行：

```bash
npx asset-compound start --yes
```

该文件固定为内层 `0.1.7` payload。外层 `0.1.8` pack 必须输出到仓库外的临时
目录，并验证只包含这一份内层 tgz 且 SHA-256 与 `SHA256SUMS` 一致。
