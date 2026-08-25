# @buildplatform/server

通用构建任务平台 NestJS 服务端。当前包含 T1.1 PostgreSQL/Prisma 数据层和 T1.2 本地账号认证。

## 认证接口

- `POST /api/auth/login`：规范化用户名、Argon2id 密码验证，返回短期 Access Token，并设置 HttpOnly Refresh Cookie 与 CSRF Cookie。
- `POST /api/auth/refresh`：校验 `X-CSRF-Token`，在数据库事务中轮换 Refresh Token。
- `POST /api/auth/logout`：校验 CSRF、撤销当前 Refresh Token、清除 Cookie，重复调用幂等。
- `GET /api/auth/me`：Bearer Access Token Guard，返回 `id/username/role/status`。
- `POST /api/admin/users`：ADMIN 创建 USER/ADMIN。
- `PATCH /api/admin/users/:id/disable`：ADMIN 禁用用户、递增 tokenVersion、撤销全部刷新会话。
- `POST /api/admin/users/:id/reset-password`：ADMIN 使用 Argon2id 重置密码并撤销全部会话。

错误响应统一为 contracts 的 `code/message/details/requestId`。不存在用户和错误密码均为
`AUTH_INVALID_CREDENTIALS`，过期/签名错误 Access Token 为 `AUTH_TOKEN_EXPIRED`。

## 首个管理员

密码不允许作为命令行参数：

```powershell
pnpm --filter @buildplatform/server run admin:init -- --username admin --password-stdin
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
pnpm --filter @buildplatform/server run dev
```

生产环境必须显式设置两个相互独立的高复杂度随机 `ACCESS_TOKEN_SECRET` 和 `REFRESH_TOKEN_HASH_SECRET`，并拒绝重复字符、示例值、占位值及开发/测试固定值；同时启用
`AUTH_COOKIE_SECURE=true`。完整环境变量见 `apps/server/.env.example`，认证设计见
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

Agent 使用原生 RFC 6455 连接 `/ws/agent`，令牌只放在握手 Header：`Authorization: Bearer <agent-token>`。Server 复用 `@buildplatform/contracts` 校验 protocol envelope、`agent.hello` 和 `agent.heartbeat`，合法 hello 后返回 `agent.registered`。心跳间隔为 15 秒，连续 45 秒未收到心跳后置为 `OFFLINE`；停用或轮换令牌会发送 `agent.token.revoked` 并断开旧连接。

连接注册表为单 Server 实例内存结构，同一 Agent 只保留一个连接。后续 T2.2 Rust Agent 应直接复用上述公共协议；WSS、重连退避、任务领取和任务执行不属于 T2.1。详细流程见 `docs/agents.md`。
