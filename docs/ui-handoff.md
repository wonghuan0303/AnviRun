# AnvilRun UI 完善任务交接文档

## 1. 任务信息

- 产品名称：AnvilRun（铸程）
- 仓库：`C:\workspace\user\buildPlatform`
- 分支：`main`
- 基线 Commit：`6e4fc54`
- 当前状态：第一版业务功能、发布门禁与真实 E2E 已完成
- 本任务目标：在不改变业务协议和功能行为的前提下，系统性提升 Web 界面的视觉质量、信息层级、易用性和响应式体验
- 主要工作目录：`apps/web/`

项目面向 Windows x64 可信内网、单实例、低并发场景。不要为了 UI 优化引入复杂基础设施、微前端、SSR、新状态管理框架或第二套组件库。

## 2. 产品定位

AnvilRun 是一个面向企业内网固定打包机的轻量构建任务平台。

管理员负责维护 Agent 和构建模板；普通用户选择模板、填写 Git 分支和动态参数后发起构建。Rust Agent 在指定打包机上拉取代码、生成 `platform.config.json`、执行命令，并将实时日志和构建产物回传平台。

产品不是 Jenkins、GitLab CI 或 GitHub Actions 的完整替代品。它聚焦“让非运维用户通过简单表单使用少量固定打包机”这一场景。

品牌标语：

> Turn dedicated build machines into a shared build service.  
> 把固定打包机变成团队共享的构建服务。

## 3. 技术栈

- Vue 3 + TypeScript
- Vite
- Element Plus
- Pinia
- Vue Router
- Vitest + Vue Test Utils + jsdom
- 原生 `fetch` API Client
- `/ws/client` 原生 WebSocket 日志连接
- `@anvilrun/contracts` 公共表单和业务契约

保持现有技术栈。可以抽取 Vue 公共展示组件和 CSS design tokens，但不要更换 Element Plus、路由、Pinia 或 API Client。

## 4. 当前页面和路由

### 公共页面

- `/`：产品概览和入口
- `/login`：登录
- 404 页面

### 登录用户页面

- `/projects`：项目列表、搜索、模板筛选和软删除
- `/projects/new`：新建项目
- `/projects/:projectId`：项目详情和构建可用性
- `/projects/:projectId/edit`：编辑项目基础信息
- `/projects/:projectId/config`：动态配置编辑
- `/projects/:projectId/tasks`：项目构建记录、筛选和发起构建
- `/tasks/:taskId`：任务详情、状态时间线、日志、取消/停止、重新构建和产物

### 管理员页面

- `/admin/agents`：Agent 分页、搜索、创建、编辑、启停、删除和令牌轮换
- `/admin/users`：用户分页列表、用户名/角色/状态筛选、创建、启用/禁用和密码重置
- `/admin/build-templates`：构建模板列表和筛选
- `/admin/build-templates/new`：新建构建模板
- `/admin/build-templates/:id/edit`：编辑构建模板和 formSchema

## 5. 主要文件

