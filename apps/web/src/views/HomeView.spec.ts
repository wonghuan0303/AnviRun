import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { describe, expect, it } from 'vitest';

import HomeView from './HomeView.vue';

describe('HomeView', () => {
  it('renders the shared contracts package identity', () => {
    const wrapper = mount(HomeView, {
      global: { plugins: [ElementPlus] },
    });

    expect(wrapper.text()).toContain('@buildplatform/contracts');
    expect(wrapper.text()).toContain('共享契约包');
  });

  it('shows a placeholder when VITE_API_BASE_URL is not configured', () => {
    const wrapper = mount(HomeView, {
      global: { plugins: [ElementPlus] },
    });

    const expected = import.meta.env.VITE_API_BASE_URL ?? '未配置（VITE_API_BASE_URL）';
    expect(wrapper.text()).toContain(expected);
  });
});
