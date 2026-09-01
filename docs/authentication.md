# T1.2 本地账号认证

## 初始化首个管理员

管理员只能通过 CLI 初始化，用户不能自行注册。命令不会接受密码参数，也不会把密码写入
进程列表或日志：

```powershell
pnpm --filter @buildplatform/server run admin:init -- --username admin --password-stdin
```

TTY 会隐藏密码输入；自动化场景把密码通过标准输入传给命令即可。成功输出只包含管理员
ID 和 username。PostgreSQL advisory lock 保证并发执行最多创建一个管理员；任何已有 ADMIN
用户都会拒绝重复初始化。T1.1 的 DISABLED/USER 占位种子不会被计为管理员。

## API

| 方法  | 路径                                  | 说明                                                             |
| ----- | ------------------------------------- | ---------------------------------------------------------------- |
| POST  | `/api/auth/login`                     | 用户名/密码登录，返回短期 Access Token，设置 Refresh/CSRF Cookie |
| POST  | `/api/auth/refresh`                   | 需要 CSRF Header，轮换 Refresh Token                             |
| POST  | `/api/auth/logout`                    | 需要 CSRF Header，撤销 Refresh Token 并清除 Cookie               |
| GET   | `/api/auth/me`                        | `Authorization: Bearer` 后返回当前用户摘要                       |
| POST  | `/api/admin/users`                    | ADMIN 创建 USER/ADMIN                                            |
| PATCH | `/api/admin/users/:id/disable`        | ADMIN 禁用用户并撤销会话                                         |
| POST  | `/api/admin/users/:id/reset-password` | ADMIN 重置密码并撤销会话                                         |

所有错误响应遵循 contracts 的 `code/message/details/requestId` 结构。不存在用户和错误密码
均返回 `AUTH_INVALID_CREDENTIALS`；过期或签名错误 Access Token 返回 `AUTH_TOKEN_EXPIRED`。

## Token、Cookie 与 CSRF

- Access Token 使用固定 HS256 签名，默认 15 分钟，claims 包含 `sub`、`role`、`tokenVersion`、`jti`、`typ`、`iat`、`exp`、`iss`、`aud`。
- Refresh Token 使用 32 字节随机值，仅以 HMAC-SHA-256 摘要写入数据库，默认 7 天；刷新在事务中撤销旧记录并创建新记录，并发请求最多一个成功。
- 开发环境 Refresh Cookie 使用 HttpOnly、SameSite=Strict、Path=/api/auth；开发环境 CSRF Cookie 使用非 HttpOnly、Path=/，以便 /admin 页面读取并回传 X-CSRF-Token；生产环境使用 `__Host-` 前缀时必须 Secure=true、Path=/ 且不设置 Domain。登录、刷新和退出清除 Cookie 使用完全一致的 Path/Secure/SameSite 配置；CSRF Cookie 独立、非 HttpOnly，客户端需通过 `X-CSRF-Token` 回传。
- 禁用用户和密码重置均在事务中递增 `tokenVersion` 并撤销全部 RefreshToken；AccessTokenGuard 每次查询数据库核对状态和版本。
- 前端后续只应把 Access Token 放在内存中，不写入 localStorage。

## 密码、限流与审计

密码使用 Argon2id（memoryCost=19456 KiB、timeCost=2、parallelism=1），每次自动生成随机
salt；允许 Unicode，按字符限制 15-128，拒绝空白密码。登录限流按来源 IP 和规范化用户名
分别计数，默认 5 分钟最多 5 次，限流为进程内实现，仅适用于单实例且重启会清空计数。

生产环境必须显式配置 `ACCESS_TOKEN_SECRET` 和 `REFRESH_TOKEN_HASH_SECRET` 两个相互独立的高复杂度密钥；重复字符、示例值、占位值和开发/测试固定值都会被拒绝。

认证成功/失败、刷新轮换/拒绝、退出、用户创建/禁用/重置和管理员初始化均写入 AuditLog。
审计 metadata 由现有 AuditService 过滤，只保留受控的安全上下文，并包含 `result: SUCCESS|FAILURE`；不包含密码、Hash、Token、Cookie、CSRF Token、Authorization Header、完整请求体或完整配置。

请求体安全边界：JSON 和 URL encoded API 请求体上限为 1 MiB，超限以结构化 `VALIDATION_FAILED` 拒绝；WebSocket 消息大小限制和产物流式上传边界见 `docs/security.md`。系统面向可信内网部署，配置静态加密和更完整的 HTTPS/部署加固留到后续阶段。
