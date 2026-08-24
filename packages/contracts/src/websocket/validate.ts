/** WebSocket JSON 消息的边界校验器；不建立连接，也不执行任务。 */

import {
  ContractValidationError,
  createIssue,
  type ValidationIssue,
  type ValidationPathSegment,
  type ValidationSuccess,
} from '../validation/issue';
import {
  describeValueType,
  findUnknownProperties,
  isFiniteNumber,
  isIso8601UtcString,
  isNonNegativeInteger,
  isPlainObject,
  isPlainText,
  isString,
} from '../validation/primitives';
import { isAgentReportableTaskStatus } from '../task/task-status';
import { isLogStream } from '../task/task-log';
import {
  isSupportedProtocolVersion,
  LEASE_TOKEN_PATTERN,
  PROTOCOL_ENVELOPE_PROPERTIES,
  PROTOCOL_ID_PATTERN,
} from './protocol';
import {
  isAgentToServerMessageType,
  isProtocolMessageType,
  isServerToAgentMessageType,
  type AgentToServerMessageType,
  type ServerToAgentMessageType,
} from './message-types';
import type { AgentToServerMessage } from './agent-to-server';
import type { ServerToAgentMessage } from './server-to-agent';

export const PROTOCOL_MESSAGE_ISSUE_CODES = [
  'MESSAGE_NOT_OBJECT',
  'UNKNOWN_PROPERTY',
  'ID_INVALID',
  'TYPE_INVALID',
  'TIMESTAMP_INVALID',
  'PROTOCOL_VERSION_INVALID',
  'PAYLOAD_INVALID',
  'PROPERTY_MISSING',
  'PROPERTY_INVALID',
  'TASK_ID_INVALID',
  'LEASE_TOKEN_INVALID',
  'GIT_CREDENTIALS_FORBIDDEN',
] as const;

export type ProtocolMessageIssueCode = (typeof PROTOCOL_MESSAGE_ISSUE_CODES)[number];
export type ProtocolMessageIssue = ValidationIssue<ProtocolMessageIssueCode>;
export interface ProtocolMessageValidationFailure {
  readonly ok: false;
  readonly issues: readonly ProtocolMessageIssue[];
}
export type ProtocolMessage = ServerToAgentMessage | AgentToServerMessage;
export type ProtocolMessageValidationResult =
  ValidationSuccess<ProtocolMessage> | ProtocolMessageValidationFailure;

type MessageObject = Record<string, unknown>;

function issue(
  issues: ProtocolMessageIssue[],
  code: ProtocolMessageIssueCode,
  path: readonly ValidationPathSegment[],
  message: string,
): void {
  issues.push(createIssue(code, path, message));
}

function objectValue(
  value: unknown,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): MessageObject | undefined {
  if (!isPlainObject(value)) {
    issue(issues, 'PAYLOAD_INVALID', path, `必须是对象，实际为 ${describeValueType(value)}`);
    return undefined;
  }
  return value;
}

function unknownProperties(
  value: MessageObject,
  allowed: readonly string[],
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  for (const key of findUnknownProperties(value, allowed))
    issue(issues, 'UNKNOWN_PROPERTY', [...path, key], `不允许的属性 ${JSON.stringify(key)}`);
}

function stringProperty(
  value: MessageObject,
  key: string,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
  required: boolean,
  plain: boolean,
): void {
  const raw = value[key];
  if (raw === undefined && !required) return;
  if (!(isString(raw) && raw.length > 0 && (!plain || isPlainText(raw))))
    issue(
      issues,
      required && raw === undefined ? 'PROPERTY_MISSING' : 'PROPERTY_INVALID',
      [...path, key],
      `${key} 必须是非空字符串`,
    );
}

function optionalText(
  value: MessageObject,
  key: string,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  const raw = value[key];
  if (raw !== undefined && !(isString(raw) && isPlainText(raw)))
    issue(issues, 'PROPERTY_INVALID', [...path, key], `${key} 必须是纯文本字符串`);
}

