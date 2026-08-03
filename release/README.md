# @adrate/cli 发布与回滚 Runbook

本目录只记录公开 CLI 镜像与 npm 发布流程。私有主站继续使用既有 `deploy.sh`、原子目录和 PM2 流程；GitHub Actions 不部署主站。当前 `external-readiness.json` 中 prerelease 与 stable 两个 channel 都是 fail-closed；任一 channel 的 required gate 为 blocked，都禁止该 channel 的 npm publish。本地构建通过不等于已经对外发布。

## 已冻结供应链合同

2026-08-01 按官方资料核验：npm Trusted Publishing 要求 npm CLI `>=11.5.1`、Node `>=22.14.0`、GitHub-hosted runner 和 `id-token: write`；公开包在可信发布下自动生成 provenance，不需要 `--provenance`。工作流冻结 Node 24、npm 11.12.1、pnpm 10.18.0，并将 `actions/checkout@v6.0.2` 固定到 `de0fac2e4500dabe0009e67214ff5f5447ce83dd`、`actions/setup-node@v6.4.0` 固定到 `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e`、`actions/upload-artifact@v7.0.1` 固定到 `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`、`actions/download-artifact@v8.0.1` 固定到 `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`。setup-node v6 还要求 GitHub runner agent `>=2.327.1`。

核验来源：

- npm Trusted Publishers: https://docs.npmjs.com/trusted-publishers/
- npm provenance: https://docs.npmjs.com/generating-provenance-statements/
- npm 发布 2FA: https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/
- npm 2FA 配置: https://docs.npmjs.com/configuring-two-factor-authentication/
- GitHub OIDC: https://docs.github.com/en/actions/concepts/security/openid-connect
- GitHub environments: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments

Trusted Publisher 必须精确绑定 owner `AdRate-io`、repository `cli`、workflow `publish.yml` 和 environment `npm-production`。`package.json.repository.url` 固定为 `git+https://github.com/AdRate-io/cli.git`。npm 包必须先存在，才能配置 Trusted Publisher；首次创建包属于人工外部闸门，不能在仓库中保存长期 npm token。

## 单向镜像

私有仓库是唯一权威源。公开仓库 bootstrap 必须先创建不含文件的空提交；不能预置另一份 README/LICENSE 后让脚本猜是否覆盖。目标必须是 clean checkout，origin 只接受 `https://github.com/AdRate-io/cli` 或带 `.git` 的 canonical 形式，调用时必须给出两端完整 SHA。脚本默认只生成 dry-run 计划：

```bash
node scripts/public-mirror.mjs \
  --target /absolute/path/to/public-cli \
  --source-commit <private-full-sha> \
  --target-commit <public-full-sha>
```

审核 added/updated/removed 后，才显式 `--apply`。源文件只从已审批 commit 的 Git blob 读取，且模式必须为 `100644`；工作区在检查后被篡改也不能改变 plan。apply 只写 plan 已捕获的 bytes，逐文件复验 SHA-256，并生成 `.adrate-public-mirror.json`。脚本会在隔离的临时 clone 索引中执行 `git add -A` 生成 binary patch，但绝不修改目标仓库 index，也不执行目标 commit、push 或 force push。维护者在目标仓库审查 diff 后做普通提交。下一轮镜像要求该 manifest 由当前 target HEAD 提交，且当前 HEAD 是 manifest 记录的 base target commit 的唯一直接子提交；源 commit 还必须是上次 source commit 的后代。未知文件、dirty checkout、origin 不匹配、摘要漂移、源历史回退或目标历史不闭合都会停止。

公开镜像只允许 CLI 源码、测试、构建配置、两项 Skills、发布 workflow/runbook 和明确 blocked 的 Accio 兼容性证据；`dist`、`node_modules`、tarball、`.env`、密钥文件与主站源码不进入镜像。

**公开仓库不得存在任何镜像外文件，也不得有任何镜像以外的手工提交。** 其中哪些由工具强制、哪些只靠平台规则，必须分清楚——排障时看到的报错要能对上下面这张表，对不上就该怀疑自己的判断而不是怀疑工具。下表是实测结论，连同"镜像工具写出的自洽提交应当放行"这一对照状态，共四种情形均由 `test/public-mirror.test.ts` 的同名用例逐条断言守护：

