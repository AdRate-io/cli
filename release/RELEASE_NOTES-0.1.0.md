# @adrate/cli 0.1.0 发布说明草案

本文覆盖 `0.1.0` release train。npm 当前已发布版本是 `0.1.0-beta.7`（dist-tag `next`）；Phase 1-4 新能力已完成本地源码，但尚未发布新的 prerelease，正式 `0.1.0` 也尚未发布。

## 安装

当前已发布 prerelease：

```bash
npm install -g @adrate/cli@0.1.0-beta.7
adrate skills install
```

后续 prerelease 必须使用新的不可变版本号。发布并完成精确版本核验后，再更新安装命令与 Accio 私有插件 pin；不得复用 beta.7 承载新源码。

正式版发布后：

```bash
npm install -g @adrate/cli
adrate skills install
```

## CLI 能力

本地源码固定签发 16 项 capability，完整顺序见包根 `README.md`。命令面包括：

- Device Authorization、凭证状态、身份查询与 logout。
- Public API capabilities/schema 自描述，Advertiser、Ads Campaign、Campaign Report 与 GMV Max 查询。
- Ads Campaign Status/Budget 和 GMV Max Campaign Status/Budget/ROAS 五类 Command 写入，以及按原 idempotency key 查询和恢复。
- Ads 与 GMV Max 自动化规则查询、create/update/enable/disable/delete 与 dryrun；receipt 写入不进入 Command pending。
- Campaign Copy preview、submit、任务列表与详情；submit 受理不代表异步任务完成。
- 显式 `adrate feedback` 提交，不自动上报。
- `adrate-shared`、`adrate-ads` 两项 Agent Skills 的安装、列举和读取。

完整命令面见包根 `README.md` 或 `adrate --help`。

## 安全与恢复

- 远端响应只校验 CLI 实际消费字段，允许新增展示字段和未知错误码。
- Command 只有在凭据、idempotency key、capability、目标、commandId 与正面终态证据全部匹配时才报告成功；transport 或证据不足保留 pending 并退出 5。
- Rule 与 Campaign Copy submit 使用 receipt。结果不确定时用原 Key 和完全相同的输入重放，不改用 Command 恢复。
- Device login 只保留必要的安全 staging 与 generation/flow 防串线，不保存 Token 副本或本地交付账本。
- logout 不确定时保留本地凭据；只有精确 revoked 或已确认失效的业务码才清理。
- Skills 读取保持零网络，安装只校验当前包内 schema、摘要与文件安全边界。
- 发布流程固定为私有源单向镜像、version tag、verify 一次 pack、publish 同一 tarball。

## 升级说明

当前没有外部用户，不为 beta 瞬态文件保留跨版本迁移层。升级时直接重装并重新 login；如果本地存在仍需恢复的 pending Command，先用旧版按原 idempotency key 恢复，再升级。

## 发布前剩余门禁

- Boss 在真实测试环境和正式环境完成 E2E。
- Boss 在真实 Windows 普通用户环境完成安装与基本流程验收。
- 发布新的不可变 prerelease，并验证 npm 精确版本后，更新 Accio `clis.json` 与 `connectors.json` 的精确 pin。
- 用新版本重新完成 Accio 导入与平台验证；平台审核提交仍是外部动作。

本地单测、typecheck、build、pack 或 macOS 自检都不能替代上述门禁。包只暴露 `adrate` 二进制，不提供库导入面；source map 不包含 `sourcesContent`。
