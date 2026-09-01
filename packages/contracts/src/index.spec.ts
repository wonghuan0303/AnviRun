import { describe, expect, it } from 'vitest';

import {
  CONTRACTS_PACKAGE_NAME,
  CONTRACTS_PACKAGE_VERSION,
  getContractsPackageInfo,
} from './index';
import { MAX_AGENT_WS_MESSAGE_BYTES, MAX_CLIENT_WS_MESSAGE_BYTES } from './websocket';

describe('contracts package skeleton', () => {
  it('exposes the package name', () => {
    expect(CONTRACTS_PACKAGE_NAME).toBe('@buildplatform/contracts');
  });

  it('exposes a semver-like package version', () => {
    expect(CONTRACTS_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('returns package info consistent with the exported constants', () => {
    expect(getContractsPackageInfo()).toEqual({
      name: CONTRACTS_PACKAGE_NAME,
      version: CONTRACTS_PACKAGE_VERSION,
    });
  });

  it('exports the synchronized WebSocket message limits', () => {
    expect(MAX_AGENT_WS_MESSAGE_BYTES).toBe(1024 * 1024);
    expect(MAX_CLIENT_WS_MESSAGE_BYTES).toBe(64 * 1024);
  });
});