| 情形                                                                                      | 谁来阻断                 | 实际报错                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引入 allowlist 之外的路径（`LICENSE`、`CODEOWNERS`、issue/PR 模板、`SECURITY.md`）        | **工具，三条路径全封死** | 未重签 manifest 时见下一行；自洽重签时 `parsePriorManifest` 的 `isAllowedMirrorPath` 报 `Target mirror manifest is invalid.`；镜像侧则报 `Source contains a path outside the mirror allowlist`           |
| 任何**未由镜像工具写入 manifest** 的手工提交                                              | **工具**                 | `Target mirror commit is not the direct child of its recorded base commit.` —— 手工提交让 HEAD 的父提交变成上一次镜像提交，而 manifest 记录的 `baseTargetCommit` 仍指向更早的 base，父子闭合检查先行拦下 |
| 手工提交**同时自洽重签 manifest**，且只涉及 allowlist 内路径（例如手改本 runbook 再重签） | **工具不阻断**           | 无报错，工具会正常收下。唯一防线是 branch ruleset 的 required review / 禁止绕过，与 :62 行"角色分离靠人工核对"同属"非平台强制"一栏                                                                       |

补充：代码里还有一条 `Target mirror manifest was not committed by the approved target HEAD.`，它要求 HEAD 的父提交里已有**字节相同**的 manifest、且那份 manifest 的 `baseTargetCommit` 正好等于该父提交自身的 SHA（自指），普通 git 操作构造不出来，排障时不要指望看到它。

因此 `CODEOWNERS`、issue 模板等一律不得由维护者在公开仓库直接添加；确有必要时先把文件加入私有源并同步扩展 `scripts/public-mirror.mjs` 的 allowlist，再由镜像写入。`LICENSE` 已于 2026-08-03 按此流程加入（MIT 正文，版权归 AdRate），tarball 合同同步重签为精确 15 项——它会被 npm 无条件打进 tarball（与 `package.json.files` 无关），所以这两者必须一起改。

## 本地与外部闸门

在 clean checkout 安装依赖并构建：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build

# prerelease 候选，例如 package version 0.1.0-beta.1
export RELEASE_COMMIT="$(git rev-parse HEAD)"
export RELEASE_ARTIFACT_DIR="/absolute/path/to/adrate-prerelease-artifact"
pnpm release:gate --channel prerelease --tag v0.1.0-beta.1 --commit "$RELEASE_COMMIT" --artifact-dir "$RELEASE_ARTIFACT_DIR"
pnpm release:external-gate --channel prerelease --tag v0.1.0-beta.1 --commit "$RELEASE_COMMIT" --artifact-dir "$RELEASE_ARTIFACT_DIR"

