# @adrate/cli

AdRate Public API 的官方薄客户端。当前版本支持 Device Authorization、凭证诊断、Campaign 查询、单 Campaign ENABLE/DISABLE、显式反馈提交，以及两项 Agent Skills。

CLI 与 Agent Skills 分两步安装：

```bash
npm install -g @adrate/cli
adrate skills install
```

## 命令面

```text
adrate auth login [--no-wait | --resume | --device] [--device-name <name>]
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
adrate feedback --category blocked|bug|suggestion|other (--message <text> | --message-stdin)
adrate skills list
adrate skills read <name> [path]
```

生产环境是默认 issuer。只有本地尚无凭据并创建新 Device Flow 时，才可通过 `--test` 选择测试环境。CLI 不支持任意 base URL、关闭 TLS、团队切换或多 Profile。

`auth login --device` 面向 device-code 机器消费方：发码后先在 stdout 输出一行顶层 JSON，包含 `verificationUriComplete`、`verificationUri`、`userCode` 和 `expiresIn`，然后继续轮询直到授权或过期。它与 `--no-wait` / `--resume` 互斥；与 `--json` 同用时 stdout 共两行 JSON，第一行是 device-code 字段，第二行是最终 envelope。

`/public/v1/me` 是激活新 Session 的服务端 Endpoint。本地存在 Token 时，`auth status` 和 `auth whoami` 都会调用它。

## 认证与本地状态

Device Token 响应按最小瞬态状态恢复，不保存 Token 副本或本地交付账本。提交凭据前会核对发起登录时的 generation/flow identity，旧登录结果不得覆盖或删除后来写入的凭据。无法安全确认 Token 已提交时，CLI 会清理同代瞬态状态并要求重新登录；未激活 Session 由服务端自然失效。

`auth logout` 只有在服务端返回精确 revoked 成功体，或精确业务码 `INVALID_CREDENTIAL`、`CREDENTIAL_EXPIRED`、`USER_DISABLED` 时才清理仍匹配的本地凭据。transport 失败、HTTP 401/403、`OWNER_REQUIRED`、未知业务码和其他不确定结果都会保留凭据，报告 unknown 并退出 5，用户可以重试或在网页确认。如果 TokenIndex 存在但 secret 已确认缺失，显式 logout 只清理本地残留，仍报告远端状态 unknown 并退出 5。

CLI 通过精确锁定的可选依赖 `@github/keytar@7.10.6` 优先使用操作系统 Keychain。新登录无法使用 Keychain 时，CLI 会明确警告并改用经过权限检查的 fallback 文件；已经由本地 index 固定为 Keychain 的凭据不会静默降级。状态目录和文件继续执行权限、symlink、路径 containment、原子替换与 Windows ACL 检查。

维护者只有在显式确认后才运行真实 Keychain 往返 smoke：

```bash
ADRATE_CONFIRM_REAL_KEYCHAIN_SMOKE=1 pnpm smoke:keychain
```

## 写命令恢复

Campaign Status 写操作保存最小 pending，包含 credentialId、issuer、idempotencyKey、capability、目标资源、原始 intent/payload 和时间。同资源已有未决操作时，不会用新 Key 覆盖；transport 失败或证据不足时保留 pending 并退出 5。

`commands resume` 先按原 idempotency key 查询，只有服务端精确返回 404 且 pending 未超过恢复期限时，才用原 Key 和原 payload 重发。CLI 只有同时确认凭据、Key、capability、目标资源、commandId 与正面终态证据全部匹配，才报告成功；其余结果保留恢复入口，不会把 unknown 当成功。

## 显式反馈

`adrate feedback` 只在用户或 Agent 显式调用时发送一次 15 秒 JSON POST。提交前必须删除 Token、Authorization/Cookie、密码、device code、TikTok access token、个人信息、完整广告 payload、环境变量、日志和堆栈；服务端已知模式清洗只是兜底，不能证明正文安全。CLI 只附带自身版本、平台架构和 Node 版本，不附带 hostname、cwd、路径、命令历史或环境变量。自由文本优先通过 `--message-stdin` 传递；`--message` 只适合已确认不敏感的短文本，因为它可能留在 shell history 或进程 argv 中。不得把正文拼接进 shell 命令字符串。CLI 不会自动上报、后台重试或写入 pending 账本。若回执不可确认，失败输出会显示本次 idempotency key；只能用同一 category、同一 message 和同一 key 有界重试。

## Agent Skills

两项 Skill 固定为 `adrate-shared` 和 `adrate-ads`。`skills-content` 保存完整正文，`skills` 保存安装壳、manifest 和 OpenAI 配置。

`adrate skills install` 只从当前 npm 包复制固定白名单内的文件到 `~/.agents/skills/`，不联网、不调用 git。安装前会校验 Skill 名称、frontmatter/manifest/openai schema、包内摘要、UTF-8、大小、安全相对路径和普通文件边界；写入使用临时目录与原子替换。旧 CLI 不会静默覆盖版本更高的已安装 Skill。

`skills list/read` 不需要认证且不发网络请求。CLI 启动时可以通过 `_notice.skills` 提示缺失或需要更新的安装项；设置 `ADRATE_NO_SKILLS_NOTIFIER=1` 可关闭这项本地检查，不影响业务退出码。

## Windows 边界

Windows 状态目录使用受保护 DACL，并拒绝 reparse point。ACL helper 只运行固定的 PowerShell 程序，路径和 PID 输入都不进入 argv。Token fallback 的 read/write/remove 固定 fail-closed。正式版发布前仍需完成真实 Windows 普通用户环境验收；合同测试不能替代真机结论。

## 范围边界

CLI 包只提供 `auth login --device` 的通用 device-code 机器输出与本地认证状态管理。第三方平台的 Plugin manifest、Connector、Skill 包和平台验收不属于 npm 包内容。

## 发布面

包只暴露 `adrate` 二进制，`exports` 为空，不支持把包根或维护脚本当作库导入。发布包保留不含 `sourcesContent` 的 source map 以便定位栈，不发布 TypeScript 源码、测试、lockfile、release 资料或主站私有模块。

tarball 的机器清单只维护在发布校验代码中，不在 README 复制。发布 workflow 的 verify job 完成测试、构建、一次 pack、内容与秘密扫描和 packed smoke；publish job 只核对同一制品的身份与 SHA-256，再通过 npm Trusted Publishing 发布该 tarball。
