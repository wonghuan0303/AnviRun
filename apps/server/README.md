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
