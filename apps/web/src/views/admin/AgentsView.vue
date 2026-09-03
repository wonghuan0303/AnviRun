<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import * as agentsApi from '@/api/agents';
import type { AgentSummary } from '@/api/types';
import CopyableText from '@/components/CopyableText.vue';
import MetricCard from '@/components/MetricCard.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { errorMessage } from '@/utils/errors';

const items = ref<AgentSummary[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const search = ref('');
const loading = ref(false);
const error = ref('');
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const agentForm = reactive({ name: '' });
const tokenVisible = ref(false);
const registrationToken = ref('');
const tokenTitle = ref('');

const onlineCount = computed(
  () => items.value.filter((a) => a.enabled && a.status === 'ONLINE').length,
);
const offlineCount = computed(
  () => items.value.filter((a) => a.enabled && a.status === 'OFFLINE').length,
);
const disabledCount = computed(() => items.value.filter((a) => !a.enabled).length);

function statusType(status: string): 'success' | 'warning' | 'info' | 'danger' {
  if (status === 'ONLINE') return 'success';
  if (status === 'OFFLINE') return 'warning';
  return 'danger';
}

function toAgent(value: unknown): AgentSummary {
  return value as AgentSummary;
}

function statusLabel(agent: unknown): string {
  const row = agent as AgentSummary;
  return row.enabled ? row.status : 'DISABLED';
}

function statusDisplayText(agent: unknown): string {
  const label = statusLabel(agent);
  if (label === 'ONLINE') return '在线';
  if (label === 'OFFLINE') return '离线';
  return '已停用';
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await agentsApi.listAgents({
      page: page.value,
      pageSize: pageSize.value,
      search: search.value.trim(),
    });
    items.value = result.items;
    total.value = result.total;
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

function openCreate(): void {
  editingId.value = null;
  agentForm.name = '';
  dialogVisible.value = true;
}

function openEdit(agent: AgentSummary): void {
  editingId.value = agent.id;
  agentForm.name = agent.name;
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!agentForm.name.trim()) {
    ElMessage.warning('请输入 Agent 名称');
    return;
  }
  saving.value = true;
  try {
    if (editingId.value) {
      await agentsApi.updateAgent(editingId.value, agentForm.name.trim());
      dialogVisible.value = false;
      ElMessage.success('Agent 已更新');
    } else {
      const result = await agentsApi.createAgent(agentForm.name.trim());
      dialogVisible.value = false;
      if (result.registrationToken) {
        tokenTitle.value = 'Agent 注册令牌（仅显示一次）';
        registrationToken.value = result.registrationToken;
        tokenVisible.value = true;
      }
      ElMessage.success('Agent 创建成功');
    }
    await load();
  } catch (caught) {
    ElMessage.error(errorMessage(caught));
  } finally {
    saving.value = false;
  }
}

async function confirmDisable(agent: AgentSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定停用 Agent“${agent.name}”吗？停用后不能接收新的构建任务。`,
      '确认停用',
      { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
    );
    await agentsApi.disableAgent(agent.id);
    ElMessage.success('Agent 已停用');
    await load();
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') ElMessage.error(errorMessage(caught));
  }
}

async function confirmEnable(agent: AgentSummary): Promise<void> {
  try {
    await agentsApi.enableAgent(agent.id);
    ElMessage.success('Agent 已启用');
    await load();
  } catch (caught) {
    ElMessage.error(errorMessage(caught));
  }
}

async function confirmRotate(agent: AgentSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `轮换“${agent.name}”的注册令牌后，旧令牌会立即失效，继续吗？`,
      '确认轮换令牌',
      { type: 'warning', confirmButtonText: '轮换', cancelButtonText: '取消' },
    );
    const result = await agentsApi.rotateAgentToken(agent.id);
    if (result.registrationToken) {
      tokenTitle.value = '新注册令牌（仅显示一次）';
      registrationToken.value = result.registrationToken;
      tokenVisible.value = true;
    }
    ElMessage.success('注册令牌已轮换');
    await load();
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') ElMessage.error(errorMessage(caught));
  }
}

async function confirmDelete(agent: AgentSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除 Agent“${agent.name}”吗？删除后不可恢复。`, '确认删除', {
      type: 'error',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await agentsApi.deleteAgent(agent.id);
    ElMessage.success('Agent 已删除');
    await load();
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') ElMessage.error(errorMessage(caught));
  }
}

async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard.writeText(registrationToken.value);
    ElMessage.success('已复制注册令牌');
  } catch {
    ElMessage.warning('复制失败，请手动选择令牌文本');
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="page-section">
    <div class="page-heading">
      <div>
        <h1>Agent 管理</h1>
        <p>维护并监控负责代码拉取与命令执行的构建节点及其注册令牌。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="load">刷新</el-button>
        <el-button type="primary" @click="openCreate">创建 Agent</el-button>
      </div>
    </div>

    <div class="agent-stats-grid">
      <MetricCard label="节点总数" :value="total" hint="已注册构建机" />
      <MetricCard label="在线节点" :value="onlineCount" type="success" hint="就绪可接收任务" />
      <MetricCard label="离线节点" :value="offlineCount" type="warning" hint="等待心跳连接" />
      <MetricCard label="停用节点" :value="disabledCount" type="danger" hint="已暂停调度" />
    </div>

    <el-card shadow="never" class="filter-card">
      <el-form inline @submit.prevent="submitSearch">
        <el-form-item label="名称">
          <el-input
            v-model="search"
            clearable
            placeholder="搜索 Agent 名称"
            @keyup.enter="submitSearch"
          />
        </el-form-item>
        <el-button type="primary" @click="submitSearch">搜索</el-button>
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
        <el-table-column prop="name" label="名称" min-width="160">
          <template #default="{ row }">
            <span class="agent-name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <StatusBadge
              :type="statusType(statusLabel(toAgent(row)))"
              :text="statusDisplayText(row)"
              :pulse="row.enabled && row.status === 'ONLINE'"
            />
          </template>
        </el-table-column>
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.enabled ? 'success' : 'info'">
              {{ row.enabled ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="主机信息" min-width="190">
          <template #default="{ row }">
            <span class="host-info">{{
              [row.hostname, row.os, row.arch].filter(Boolean).join(' / ') || '—'
            }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="version" label="版本" width="110">
          <template #default="{ row }">
            <code v-if="row.version" class="version-tag">v{{ row.version }}</code>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="最近在线" width="175">
          <template #default="{ row }">{{ formatDate(row.lastSeenAt) }}</template>
        </el-table-column>
        <el-table-column prop="activeTaskId" label="活动任务" min-width="160">
          <template #default="{ row }">
            <CopyableText
              v-if="row.activeTaskId"
              :text="row.activeTaskId"
              :display-text="`${row.activeTaskId.slice(0, 8)}…`"
            />
            <span v-else class="muted-text">空闲</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="290" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(toAgent(row))">编辑</el-button>
            <el-button v-if="row.enabled" link type="warning" @click="confirmDisable(toAgent(row))">
              停用
            </el-button>
            <el-button v-else link type="success" @click="confirmEnable(toAgent(row))">
              启用
            </el-button>
            <el-button link type="warning" @click="confirmRotate(toAgent(row))">
              轮换令牌
            </el-button>
            <el-button link type="danger" @click="confirmDelete(toAgent(row))">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && items.length === 0" description="暂无 Agent 节点" />

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
      v-model="dialogVisible"
      :title="editingId ? '编辑 Agent' : '创建 Agent'"
      width="440px"
      align-center
    >
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="名称" required>
          <el-input
            v-model="agentForm.name"
            maxlength="100"
            placeholder="例如 build-node-01"
            show-word-limit
            @keyup.enter="save"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="tokenVisible" :title="tokenTitle" width="600px" align-center>
      <el-alert
        title="关闭后服务端不会再次返回此令牌，请立即复制并安全保存。"
        type="warning"
        show-icon
        :closable="false"
        class="page-alert"
      />
      <div class="token-box">
        <el-input :model-value="registrationToken" readonly class="token-field">
          <template #append>
            <el-button type="primary" @click="copyToken">复制令牌</el-button>
          </template>
        </el-input>
      </div>
    </el-dialog>
  </section>
</template>

<style scoped>
.agent-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.filter-card {
  border-radius: var(--ar-radius-lg);
}

.agent-name {
  font-weight: 600;
  color: var(--ar-text-primary);
}

.host-info {
  font-size: 13px;
  color: var(--ar-text-regular);
}

.version-tag {
  font-size: 12px;
  background: var(--ar-bg-subtle);
  padding: 2px 6px;
  border-radius: var(--ar-radius-sm);
  color: var(--ar-color-slate-700);
}

.token-box {
  margin-top: 16px;
}
</style>
