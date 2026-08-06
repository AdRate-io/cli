# Accio Work Connector 兼容性核验

核验日期：2026-08-01。范围决策更新：2026-08-02。

**范围决策（2026-08-02，2026-08-05 更新发布边界）**：**@adrate/cli 第一版不支持 Accio connector。** 我们在检索范围内没有找到可据以实现和验证 custom Connector 的正式合同，按"不猜接口"的原则没有做适配，留到后续版本。CLI-CLEANUP 已删除旧 external gate/evidence/pin/readiness 机制，Accio 不进入现行 npm 发布流程；本文件只记录"尚未适配"的事实和重新评估条件。

结论：正式适配保持 `BLOCKED`。**这是对我们检索结果的记录，不是对 Accio 官方资料完备性的判断。** 截至核验日，我们在下列公开入口中未能找到 custom Connector manifest 的 Schema、目录/文件名、device-code 字段、官方 validator 命令或 import smoke 命令。因此本仓库没有生成 connector manifest，也没有把冻结设计稿中的历史 API Key 形状改写成看似有效的 device-code manifest。

## 我们检索过的公开入口

| 资料                        | URL                                                   | 我们看到的                                          | 我们未找到的                                             |
| --------------------------- | ----------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| Accio Work Connector guide  | https://www1.accio.com/work/doc?slug=connectors-guide | 公开的 Connector 使用说明                           | custom manifest Schema/目录、device-code 字段、validator |
| Accio Work changelog        | https://www1.accio.com/work/doc?slug=changelog        | 核验时可见的最新版本为 v0.25.0，发布日期 2026-07-22 | 上述 custom Connector 合同的补充说明                     |
| 官方 npm 包 `@accio-ai/cli` | https://www.npmjs.com/package/@accio-ai/cli           | 公开的 CLI 包入口                                   | 可据以实现和验证 custom Connector 的 Schema/validator    |

⚠️ **这三行只描述我们的检索结果，不构成对 Accio 的任何断言。** 相关合同完全可能存在于 Accio 的私有控制台、受限文档、我们未检索到的位置或更新的版本中。拿到官方 schema/tool/access 后必须重新核验并记录精确版本、发布日期、命令和脱敏输出。

## 已冻结的 AdRate 输入，不是 Accio 字段声明

下列语义来自 AdRate T01-T10 合同，只能作为未来映射输入，不能据此猜 Accio 字段名：

- OAuth 模式为 Device Authorization，不回退 API Key-first。
- production 发码与 token URL 分别为 `https://api.adrate.io/oauth/device/code`、`https://api.adrate.io/oauth/token`；test issuer 必须隔离。
- `client_id=adrate-cli`。
- scope 精确为 `identity.read connections.read ads.campaign.read ads.report.read ads.campaign.status.write feedback.write`。
- 单活动 Session，预期 `multiAccount=false`。
- 可执行程序为 `adrate`，logout 命令为 `adrate auth logout`。
- 连接态只观察用户目录下 `.adrate/credentials.json`；该文件不含 Token，Token 仍进 Keychain 或安全 fallback。

## 解锁条件

只有以下资料我们都拿到了，才能创建 manifest、更新兼容性结论并重新评估是否纳入产品范围：

1. Accio custom Connector 的 manifest Schema、规定目录/文件名和 device-code 字段合同。
2. 官方 validator 的名称、版本、安装来源和可复现命令。
3. 官方 import smoke 的可复现命令与脱敏 PASS 输出。
4. Accio 真实沙箱中 device-code、六项 M0 scope、无 API Key/client secret、连接态、logout 双清、0600 fallback 的实测。
5. Boss 确认真实账户规模/轮询节奏可被 3000 单位/日覆盖。

在解锁前不得创建任何猜测性 manifest；本地 CLI build/test 和 npm 发布不因外部资料缺失而失败。
