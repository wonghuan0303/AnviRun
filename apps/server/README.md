# @anvilrun/server

AnvilRun（铸程）构建任务平台 NestJS 服务端，负责认证授权、项目与任务队列、Agent WebSocket、日志和产物管理。

## 认证接口

- `POST /api/auth/login`：规范化用户名、Argon2id 密码验证，返回短期 Access Token，并设置 HttpOnly Refresh Cookie 与 CSRF Cookie。
- `POST /api/auth/refresh`：校验 `X-CSRF-Token`，在数据库事务中轮换 Refresh Token；开发环境 CSRF Cookie 使用 Path=/ 供管理页面读取。
- `POST /api/auth/logout`：校验 CSRF、撤销当前 Refresh Token、清除 Cookie，重复调用幂等。
- `GET /api/auth/me`：Bearer Access Token Guard，返回 `id/username/role/status`。
- `POST /api/admin/users`：ADMIN 创建 USER/ADMIN。
- `PATCH /api/admin/users/:id/disable`：ADMIN 禁用用户、递增 tokenVersion、撤销全部刷新会话。
- `POST /api/admin/users/:id/reset-password`：ADMIN 使用 Argon2id 重置密码并撤销全部会话。

错误响应统一为 contracts 的 `code/message/details/requestId`。不存在用户和错误密码均为
`AUTH_INVALID_CREDENTIALS`，过期/签名错误 Access Token 为 `AUTH_TOKEN_EXPIRED`。

服务端在生产启动时关闭默认 body parser，使用 1 MiB JSON/URL encoded 请求体上限；超限或格式错误返回结构化 `VALIDATION_FAILED`，不返回解析器错误、堆栈或本地路径。Agent `/ws/agent` 单条消息上限为 1 MiB，浏览器 `/ws/client` 单条消息上限为 64 KiB。Agent 会在发送 `task.artifact-manifest` 前按完整 UTF-8 envelope 检查该上限，超限发送 `ARTIFACT_MANIFEST_TOO_LARGE` 的 `task.failed`，不重复重连；产物内容仍通过独立流式 HTTP 上传，不受 JSON parser 限制。

## 首个管理员

密码不允许作为命令行参数：

```powershell
pnpm --filter @anvilrun/server run admin:init -- --username admin --password-stdin
```

TTY 中密码隐藏输入；自动化场景从 stdin 提供密码。CLI 使用 PostgreSQL advisory lock，
已有 ADMIN 或并发初始化都会安全拒绝重复创建。成功输出只包含管理员 ID 和 username。

## 本地运行与数据库

```powershell
docker compose -f docker-compose.dev.yml up -d
Copy-Item .env.example .env
pnpm run db:generate
pnpm run db:migrate
pnpm run db:seed
pnpm --filter @anvilrun/server run dev
```

生产环境必须显式设置两个相互独立的高复杂度随机 `ACCESS_TOKEN_SECRET` 和 `REFRESH_TOKEN_HASH_SECRET`，并拒绝重复字符、示例值、占位值及开发/测试固定值。默认生产认证启用
`AUTH_COOKIE_SECURE=true`、`__Host-` Cookie、Path=/ 且不设置 Domain。仅可信内网 HTTP 部署可显式设置
`ALLOW_INSECURE_HTTP=true`、`AUTH_COOKIE_SECURE=false`、非 `__Host-` Cookie 名和 `SameSite=Strict`；该模式会输出 warning，不适合公网，接入 HTTPS 后应关闭。完整环境变量见 `apps/server/.env.example`，认证设计见
`docs/authentication.md`。认证测试必须使用独立 `buildplatform_test`，不得清理
`buildplatform_dev`。

## T1.3 RBAC 与资源所有权

服务端权限以 `Project.ownerId` 作为唯一业务所有权来源：