function idProperty(
  value: MessageObject,
  key: string,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
  nullable = false,
): void {
  const raw = value[key];
  if (nullable && raw === null) return;
  if (!(isString(raw) && PROTOCOL_ID_PATTERN.test(raw)))
    issue(
      issues,
      raw === undefined ? 'PROPERTY_MISSING' : 'ID_INVALID',
      [...path, key],
      `${key} 必须是协议标识${nullable ? '或 null' : ''}`,
    );
}

function leaseProperty(
  value: MessageObject,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  const raw = value.leaseToken;
  if (!(isString(raw) && LEASE_TOKEN_PATTERN.test(raw)))
    issue(
      issues,
      raw === undefined ? 'PROPERTY_MISSING' : 'LEASE_TOKEN_INVALID',
      [...path, 'leaseToken'],
      'leaseToken 格式非法',
    );
}

function taskLease(
  value: MessageObject,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  idProperty(value, 'taskId', path, issues);
  leaseProperty(value, path, issues);
}

function timeProperty(
  value: MessageObject,
  key: string,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  if (!isIso8601UtcString(value[key]))
    issue(
      issues,
      value[key] === undefined ? 'PROPERTY_MISSING' : 'TIMESTAMP_INVALID',
      [...path, key],
      `${key} 必须是 ISO 8601 UTC 时间`,
    );
}

function positiveInteger(
  value: MessageObject,
  key: string,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  if (!(isNonNegativeInteger(value[key]) && (value[key] as number) > 0))
    issue(issues, 'PROPERTY_INVALID', [...path, key], `${key} 必须是正整数`);
}

function nonNegativeInteger(
  value: MessageObject,
  key: string,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
  required = false,
): void {
  if (value[key] === undefined && !required) return;
  if (!isNonNegativeInteger(value[key]))
    issue(
      issues,
      required && value[key] === undefined ? 'PROPERTY_MISSING' : 'PROPERTY_INVALID',
      [...path, key],
      `${key} 必须是非负安全整数`,
    );
}

function stringArray(
  value: MessageObject,
  key: string,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  const raw = value[key];
  if (!Array.isArray(raw) || raw.some((item) => !(isString(item) && item.length > 0)))
    issue(
      issues,
      raw === undefined ? 'PROPERTY_MISSING' : 'PROPERTY_INVALID',
      [...path, key],
      `${key} 必须是非空字符串数组`,
    );
}

function configValue(value: unknown): boolean {
  return (
    value === null ||
    isString(value) ||
    (isFiniteNumber(value) && !Number.isNaN(value)) ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => isString(item) || isFiniteNumber(item)))
  );
}

function configObject(
  raw: unknown,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  const config = objectValue(raw, path, issues);
  if (config === undefined) return;
  for (const [key, value] of Object.entries(config))
    if (!PROTOCOL_ID_PATTERN.test(key) || !configValue(value))
      issue(issues, 'PROPERTY_INVALID', [...path, key], 'config 只能包含协议键名和 JSON 基础值');
}

function gitSource(
  raw: unknown,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  const git = objectValue(raw, path, issues);
  if (git === undefined) return;
  unknownProperties(git, ['url', 'branch'], path, issues);
  stringProperty(git, 'url', path, issues, true, true);
  stringProperty(git, 'branch', path, issues, true, true);
  const gitUrlUserInfo = isString(git.url)
    ? /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)@/.exec(git.url)
    : undefined;
  if (
    gitUrlUserInfo !== null &&
    gitUrlUserInfo !== undefined &&
    !(gitUrlUserInfo[1].toLowerCase() === 'ssh' && gitUrlUserInfo[2] === 'git')
  )
    issue(issues, 'GIT_CREDENTIALS_FORBIDDEN', [...path, 'url'], 'Git URL 不得包含凭据');
}

