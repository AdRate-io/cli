import packageMetadata from "../package.json" with { type: "json" }

declare const __ADRATE_CLI_VERSION__: string

/**
 * CLI 版本由构建/测试配置从 package.json 注入，避免源码与包元数据双写。
 * 被主仓库合同测试直接加载源码时，仍从同一 package.json 读取。
 */
export const CLI_VERSION =
  typeof __ADRATE_CLI_VERSION__ === "string"
    ? __ADRATE_CLI_VERSION__
    : packageMetadata.version