- `ADMIN` 可以访问所有未软删除的 Project、BuildTask、任务日志和 Artifact。
- `USER` 只能访问 `Project.ownerId` 等于当前用户 ID 的资源。
- BuildTask、任务日志和 Artifact 分别沿 `BuildTask.project`、`taskId -> BuildTask.project`、`Artifact.task -> BuildTask.project` 继承 Project 权限。
- `BuildTask.createdBy`、`BuildTemplate.createdBy`、Agent、Artifact 的 `storagePath` 和客户端传入的 `ownerId` 都不是权限依据。

普通业务授权默认要求 Project 的 `deletedAt` 为 `null`；因此已软删除 Project 及其 Task、日志和 Artifact 对普通访问和默认管理员访问均不可见。将来管理接口如需查看已删除资源，必须显式设计独立的管理查询条件。

后续资源 Controller 应先运行 `AccessTokenGuard`，再运行 `OwnershipGuard`，并用显式 Decorator 声明参数对应的资源类型：

```ts
@Get(':projectId')
@UseGuards(AccessTokenGuard, OwnershipGuard)
@OwnedResource('project', 'projectId')
getProject() {
  // OwnershipGuard 已完成统一的 Project.ownerId 与 deletedAt 校验
}
```

可用资源类型包括 `project`、`task`、`taskLog` 和 `artifact`。授权查询统一通过 `AuthorizationService`：

```ts
const where = authorization.projectScope(actor, clientWhere);
const taskWhere = authorization.taskScope(actor, clientWhere);
const artifactWhere = authorization.artifactScope(actor, clientWhere);
```

这些方法返回可直接组合到 Prisma `where` 的数据库条件。客户端筛选只能作为额外的 AND 条件，不能覆盖服务端注入的 owner scope；列表接口不得先查询全部资源再在内存中过滤。单资源检查使用 `assertProjectAccess`、`assertTaskAccess`、`assertTaskLogAccess` 或 `assertArtifactAccess`。

未认证请求仍由 `AccessTokenGuard` 返回既有认证错误，普通用户访问管理员接口仍由 `AdminGuard` 返回 `FORBIDDEN`。不存在、跨用户、已软删除和非法 UUID 的资源统一返回 `404 RESOURCE_NOT_FOUND`，不返回 owner、用户名、storagePath、Prisma/PostgreSQL 错误或堆栈，以避免资源枚举。

## T2.1 Agent 管理与连接

Agent 管理接口位于 `/api/admin/agents`，全部要求 `AccessTokenGuard, AdminGuard`。管理员可以创建、分页查询、修改名称、启用、停用、轮换注册令牌和删除 Agent；普通用户统一返回 `FORBIDDEN`。创建或轮换响应中的 `registrationToken` 只显示一次，数据库、列表、详情、审计和错误响应只保存/展示 SHA-256 哈希之外的安全摘要，不返回明文令牌。

Agent 使用原生 RFC 6455 连接 `/ws/agent`，令牌只放在握手 Header：`Authorization: Bearer <agent-token>`。Server 复用 `@anvilrun/contracts` 校验 protocol envelope、`agent.hello` 和 `agent.heartbeat`，合法 hello 后返回 `agent.registered`。心跳间隔为 15 秒，连续 45 秒未收到心跳后置为 `OFFLINE`；停用或轮换令牌会发送 `agent.token.revoked` 并断开旧连接。

连接注册表为单 Server 实例内存结构，同一 Agent 只保留一个连接。后续 T2.2 Rust Agent 应直接复用上述公共协议；WSS、重连退避、任务领取和任务执行不属于 T2.1。详细流程见 `docs/agents.md`。

## T3.1 构建模板后端

管理员模板接口位于 `/api/admin/build-templates`，全部要求 `AccessTokenGuard, AdminGuard`。支持创建、分页筛选、详情、更新、启用、停用和删除；模板始终由服务端写入 `createdBy`，不接受客户端篡改。

普通登录用户使用 `/api/build-templates` 读取已启用模板摘要和动态 `formSchema`，不能读取停用模板。公共响应不包含构建命令、产物目录、创建者或 Agent tokenHash。

