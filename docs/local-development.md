# 本地开发说明

本文档描述在全新环境中安装依赖、启动各子项目并执行检查的完整步骤。业务设计见
[产品与系统设计](product-design.md)，任务拆分见 [分阶段实施计划](implementation-plan.md)。

当前仓库已完成 T0.1～T6.4：Web、Server、契约包与 Rust Agent 可构建，Server 已接入 PostgreSQL + Prisma 数据层，并提供 Windows 内网本机部署脚本、readiness、同源静态托管、备份恢复、Windows x64 Agent 发布包和真实 Server + Rust Agent + PostgreSQL 发布门禁。

## 1. 环境要求

| 工具    | 版本要求                                | 说明                                           |
| ------- | --------------------------------------- | ---------------------------------------------- |
| Node.js | `>=20.19.0`（推荐 24 LTS，见 `.nvmrc`） | Vite 7 与 NestJS 11 的最低要求                 |
| pnpm    | `>=10`（当前固定 10.15.0）              | 由 `package.json` 的 `packageManager` 字段固定 |
| Rust    | stable（`>=1.82`）                      | 需要 `rustfmt` 与 `clippy` 组件                |
| Git     | 任意近期版本                            | Agent 后续直接调用系统 Git（T4.2）             |

启用 pnpm 的推荐方式：

```bash
corepack enable pnpm
```

Rust 组件：

```bash
rustup component add rustfmt clippy
```

## 2. 安装依赖

```bash
git clone <仓库地址> anvilrun
cd anvilrun
pnpm install
```

`pnpm install` 只安装 Node 侧依赖（`apps/web`、`apps/server`、`packages/contracts`）。
Rust 依赖在首次 `cargo build` 时解析。

## 3. 环境变量

每个应用读取自己目录下的 `.env`，示例文件随仓库提交，真实 `.env` 已被 `.gitignore` 忽略。

```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

Windows PowerShell：

```powershell
Copy-Item apps/server/.env.example apps/server/.env
Copy-Item apps/web/.env.example apps/web/.env
```

| 变量                | 归属          | 默认值        | 说明                                        |
| ------------------- | ------------- | ------------- | ------------------------------------------- |
| `NODE_ENV`          | `apps/server` | `development` | 运行环境标识                                |
| `SERVER_HOST`       | `apps/server` | `127.0.0.1`   | HTTP 监听地址，容器部署改为 `0.0.0.0`       |
| `SERVER_PORT`       | `apps/server` | `3000`        | HTTP 监听端口                               |
| `VITE_API_BASE_URL` | `apps/web`    | 无            | 服务端 API 基地址，未配置时页面显示“未配置” |

示例文件中禁止出现真实账号、密码、令牌或内网地址。数据库、JWT 密钥、Agent 令牌等变量
分别在 T1.1、T1.2、T2.1 引入。

## 4. 启动各子项目

### 4.1 共享契约包

Web 与 Server 通过包名引用 `@anvilrun/contracts` 的编译产物，因此首次开发前需要
先构建一次：

```bash
pnpm run contracts:build
```

仓库根目录的 `type-check`、`test`、`build` 命令已自动包含该步骤。

### 4.2 Server（NestJS）

```bash
pnpm run dev:server
```

预期结果：控制台输出 `Server listening on http://127.0.0.1:3000/health`。

```bash
curl http://127.0.0.1:3000/health
# {"status":"ok","service":"@anvilrun/server","contracts":{"name":"@anvilrun/contracts","version":"0.1.0"},"uptimeSeconds":0}

curl http://127.0.0.1:3000/health/live
# {"status":"ok"}
```

### 4.3 Web（Vite）

```bash
pnpm run dev:web
```

预期结果：终端输出本地地址（默认 `http://localhost:5173/`），页面顶部显示
“AnvilRun（铸程）构建任务平台”，正文卡片显示前端技术栈、共享契约包版本、API 基地址，以及
“当前为 T1.1 数据层建设阶段”的提示。

### 4.4 Rust Agent

```bash
cd agent
cargo run -p build-agent
```

预期结果：输出版本信息后按配置连接 Server，并以前台长期运行。测试或只查看版本时可执行：

```powershell
cargo run -p build-agent -- --version
```

## 5. 统一检查命令

在仓库根目录执行（覆盖 Web、Server、契约包）：

