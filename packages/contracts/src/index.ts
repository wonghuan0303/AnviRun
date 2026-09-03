/** Web、Server 与 Rust Agent 共享的公共业务契约包。 */

/** 契约包名称，便于运行期自检与日志输出。 */
export const CONTRACTS_PACKAGE_NAME = '@anvilrun/contracts';

/** 契约包版本，与 WebSocket protocolVersion 不同。 */
export const CONTRACTS_PACKAGE_VERSION = '0.1.0';

export interface ContractsPackageInfo {
  readonly name: typeof CONTRACTS_PACKAGE_NAME;
  readonly version: typeof CONTRACTS_PACKAGE_VERSION;
}

export function getContractsPackageInfo(): ContractsPackageInfo {
  return { name: CONTRACTS_PACKAGE_NAME, version: CONTRACTS_PACKAGE_VERSION };
}

export * from './auth';
export * from './agent';
export * from './api';
export * from './form-schema';
export * from './task';
export * from './validation';
export * from './websocket';
