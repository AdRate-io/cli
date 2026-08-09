# Accio Work 兼容性记录

核验日期：2026-08-08。

本文件记录 AdRate 可保证的 CLI 兼容性事实，不是 Accio 官方 validator 输出，也不把第三方平台未公开信息写成结论。Accio Plugin manifest、Connector、平台专用 Skill 与原始自检证据位于私有仓库范围，不进入 npm 包或 CLI 公开镜像。

## 当前结论

- CLI 已提供 `auth login --device` 的通用 device-code 机器输出、凭据归一化、连接态检查与 logout 本地状态清理。
- 私有 Accio Plugin 的 Phase A-D(macOS) 已于 2026-08-06 完成本地导入与自检，既有加权结果为 4.85/5.0。
- npm 当前已发布版本与私有 Accio Plugin 精确 pin 均为 `0.1.0-beta.7`。
- CLI 能力扩展 Phase 1-4 已完成本地源码，固定签发 16 项 capability，但这些新增能力尚未发布新的不可变 prerelease，因此当前 Accio pin 不承载本轮源码。
- Windows 实测、使用新 prerelease 的重新导入验证与 Accio 平台审核仍待完成，不能写成已通过或已上线。

## AdRate 可保证的机器合同

- OAuth 使用 Device Authorization，不回退 API Key/client secret。
- production 发码与 token URL 分别为 `https://api.adrate.io/oauth/device/code`、`https://api.adrate.io/oauth/token`；test issuer 独立。
- `client_id=adrate-cli`。
- `auth login --device` 先输出一行 device-code JSON，再继续有界轮询；与 `--json` 同用时最终 envelope 是第二行 JSON。
- Session 固定一个团队，不支持团队切换、多 Profile、任意 base URL 或开发 issuer。
- 连接态只读取用户目录下 `.adrate/credentials.json`；该文件不保存 Token，Token 进入 Keychain 或受保护 fallback。
- CLI 源码的授权 scope 是包根 `README.md` 所列精确有序 16 项 capability。

## 版本与验证矩阵

| 对象 | 版本或状态 | 已验证范围 |
| --- | --- | --- |
| npm 当前发布 | `0.1.0-beta.7` | 已发布，dist-tag `next` |
| 私有 Accio CLI/Connector pin | `0.1.0-beta.7` | macOS 本地导入与自检已完成 |
| Phase 1-4 本地源码 | 16 项 capability | 单测、类型与本地制品门禁；尚未发布 |
| 下一 prerelease | 待发布时确定 | 未发布、未更新 pin、未做平台验证 |
| Windows | 待 Boss 实测 | 未完成 |
| Accio 平台审核 | 待外部提交 | 未完成 |

## 后续门禁

1. Boss 完成测试环境与正式环境 E2E，以及 Windows 普通用户环境验收。
2. 选择新的 prerelease 版本号，按单向镜像与单制品链路发布，并核验 npm 精确版本。
3. 仅在发布成功后更新私有 `clis.json` 与 `connectors.json` 的两个精确 pin。
4. 使用新 pin 重新导入 Accio，复核 device-code、16 项 scope、连接态、logout 与 fallback 权限。
5. 完成平台审核所需的外部提交与结果记录。

在以上门禁完成前，不修改 beta.7 pin，不声称 Phase 1-4 已通过 Accio 或已经上线。
