<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import BrandLogo from '@/components/BrandLogo.vue';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/errors';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const userLabel = computed(() => (auth.user ? `${auth.user.username}（${auth.user.role}）` : ''));
const menu = [
  { name: 'projects', label: '项目管理', path: '/projects' },
  { name: 'admin-agents', label: 'Agent 管理', path: '/admin/agents' },
  { name: 'admin-build-templates', label: '构建模板', path: '/admin/build-templates' },
];

async function logout(): Promise<void> {
  try {
    await auth.logout();
    await router.replace({ name: 'login' });
  } catch (caught) {
    ElMessage.error(errorMessage(caught));
  }
}
</script>

<template>
  <el-container class="admin-shell">
    <el-aside width="220px" class="admin-shell__aside">
      <div class="admin-shell__brand" style="cursor: pointer" @click="router.push('/')">
        <div class="admin-shell__brand-inner">
          <BrandLogo size="default" dark />
        </div>
      </div>
      <div class="admin-shell__nav">
        <el-menu :default-active="route.path" router>
          <el-menu-item v-for="item in menu" :key="item.name" :index="item.path">
            <span>{{ item.label }}</span>
          </el-menu-item>
        </el-menu>
      </div>
    </el-aside>
    <el-container>
      <el-header class="admin-shell__header">
        <div class="admin-shell__header-left">
          <span class="admin-shell__scope-badge">系统管理</span>
          <span class="admin-shell__header-title">{{ route.meta.title }}</span>
        </div>
        <div class="admin-shell__account">
          <span class="user-badge">{{ userLabel }}</span>
          <el-button link type="primary" @click="logout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="admin-shell__main"><RouterView /></el-main>
    </el-container>
  </el-container>
</template>
