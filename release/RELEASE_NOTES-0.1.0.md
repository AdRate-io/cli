# @adrate/cli 0.1.0 发布说明草案

本文覆盖整个 `0.1.0` release train。**该 train 的首个发布版本是 `0.1.0-beta.1`，dist-tag 为 `next`**——`npm i -g @adrate/cli` 不会装到它，需要显式 `@adrate/cli@next`。正式的 `0.1.0` 要等真实端到端验收、Windows 矩阵与 production 反代取证全部完成后才发布。

状态：外部 GitHub/npm/OpenResty/E2E 闸门仍为 blocked。

**第一版不支持 Accio connector。** 我们在检索范围内没有找到可据以实现和验证 custom Connector 的 manifest schema、device-code 字段与 validator，按"不猜接口"的原则没有做适配（这是对我们检索结果的说明，不是对 Accio 官方资料的判断）。两项 accio 闸门也不再是发布必需项，仍保留在名册中并维持 blocked。

## 安装

CLI 与 Agent Skills 分两步安装，两条命令缺一不可：

```bash
npm install -g @adrate/cli
npx skills add AdRate-io/cli -g -y
```

## M0 命令

```text
adrate auth login [--no-wait | --resume] [--device-name <name>]
adrate auth status
adrate auth whoami
adrate auth logout
adrate capabilities
adrate schema <capabilityId>
adrate ads advertisers
adrate ads campaigns list --adv-id <id>
adrate ads campaigns get --adv-id <id> --campaign-id <id>
adrate ads campaigns status --adv-id <id> --campaign-id <id> --set enable|disable
adrate ads report campaigns --adv-id <id> --start-date <date> --end-date <date>
adrate commands get (--command-id <uuid> | --idempotency-key <key>)
adrate commands pending
adrate commands resume --idempotency-key <key>
adrate skills list
adrate skills read <name> [path]
```

两项 Skill 为 `adrate-shared@1.0.0` 与 `adrate-ads@1.0.0`，最低 CLI 均为 `0.1.0`。只安装 CLI 时，本地 `_notice.skills` 会提示缺失或漂移；只安装 Skills 时，壳会提示安装最低 CLI。

`auth status`、`capabilities`、`skills list` 在核心结果形成后可执行匿名版本检查。发现新版本时写入 `_notice.update`；固定 registry timeout 为 2 秒，成功结果在 `~/.adrate/cache/update.json` 安全缓存 24 小时。离线、超时、非 2xx、无效 semver 或缓存损坏不改变核心命令退出码；仅 `--verbose` 输出脱敏诊断。`ADRATE_NO_UPDATE_NOTIFIER=1` 只关闭更新检查，不关闭 `_notice.credential` 或 `_notice.skills`。

## 冻结 tarball

待发布包必须精确包含以下 15 项：

```text
LICENSE
dist/bin.js
dist/bin.js.map
dist/bin.d.ts
package.json
README.md
scripts/keychain-smoke.mjs
skills/adrate-shared/SKILL.md
skills/adrate-shared/skill-manifest.json
skills/adrate-shared/agents/openai.yaml
skills/adrate-ads/SKILL.md
skills/adrate-ads/skill-manifest.json
skills/adrate-ads/agents/openai.yaml
skills-content/adrate-shared/SKILL.md
skills-content/adrate-ads/SKILL.md
```

包只暴露 `adrate` 二进制，`exports` 为空，source map 不含 `sourcesContent`。tarball 不包含源码、测试、lockfile、release/mirror/Accio artifact、`.env`、测试凭证或主站源码。

## 已知外部阻断

- npm 包 bootstrap、2FA enforcement、Trusted Publisher 和 provenance 尚未在真实账户验收。
- `AdRate-io/cli` 公开远端、保护规则、单向镜像提交和 GitHub Release 尚未创建/验收。
- test/production OpenResty、trusted CIDR、源站防绕过、90/110/120 秒与 76 秒最慢链路尚未实测。
- Windows 真实硬件 Keychain/fallback 尚未验收。

Accio 不在此列：它已从 required 闸门摘除，属于 M0 范围外的后续适配，不阻断本版发布。
