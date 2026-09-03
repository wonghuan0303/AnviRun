<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/errors';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const userLabel = computed(() => (auth.user ? `${auth.user.username}（${auth.user.role}）` : ''));
const menu = computed(() => [
  { name: 'projects', label: '项目管理', path: '/projects' },
  ...(auth.isAdmin
    ? [
        { name: 'admin-agents', label: 'Agent 管理', path: '/admin/agents' },
        { name: 'admin-build-templates', label: '构建模板', path: '/admin/build-templates' },
      ]
    : []),
]);

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
  <el-container class="app-shell">
    <el-aside width="220px" class="app-shell__aside">
      <div class="app-shell__brand">AnvilRun</div>
      <el-menu :default-active="route.path" router>
        <el-menu-item v-for="item in menu" :key="item.name" :index="item.path">{{
          item.label
        }}</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="app-shell__header">
        <span>{{ route.meta.title }}</span>
        <div class="app-shell__account">
          <span>{{ userLabel }}</span>
          <el-button link type="primary" @click="logout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="app-shell__main"><RouterView /></el-main>
    </el-container>
  </el-container>
</template>