```bash
pnpm run lint         # ESLint 静态检查 + Prettier 格式检查
pnpm run type-check   # 各包 tsc / vue-tsc
pnpm run test         # Vitest（Web、契约包）+ Jest（Server）
pnpm run build        # contracts -> server -> web
pnpm run format       # 按 Prettier 规则写回格式
```

Rust Agent 既可以在 `agent/` 目录直接使用 cargo，也可以从根目录调用：

```bash
pnpm run agent:fmt:check   # cargo fmt --all -- --check
pnpm run agent:lint        # cargo clippy --all-targets --all-features -- -D warnings
pnpm run agent:test        # cargo test
pnpm run agent:build       # cargo build
pnpm run agent:run         # cargo run -p build-agent
```

## 6. 持续集成

`.github/workflows/ci.yml` 包含两个作业：

- `node`：`pnpm install --frozen-lockfile` 后依次执行 `lint`、`type-check`、`test`、`build`。
- `agent`：`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`、`cargo build`。

CI 使用 `.nvmrc` 指定 Node 版本，使用 `package.json` 的 `packageManager` 指定 pnpm 版本，
与本地保持一致。

## 7. 常见问题

**`pnpm install` 报告 Node 版本不满足要求**
升级到 Node 20.19 或更高版本；推荐使用 `.nvmrc` 中的 24。

**Server 或 Web 的 `type-check` 报告找不到 `@anvilrun/contracts`**
先执行 `pnpm run contracts:build`，或直接使用根目录的 `pnpm run type-check`。

**`cargo fmt` / `cargo clippy` 提示组件缺失**
执行 `rustup component add rustfmt clippy`。

**Windows 上换行符导致 Prettier 格式检查失败**
仓库统一使用 LF（`.editorconfig` 与 `.gitattributes` 已约束）。若本地历史配置了
`core.autocrlf=true`，可在仓库内执行 `git config core.autocrlf false` 后重新检出。

## 8. PostgreSQL 与 Prisma（T1.1）

### 8.1 启动开发数据库

```bash
docker compose -f docker-compose.dev.yml up -d
```

容器名为 `buildplatform-postgres-t11`，健康检查通过后监听宿主
`127.0.0.1:54329`。开发数据库为 `buildplatform_dev`，默认凭据只用于本地开发。
复制 `apps/server/.env.example` 为 `apps/server/.env` 后即可使用示例 `DATABASE_URL`。

### 8.2 Prisma 命令

```bash
pnpm run db:generate
pnpm run db:migrate                 # 开发环境创建/应用新 migration
pnpm run db:migrate:deploy          # 部署/CI 只应用已提交 migration
pnpm run db:seed                    # 幂等开发种子，可重复执行
```

用户名写入策略是 Server 通过 `normalizeUsername` 规范化为 3-64 位 ASCII 小写
`[a-z0-9_.-]`，数据库同时有 lowercase CHECK，防止绕过 Server 写入大小写变体。
密码、Refresh Token、Agent Token 和任务租约均不保存明文；T1.1 seed 只创建禁用占位用户。

### 8.3 独立数据库集成测试

测试禁止连接开发数据库。先在同一 Docker PostgreSQL 容器中创建独立的
`buildplatform_test` 数据库（只允许重置这个数据库），再设置：

```powershell
docker exec buildplatform-postgres-t11 psql -U buildplatform -d postgres -c "DROP DATABASE IF EXISTS buildplatform_test;"
docker exec buildplatform-postgres-t11 psql -U buildplatform -d postgres -c "CREATE DATABASE buildplatform_test OWNER buildplatform;"
$env:DATABASE_URL = 'postgresql://buildplatform:buildplatform_dev_only@127.0.0.1:54329/buildplatform_test?schema=public'
pnpm run db:test
```

`db:test` 会从 migration deploy 开始，运行真实 PostgreSQL 测试，包括外键/唯一约束、软删除、
稳定分页、BIGINT、Agent 执行槽 partial unique index 和两个并发领取事务。

## T6.3 Windows 部署补充

Windows 内网本机部署不需要 Server/Web Docker 镜像：PostgreSQL 使用现有 Docker 容器，Server
和 Agent 以前台进程运行，Web 由 Server 通过 `WEB_STATIC_ROOT` 同源托管。部署、备份恢复、
升级回滚和故障排查见 [`docs/windows-deployment.md`](windows-deployment.md)。

部署健康检查使用 `/health/live` 和 `/health/ready`；ready 会执行数据库 `SELECT 1`、检查
任务日志/产物目录可写性，并在启用静态托管时检查 `index.html`。
