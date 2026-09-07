<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';

import * as usersApi from '@/api/users';
import type { AdminUser, UserRole, UserStatus } from '@/api/types';
import MetricCard from '@/components/MetricCard.vue';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/errors';
import { formatTaskDate } from '@/views/tasks/task-status';

const auth = useAuthStore();
const router = useRouter();
const items = ref<AdminUser[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const search = ref('');
const role = ref<UserRole | ''>('');
const status = ref<UserStatus | ''>('');
const metrics = reactive({ total: 0, active: 0, disabled: 0, admins: 0 });
const loading = ref(false);
const error = ref('');
const createVisible = ref(false);
const resetVisible = ref(false);
const submitting = ref(false);
const resetTarget = ref<AdminUser | null>(null);
const createForm = reactive({
  username: '',
  password: '',
  confirmPassword: '',
  role: 'USER' as UserRole,
});
const resetForm = reactive({ password: '', confirmPassword: '' });

const currentUserId = computed(() => auth.user?.id ?? '');

function roleLabel(value: UserRole): string {
  return value === 'ADMIN' ? '管理员' : '普通用户';
}

function statusLabel(value: UserStatus): string {
  return value === 'ACTIVE' ? '已启用' : '已禁用';
}

function statusType(value: UserStatus): 'success' | 'info' {
  return value === 'ACTIVE' ? 'success' : 'info';
}

function isCurrentUser(user: AdminUser): boolean {
  return user.id === currentUserId.value;
}

function toUser(value: unknown): AdminUser {
  return value as AdminUser;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await usersApi.listAdminUsers({
      page: page.value,
      pageSize: pageSize.value,
      search: search.value.trim(),
      role: role.value || undefined,
      status: status.value || undefined,
    });
    items.value = result.items;
    total.value = result.total;
    Object.assign(metrics, result.metrics);
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

function submitSearch(): void {
  page.value = 1;
  void load();
}

function resetSearch(): void {
  search.value = '';
  role.value = '';
  status.value = '';
  page.value = 1;
  void load();
}

function openCreate(): void {
  createForm.username = '';
  createForm.password = '';
  createForm.confirmPassword = '';
  createForm.role = 'USER';
  createVisible.value = true;
}

function clearCreateForm(): void {
  createForm.username = '';
  createForm.password = '';
  createForm.confirmPassword = '';
  createForm.role = 'USER';
}

function closeCreate(): void {
  createVisible.value = false;
  clearCreateForm();
}

function validatePasswords(password: string, confirmPassword: string): boolean {
  if (!password) {
    ElMessage.warning('请输入密码');
    return false;
  }
  if ([...password].length < 8 || [...password].length > 128) {
    ElMessage.warning('密码长度需为 8-128 个字符');
    return false;
  }
  if (password !== confirmPassword) {
    ElMessage.warning('两次输入的密码不一致');
    return false;
  }
  return true;
}

async function createUser(): Promise<void> {
  if (!createForm.username.trim()) {
    ElMessage.warning('请输入用户名');
    return;
  }
  if (!validatePasswords(createForm.password, createForm.confirmPassword)) return;

  submitting.value = true;
  try {
    await usersApi.createAdminUser({
      username: createForm.username.trim(),
      password: createForm.password,
      role: createForm.role,
    });
    closeCreate();
    ElMessage.success('用户创建成功');
    await load();
  } catch (caught) {
    ElMessage.error(errorMessage(caught));
  } finally {
    submitting.value = false;
  }
}

async function disableUser(user: AdminUser): Promise<void> {
  if (isCurrentUser(user)) return;
  try {
    await ElMessageBox.confirm(
      `确定禁用用户“${user.username}”吗？禁用后该用户将无法登录。`,
      '确认禁用',
      { type: 'warning', confirmButtonText: '禁用', cancelButtonText: '取消' },
    );
    await usersApi.disableAdminUser(user.id);
    ElMessage.success('用户已禁用');
    await load();
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') ElMessage.error(errorMessage(caught));
  }
}

async function enableUser(user: AdminUser): Promise<void> {
  try {
    await usersApi.enableAdminUser(user.id);
    ElMessage.success('用户已启用，请重新登录');
    await load();
  } catch (caught) {
    ElMessage.error(errorMessage(caught));
  }
}

function openReset(user: AdminUser): void {
  resetTarget.value = user;
  resetForm.password = '';
  resetForm.confirmPassword = '';
  resetVisible.value = true;
}

function clearResetForm(): void {
  resetTarget.value = null;
  resetForm.password = '';
  resetForm.confirmPassword = '';
}

function closeReset(): void {
  resetVisible.value = false;
  clearResetForm();
}

async function resetPassword(): Promise<void> {
  const target = resetTarget.value;
  if (!target || !validatePasswords(resetForm.password, resetForm.confirmPassword)) return;

  submitting.value = true;
  try {
    await usersApi.resetAdminUserPassword(target.id, resetForm.password);
    const resetCurrentUser = isCurrentUser(target);
    closeReset();
    ElMessage.success('密码已重置');
    if (resetCurrentUser) {
      auth.clearSession();
      await router.replace({ name: 'login' });
      return;
    }
    await load();
  } catch (caught) {
    ElMessage.error(errorMessage(caught));
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="page-section users-page">
    <div class="page-heading">
      <div>
        <h1>用户管理</h1>
        <p>维护平台用户、账号状态和登录凭据。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="load">刷新</el-button>
        <el-button type="primary" @click="openCreate">创建用户</el-button>
      </div>
    </div>

    <div class="user-stats-grid">
      <MetricCard label="用户总数" :value="metrics.total" hint="全部用户" />
      <MetricCard label="启用用户" :value="metrics.active" type="success" hint="可正常登录" />
      <MetricCard label="禁用用户" :value="metrics.disabled" type="warning" hint="暂不可登录" />
      <MetricCard label="管理员" :value="metrics.admins" type="primary" hint="拥有管理权限" />
    </div>

    <el-card shadow="never" class="filter-card">
      <el-form inline @submit.prevent="submitSearch">
        <el-form-item label="用户名">
          <el-input
            v-model="search"
            clearable
            placeholder="搜索用户名"
            @keyup.enter="submitSearch"
          />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="role" clearable placeholder="全部" @change="submitSearch">
            <el-option label="管理员" value="ADMIN" />
            <el-option label="普通用户" value="USER" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="status" clearable placeholder="全部" @change="submitSearch">
            <el-option label="已启用" value="ACTIVE" />
            <el-option label="已禁用" value="DISABLED" />
          </el-select>
        </el-form-item>
        <el-button type="primary" @click="submitSearch">搜索</el-button>
        <el-button @click="resetSearch">重置</el-button>
      </el-form>
    </el-card>

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
      class="page-alert"
    />

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="items" row-key="id">
        <el-table-column prop="username" label="用户名" min-width="190">
          <template #default="{ row }">
            <span class="user-name">{{ row.username }}</span>
            <el-tag v-if="isCurrentUser(toUser(row))" size="small" type="info" class="current-tag">
              当前用户
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="120">
          <template #default="{ row }">{{ roleLabel(row.role) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{
              statusLabel(row.status)
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">{{ formatTaskDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">{{ formatTaskDate(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="270" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'ACTIVE'"
              link
              type="warning"
              :disabled="isCurrentUser(toUser(row))"
              @click.stop="disableUser(toUser(row))"
            >
              禁用
            </el-button>
            <el-button v-else link type="success" @click.stop="enableUser(toUser(row))"
              >启用</el-button
            >
            <el-button link type="primary" @click.stop="openReset(toUser(row))">重置密码</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && items.length === 0" description="暂无用户" />

      <div class="pagination-row">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          layout="total, sizes, prev, pager, next"
          :total="total"
          @current-change="load"
          @size-change="load"
        />
      </div>
    </el-card>

    <el-dialog
      v-model="createVisible"
      title="创建用户"
      width="440px"
      align-center
      @closed="clearCreateForm"
    >
      <el-form label-position="top" @submit.prevent="createUser">
        <el-form-item label="用户名" required>
          <el-input v-model="createForm.username" maxlength="64" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码" required>
          <el-input
            v-model="createForm.password"
            type="password"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item label="确认密码" required>
          <el-input
            v-model="createForm.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item label="角色" required>
          <el-select v-model="createForm.role" style="width: 100%">
            <el-option label="普通用户" value="USER" />
            <el-option label="管理员" value="ADMIN" />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="createForm.role === 'ADMIN'"
          title="管理员可以访问 Agent、构建模板和用户管理功能，请仅授予可信人员。"
          type="warning"
          show-icon
          :closable="false"
        />
      </el-form>
      <template #footer>
        <el-button @click="closeCreate">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="createUser">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="resetVisible"
      title="重置密码"
      width="440px"
      align-center
      @closed="clearResetForm"
    >
      <el-form label-position="top" @submit.prevent="resetPassword">
        <p class="reset-target">正在重置：{{ resetTarget?.username }}</p>
        <el-form-item label="新密码" required>
          <el-input
            v-model="resetForm.password"
            type="password"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item label="确认密码" required>
          <el-input
            v-model="resetForm.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>
        <el-alert
          v-if="resetTarget?.status === 'DISABLED'"
          title="重置密码不会自动启用账号。"
          type="info"
          show-icon
          :closable="false"
        />
      </el-form>
      <template #footer>
        <el-button @click="closeReset">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="resetPassword">重置</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.users-page {
  min-width: 0;
}

.user-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.filter-card {
  border-radius: var(--ar-radius-lg);
}

.table-card {
  min-width: 0;
  overflow: hidden;
}

.user-name {
  color: var(--ar-text-primary);
  font-weight: 600;
}

.current-tag {
  margin-left: 8px;
}

.reset-target {
  margin: 0 0 16px;
  color: var(--ar-text-regular);
}

@media (max-width: 900px) {
  .table-card {
    overflow-x: auto;
  }

  .table-card :deep(.el-table) {
    min-width: 900px;
  }
}

@media (max-width: 640px) {
  .user-stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .filter-card :deep(.el-form) {
    display: grid;
    grid-template-columns: 1fr;
  }

  .filter-card :deep(.el-form-item),
  .filter-card :deep(.el-button) {
    width: 100%;
    margin-right: 0;
  }

  .filter-card :deep(.el-select),
  .filter-card :deep(.el-input) {
    width: 100%;
  }
}
</style>