服务端复用 `@anvilrun/contracts` 的 `validateFormSchema`，校验 Git URL、Shell 命令、工作区内相对产物目录和正整数超时。绑定 Agent 必须存在且 `enabled=true`；OFFLINE 但启用的 Agent 可以绑定。删除被 Project 或 BuildTask 引用的模板返回 409。

T3.1 不包含模板版本、Git 拉取、项目、任务派发或 Web 管理页面。

## T3.3 项目后端与所有权

项目接口位于 `/api/projects`，登录用户可创建、分页查询、查看详情、更新名称/说明/分支、通过专用接口保存配置以及软删除项目：

- `POST /api/projects`
- `GET /api/projects?page=&pageSize=&search=&buildTemplateId=&ownerId=`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId`
- `PUT /api/projects/:projectId/config`
- `DELETE /api/projects/:projectId`

服务端始终从认证用户写入 `ownerId`，请求体中的 `ownerId`、`deletedAt` 和受保护的模板/config 字段会被拒绝。创建只能绑定已启用模板；绑定 Agent 是否 OFFLINE 不影响创建。项目删除是软删除，默认列表、详情以及任务/日志/Artifact 的既有授权 scope 都会排除已删除项目。

所有详情、更新、配置保存和删除接口先运行 `AccessTokenGuard`，再运行 `OwnershipGuard` 并声明 `@OwnedResource('project', 'projectId')`。USER 的 Prisma 查询通过 `AuthorizationService.projectScope` 强制注入当前用户和 `deletedAt: null`；ADMIN 可查看全部未删除项目，并可用 `ownerId` 作额外筛选。跨用户、已删除、非法 UUID 和不存在项目统一返回 `404 RESOURCE_NOT_FOUND`。

项目配置保存在 Project 的单个 JSONB `config` 字段中。Server 使用 `@anvilrun/contracts` 的 `validateFormConfigValues` 过滤未知字段、校验控件值并应用默认值；`PUT /config` 才会持久化规范化结果。详情通过 `analyzeFormConfigCompatibility` 返回 `valid`、`effectiveConfig`、`missingFields`、`obsoleteFields`、`typeConflictFields`、`issues`、`templateEnabled`、`agentEnabled` 和 `buildable`，读取详情不会改写数据库。模板新增带默认值字段不会破坏旧配置，新增无默认值的必填字段、类型变化或 options 变化会使项目不可构建；模板/Agent 停用时项目仍可读但不可构建。 详情/创建/更新/配置保存响应包含当前模板 `formSchema`，便于项目配置页面渲染；分页列表只返回模板安全摘要，不携带 `formSchema`，避免无必要地扩大列表响应。

T3.3 不包含 Web 项目页面、构建任务创建、Git 访问、Agent 派发、模板版本或配置加密。

## T4.1 构建任务创建与数据库队列

任务接口位于 `/api/projects/:projectId/tasks` 和 `/api/tasks/:taskId`，要求登录并复用
`AccessTokenGuard -> OwnershipGuard`。用户只能创建和查看自己项目下的任务；ADMIN 可访问所有未软删除项目，跨用户、非法 UUID、已删除或不存在资源统一返回 `404 RESOURCE_NOT_FOUND`。

- `POST /api/projects/:projectId/tasks` 创建任务；服务端复制项目当前 branch/config，并记录当前模板、Agent 和创建者，不接受客户端 ownerId、模板或配置覆盖。
- 创建接口支持 `Idempotency-Key` 请求头；同一用户、项目和幂等键在 PostgreSQL 中只对应一条任务，Web 创建/重建请求会自动携带该键。
- `GET /api/projects/:projectId/tasks?page=&pageSize=&status=` 分页查询项目任务；`GET /api/tasks/:taskId` 返回安全详情和按时间排序的状态历史。
- 创建前校验模板和 Agent 均启用、项目配置对模板当前 Schema 兼容；Agent 无可用连接时进入 `WAITING_AGENT`，Agent 已完成 WebSocket hello 时进入 `QUEUED`。
- Agent hello 后会将该 Agent 的等待任务转为 `QUEUED` 并发送 `task.available`。`task.claim` 在 PostgreSQL 事务中先锁定 Agent 行，再按 `createdAt,id` FIFO 领取，写入派发租约并设置 `activeTaskId`；部分唯一索引和同一锁顺序保证一个 Agent 同时最多一个活动任务。
- 租约明文只在 `task.assignment` 中短暂发送，数据库只保存 SHA-256 哈希和过期时间。Agent 以 `task.accepted` 确认后任务进入 `PREPARING`；未确认的 `DISPATCHED` 超过 30 秒会被回收至 `QUEUED` 或 `WAITING_AGENT`。Server 重启后队列、租约状态和历史仍以 PostgreSQL 为准。
- T6.1 中 Agent 的普通短断线会使执行中任务进入 `AGENT_LOST`，保留租约和 `activeTaskId`，重连 hello 经数据库锁定后由 `task.recovery` 决定 RESUME、CANCEL 或 ABANDON；CANCELING 任务保持取消确认窗口，重连只执行 CANCEL 清理，不恢复命令。恢复窗口默认 300 秒，超时转 FAILED。终态事务完成后通过 `task.result.ack` 明确确认，重复终态上报不重复写历史。

T4.1 只实现创建、查询、状态历史、Agent 可用通知、领取确认、租约和派发超时回收；任务执行、完成/失败上报、日志、产物和取消留给后续阶段。

## T5.3 产物上传与下载

Agent 在任务进入 `UPLOADING` 后先通过 WebSocket 发送 `task.artifact-manifest`。Server 按 Agent、活动任务和租约校验清单，写入尚未上传的 Artifact 元数据并返回 `task.artifact-manifest-ack`；文件本体通过 `PUT /api/agent/tasks/:taskId/artifacts/content?relativePath=...` 以 `application/octet-stream` 流式上传。上传过程在 Server 侧按清单大小和 SHA-256 校验，使用任务目录内的独占临时文件、刷盘后移动到 `data/artifacts/<taskId>/<relativePath>`，不把租约明文写入 URL、数据库、日志或响应。短写会被完整处理并在移动前复核临时文件大小；若正式文件已移动但 `uploadedAt` 尚未落库，内容一致的重试会流式复核并补写元数据。单任务总量上限为 2 GiB，路径穿越、符号链接/reparse point、尺寸或 Hash 不匹配都会拒绝；同一文件在内容一致时可安全重试。

派发时使用的 `artifactDir` 会单独保存到 BuildTask，manifest 始终按本次 assignment 的目录校验，不受运行期间模板编辑影响。所有文件成功确认后，Agent 发送 `task.completed`，Server 再经 `TaskStateService` 将 `UPLOADING -> SUCCEEDED`，记录产物数量/字节数、清除任务租约和 `Agent.activeTaskId`。未完成全部上传不会成功收尾；如果完成统计错误，Server 拒绝消息并关闭当前 Agent 连接，由既有断线收尾将任务安全置为失败、释放执行槽。重复完成只接受与已记录统计一致的结果，不重复写终态历史。

登录用户可使用：

- `GET /api/tasks/:taskId/artifacts?page=&pageSize=`：按项目所有权分页列出已成功任务的产物。
- `GET /api/artifacts/:artifactId/download`：流式下载单个产物。
- `GET /api/tasks/:taskId/artifacts/archive`：流式下载任务 ZIP，不在内存中汇总文件内容；单个清单最多 65,535 个文件。
- `DELETE /api/artifacts/:artifactId`：软删除产物。

这些接口复用 `AccessTokenGuard -> OwnershipGuard` 和既有 `AuthorizationService`；跨用户、未完成任务、已删除产物、非法 UUID 和不存在资源统一返回 `404 RESOURCE_NOT_FOUND`。响应只包含相对路径、文件名、大小、SHA-256 等安全字段，不返回 `storagePath`、lease、Agent token、passwordHash 或 tokenVersion。

## 任务概览

登录用户可通过 `GET /api/overview` 获取登录后的任务概览。接口使用 `AccessTokenGuard`，任务查询在数据库层复用 `AuthorizationService.taskScope`：ADMIN 查看全部未删除项目任务，USER 只能看到自己项目下的非终态任务；Agent 仅返回名称、启停/在线状态和主机摘要。

响应按 Agent 分组提供执行中（DISPATCHED/PREPARING/RUNNING/UPLOADING/CANCELING/AGENT_LOST）和排队中（CREATED/WAITING_AGENT/QUEUED）任务，队列顺序为 `createdAt ASC, id ASC`，不包含命令、配置、租约或认证字段。

## T5.4 任务查询与重新构建

登录用户可使用：

- `GET /api/projects/:projectId/tasks?page=&pageSize=&status=`：按项目所有权分页查询任务。
- `GET /api/tasks/:taskId`：返回任务安全详情和按时间排序的状态历史。
- `POST /api/tasks/:taskId/cancel`：按当前任务状态请求取消或停止。
- `POST /api/tasks/:taskId/rebuild`：按旧任务取得项目后，使用项目当前 branch、config 和模板创建一条全新任务；旧任务的状态、历史、日志、产物和执行租约不复制。

任务详情、日志和产物接口都先执行 `AccessTokenGuard`，再执行 `OwnershipGuard`；USER 只能访问自己 `Project.ownerId` 下的任务，ADMIN 可访问所有未软删除项目。跨用户、非法 UUID、不存在和已软删除资源统一返回 `404 RESOURCE_NOT_FOUND`。任务响应只返回安全的项目、模板、Agent 和用户摘要，`leaseHash`、`storagePath`、Agent token、`passwordHash` 和 `tokenVersion` 不对外暴露。

T5.4 页面接口不承载 T6.1 的断线恢复协议；Server/Agent 已在 T6.1 支持短断线租约对账和 Agent 重启孤立任务失败。系统不提供自动重试或日志搜索。

## T6.2 内网安全与审计

本阶段复用 `AccessTokenGuard`、`AdminGuard`、`OwnershipGuard`、`AuthorizationService`、`CookieService` 和既有 `AuditService`，不重新设计认证协议。权限、Cookie/CSRF 和敏感响应边界保持既有规则：生产 `__Host-` Cookie 必须 Secure=true、Path=/ 且不设置 Domain；Refresh Cookie 为 HttpOnly、SameSite=Strict，refresh/logout 继续校验 CSRF；Access Token 只在 Web 内存中保存。

审计覆盖认证、用户、Agent、构建模板、Project、任务创建/取消/重建和 Artifact 软删除。审计 metadata 只包含受控安全上下文，并统一写入 `result: SUCCESS|FAILURE`；密码、Hash、Token、Cookie、Authorization Header、完整配置、敏感字段、storagePath、Prisma 错误和堆栈均不得进入 API 错误、普通日志或审计记录。T6.2 不包含 HTTPS 证书加载、配置静态加密、分布式限流、审计查询页面或部署/安装工作。

### T5.1 任务日志

### T5.2 任务取消与超时

登录用户可通过 POST /api/tasks/:taskId/cancel 请求取消自己项目中的任务；ADMIN 可取消所有未软删除项目中的任务。接口复用 AccessTokenGuard -> OwnershipGuard，跨用户、非法 UUID、已删除和不存在任务统一返回 404 RESOURCE_NOT_FOUND。

排队任务在同一事务中经由 CREATED/WAITING_AGENT/QUEUED -> CANCELING -> CANCELED 收尾；已派发或执行中的任务先锁定 Agent 行并进入 CANCELING，Server 使用进程内短暂保存的明文租约发送 task.cancel，只接受匹配 Agent、taskId、activeTaskId 和租约的 task.canceled 回执。租约明文不写入数据库、日志或 API 响应。

取消完成会清除任务租约、Agent.activeTaskId 和 finishedAt，并保留任务日志租约；重复回执幂等，普通状态上报不能逆转 CANCELING，但在 Agent、任务、活动租约和 leaseToken 均校验通过时，普通 task.failed 可将 CANCELING 收尾为 FAILED。Agent 断线时 CANCELING 保留租约和执行槽，重连由 `task.recovery(CANCEL)` 要求 Agent 清理；task.cancel 未送达或超时未确认时，Server 在固定确认窗口后以 CANCELING -> FAILED 做最小收尾并断开 Agent，避免执行槽永久占用。Rust Agent 使用 Windows Job Object 或 Unix 进程组终止任务进程树，确认工作区清理成功后发送 task.canceled；完整恢复对账仍不属于本阶段。

Agent 的 `task.log` 由 `/ws/agent` 接收并按任务追加到文件型 NDJSON 日志，文件路径为 `<TASK_LOG_ROOT>/<taskId 前两位>/<taskId>.ndjson`。PostgreSQL 只保存 `lastLogSequence`、`logSize`、短期日志租约和敏感键快照，不保存日志正文。重复序号会返回当前 ACK，乱序序号不会写入；成功追加后 Server 返回 `task.log.ack`，其中包含连续序号和持久化偏移。

已登录用户可通过 `GET /api/tasks/:taskId/logs?offset=&limit=` 增量读取历史日志，并通过 `/ws/client` 发送首条 `auth` 消息后订阅实时日志。订阅与 HTTP 查询均复用 `AuthorizationService.assertTaskLogAccess`，跨用户资源统一表现为 `404 RESOURCE_NOT_FOUND`。Server 和 Agent 都会遮蔽敏感配置值；敏感字段本身仍完整写入 Agent 的 `platform.config.json`。日志读取按偏移和有界大小流式处理，不把完整日志加载进 PostgreSQL 或内存。

## Windows 内网部署（T6.3 精简版）

Server 可通过 `WEB_STATIC_ROOT` 可选托管 `apps/web/dist`，与 API 和 WebSocket 使用同源访问。`/` 与无扩展名 Vue history 路由回退到 `index.html`；`/api/*`、`/health/*`、`/ws/*` 不参与 SPA 回退，不存在的带扩展名资源返回 404。静态根必须包含可读的 `index.html`，缺失时启动失败，`/health/ready` 也会报告 Web 不可用。

`/health/live` 只检查 Node 进程响应，不访问数据库或磁盘；`/health/ready` 执行 `SELECT 1`，对 `TASK_LOG_ROOT` 和 `ARTIFACT_STORAGE_ROOT` 做独占临时文件写入/同步/删除探针，并检查可选 Web 入口。ready 成功返回 200，失败返回 503；响应不包含数据库 URL、密钥、绝对路径、Prisma 错误或堆栈。

Windows 本机部署脚本位于 `deploy/windows/`：`build.ps1`、`start-server.ps1`、`start-agent.ps1`、`check-health.ps1`、`backup.ps1`、`restore.ps1` 和 `package-agent.ps1`。脚本支持带空格路径，使用 `-LiteralPath`，Server/Agent 前台运行，迁移失败不启动 Server，不自动 seed 或创建管理员。完整目录、升级回滚、备份恢复和故障排查见 `docs/windows-deployment.md` 与 `docs/operations.md`。

生产配置必须显式提供两个独立强密钥；默认使用 HTTPS 以满足 Secure Cookie，可信内网 HTTP 例外必须显式开启 `ALLOW_INSECURE_HTTP`，不提供默认管理员、Windows Service、应用 Docker 镜像或 Linux/macOS 安装包。
