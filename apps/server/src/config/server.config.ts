/** 服务名称，用于日志与健康检查响应。 */
export const SERVICE_NAME = '@buildplatform/server';

/** 监听地址默认值：默认只监听本机，部署时通过 SERVER_HOST 显式放开。 */
export const DEFAULT_SERVER_HOST = '127.0.0.1';

/** 监听端口默认值。 */
export const DEFAULT_SERVER_PORT = 3000;

/** 解析后的监听参数。 */
export interface ServerListenOptions {
  host: string;
  port: number;
}

/** 环境变量中与监听相关的字段。 */
export interface ServerEnv {
  SERVER_HOST?: string | undefined;
  SERVER_PORT?: string | undefined;
}

/**
 * 从环境变量解析监听地址与端口。
 *
 * 缺失、空白或非法端口都回退到默认值，避免服务因配置错误无法启动。
 */
export function resolveServerListenOptions(env: ServerEnv): ServerListenOptions {
  const host = env.SERVER_HOST?.trim();
  const port = Number.parseInt(env.SERVER_PORT ?? '', 10);
  const portIsValid = Number.isInteger(port) && port > 0 && port <= 65535;

  return {
    host: host !== undefined && host.length > 0 ? host : DEFAULT_SERVER_HOST,
    port: portIsValid ? port : DEFAULT_SERVER_PORT,
  };
}
