# @buildplatform/server

通用构建任务平台的 NestJS 服务端。

当前状态（T1.1）：包含 PostgreSQL + Prisma 数据层、migration、幂等 seed、数据库集成测试和最小健康检查；认证、Agent 网关和任务业务仍按实施计划在后续任务实现。

## 接口

| 方法 | 路径           | 说明                                       |
| ---- | -------------- | ------------------------------------------ |
| GET  | `/health`      | 返回服务名称、共享契约包版本和进程运行秒数 |
| GET  | `/health/live` | 存活探针，固定返回 `{"status":"ok"}`       |

`/health/ready`（数据库与存储目录就绪检查）留给 T6.3；`/api` 前缀与业务接口
从 T1.2 起加入。

## 本地运行

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
pnpm --filter @buildplatform/server run dev
```

默认监听 `http://127.0.0.1:3000`，可通过 `SERVER_HOST` / `SERVER_PORT` 覆盖。

## 命令

```bash
pnpm --filter @buildplatform/server run dev          # nest start --watch
pnpm --filter @buildplatform/server run build        # nest build -> dist/
pnpm --filter @buildplatform/server run start        # 运行 dist/main.js
pnpm --filter @buildplatform/server run type-check
pnpm --filter @buildplatform/server run test         # jest
```

依赖 `@buildplatform/contracts` 的编译产物，首次运行前需先执行
`pnpm run contracts:build`（仓库根目录的统一命令已包含该步骤）。

## PostgreSQL / Prisma

```bash
docker compose -f docker-compose.dev.yml up -d
Copy-Item apps/server/.env.example apps/server/.env # PowerShell；Unix 使用 cp
pnpm run db:generate
pnpm run db:migrate
pnpm run db:seed
```

部署/CI 只执行 `pnpm run db:migrate:deploy`，不要使用 `db push`。集成测试必须使用独立
的 `buildplatform_test` 数据库，设置该库的 `DATABASE_URL` 后执行 `pnpm run db:test`。
测试会在专用库中清理测试数据，不会清空 `buildplatform_dev`。

本任务只建立数据模型和数据层原语，不实现登录、令牌签发、Agent 注册、业务 Controller
或任务队列。用户名由 `src/database/username.ts` 规范化为 ASCII 小写，数据库也有
lowercase CHECK；密码和令牌字段只保存哈希或占位值。

`BuildTask.logSize`、`artifactCount`、`artifactBytes` 与 `Artifact.size` 使用 PostgreSQL
`BIGINT`，Prisma 返回 JavaScript `bigint`，后续 API 层序列化前必须显式转换。AuditLog
`metadata` 只能记录非敏感审计上下文，不得写入密码、令牌或完整配置。
