import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAppStore } from './app';

describe('useAppStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('exposes the application name', () => {
    expect(useAppStore().appName).toBe('通用构建任务平台');
  });
});
