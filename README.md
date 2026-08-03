# @adrate/cli

AdRate Public API 的官方薄客户端。M0 支持 Device Authorization、凭证诊断、Campaign 查询与单 Campaign ENABLE/DISABLE，并内置两项 Agent Skills。

CLI 与 Agent Skills 分两步安装，两条命令缺一不可：

```bash
npm install -g @adrate/cli
npx skills add AdRate-io/cli -g -y
```

认证快速入口：

```bash
adrate auth login --no-wait
adrate auth login --resume
adrate auth whoami
```

完整 M0 命令面：

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

两项 Skill 固定为 `adrate-shared` 和 `adrate-ads`，当前版本均为 `1.0.0`，最低 CLI 版本均为 `0.1.0`。安装壳的 frontmatter 顶层只允许 `name`、`description`、`metadata`；metadata 只允许下列四个字符串字段：

```yaml
metadata:
  version: "1.0.0"
  minCliVersion: "0.1.0"
  requiredBin: "adrate"
  cliHelp: "adrate skills read <对应name>"
```

壳先检查 `adrate --version`，CLI 缺失或低于最低版本时提示 `npm install -g @adrate/cli`，版本满足后再运行对应的 `adrate skills read`。完整正文只从包内 `skills-content/<name>/SKILL.md` 读取。

`skills list/read` 的核心 Skills 读取都不需要认证且不发网络请求。`skills list` 在核心结果形成后、缓存过期且未设置 `ADRATE_NO_UPDATE_NOTIFIER=1` 时，可能额外向固定 npm registry 发起可抑制的匿名更新检查；`skills read` 全程零网络。`skills read` 的 human 模式只把规范化后的 Skill 原文写到 stdout；JSON 模式仍只输出一个信封。每次启动会定点检查 `~/.agents/skills/adrate-shared` 与 `~/.agents/skills/adrate-ads`，缺失、低版本或内容摘要漂移只产生 `_notice.skills` 与 stderr warning，不改变业务退出码。可用 `ADRATE_NO_SKILLS_NOTIFIER=1` 独立关闭该检查。

`auth status`、`capabilities`、`skills list` 只在核心结果形成后检查 CLI 新版本，请求固定为 `https://registry.npmjs.org/@adrate%2Fcli/latest`，总 timeout 2 秒，不携带 AdRate Token/Cookie。成功结果原子缓存到 `~/.adrate/cache/update.json` 24 小时；文件/目录继续使用安全的 `0600`/`0700` 权限。只有发现更高 semver 时才生成 `_notice.update`：

```text
{
  level: "info"
  currentVersion: semver
  latestVersion: semver
  checkedAt: ISO UTC
  suggestedAction: "upgrade_cli"
  command: "npm install -g @adrate/cli"
}
```

离线、超时、非 2xx、无效 semver 或缓存损坏会省略 update notice；只有 `--verbose` 才输出固定脱敏诊断，核心退出码不变。`ADRATE_NO_UPDATE_NOTIFIER=1` 只关闭 update 检查，不影响 `_notice.credential` 或 `_notice.skills`；三个 key 独立合并。

`/public/v1/me` 是唯一能激活新 Session 的服务端 Endpoint。本地存在 Token 时，`auth status` 和 `auth whoami` 都会调用该 Endpoint；不要把其中任一 CLI 命令描述为唯一激活请求。

生产环境为默认 issuer。只有在尚无本地凭证并创建新的 Device Flow 时，才可通过 `--test` 选择测试环境。CLI 不支持任意 base URL、关闭 TLS、团队切换或多 Profile。

## 认证恢复

CLI 会先持久化 Device poll 响应与 logout 投递事实，再提交可变本地状态。崩溃后的 `auth login/status/whoami/logout` 只续作已冻结本地事实，不重复 Token POST 或 logout DELETE。

logout 只在 HTTP 200 且服务端返回精确 revoked DTO 时确认远端 Session 已失效；其他 2xx、空响应、错 credentialId 或非标准 UTC 时间都会保守清理本地凭证并以退出码 5 提示远端结果未确认。输出真实写入后会先耐久化已交付事实，再回收 journal；若回收中断，下一个 auth 命令只做本地回收并要求用户重试该命令，不会重放已交付输出。

## 凭证存储

CLI 通过精确锁定的可选依赖 `@github/keytar@7.10.6` 优先使用操作系统 Keychain。新登录无法使用 Keychain 时，CLI 会明确警告并改用已经验证的 POSIX `0700`/`0600` fallback 文件。已经由 `token-index.json` 固定为 Keychain 的凭证不会静默降级。

pnpm 10 可能要求安装项目显式批准 `@github/keytar` 的可选原生构建脚本。未批准构建或桌面 Keychain 不可用时，新登录按上述合同使用 fallback。

维护者只有在显式确认后才运行真实 Keychain 往返 smoke：

```bash
ADRATE_CONFIRM_REAL_KEYCHAIN_SMOKE=1 pnpm smoke:keychain
```

该 smoke 使用随机 service/account 和随机 dummy secret，验证 set/read/主 delete/post-read，并在 `finally` 中再执行一次幂等 delete/post-read。主删除或最终不存在性任一无法确认都会 `FAIL`。未设置确认变量时，脚本在导入或访问 Keychain 前以 `SKIP` 退出。

T09 平台闸门已在 macOS 桌面 Keychain 会话显式确认运行该 smoke，set/read/constant compare/主 delete/post-read 与 `finally` 第二次幂等 delete/post-read 全部 PASS。

## POSIX 锁接管边界

stale 锁接管只以 hard-link claim 作为 canonical inode 的原子捕获证据。只有 manifest 而没有同 token claim 时，该 unique JSON 没有引用 canonical inode，因此既不形成锁 barrier，也不授权删除 canonical；fresh、损坏或 token 不匹配的 manifest-only 记录保留，只有结构与 token 完整、已 stale 且 reclaimer 明确死亡或 PID 复用时，才只删除该 unique manifest。一旦 hard-link claim 存在，损坏或错配的二件套证据继续 fail-closed。

## Windows 安全边界

Windows 状态目录的当前实现使用受保护 DACL：owner 为当前用户，继承关闭且仅有一条当前用户 `FullControl` 显式 allow ACE，不包含 SYSTEM ACE，并拒绝 reparse point。ACL helper 只运行固定绝对 PowerShell 程序；ACL 路径请求以 Base64 JSON 通过 stdin 输入，进程身份查询的 PID 则以 UTF-8 十进制文本做 Base64 后通过 stdin 输入，二者都不进入 argv。Windows Token fallback 的 read/write/remove 均 fail-closed。当前只完成可控 native runner 合同测试，尚未在真实 Windows 主机验证，不声称 Windows 实机 PASS。

## 范围边界

**第一版不支持 Accio connector。** 我们在检索范围内没有找到可据以实现和验证 custom Connector 的 manifest schema、device-code 字段与 validator，按"不猜接口"的原则没有做适配。这是对我们检索结果的说明，不是对 Accio 官方资料的判断——拿到合同后会在后续版本补上。

## 发布面

`pnpm pack` 的冻结 tarball 只包含以下 15 项：

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

包只暴露 `adrate` 二进制，`exports` 为空，不支持从包根或 `scripts/keychain-smoke.mjs` 子路径作为库导入。发布包保留 `dist/bin.js.map` 用于定位栈，但关闭 `sourcesContent`，不在 source map 中嵌入源码正文。包不发布源码、测试、lockfile 或主站私有模块。
