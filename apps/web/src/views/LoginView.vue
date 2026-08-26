<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import { errorMessage } from '@/utils/errors';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const form = reactive({ username: '', password: '' });
const submitting = ref(false);
const error = ref('');

function safeRedirect(): string {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '';
  return redirect.startsWith('/admin/') ? redirect : auth.isAdmin ? '/admin/agents' : '/';
}

async function submit(): Promise<void> {
  error.value = '';
  submitting.value = true;
  try {
    await auth.login(form.username.trim(), form.password);
    ElMessage.success('登录成功');
    await router.replace(safeRedirect());
  } catch (caught) {
    error.value = errorMessage(caught, '登录失败，请检查账号和密码');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <el-card class="login-card" shadow="always">
      <template #header>
        <div class="login-card__title">
          <span>Build Platform</span>
          <small>通用构建任务平台</small>
        </div>
      </template>
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        show-icon
        :closable="false"
        class="page-alert"
      />
      <el-form :model="form" label-position="top" @submit.prevent="submit">
        <el-form-item label="用户名" required>
          <el-input v-model="form.username" autocomplete="username" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item label="密码" required>
          <el-input
            v-model="form.password"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="请输入密码"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button
          type="primary"
          native-type="submit"
          :loading="submitting"
          class="login-card__submit"
        >
          登录
        </el-button>
      </el-form>
    </el-card>
  </main>
</template>
