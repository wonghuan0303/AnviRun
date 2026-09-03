import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

import { useAuthStore } from '@/stores/auth';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: '概览' },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: '登录' },
  },
  {
    path: '/overview',
    component: () => import('@/layouts/AppLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'overview',
        component: () => import('@/views/OverviewView.vue'),
        meta: { title: '任务概览' },
      },
    ],
  },
  {
    path: '/projects',
    component: () => import('@/layouts/AppLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'projects',
        component: () => import('@/views/projects/ProjectsView.vue'),
        meta: { title: '项目管理' },
      },
      {
        path: 'new',
        name: 'project-new',
        component: () => import('@/views/projects/ProjectEditorView.vue'),
        meta: { title: '新建项目' },
      },
      {
        path: ':projectId',
        name: 'project-detail',
        component: () => import('@/views/projects/ProjectDetailView.vue'),
        meta: { title: '项目详情' },
      },
      {
        path: ':projectId/edit',
        name: 'project-edit',
        component: () => import('@/views/projects/ProjectEditorView.vue'),
        meta: { title: '编辑项目' },
      },
      {
        path: ':projectId/config',
        name: 'project-config',
        component: () => import('@/views/projects/ProjectConfigView.vue'),
        meta: { title: '项目配置' },
      },
      {
        path: ':projectId/tasks',
        name: 'project-tasks',
        component: () => import('@/views/tasks/ProjectTasksView.vue'),
        meta: { title: '构建记录' },
      },
    ],
  },
  {
    path: '/tasks/:taskId',
    component: () => import('@/layouts/AppLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'task-detail',
        component: () => import('@/views/tasks/TaskDetailView.vue'),
        meta: { title: '任务详情' },
      },
    ],
  },
  {
    path: '/admin',
    component: () => import('@/layouts/AdminLayout.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
    children: [
      { path: '', redirect: { name: 'admin-agents' } },
      {
        path: 'agents',
        name: 'admin-agents',
        component: () => import('@/views/admin/AgentsView.vue'),
        meta: { title: 'Agent 管理' },
      },
      {
        path: 'build-templates',
        name: 'admin-build-templates',
        component: () => import('@/views/admin/BuildTemplatesView.vue'),
        meta: { title: '构建模板' },
      },
      {
        path: 'build-templates/new',
        name: 'admin-build-template-new',
        component: () => import('@/views/admin/BuildTemplateEditorView.vue'),
        meta: { title: '新建构建模板' },
      },
      {
        path: 'build-templates/:id/edit',
        name: 'admin-build-template-edit',
        component: () => import('@/views/admin/BuildTemplateEditorView.vue'),
        meta: { title: '编辑构建模板' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { title: '页面不存在' },
  },
];

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.restoreSession();

  if (to.name === 'login' && auth.isAuthenticated) {
    return { name: 'overview' };
  }
  if (to.matched.some((record) => record.meta.requiresAuth) && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.matched.some((record) => record.meta.requiresAdmin) && !auth.isAdmin) {
    return { name: 'overview' };
  }
  return true;
});
