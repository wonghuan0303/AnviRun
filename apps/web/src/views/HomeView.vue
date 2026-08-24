<script setup lang="ts">
import { getContractsPackageInfo } from '@buildplatform/contracts';
import { computed } from 'vue';

const contracts = getContractsPackageInfo();

const apiBaseUrl = computed(
  () => import.meta.env.VITE_API_BASE_URL ?? '未配置（VITE_API_BASE_URL）',
);
</script>

<template>
  <el-card shadow="never">
    <template #header>
      <span>工程骨架状态</span>
    </template>
    <ul class="overview">
      <li>
        <span class="overview__label">前端技术栈</span>
        <span class="overview__value"
          >Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router</span
        >
      </li>
      <li>
        <span class="overview__label">共享契约包</span>
        <span class="overview__value">{{ contracts.name }}@{{ contracts.version }}</span>
      </li>
      <li>
        <span class="overview__label">API 基地址</span>
        <span class="overview__value">{{ apiBaseUrl }}</span>
      </li>
    </ul>
    <el-alert type="info" :closable="false" show-icon>
      当前为 T0.1 工程骨架，尚未实现登录、构建模板、项目与任务功能。
    </el-alert>
  </el-card>
</template>

<style scoped>
.overview {
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
}

.overview li {
  display: flex;
  gap: 12px;
  padding: 6px 0;
}

.overview__label {
  flex: 0 0 120px;
  color: #909399;
}

.overview__value {
  word-break: break-all;
}
</style>
