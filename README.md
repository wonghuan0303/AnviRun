# Build Platform

通用构建任务平台。管理员配置构建模板，用户创建项目并填写动态配置，Rust Agent 在指定打包机上拉取代码、执行构建并回传日志与产物。

## 文档

- [产品与系统设计](docs/product-design.md)
- [分阶段实施计划](docs/implementation-plan.md)
- [本地开发说明](docs/local-development.md)

## 当前进度

已完成 T0.1～T6.4：Web、Server、TypeScript contracts 与 Rust Agent 均可安装、检查、测试和构建；当前提供 Windows x64 内网本机部署脚本、同源 Web 静态托管、readiness、数据备份恢复、Agent 发布包以及真实 Server + Rust Agent + PostgreSQL E2E 发布门禁。

## 目录结构

```text
buildPlatform/
├─ apps/
│  ├─ web/                 # Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router
│  └─ server/              # NestJS + TypeScript
├─ agent/                  # Rust Cargo workspace（跨平台 Agent）
├─ packages/
│  └─ contracts/           # Web/Server/Agent 公共业务协议与共享 fixtures
├─ docs/                   # 设计与开发文档
└─ deploy/                 # Windows 内网部署与运维脚本
```

## 环境要求

| 工具    | 版本                                                     |
| ------- | -------------------------------------------------------- |
| Node.js | `>=20.19.0`（推荐 24，见 `.nvmrc`）                      |
| pnpm    | `>=10`（当前固定 10.15.0，由 `packageManager` 字段声明） |
| Rust    | stable `>=1.82`，需 `rustfmt` 与 `clippy`                |

## 快速开始

```bash
pnpm install

# 环境变量（示例文件不含任何真实凭据）
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env

# 构建共享契约包（Web/Server 依赖其编译产物）
pnpm run contracts:build

# 启动服务端：http://127.0.0.1:3000/health
pnpm run dev:server

# 启动前端：http://localhost:5173/
pnpm run dev:web

# 运行 Agent，输出版本信息后退出
pnpm run agent:run
```

详细步骤、环境变量清单与常见问题见[本地开发说明](docs/local-development.md)。

## 统一命令

Node 侧（`apps/web`、`apps/server`、`packages/contracts`）：

| 命令                  | 说明                                     |
| --------------------- | ---------------------------------------- |
| `pnpm run lint`       | ESLint 静态检查 + Prettier 格式检查      |
| `pnpm run type-check` | 各包 `tsc` / `vue-tsc`                   |
| `pnpm run test`       | Vitest（Web、contracts）+ Jest（Server） |
| `pnpm run build`      | 按 contracts → server → web 顺序构建     |
| `pnpm run format`     | 按 Prettier 规则写回格式                 |

Rust Agent：

| 命令                       | 等价 cargo 命令（在 `agent/` 目录）                        |
| -------------------------- | ---------------------------------------------------------- |
| `pnpm run agent:fmt:check` | `cargo fmt --all -- --check`                               |
| `pnpm run agent:lint`      | `cargo clippy --all-targets --all-features -- -D warnings` |
| `pnpm run agent:test`      | `cargo test`                                               |
| `pnpm run agent:build`     | `cargo build`                                              |
| `pnpm run agent:run`       | `cargo run -p build-agent`                                 |

## 持续集成

`.github/workflows/ci.yml` 包含 `node` 与 `agent` 两个作业，分别执行格式检查、静态检查、测试和构建。CI 与本地共用 `.nvmrc` 和 `packageManager` 中的版本声明。

## PostgreSQL / Prisma 数据库（T1.1）

```bash
docker compose -f docker-compose.dev.yml up -d
Copy-Item apps/server/.env.example apps/server/.env # PowerShell；Unix 使用 cp
pnpm run db:generate
pnpm run db:migrate
pnpm run db:seed
```

部署使用 `pnpm run db:migrate:deploy`。数据库集成测试必须设置独立的
`buildplatform_test` DATABASE_URL 后运行 `pnpm run db:test`，不得清空
`buildplatform_dev`。完整 Docker、测试库重建和用户名规范化说明见[本地开发说明](docs/local-development.md)。

根级数据库命令：`db:generate`、`db:migrate`、`db:migrate:deploy`、`db:seed`、`db:test`。

## Windows 内网部署（T6.3 精简版）

部署形态为现有 Docker PostgreSQL + Windows 主机 Server/Web/Agent。使用
`deploy/windows/build.ps1` 构建，`start-server.ps1` 迁移并前台启动 Server，
`start-agent.ps1` 前台运行 Agent；`package-agent.ps1` 生成 Windows x64 ZIP 和 SHA-256。
Server 设置 `WEB_STATIC_ROOT` 后可与 API、WebSocket 同源托管 `apps/web/dist`，
`/api`、`/health`、`/ws` 不会被 SPA 回退接管。健康检查、备份恢复、升级回滚与故障排查见
[`docs/windows-deployment.md`](docs/windows-deployment.md) 和 [`docs/operations.md`](docs/operations.md)。

当前不提供 Server/Web Docker 镜像、Windows Service 或 Linux/macOS 安装模板；这些部署形态按当前内网单机需求延期。

## Windows 第一版发布门禁（T6.4）

在 Windows x64、Docker PostgreSQL healthy 且仅使用隔离测试库的环境中执行：

```powershell
pwsh -File .\deploy\windows\release-check.ps1
```

该入口按顺序运行 Node/Prisma/数据库/Rust/Agent 发布检查，并创建随机隔离数据库和临时目录运行真实构建闭环；完成后清理自身资源，不会修改 `buildplatform_dev`，也不会自动 commit。验收映射、P0/P1 规则、发布产物和已知限制见 [`docs/release-check.md`](docs/release-check.md)。
