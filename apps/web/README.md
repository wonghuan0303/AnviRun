# @anvilrun/web

AnvilRun（铸程）构建任务平台 Web 前端，使用 Vue 3、TypeScript、Vite、Element Plus、Pinia 和 Vue Router。

## T3.2 已实现

- /login 登录、Refresh Cookie 会话恢复、退出；Access Token 只保存在 Pinia 内存。
- /admin/agents 管理 Agent、启停、删除、名称编辑和一次性注册令牌轮换。
- /admin/build-templates 分页、名称/启用状态/Agent 筛选和模板启停删除。
- /admin/build-templates/new、/admin/build-templates/:id/edit 模板表单。
- formSchema 支持本地 .json 上传（最大 1 MB）、文本编辑、格式化、重置、公共契约校验、JSON 行列定位和白名单动态预览。
- 普通 USER 不能进入管理员路由；服务端 401/403 仍是最终权限边界。

## T3.4 项目页面

- `/projects` 提供项目分页、名称搜索、构建模板筛选、状态查看和软删除。
- `/projects/new` 创建项目；`/projects/:projectId/edit` 编辑名称、说明和 Git 分支。
- `/projects/:projectId` 查看所有权、模板/Agent 状态及配置兼容性；`/projects/:projectId/config` 独立保存项目配置。
- 项目配置编辑器只显式渲染公共契约白名单控件，使用 `validateFormConfigValues`、`normalizeFormConfigValues` 和 `analyzeFormConfigCompatibility`，不会动态加载组件、HTML、事件或脚本。
- ADMIN 和 USER 共用项目路由，最终所有权隔离由 Server 的 `Project.ownerId` 授权规则保证；ADMIN 额外显示 Agent 和构建模板菜单。

## T5.4 任务页面

- `/projects/:projectId/tasks` 提供项目任务分页、状态筛选、状态中文反馈和开始构建入口。
- `/tasks/:taskId` 展示任务基础信息、状态时间线、轮询状态、历史/实时日志和产物。
- 任务页面支持排队任务取消、执行中任务停止、终态重新构建、单文件下载、ZIP 下载和产物软删除。
- 历史日志先通过 HTTP 按偏移分页读取，再通过 `/ws/client` 以最后确认的偏移订阅；重复偏移会忽略，发现缺口会回读 HTTP。
- 下载统一使用带 Bearer Token 的 Blob 请求，401 时最多刷新并重试一次；Access Token 不进入 URL 或持久化存储。
- 创建任务和重新构建请求使用新的 `Idempotency-Key`，认证刷新重试沿用同一个键，避免重复创建任务。

T5.4 页面不负责 T6.1 断线恢复协议；Server/Agent 已支持短断线对账。自动重试、日志搜索、产物预览和对象存储仍未实现。

## 本地运行

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
pnpm run contracts:build      # 首次运行前在仓库根目录构建共享契约包
pnpm --filter @anvilrun/web run dev
```

默认地址为 http://127.0.0.1:5173/。开发服务器将同源 /api 代理到
http://127.0.0.1:3000，也可以通过 VITE_API_BASE_URL 配置服务端 origin。

## 认证与 API Client

API Client 统一使用 fetch、credentials: 'include' 和内存中的 Bearer Access Token。
收到一次 401 时最多自动调用 Refresh 并重试原请求一次，Refresh 失败后清空会话并回到登录页。
Refresh Cookie 保持 HttpOnly；开发环境 CSRF Cookie 使用可由管理页面读取的 Path=/，
请求刷新和退出时由 Client 自动设置 X-CSRF-Token。

## 命令

```bash
pnpm --filter @anvilrun/web run dev
pnpm --filter @anvilrun/web run build
pnpm --filter @anvilrun/web run type-check
pnpm --filter @anvilrun/web run test
```

## 约定

动态表单预览只使用 @anvilrun/contracts 的 validateFormSchema 和明确白名单控件，
不会根据 JSON 动态加载 Vue 组件、HTML、事件或插槽。T3.4 不包含任务、日志、产物和
WebSocket 实时刷新；构建任务由 T4.1 负责。

## T6.3 同源部署

生产构建输出 `dist/` 可复制到 Server 的 `WEB_STATIC_ROOT`。Server 会为 `/` 和无扩展名
Vue history 路由返回 `index.html`，而 `/api/*`、`/health/*`、`/ws/*` 继续交给 Server，
不存在的带扩展名资源返回 404。部署流程见 `docs/windows-deployment.md`。
