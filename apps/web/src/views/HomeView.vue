<script setup lang="ts">
import { computed } from 'vue';
import { getContractsPackageInfo } from '@anvilrun/contracts';

import BrandLogo from '@/components/BrandLogo.vue';

const contracts = getContractsPackageInfo();

const apiBaseUrl = computed(
  () => import.meta.env.VITE_API_BASE_URL ?? '未配置（VITE_API_BASE_URL）',
);
</script>

<template>
  <div class="home-page">
    <div class="home-container">
      <header class="home-header">
        <BrandLogo size="large" />
        <div class="home-header__actions">
          <RouterLink to="/login">
            <el-button type="primary" size="large">进入管理台</el-button>
          </RouterLink>
        </div>
      </header>

      <section class="home-hero">
        <div class="home-hero__badge">轻量构建任务平台 · 专机共享服务</div>
        <h1 class="home-hero__title">把固定打包机变成团队共享的构建服务</h1>
        <p class="home-hero__subtitle">
          Turn dedicated build machines into a shared build service.
          面向企业内网高可靠打包节点，提供开箱即用的构建模板、动态参数配置、实时日志与产物管理。
        </p>
      </section>

      <div class="home-features">
        <div class="feature-card">
          <div class="feature-card__icon">🖥️</div>
          <h3>固定 Agent 节点</h3>
          <p>基于 Rust 构建的高可靠 Agent，负责源码拉取、环境准备与打包命令执行。</p>
        </div>
        <div class="feature-card">
          <div class="feature-card__icon">⚙️</div>
          <h3>动态表单契约</h3>
          <p>模板支持声明式 FormSchema，非运维用户即可轻松定制构建参数并即时校验。</p>
        </div>
        <div class="feature-card">
          <div class="feature-card__icon">📡</div>
          <h3>实时日志与产物</h3>
          <p>WebSocket 实时日志回传、自动重连与断点续传，产物直接提供 SHA 校验与打包下载。</p>
        </div>
      </div>

      <el-card shadow="never" class="home-status-card">
        <template #header>
          <div class="card-header-line">
            <span style="font-weight: 600">工程与运行状态</span>
            <el-tag size="small" type="success">服务就绪</el-tag>
          </div>
        </template>
        <ul class="overview-list">
          <li>
            <span class="overview-list__label">前端技术栈</span>
            <span class="overview-list__value"
              >Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router</span
            >
          </li>
          <li>
            <span class="overview-list__label">共享契约包</span>
            <span class="overview-list__value">
              <code>{{ contracts.name }}@{{ contracts.version }}</code>
            </span>
          </li>
          <li>
            <span class="overview-list__label">API 基地址</span>
            <span class="overview-list__value">
              <code>{{ apiBaseUrl }}</code>
            </span>
          </li>
        </ul>
        <div class="home-actions">
          <RouterLink to="/login">
            <el-button type="primary">进入管理台</el-button>
          </RouterLink>
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.home-page {
  min-height: 100vh;
  padding: 32px 24px 64px;
  background-color: var(--ar-bg-body);
}

.home-container {
  max-width: 960px;
  margin: 0 auto;
}

.home-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--ar-border-color);
  margin-bottom: 40px;
}

.home-hero {
  text-align: center;
  margin-bottom: 48px;
}

.home-hero__badge {
  display: inline-block;
  padding: 4px 12px;
  background: var(--ar-color-primary-subtle);
  color: var(--ar-color-primary-text);
  font-size: 13px;
  font-weight: 600;
  border-radius: var(--ar-radius-full);
  margin-bottom: 16px;
  border: 1px solid #fed7aa;
}

.home-hero__title {
  font-size: 32px;
  font-weight: 800;
  color: var(--ar-text-primary);
  letter-spacing: -0.02em;
  margin: 0 0 16px;
}

.home-hero__subtitle {
  font-size: 16px;
  color: var(--ar-text-secondary);
  line-height: 1.6;
  max-width: 720px;
  margin: 0 auto;
}

.home-features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 20px;
  margin-bottom: 40px;
}

.feature-card {
  background: var(--ar-bg-card);
  border: 1px solid var(--ar-border-color);
  border-radius: var(--ar-radius-lg);
  padding: 24px;
  box-shadow: var(--ar-shadow-xs);
  transition: var(--ar-transition-base);
}

.feature-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--ar-shadow-md);
  border-color: var(--ar-border-dark);
}

.feature-card__icon {
  font-size: 28px;
  margin-bottom: 12px;
}

.feature-card h3 {
  font-size: 16px;
  font-weight: 700;
  color: var(--ar-text-primary);
  margin: 0 0 8px;
}

.feature-card p {
  font-size: 13px;
  color: var(--ar-text-secondary);
  margin: 0;
  line-height: 1.5;
}

.home-status-card {
  border-radius: var(--ar-radius-lg);
  border: 1px solid var(--ar-border-color);
}

.overview-list {
  margin: 0 0 20px;
  padding: 0;
  list-style: none;
}

.overview-list li {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--ar-border-subtle);
}

.overview-list li:last-child {
  border-bottom: none;
}

.overview-list__label {
  flex: 0 0 140px;
  color: var(--ar-text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.overview-list__value {
  color: var(--ar-text-primary);
  font-size: 13px;
  word-break: break-all;
}

.overview-list__value code {
  background: var(--ar-bg-subtle);
  padding: 2px 6px;
  border-radius: var(--ar-radius-sm);
  color: var(--ar-color-slate-700);
}

.home-actions {
  margin-top: 16px;
}
</style>
