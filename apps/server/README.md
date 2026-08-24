# @buildplatform/server

通用构建任务平台的 NestJS 服务端。

当前状态（T0.1）：只包含应用引导、环境变量读取和最小健康检查，没有数据库、认证、
Agent 网关和任务逻辑。

## 接口

| 方法 | 路径           | 说明                                       |
| ---- | -------------- | ------------------------------------------ |
| GET  | `/health`      | 返回服务名称、共享契约包版本和进程运行秒数 |
| GET  | `/health/live` | 存活探针，固定返回 `{"status":"ok"}`       |

`/health/ready`（数据库与存储目录就绪检查）在 T1.1、T6.3 补充；`/api` 前缀与业务接口
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