- `apps/web/src/styles/main.css`：当前全局样式集中位置
- `apps/web/src/layouts/AppLayout.vue`：项目和任务布局
- `apps/web/src/layouts/AdminLayout.vue`：管理员布局
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/HomeView.vue`
- `apps/web/src/views/NotFoundView.vue`
- `apps/web/src/views/admin/`
- `apps/web/src/views/projects/`
- `apps/web/src/views/tasks/`
- `apps/web/src/form-schema/`：动态表单编辑、预览和项目配置控件
- `apps/web/src/router/index.ts`：路由和权限跳转
- `apps/web/src/api/`：API Client，不要因视觉调整改写其行为
- `apps/web/src/stores/auth.ts`：认证会话，不要改写存储策略

## 6. UI 优化目标

### 6.1 品牌与视觉系统

围绕 AnvilRun“可靠的工程构建工具”建立一致视觉语言：

- 推荐使用深蓝灰、石墨色作为主要中性色，暖橙或铜色作为品牌强调色。
- 整体应克制、清晰、专业，不使用大面积高饱和渐变或营销网站式动画。
- 建立 CSS variables，统一颜色、圆角、阴影、间距、字体大小和内容宽度。
- 为 AnvilRun 设计简单的文字标识或纯 CSS/SVG 图形标识；不要引入来源不明的图片素材。
- 暗色主题不是本任务必需项，不要为了主题系统扩大范围。

### 6.2 布局与导航

- 统一 `AppLayout` 和 `AdminLayout` 的品牌区、顶部栏、账号区和内容容器。
- 清晰区分“项目工作区”和“管理员设置”，但避免两套完全不同的视觉系统。
- 当前路由和权限跳转必须保持不变。
- 桌面端优先，同时保证 1024px 宽度可用；窄屏下侧边栏、表格和操作按钮不能遮挡内容。
- 面包屑、返回路径和页面主操作应清楚，避免用户在项目、任务和配置页之间迷失。

### 6.3 页面信息层级

- 每页应有统一的标题、说明、主操作和次操作区域。
- 列表页统一搜索、筛选、刷新、创建按钮和分页位置。
- 详情页优先展示状态、可执行操作和关键指标，再展示低频元数据。
- 危险操作与普通操作在颜色和位置上明确区分。
- 长 ID、Git URL、Commit SHA 和时间信息要便于复制、截断和查看完整内容。

### 6.4 状态表达

统一以下状态的标签、图标和文案：

- Agent：ONLINE、OFFLINE、DISABLED
- 项目：可构建、配置不兼容、模板停用、Agent 停用
- 任务：CREATED、WAITING_AGENT、QUEUED、DISPATCHED、PREPARING、RUNNING、UPLOADING、CANCELING、SUCCEEDED、FAILED、CANCELED、AGENT_LOST
- 日志连接：连接中、实时、重连中、已断开、历史日志

状态不能只依赖颜色表达；应同时提供文字或图标。终态、进行中、等待、失败和取消需要有稳定一致的语义颜色。

### 6.5 表单体验

- 改善表单分组、必填提示、帮助文本、错误定位和底部操作区。
- 新建/编辑页在长表单下仍能明确看到保存与取消操作。
- formSchema JSON 编辑器、错误列表和安全预览应形成清楚的编辑—校验—预览关系。
- 项目动态配置继续显式支持现有 9 种白名单控件。
- 不得使用动态 HTML、动态 Vue 组件名、`v-html`、脚本、事件字符串或插槽执行 formSchema 内容。
- Server issues、本地校验 issues 和 JSON 语法错误的独立状态语义必须保持不变。

### 6.6 任务详情与日志

- 任务状态和主要操作应放在首屏明显位置。
- 状态时间线要清楚区分当前状态、历史状态、时间和原因。
- 日志区域保持等宽字体，并改善工具栏、连接状态、自动滚动、stdout/stderr 区分和空状态。
- 不要破坏 offset 去重、日志缺口补齐、历史分页和 WebSocket 重连逻辑。
- 产物列表应突出名称、路径、大小、上传时间、下载和删除操作。

### 6.7 完整交互状态

所有主要页面都应有一致的：

- 首次加载状态
- 局部刷新状态
- 空数据状态
- 请求失败状态
- 禁用状态
- 二次确认
- 成功反馈

请求失败时保留已有页面数据，不要用空白页面覆盖当前内容。

### 6.8 可访问性和可用性

- 可点击元素应使用正确的按钮或链接语义。
- 表单控件具备标签，图标按钮提供可读名称或 tooltip。
- 键盘焦点清晰可见。
- 正文、次要文字和状态标签保持足够对比度。
- 不以 hover 作为查看关键信息的唯一方式。
- 动画保持短暂克制，并尊重 `prefers-reduced-motion`。

## 7. 必须保持的功能行为

### 认证与路由

- Access Token 只能保存在 Pinia 内存，不写入 localStorage、sessionStorage、URL 或日志。
- 请求继续使用 `credentials: include`。
- 401 最多自动 refresh 并重试一次。
- USER 登录后进入 `/projects`，不能进入 `/admin/*`。
- ADMIN 可以进入管理员页面，也可以访问项目和任务页面。
- 未登录访问受保护页面继续跳转 `/login` 并保留 redirect。

### 动态表单

- 继续复用 `@anvilrun/contracts` 的 Schema/config 校验器。
- 用户编辑字段 A 时，只清除字段 A 的 Server issue；其他字段和顶层 issue 保留。
- 用户修改、上传、格式化或重置 JSON 后，旧 Server Schema issues 按现有逻辑清理。
- externalIssues 更新不能触发 validation emit 覆盖 Server issues。

### 项目与权限

- 不在前端伪造 ownerId、模板绑定或配置兼容状态。
- USER/ADMIN 的最终资源权限仍由 Server 保证。
- 跨用户资源 404 行为不能被 UI 改成客户端推断或泄露。

### 任务与实时日志

- `TaskDetailView` 必须继续监听 `taskId` 变化。
- 路由复用时关闭旧 WebSocket、停止旧轮询、清理重连计时器并防止旧请求覆盖新任务。
- 只有收到 `auth.ok` 才重置 WebSocket 重连次数。
- 认证失败最多 refresh 一次，自动重连最多 5 次。
- 非终态任务轮询，终态任务停止轮询。
- 创建任务和重新构建的 Idempotency-Key 行为保持不变。
- 产物 Blob 下载继续携带 Bearer Token，401 最多 refresh 并重试一次。

任务详情在“构建控制台日志”下方为 `interactiveInputEnabled=true` 的任务显示“任务交互输入”区域。
用户必须先接管当前任务的 `/ws/client` 控制权，输入一行文本后可发送并自动回车；敏感输入使用密码
控件并在发送前清空，不保存历史。区域会显示 Agent 离线、能力不支持、其他窗口占用、任务未运行和
通道关闭等安全状态，任务结束或切换路由时释放控制权并清空输入状态。

该区域不模拟完整终端：不支持 GUI 弹窗、PTY/ConPTY、全屏 TUI、方向键或 Ctrl+C 等控制序列；只支持
标准输入行。窄屏下控件允许换行但不得产生横向滚动，任务原有轮询、日志 offset 和超时行为保持不变。

## 8. 建议实施顺序

1. 浏览所有现有页面并记录明显不一致之处。
2. 建立全局 design tokens、字体、背景、卡片和状态色。
3. 统一两个 Layout、导航和响应式行为。
4. 抽取少量真正复用的展示组件，例如 Brand、PageHeader、StatusBadge、EmptyState、MetricCard。
5. 优化登录页和首页，建立第一印象。
6. 优化 Agent、模板和项目列表。
7. 优化项目详情、编辑和动态配置表单。
8. 最后处理任务详情、日志、时间线和产物，因为这些页面状态最多。
9. 更新受影响测试并完成多尺寸视觉复核。

不要先大规模重写业务组件。优先建立基础视觉规则，再逐页收敛。

## 9. 测试与验收

至少执行：

```powershell
pnpm lint
pnpm type-check
pnpm test
pnpm build
git diff --check
```

本任务只修改 Web 时，无需重复 PostgreSQL 和 Rust 全量回归；如果修改了 Server、公共 contracts、WebSocket 协议或 fixtures，则必须执行对应完整回归并说明原因。

必须手工或通过浏览器工具检查以下视口：

- 1440 × 900：主要桌面体验
- 1024 × 768：较窄桌面
- 390 × 844：移动端基本可用性

至少检查：

- 登录页
- 项目列表和项目详情
- Agent 管理
- 构建模板编辑及 Schema 预览
- 项目动态配置
- 任务详情、长日志和产物列表
- loading、empty、error、disabled 和确认弹窗

现有测试断言可以为适配 DOM 结构调整，但不得删除关键行为测试或把断言弱化为仅检查组件能挂载。

## 10. 范围限制

本任务不要实现：

- 新业务 API、数据库字段或 migration
- 用户管理页面
- 新任务状态或 WebSocket 消息
- 多步骤流水线、自动重试或调度策略
- Docker 镜像、Windows Service 或部署架构调整
- 暗色主题、国际化或复杂动画系统
- 第二套 UI 组件框架
- 与 UI 无关的大规模重构

如果确实发现 UI 无法完成所需体验的后端阻塞，应先在交接报告中说明，不要自行扩大 Server 范围。

## 11. 交付要求

完成后输出：

1. 视觉方向和设计原则。
2. 页面级修改摘要。
3. 新增或重构的公共组件。
4. 响应式和可访问性处理。
5. 保持不变的关键业务行为。
6. 测试命令和结果。
7. 浏览器视觉验收结果及截图位置。
8. 修改文件清单。
9. 已知限制和建议后续改进。
10. 当前 `git status`。

不要执行 `git commit`，保留工作区供上级 Agent 复审。
