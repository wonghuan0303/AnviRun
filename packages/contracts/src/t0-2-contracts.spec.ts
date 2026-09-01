import { describe, expect, it } from 'vitest';

import validFormSchema from '../fixtures/valid-form-schema.json';
import invalidFormSchema from '../fixtures/invalid-form-schema.json';
import apiError from '../fixtures/api-error.json';
import serverMessages from '../fixtures/server-to-agent-messages.json';
import agentMessages from '../fixtures/agent-to-server-messages.json';
import invalidMessages from '../fixtures/invalid-messages.json';
import {
  API_ERROR_CODES,
  ACTIVE_TASK_STATUSES,
  BUILD_TASK_STATUSES,
  FORM_SCHEMA_JSON_SCHEMA,
  PROTOCOL_VERSION,
  TASK_STATUS_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  canTransitionTaskStatus,
  validateApiErrorResponse,
  validateFormSchema,
  validateProtocolMessage,
} from './index';

describe('T0.2 shared contract baseline', () => {
  it('parses the valid form fixture and normalizes password sensitivity', () => {
    const result = validateFormSchema(validFormSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(9);
      expect(result.value.find((field) => field.type === 'password')?.sensitive).toBe(true);
    }
  });

  it('rejects invalid controls, duplicate names, defaults and options', () => {
    const result = validateFormSchema(invalidFormSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((issue) => issue.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          'FIELD_TYPE_UNKNOWN',
          'FIELD_NAME_DUPLICATE',
          'DEFAULT_VALUE_TYPE_INVALID',
          'CONSTRAINT_RANGE_INVALID',
          'OPTION_VALUE_DUPLICATE',
        ]),
      );
      expect(result.issues.every((issue) => issue.pointer.length > 0)).toBe(true);
    }
  });

  it('keeps terminal states terminal and accepts every declared legal edge', () => {
    expect(TERMINAL_TASK_STATUSES).toEqual(['SUCCEEDED', 'FAILED', 'CANCELED']);
    expect(ACTIVE_TASK_STATUSES).toHaveLength(
      BUILD_TASK_STATUSES.length - TERMINAL_TASK_STATUSES.length,
    );
    for (const [from, targets] of Object.entries(TASK_STATUS_TRANSITIONS)) {
      for (const to of targets) expect(canTransitionTaskStatus(from, to)).toBe(true);
    }
    for (const terminal of TERMINAL_TASK_STATUSES) {
      for (const state of BUILD_TASK_STATUSES)
        expect(canTransitionTaskStatus(terminal, state)).toBe(false);
    }
    expect(canTransitionTaskStatus('RUNNING', 'SUCCEEDED')).toBe(false);
    expect(canTransitionTaskStatus('RUNNING', 'RUNNING')).toBe(false);
  });

  it('validates every server and agent message fixture', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(serverMessages).toHaveLength(12);
    expect(agentMessages).toHaveLength(10);
    for (const message of [...serverMessages, ...agentMessages])
      expect(validateProtocolMessage(message).ok).toBe(true);
    for (const message of invalidMessages) expect(validateProtocolMessage(message).ok).toBe(false);
  });

  it('validates the stable API error shape and blocks sensitive details', () => {
    expect(API_ERROR_CODES).toContain('TASK_LEASE_INVALID');
    expect(validateApiErrorResponse(apiError).ok).toBe(true);
    expect(
      validateApiErrorResponse({
        code: 'VALIDATION_FAILED',
        message: 'bad',
        details: { password: 'secret' },
      }).ok,
    ).toBe(false);
    expect(
      validateApiErrorResponse({ code: 'VALIDATION_FAILED', message: 'at fn (file.ts:1:2)' }).ok,
    ).toBe(false);
  });

  it('publishes a non-TypeScript JSON Schema with the same stable id', () => {
    expect(FORM_SCHEMA_JSON_SCHEMA.$id).toBe(
      'https://buildplatform.local/schemas/form-schema.schema.json',
    );
    expect(FORM_SCHEMA_JSON_SCHEMA.$schema).toContain('2020-12');
  });
});
