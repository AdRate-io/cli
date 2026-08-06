# @adrate/cli 0.1.0 发布说明草案

本文覆盖 `0.1.0` release train。下一 prerelease 候选为 `0.1.0-beta.6`，dist-tag 为 `next`；正式 `0.1.0` 尚未发布。

## 安装

prerelease：

```bash
npm install -g @adrate/cli@next
adrate skills install
```

正式版发布后：

```bash
npm install -g @adrate/cli
adrate skills install
```

## M0 能力

- Device Authorization 登录、凭证状态、身份查询和 logout。
- Public API capabilities/schema 自描述。
- Advertiser、Campaign 与 Campaign Report 只读查询。
- 单 Campaign ENABLE/DISABLE，以及按原 idempotency key 查询和恢复未决 Command。
- 显式 `adrate feedback` 反馈提交；不自动上报，不进入 Command pending 恢复链路。
- `adrate-shared`、`adrate-ads` 两项 Agent Skills 的安装、列举和读取。

完整命令面见包根 `README.md` 或 `adrate --help`。

## 本轮收口

- 远端响应只校验 CLI 实际消费的字段，允许新增展示字段和未知错误码，避免服务端安全扩展被旧 CLI 无故拒绝。
- Status 写操作只在凭据、idempotency key、capability、目标、commandId 和正面终态证据全部匹配时报告成功；transport 或证据不足保留 pending 并退出 5。
- Device login 只保留必要的安全 staging 和 generation/flow 防串线，不再维护本地交付账本；不确定结果可以重新登录。
- logout 不再持久化 delivery journal。不确定结果保留本地凭据，只有精确 revoked 或已确认失效的业务码才清理。
- 删除 CLI 更新联网检查及缓存。Skills 读取保持零网络，安装只校验当前包内的 schema、摘要与文件安全边界。
- 发布流程收敛为私有源单向镜像、version tag、verify 一次 pack、publish 同一 tarball。publish job 只复核制品身份和 SHA-256，不复制完整 verifier。

## 升级说明

当前没有外部用户，不为 beta 瞬态文件保留跨版本迁移层。升级时直接重装并重新 login；如果本地存在仍需恢复的 pending Command，先用旧版按原 idempotency key 恢复，再升级。

## 已知范围

- 第一版不支持 Accio connector。我们在检索范围内没有找到足以实现和验证 custom Connector 的 manifest schema、device-code 字段与 validator，因此没有猜接口。
- 首个 stable 发布前仍需完成 Boss 的端到端验收和真实 Windows 普通用户环境验收。
- 包只暴露 `adrate` 二进制，不提供库导入面；source map 不包含 `sourcesContent`。
