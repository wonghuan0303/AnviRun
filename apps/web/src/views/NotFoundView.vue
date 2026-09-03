<script setup lang="ts">
import { RouterLink } from 'vue-router';
</script>

<template>
  <div class="not-found-page">
    <el-card shadow="never" class="not-found-card">
      <div class="not-found-code">404</div>
      <h2 class="not-found-title">页面不存在</h2>
      <p class="not-found-desc">您访问的页面不存在或已被移除，请检查路径是否正确。</p>
      <div class="not-found-actions">
        <RouterLink to="/"><el-button type="primary">返回首页</el-button></RouterLink>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.not-found-page {
  min-height: 80vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.not-found-card {
  max-width: 480px;
  width: 100%;
  text-align: center;
  padding: 32px 16px;
  border-radius: var(--ar-radius-xl);
  border: 1px solid var(--ar-border-color);
}

.not-found-code {
  font-size: 64px;
  font-weight: 900;
  color: var(--ar-color-primary);
  line-height: 1;
  margin-bottom: 12px;
  letter-spacing: -0.04em;
}

.not-found-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--ar-text-primary);
  margin: 0 0 8px;
}

.not-found-desc {
  color: var(--ar-text-secondary);
  font-size: 14px;
  margin: 0 0 24px;
}

.not-found-actions {
  display: flex;
  justify-content: center;
}
</style>
