# @buildplatform/web

通用构建任务平台 Web 前端，使用 Vue 3、TypeScript、Vite、Element Plus、Pinia 和 Vue Router。

## T3.2 已实现

- /login 登录、Refresh Cookie 会话恢复、退出；Access Token 只保存在 Pinia 内存。
- /admin/agents 管理 Agent、启停、删除、名称编辑和一次性注册令牌轮换。
- /admin/build-templates 分页、名称/启用状态/Agent 筛选和模板启停删除。
- /admin/build-templates/new、/admin/build-templates/:id/edit 模板表单。
- formSchema 支持本地 .json 上传（最大 1 MB）、文本编辑、格式化、重置、公共契约校验、JSON 行列定位和白名单动态预览。
- 普通 USER 不能进入管理员路由；服务端 401/403 仍是最终权限边界。

## 本地运行

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
pnpm run contracts:build      # 首次运行前在仓库根目录构建共享契约包
pnpm --filter @buildplatform/web run dev
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
pnpm --filter @buildplatform/web run dev
pnpm --filter @buildplatform/web run build
pnpm --filter @buildplatform/web run type-check
pnpm --filter @buildplatform/web run test
```

## 约定

动态表单预览只使用 @buildplatform/contracts 的 validateFormSchema 和明确白名单控件，
不会根据 JSON 动态加载 Vue 组件、HTML、事件或插槽。T3.2 不包含项目、任务、日志、产物和
WebSocket 实时刷新；这些由后续计划负责。