function artifactFiles(
  raw: unknown,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  if (!Array.isArray(raw)) {
    issue(issues, 'PROPERTY_INVALID', path, 'files 必须是数组');
    return;
  }
  raw.forEach((item, index) => {
    const filePath = [...path, index];
    const file = objectValue(item, filePath, issues);
    if (file === undefined) return;
    unknownProperties(file, ['relativePath', 'size', 'sha256'], filePath, issues);
    stringProperty(file, 'relativePath', filePath, issues, true, true);
    nonNegativeInteger(file, 'size', filePath, issues, true);
    if (
      isString(file.relativePath) &&
      (file.relativePath.startsWith('/') ||
        file.relativePath.startsWith('\\') ||
        file.relativePath.includes('..') ||
        file.relativePath.includes('\\'))
    )
      issue(
        issues,
        'PROPERTY_INVALID',
        [...filePath, 'relativePath'],
        'relativePath 必须是安全的相对路径',
      );
    if (!(isString(file.sha256) && /^[a-f0-9]{64}$/.test(file.sha256)))
      issue(
        issues,
        'PROPERTY_INVALID',
        [...filePath, 'sha256'],
        'sha256 必须是 64 位小写十六进制摘要',
      );
  });
}

function serverPayload(
  type: ServerToAgentMessageType,
  raw: unknown,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  const value = objectValue(raw, path, issues);
  if (value === undefined) return;
  switch (type) {
    case 'agent.registered':
      unknownProperties(
        value,
        [
          'agentId',
          'agentName',
          'heartbeatIntervalSeconds',
          'heartbeatTimeoutSeconds',
          'serverTime',
        ],
        path,
        issues,
      );
      idProperty(value, 'agentId', path, issues);
      stringProperty(value, 'agentName', path, issues, true, true);
      positiveInteger(value, 'heartbeatIntervalSeconds', path, issues);
      positiveInteger(value, 'heartbeatTimeoutSeconds', path, issues);
      timeProperty(value, 'serverTime', path, issues);
      return;
    case 'task.available':
      unknownProperties(value, ['agentId', 'queuedTaskCount'], path, issues);
      idProperty(value, 'agentId', path, issues);
      nonNegativeInteger(value, 'queuedTaskCount', path, issues);
      return;
    case 'task.assignment':
      unknownProperties(
        value,
        [
          'taskId',
          'leaseToken',
          'leaseExpiresAt',
          'agentId',
          'projectId',
          'buildTemplateId',
          'git',
          'command',
          'artifactDir',
          'timeoutSeconds',
          'config',
          'sensitiveConfigKeys',
        ],
        path,
        issues,
      );
      taskLease(value, path, issues);
      timeProperty(value, 'leaseExpiresAt', path, issues);
      idProperty(value, 'agentId', path, issues);
      idProperty(value, 'projectId', path, issues);
      idProperty(value, 'buildTemplateId', path, issues);
      gitSource(value.git, [...path, 'git'], issues);
      stringProperty(value, 'command', path, issues, true, false);
      stringProperty(value, 'artifactDir', path, issues, true, true);
      positiveInteger(value, 'timeoutSeconds', path, issues);
      configObject(value.config, [...path, 'config'], issues);
      stringArray(value, 'sensitiveConfigKeys', path, issues);
      return;
    case 'task.cancel':
      unknownProperties(value, ['taskId', 'leaseToken', 'requestedAt', 'reason'], path, issues);
      taskLease(value, path, issues);
      timeProperty(value, 'requestedAt', path, issues);
      optionalText(value, 'reason', path, issues);
      return;
    case 'agent.token.revoked':
      unknownProperties(value, ['agentId', 'revokedAt', 'reason'], path, issues);
      idProperty(value, 'agentId', path, issues);
      timeProperty(value, 'revokedAt', path, issues);
      optionalText(value, 'reason', path, issues);
      return;
  }
}

