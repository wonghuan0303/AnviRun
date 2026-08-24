# Build Platform

通用构建任务平台。管理员配置构建模板，用户创建项目并填写动态配置，Rust Agent 在指定打包机上拉取代码、执行构建并回传日志与产物。

## 文档

- [产品与系统设计](docs/product-design.md)
- [分阶段实施计划](docs/implementation-plan.md)
- [本地开发说明](docs/local-development.md)

## 当前进度

已完成 **T0.1 Monorepo 骨架** 与 **T0.2 公共业务契约**：Web、Server、TypeScript contracts 与 Rust Agent 均可安装、检查、测试和构建。登录、数据库、Agent 连接、动态表单业务页面与任务执行逻辑仍按实施计划在后续任务实现。

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
└─ deploy/                 # 部署与运维资产（T6.3 填充）
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
