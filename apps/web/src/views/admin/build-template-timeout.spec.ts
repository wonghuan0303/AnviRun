import { describe, expect, it } from 'vitest';

import { isValidBuildTimeoutSeconds } from './build-template-timeout';

describe('build template timeout', () => {
  it.each([1, 60, 3_541, 3_600, 3_601, 86_400])('accepts timeout %i', (value) => {
    expect(isValidBuildTimeoutSeconds(value)).toBe(true);
  });

  it.each([0, 1.5, 86_401])('rejects invalid timeout %i', (value) => {
    expect(isValidBuildTimeoutSeconds(value)).toBe(false);
  });
});