function currentTask(
  raw: unknown,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  const value = objectValue(raw, path, issues);
  if (value === undefined) return;
  unknownProperties(value, ['taskId', 'leaseToken', 'status', 'lastLogSequence'], path, issues);
  taskLease(value, path, issues);
  if (!isAgentReportableTaskStatus(value.status))
    issue(issues, 'PROPERTY_INVALID', [...path, 'status'], 'status 必须是 Agent 可上报阶段');
  positiveInteger(value, 'lastLogSequence', path, issues);
}

function agentPayload(
  type: AgentToServerMessageType,
  raw: unknown,
  path: readonly ValidationPathSegment[],
  issues: ProtocolMessageIssue[],
): void {
  const value = objectValue(raw, path, issues);
  if (value === undefined) return;
  switch (type) {
    case 'agent.hello':
      unknownProperties(
        value,
        ['agentId', 'agentVersion', 'hostname', 'os', 'arch', 'workspaceRoot', 'currentTask'],
        path,
        issues,
      );
      idProperty(value, 'agentId', path, issues, true);
      stringProperty(value, 'agentVersion', path, issues, true, true);
      stringProperty(value, 'hostname', path, issues, true, true);
      stringProperty(value, 'os', path, issues, true, true);
      stringProperty(value, 'arch', path, issues, true, true);
      stringProperty(value, 'workspaceRoot', path, issues, true, true);
      if (value.currentTask !== undefined && value.currentTask !== null)
        currentTask(value.currentTask, [...path, 'currentTask'], issues);
      return;
    case 'agent.heartbeat':
      unknownProperties(value, ['agentId', 'currentTaskId'], path, issues);
      idProperty(value, 'agentId', path, issues);
      idProperty(value, 'currentTaskId', path, issues, true);
      if (!('currentTaskId' in value))
        issue(issues, 'PROPERTY_MISSING', [...path, 'currentTaskId'], '缺少 currentTaskId');
      return;
    case 'task.claim':
      unknownProperties(value, ['agentId', 'taskId'], path, issues);
      idProperty(value, 'agentId', path, issues);
      idProperty(value, 'taskId', path, issues, true);
      return;
    case 'task.accepted':
      unknownProperties(value, ['taskId', 'leaseToken', 'acceptedAt'], path, issues);
      taskLease(value, path, issues);
      timeProperty(value, 'acceptedAt', path, issues);
      return;
    case 'task.status':
      unknownProperties(
        value,
        ['taskId', 'leaseToken', 'status', 'occurredAt', 'reason', 'sourceCommit'],
        path,
        issues,
      );
      taskLease(value, path, issues);
      if (!isAgentReportableTaskStatus(value.status))
        issue(issues, 'PROPERTY_INVALID', [...path, 'status'], 'status 必须是 Agent 可上报阶段');
      timeProperty(value, 'occurredAt', path, issues);
      optionalText(value, 'reason', path, issues);
      optionalText(value, 'sourceCommit', path, issues);
      return;
    case 'task.log':
      unknownProperties(
        value,
        ['taskId', 'leaseToken', 'sequence', 'stream', 'chunk', 'emittedAt'],
        path,
        issues,
      );
      taskLease(value, path, issues);
      positiveInteger(value, 'sequence', path, issues);
      if (!isLogStream(value.stream))
        issue(issues, 'PROPERTY_INVALID', [...path, 'stream'], 'stream 必须是 stdout 或 stderr');
      if (!isString(value.chunk))
        issue(issues, 'PROPERTY_INVALID', [...path, 'chunk'], 'chunk 必须是字符串');
      timeProperty(value, 'emittedAt', path, issues);
      return;
    case 'task.artifact-manifest':
      unknownProperties(
        value,
        ['taskId', 'leaseToken', 'artifactDir', 'totalBytes', 'files'],
        path,
        issues,
      );
      taskLease(value, path, issues);
      stringProperty(value, 'artifactDir', path, issues, true, true);
      nonNegativeInteger(value, 'totalBytes', path, issues, true);
      artifactFiles(value.files, [...path, 'files'], issues);
      return;
    case 'task.completed':
      unknownProperties(
        value,
        [
          'taskId',
          'leaseToken',
          'exitCode',
          'finishedAt',
          'artifactCount',
          'artifactBytes',
          'sourceCommit',
        ],
        path,
        issues,
      );
      taskLease(value, path, issues);
      if (!(Number.isInteger(value.exitCode) && isFiniteNumber(value.exitCode)))
        issue(
          issues,
          value.exitCode === undefined ? 'PROPERTY_MISSING' : 'PROPERTY_INVALID',
          [...path, 'exitCode'],
          'exitCode 必须是整数',
        );
      timeProperty(value, 'finishedAt', path, issues);
      nonNegativeInteger(value, 'artifactCount', path, issues, true);
      nonNegativeInteger(value, 'artifactBytes', path, issues, true);
      optionalText(value, 'sourceCommit', path, issues);
      return;
    case 'task.failed':
      unknownProperties(
        value,
        ['taskId', 'leaseToken', 'reason', 'failedAt', 'exitCode'],
        path,
        issues,
      );
      taskLease(value, path, issues);
      stringProperty(value, 'reason', path, issues, true, true);
      timeProperty(value, 'failedAt', path, issues);
      if (
        value.exitCode !== undefined &&
        !(Number.isInteger(value.exitCode) && isFiniteNumber(value.exitCode))
      )
        issue(issues, 'PROPERTY_INVALID', [...path, 'exitCode'], 'exitCode 必须是整数');
      return;
    case 'task.canceled':
      unknownProperties(value, ['taskId', 'leaseToken', 'canceledAt', 'reason'], path, issues);
      taskLease(value, path, issues);
      timeProperty(value, 'canceledAt', path, issues);
      optionalText(value, 'reason', path, issues);
      return;
  }
}

