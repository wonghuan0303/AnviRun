import { defineStore } from 'pinia';
import { ref } from 'vue';

import { PRODUCT_FULL_NAME } from '@/config/product';

/**
 * 应用级基础状态。
 *
 * T0.1 只保存应用名称，用于验证 Pinia 已正确接入；
 * 当前用户与权限状态在 T1.2、T1.3 加入。
 */
export const useAppStore = defineStore('app', () => {
  const appName = ref(PRODUCT_FULL_NAME);

  return { appName };
});
