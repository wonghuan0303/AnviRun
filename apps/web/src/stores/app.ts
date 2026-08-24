import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 应用级基础状态。
 *
 * T0.1 只保存应用名称，用于验证 Pinia 已正确接入；
 * 当前用户与权限状态在 T1.2、T1.3 加入。
 */
export const useAppStore = defineStore('app', () => {
  const appName = ref('通用构建任务平台');

  return { appName };
});