export function validateProtocolMessage(input: unknown): ProtocolMessageValidationResult {
  const issues: ProtocolMessageIssue[] = [];
  if (!isPlainObject(input))
    return {
      ok: false,
      issues: [
        createIssue('MESSAGE_NOT_OBJECT', [], `消息必须是对象，实际为 ${describeValueType(input)}`),
      ],
    };
  unknownProperties(input, PROTOCOL_ENVELOPE_PROPERTIES, [], issues);
  idProperty(input, 'id', [], issues);
  const type = input.type;
  if (!isProtocolMessageType(type))
    issue(
      issues,
      type === undefined ? 'PROPERTY_MISSING' : 'TYPE_INVALID',
      ['type'],
      'type 不是已知协议消息类型',
    );
  if (!isIso8601UtcString(input.timestamp))
    issue(
      issues,
      input.timestamp === undefined ? 'PROPERTY_MISSING' : 'TIMESTAMP_INVALID',
      ['timestamp'],
      'timestamp 必须是 ISO 8601 UTC 时间',
    );
  if (!isSupportedProtocolVersion(input.protocolVersion))
    issue(
      issues,
      input.protocolVersion === undefined ? 'PROPERTY_MISSING' : 'PROTOCOL_VERSION_INVALID',
      ['protocolVersion'],
      '不支持该协议版本',
    );
  const payload = objectValue(input.payload, ['payload'], issues);
  if (payload !== undefined && isProtocolMessageType(type)) {
    if (isServerToAgentMessageType(type)) serverPayload(type, payload, ['payload'], issues);
    else if (isAgentToServerMessageType(type)) agentPayload(type, payload, ['payload'], issues);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: input as unknown as ProtocolMessage };
}

export function isProtocolMessage(input: unknown): input is ProtocolMessage {
  return validateProtocolMessage(input).ok;
}

export function parseProtocolMessage(input: unknown): ProtocolMessage {
  const result = validateProtocolMessage(input);
  if (!result.ok) throw new ContractValidationError('WebSocket 消息校验失败', result.issues);
  return result.value;
}
