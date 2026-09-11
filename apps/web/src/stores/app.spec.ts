import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { PRODUCT_FULL_NAME } from '@/config/product';

import { useAppStore } from './app';

describe('useAppStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('exposes the application name', () => {
    expect(useAppStore().appName).toBe(PRODUCT_FULL_NAME);
  });
});
