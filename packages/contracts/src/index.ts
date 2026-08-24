/**
 * Web、Server 与（通过 JSON fixtures 对齐的）Rust Agent 共享的公共契约包。
 *
 * T0.1 只建立包结构与导出入口，故意不包含任何业务协议。
 * 角色、Agent 状态、任务状态机、配置表单 Schema、WebSocket 消息信封和
 * API 错误码在 T0.2 中定义，并从本文件统一导出。
 */

/** 契约包名称，便于运行期自检与日志输出。 */
export const CONTRACTS_PACKAGE_NAME = '@buildplatform/contracts';

/**
 * 契约包版本。
 *
 * 与协议版本（`protocolVersion`）不同：协议版本在 T0.2 随 WebSocket 消息信封一起定义。
 */
export const CONTRACTS_PACKAGE_VERSION = '0.1.0';

/** 契约包的基础元信息。 */
export interface ContractsPackageInfo {
  readonly name: typeof CONTRACTS_PACKAGE_NAME;
  readonly version: typeof CONTRACTS_PACKAGE_VERSION;
}

/** 返回契约包元信息，用于 Web/Server 启动自检。 */
export function getContractsPackageInfo(): ContractsPackageInfo {
  return {
    name: CONTRACTS_PACKAGE_NAME,
    version: CONTRACTS_PACKAGE_VERSION,
  };
}
