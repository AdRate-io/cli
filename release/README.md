# @adrate/cli 发布与回滚

本文件是当前 CLI 发布入口。历史 evidence、readiness、trusted pins、external gate 和发布 job 二次完整校验已经删除，不再执行旧 Runbook 中的对应命令。

当前流程只有一条：私有源提交 -> 公开镜像提交 -> version tag -> verify -> publish。同一次 workflow 中，verify 只生成一次 tarball，publish 只发布这一个已验证制品。

## 发布边界

- 私有仓库的 `cli/` 是唯一出境源，公开仓库固定为 `https://github.com/AdRate-io/cli`。
- 镜像只读取已提交 Git blob，使用静态路径 allowlist 和秘密扫描，并拒绝 symlink、可执行 blob、未知文件与不闭合的镜像历史。
- workflow 由 version tag 触发，tag 必须与 `package.json` version 一致：prerelease 发布到 `next`，stable 发布到 `latest`。
- verify job 不持有发布凭据，负责 lockfile 安装、typecheck、test、build、一次 pack、包内容与秘密扫描、source map 检查和 packed smoke。
- publish job 不 checkout、不运行项目代码，只核对 verify 产出的 manifest 身份和 tarball SHA-256，然后使用 `--ignore-scripts` 发布同一个 tarball。
- 发布使用 npm OIDC Trusted Publisher 和 provenance，不保存 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。

tarball 文件清单只有 `scripts/release-gate.mjs` 中的 `EXPECTED_TARBALL_FILES` 一个机器真源。workflow、README 和 release notes 不复制清单。

## 0. 版本号一键更新

版本引用按"什么时候才需要动"分三层，全部由 `pnpm release:bump` 统一修改（在 `cli/` 目录执行）：

```bash
pnpm release:bump <新CLI版本>                        # 层 1：仅 package.json（Skill 未变的发布只需这一层）
pnpm release:bump <新CLI版本> --skill <新Skill版本>   # 层 1+2：Skill 正文有变更时（壳 frontmatter、minCliVersion、
                                                     #         测试字面量，并自动 reseal + validate）
pnpm release:bump <新CLI版本> --accio                # 层 1+3：需要推给 Accio 平台时（clis.json / connectors.json pin）
```

- 层 2 的测试版本字面量是守门设计（版本 bump 必须留下可见 diff），脚本改完后照常由测试验证一致性，任何一处预期替换数为 0 会直接失败退出。
- Skill 正文变更的判定：`cli/skills-content/` 有 diff 即算，Skill 版本按语义化递增（内容新增 minor、修错字 patch）。
- `--accio` 改的 pin 指向 npm 包，发布成功前 pin 是悬空的；只在本次发布确定要同步 Accio 平台时携带。
- 改完运行 `npx vitest run`（cli/）与仓库根目录 `pnpm accio:check` 验证。

## 1. 在私有源完成候选提交

先把版本、代码、测试、Skills 和发布配置提交到私有仓库，确认工作区干净。候选 commit 必须是准备镜像和发布的完整状态，不能在镜像后继续手改公开仓库。

在 `cli/` 目录执行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm release:gate
```

`release:gate` 会要求 clean checkout，并检查包契约、镜像出境面、秘密、tarball 文件集、source map 和 packed smoke。

⚠️ **私有侧预检不要传 `--tag`/`--commit`/`--channel`/`--artifact-dir`**：这些参数会触发 `assertReleaseGitIdentity`，它要求运行目录就是 git toplevel 且 tag 已解析到 HEAD——只有公开仓 root 在 tag 推送后才满足（私有仓里 `cli/` 是子目录，必然报 "Release identity must be checked at the public repository root"）。身份校验与发布制品由公开仓 workflow 的 verify job 负责。

## 2. 单向同步公开镜像

公开仓库 bootstrap 已完成。每次同步都从私有 `cli/` 运行镜像脚本，先 dry-run，再 apply：

```bash
node scripts/public-mirror.mjs \
  --target /absolute/path/to/public-cli \
  --source-commit <private-full-sha> \
  --target-commit <public-full-sha>

node scripts/public-mirror.mjs \
  --target /absolute/path/to/public-cli \
  --source-commit <private-full-sha> \
  --target-commit <public-full-sha> \
  --apply
```

审核公开 checkout 的 added/updated/removed 和 `.adrate-public-mirror.json` 后，通过普通 PR 提交并合并。镜像脚本不 commit、不 push、不 force push，也不修改目标 index。公开仓库不要直接添加 README、LICENSE、CODEOWNERS、issue 模板或其他手工文件；需要新增路径时，先在私有源修改 allowlist 和校验，再由镜像带出。

公开 main 的镜像历史必须保持工具要求的直接父子关系。合并只能使用平台已允许的 rebase 或 squash 方式，合并后重新 fetch 公开 main，以远端 HEAD 作为下一次 `--target-commit`。

## 3. 推 version tag

确认公开 main 的内容对应已审批私有 commit，`package.json` version 正确，工作区干净，然后在公开仓库对当前 HEAD 创建并推送不可复用的 tag：

```bash
git tag "v<package-version>"
git push origin "v<package-version>"
```

不要移动、覆盖或复用已推送版本号。若 workflow 失败，修复后提升 semver，重新走镜像和 tag。

## 4. 核对 workflow 与安装结果

tag 会触发 `.github/workflows/publish.yml`：

1. verify job 校验 tag/version/channel/commit，执行测试和构建，生成唯一 tarball 与 `release-artifact.json`，上传短期 artifact。
2. publish job 下载该 artifact，只复核 release 身份和 tarball 总 SHA-256，通过 `npm-production` environment 与 Trusted Publishing 发布。
3. prerelease 使用 dist-tag `next`，stable 使用 `latest`。

发布后在全新用户目录验证：

```bash
npm install -g @adrate/cli@next # stable 改为 @adrate/cli
adrate --version
adrate --help
adrate skills install
adrate skills list
adrate skills read adrate-shared
```

再按当前验收范围完成 production/test 登录、只读命令、Status 写恢复与 logout。首个 stable 还需完成真实 Windows 普通用户环境验收；这是一项发布前人工验收，不写回仓库内长期 evidence 账本。

## 回滚

已发布 npm 版本不覆盖、不重发。发现客户端或供应链缺陷时，停止新 tag，对问题版本执行 npm deprecate，修复后发布新 semver。若问题只在公开镜像，暂停镜像和发布，在私有权威源修复后按正常镜像流程前进，不 force push。

CLI 回滚不能删除服务端 Command 或破坏 Public API v1 兼容性。服务端回滚继续走主站既有部署流程。