# stable 候选，例如 package version 0.1.0
export RELEASE_COMMIT="$(git rev-parse HEAD)"
export RELEASE_ARTIFACT_DIR="/absolute/path/to/adrate-stable-artifact"
pnpm release:gate --channel stable --tag v0.1.0 --commit "$RELEASE_COMMIT" --artifact-dir "$RELEASE_ARTIFACT_DIR"
pnpm release:external-gate --channel stable --tag v0.1.0 --commit "$RELEASE_COMMIT" --artifact-dir "$RELEASE_ARTIFACT_DIR"
```

`release:gate` 会检查仓库元数据、workflow 闭世界字节 SHA、tracked/mirror/tarball 三层秘密形状、文档一致性、精确 15 项 tarball、两次独立实际 `npm pack` 的整个 `.tgz` SHA-256 与文件摘要一致，以及 source map 不含 `sourcesContent`。整个 `.tgz` 的比较不做归一化，因此 tar header、条目顺序、mode、mtime 或 gzip metadata 任一漂移都会阻断。它还会在 readiness 仍 blocked、pin 全为 null 时校验 `release/trusted-evidence-pins.json` 的 exact-nine Schema，不会把 malformed trust root 留到外部闸门才发现，也不会读取被 allowlist 拒绝的工作区 `.env` 内容。真实 workflow 会把同一份已验证 tarball 和 digest manifest 传给外部闸门与发布 job，不会在有 OIDC 权限的 job 中重建或 checkout 项目代码。

`release:external-gate --channel prerelease` 只消费 prerelease 的 4 项 required gate；`--channel stable` 消费 7 项。名册仍是 exact-nine，两项 accio gate（`accio-official-connector`、`accio-capacity`）保留在名册和 pin 文件里并维持 `blocked`，但**不属于任何 channel 的 required 列表**——第一版不支持 Accio connector，我们拿到 manifest/device-code schema 与 validator 后转回 required 即可。pass 不信任可编辑 JSON 声明：每份证据必须位于固定 `release/evidence/<gate-id>.json`，摘要、issuer 和 environment 必须命中单独声明、单独提交审查的 `release/trusted-evidence-pins.json`，时间不得晚于 readiness 检查时间。pin 文件固定 exact-nine ID、严格字段和预期 environment，未审查项只能为 null；它由 public mirror 的 branch ruleset 保护，并约定 pin 审批与证据生成由不同角色承担。⚠️ **当前公开仓库为单人维护**：ruleset 配置为 `required_approving_review_count=0` 且允许作者自审（单人账号下任一审批要求为真都会让合并与发版永久死锁），因此该角色分离目前**由本 runbook 约定、在 review 时人工核对，平台不强制**。换句话说，这层机制是**防误操作控制，不构成独立于维护者的信任根**——仓内 gate 只能验证 evidence、readiness 与 pin 三者自洽，无法证明审批身份独立于作者。请勿将其理解为第三方审计或独立签名。引入第二身份并强制非作者审批后，本段才可改回独立信任根的表述。ruleset 当前实际强制的是：默认分支受保护、必须走 pull request、禁止 force push 与删除、禁止管理员绕过。**这里刻意不使用 CODEOWNERS**：CODEOWNERS 的三个合法位置都不在镜像 allowlist 内，放进公开仓库会立刻触发上一节的闭世界阻断；而 ruleset 的 required review 不需要仓库里存在任何文件即可满足。代价是 ruleset 只能做分支级强制、无法按路径指定 reviewer，"pin 必须由不生成证据的人审批"这一角色分离由本 runbook 约定并在 review 时人工核对，不由平台强制。`testedCommit` 与 `validatedCommit` 必须是当前 tag commit 的已存在祖先，避免证据文件自指其尚未存在的 commit。prerelease 还必须同版本、同 release train、runtime 无漂移且当前重建 tarball SHA-256 与已测产物相同；stable 必须消费同 train 的 prerelease 证据，只允许 package version 和严格列举的 readiness、evidence、pin、mirror manifest 与 runbook 变化。release gate 实现、类型声明或合同测试在已测候选后均不可变化；任何 verifier 变更都必须生成新的 prerelease 候选并重新取得全部适用证据。

当前仓库九项 gate 全部为 blocked，其中 7 项属于 stable required、4 项属于 prerelease required，因此上述 external 命令会在 readiness 派生状态检查处按设计退出 1。Accio 自 2026-08-02 起不再是 required blocker，但 GitHub 镜像、npm bootstrap/2FA、Trusted Publisher 与 OpenResty 取证仍未完成，任一未取证都会独立阻断。

## 发布

1. 在 npm 真实账户完成包 bootstrap、owner/org 2FA enforcement 和最小权限验收。
2. 在 npm Trusted Publisher 精确登记 `AdRate-io/cli`、`publish.yml`、`npm-production`，在 GitHub environment 配置保护人。
3. 先完成 prerelease channel 的 4 项 required gate，并审批声明式 pin（角色分离见上节说明），再推 prerelease semver 的 `v<package-version>` tag；workflow 自动使用 npm dist-tag `next`。
4. 从该 `next` tarball 在全新用户目录安装，完成 production/test、Device Flow、Status 恢复、notice、Skills 与 Windows 矩阵，形成 stable-only gate 证据。
5. 全部 7 项 stable required gate 有固定证据，且 stable 候选与同 train prerelease 的 runtime 一致后，再推正式 semver tag；workflow 使用 `latest`。
6. 核对 npm provenance、GitHub Release/tag/source commit、公开 mirror manifest 和 tarball 摘要指向同一版本。

发布 workflow 不接受 `NPM_TOKEN`/`NODE_AUTH_TOKEN`，不加 `--provenance`，也不支持从 dirty 开发目录发布。版本一旦发布不可覆盖；失败修复必须提升 semver。

## 安装 smoke

两步缺一不可：

```bash
npm install -g @adrate/cli
npx skills add AdRate-io/cli -g -y
```

在全新用户目录验证 `adrate --version`、`adrate --help`、`adrate skills list`、`adrate skills read adrate-shared`，然后按 T11 矩阵跑真实 production/test 流程（第一版不支持 Accio connector，不跑 Accio 流程）。任何输出、日志和报告只保存脱敏 requestId、版本、状态和摘要，不保存 Session Token、device code、TikTok Token 或 pepper。

## 回滚

CLI 回滚不删除服务端 Command，不破坏 Public API v1 兼容性。发现供应链或客户端缺陷时停止新 tag，使用 npm 的 deprecate 能力标记问题版本，保持 provenance 与审计记录，修复后发布新 semver；不要覆盖或重发同一版本。若问题只影响公开镜像，暂停镜像与发布，保留私有权威源和目标 commit 证据，按普通 git revert 恢复，不强推。若服务端需要回滚，走既有 PM2/原子目录流程，并维持 CLI 所依赖的 v1 合同。
