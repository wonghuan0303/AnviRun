/**
 * 构建日志流类型。
 *
 * 产品设计第 11 节要求 Agent 按字节流读取 stdout/stderr，因此日志分片必须标注来源流，
 * 便于前端区分渲染与问题定位。
 */

import { parseEnumValue } from '../validation/enum';

/** 日志来源流，顺序稳定。 */
export const LOG_STREAMS = ['stdout', 'stderr'] as const;

/** 日志来源流。 */
export type LogStream = (typeof LOG_STREAMS)[number];

/** {@link parseLogStream} 校验失败时使用的问题码。 */
export const LOG_STREAM_INVALID_CODE = 'LOG_STREAM_INVALID';

/** 判断是否为合法日志流类型。 */
export function isLogStream(value: unknown): value is LogStream {
  return typeof value === 'string' && (LOG_STREAMS as readonly string[]).includes(value);
}

/** 解析日志流类型，非法值抛出 `ContractValidationError`。 */
export function parseLogStream(value: unknown): LogStream {
  return parseEnumValue(LOG_STREAMS, value, {
    code: LOG_STREAM_INVALID_CODE,
    label: '日志流类型',
  });
}
