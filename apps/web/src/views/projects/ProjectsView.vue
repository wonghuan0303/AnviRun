<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';

import * as projectApi from '@/api/project';
import * as templateApi from '@/api/build-templates';
import type { BuildTemplatePublicView, ProjectView } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/errors';
import {
  agentStatusLabel,
  agentStatusType,
  compatibilityLabel,
  compatibilityType,
  formatDate,
} from './project-status';

const auth = useAuthStore();
const router = useRouter();
const items = ref<ProjectView[]>([]);
const templates = ref<BuildTemplatePublicView[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const search = ref('');
const buildTemplateId = ref('');
const loading = ref(false);
const error = ref('');
const hasLoadedTemplates = ref(false);
const isAdmin = computed(() => auth.isAdmin);

function toProject(value: unknown): ProjectView {
  return value as ProjectView;
}

async function loadTemplates(): Promise<void> {
  try {
    const result = await templateApi.listPublicBuildTemplates({ page: 1, pageSize: 100 });
    templates.value = result.items;
    hasLoadedTemplates.value = true;
  } catch (caught) {
    error.value = errorMessage(caught, '模板列表加载失败');
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await projectApi.listProjects({
      page: page.value,
      pageSize: pageSize.value,
      search: search.value.trim(),
      buildTemplateId: buildTemplateId.value || undefined,
    });
    items.value = result.items;
    total.value = result.total;
  } catch (caught) {
    error.value = errorMessage(caught, '项目列表加载失败');
  } finally {
    loading.value = false;
  }
}

function submitSearch(): void {
  page.value = 1;
  void load();
}

function templateName(project: ProjectView): string {
  return project.buildTemplate.name;
}

async function confirmDelete(project: ProjectView): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定软删除项目“${project.name}”吗？删除后项目将从列表中隐藏。`,
      '确认删除项目',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
    await projectApi.deleteProject(project.id);
    ElMessage.success('项目已删除');
    if (items.value.length === 1 && page.value > 1) page.value -= 1;
    await load();
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') {
      ElMessage.error(errorMessage(caught));
    }
  }
}

onMounted(() => {
  void Promise.all([loadTemplates(), load()]);
});
</script>

<template>
  <section class="page-section">
    <div class="page-heading">
      <div>
        <h1>项目管理</h1>
        <p>管理项目基本信息、模板配置和当前可构建状态。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="load">刷新</el-button>
        <el-button type="primary" @click="router.push({ name: 'project-new' })">新建项目</el-button>
      </div>
    </div>

    <el-card shadow="never">
      <el-form inline @submit.prevent="submitSearch">
        <el-form-item label="名称">
          <el-input
            v-model="search"
            clearable
            placeholder="搜索项目名称"
            @keyup.enter="submitSearch"
          />
        </el-form-item>
        <el-form-item label="构建模板">
          <el-select
            v-model="buildTemplateId"
            clearable
            filterable
            placeholder="全部模板"
            style="width: 220px"
            @change="submitSearch"
          >
            <el-option
              v-for="template in templates"
              :key="template.id"
              :label="template.name"
              :value="template.id"
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
    <el-alert
      v-if="!hasLoadedTemplates && !error"
      title="构建模板正在加载"
      type="info"
      :closable="false"
      class="page-alert"
    />

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="items" row-key="id">
        <el-table-column prop="name" label="项目名称" min-width="180" />
        <el-table-column v-if="isAdmin" label="所有者" width="130">
          <template #default="{ row }">{{ row.owner.username }}</template>
        </el-table-column>
        <el-table-column label="模板" min-width="160">
          <template #default="{ row }">{{ templateName(toProject(row)) }}</template>
        </el-table-column>
        <el-table-column prop="branch" label="分支" min-width="150" />
        <el-table-column label="Agent" width="110">
          <template #default="{ row }">
            <el-tag :type="agentStatusType(row.buildTemplate.agent)">
              {{ agentStatusLabel(row.buildTemplate.agent) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="配置" width="130">
          <template #default="{ row }">
            <el-tag :type="compatibilityType(toProject(row))">
              {{ compatibilityLabel(toProject(row)) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="175">
          <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="245" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              @click="router.push({ name: 'project-detail', params: { projectId: row.id } })"
              >详情</el-button
            >
            <el-button
              link
              type="primary"
              @click="router.push({ name: 'project-edit', params: { projectId: row.id } })"
              >编辑</el-button
            >
            <el-button
              link
              type="primary"
              @click="router.push({ name: 'project-config', params: { projectId: row.id } })"
              >配置</el-button
            >
            <el-button link type="danger" @click="confirmDelete(toProject(row))">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && items.length === 0" description="暂无项目" />
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
