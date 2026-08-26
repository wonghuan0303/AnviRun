<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { RouterLink } from 'vue-router';

import * as agentsApi from '@/api/agents';
import * as templatesApi from '@/api/build-templates';
import type { AgentSummary, BuildTemplateAdminView } from '@/api/types';
import { errorMessage } from '@/utils/errors';

const items = ref<BuildTemplateAdminView[]>([]);
const agents = ref<AgentSummary[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const search = ref('');
const enabled = ref('');
const agentId = ref('');
const loading = ref(false);
const error = ref('');

function statusType(
  status: BuildTemplateAdminView['agent']['status'],
): 'success' | 'warning' | 'info' | 'danger' {
  if (status === 'ONLINE') return 'success';
  if (status === 'OFFLINE') return 'warning';
  return 'danger';
}
function toTemplate(value: unknown): BuildTemplateAdminView {
  return value as BuildTemplateAdminView;
}
function statusLabel(row: BuildTemplateAdminView): string {
  return row.agent.enabled ? row.agent.status : '已停用';
}
function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
function summary(value: string | null): string {
  return value?.trim() || '—';
}
async function loadAgents(): Promise<void> {
  try {
    agents.value = (await agentsApi.listAgents({ page: 1, pageSize: 100 })).items;
  } catch (caught) {
    error.value = errorMessage(caught);
  }
}
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await templatesApi.listBuildTemplates({
      page: page.value,
      pageSize: pageSize.value,
      search: search.value.trim(),
      enabled: enabled.value === '' ? undefined : enabled.value === 'true',
      agentId: agentId.value || undefined,
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
async function toggle(row: BuildTemplateAdminView): Promise<void> {
  try {
    if (row.enabled)
      await ElMessageBox.confirm(`确定停用模板“${row.name}”吗？`, '确认停用', {
        type: 'warning',
        confirmButtonText: '停用',
        cancelButtonText: '取消',
      });
    const updated = row.enabled
      ? await templatesApi.disableBuildTemplate(row.id)
      : await templatesApi.enableBuildTemplate(row.id);
    ElMessage.success(updated.template.enabled ? '模板已启用' : '模板已停用');
    await load();
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') ElMessage.error(errorMessage(caught));
  }
}
async function remove(row: BuildTemplateAdminView): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除模板“${row.name}”吗？存在引用时删除会失败并保留列表记录。`,
      '确认删除',
      { type: 'error', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
    await templatesApi.deleteBuildTemplate(row.id);
    ElMessage.success('模板已删除');
    await load();
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') ElMessage.error(errorMessage(caught));
  }
}
onMounted(() => {
  void Promise.all([loadAgents(), load()]);
});
</script>

<template>
  <section class="page-section">
    <div class="page-heading">
      <div>
        <h1>构建模板</h1>
        <p>维护构建命令、Agent 绑定和表单协议。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="load">刷新</el-button
        ><RouterLink to="/admin/build-templates/new"
          ><el-button type="primary">新建模板</el-button></RouterLink
        >
      </div>
    </div>
    <el-card shadow="never">
      <el-form inline @submit.prevent="submitSearch">
        <el-form-item label="名称"
          ><el-input v-model="search" clearable placeholder="搜索名称" @keyup.enter="submitSearch"
        /></el-form-item>
        <el-form-item label="启用状态">
          <el-select
            v-model="enabled"
            clearable
            placeholder="全部"
            style="width: 130px"
            @change="submitSearch"
            ><el-option label="已启用" value="true" /><el-option label="已停用" value="false"
          /></el-select>
        </el-form-item>
        <el-form-item label="Agent">
          <el-select
            v-model="agentId"
            clearable
            filterable
            placeholder="全部 Agent"
            style="width: 220px"
            @change="submitSearch"
          >
            <el-option
              v-for="agent in agents"
              :key="agent.id"
              :label="`${agent.name}（${agent.enabled ? agent.status : '已停用'}）`"
              :value="agent.id"
            />
          </el-select>
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
        <el-table-column prop="name" label="名称" min-width="150" />
        <el-table-column label="说明" min-width="160"
          ><template #default="{ row }">{{ summary(row.description) }}</template></el-table-column
        >
        <el-table-column label="Agent" min-width="160"
          ><template #default="{ row }"
            ><div>{{ row.agent.name }}</div>
            <el-tag size="small" :type="statusType(row.agent.status)">{{
              statusLabel(toTemplate(row))
            }}</el-tag></template
          ></el-table-column
        >
        <el-table-column prop="gitUrl" label="Git URL" min-width="210" show-overflow-tooltip />
        <el-table-column
          prop="artifactDir"
          label="产物目录"
          min-width="130"
          show-overflow-tooltip
        />
        <el-table-column label="超时" width="90"
          ><template #default="{ row }">{{ row.timeoutSeconds }} 秒</template></el-table-column
        >
        <el-table-column label="模板状态" width="100"
          ><template #default="{ row }"
            ><el-tag :type="row.enabled ? 'success' : 'info'">{{
              row.enabled ? '已启用' : '已停用'
            }}</el-tag></template
          ></el-table-column
        >
        <el-table-column label="更新时间" width="170"
          ><template #default="{ row }">{{ formatDate(row.updatedAt) }}</template></el-table-column
        >
        <el-table-column label="操作" min-width="220" fixed="right">
          <template #default="{ row }">
            <RouterLink :to="`/admin/build-templates/${row.id}/edit`"
              ><el-button link type="primary">编辑</el-button></RouterLink
            >
            <el-button
              link
              :type="row.enabled ? 'warning' : 'success'"
              @click="toggle(toTemplate(row))"
              >{{ row.enabled ? '停用' : '启用' }}</el-button
            >
            <el-button link type="danger" @click="remove(toTemplate(row))">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && items.length === 0" description="暂无构建模板" />
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
  </section>
</template>
