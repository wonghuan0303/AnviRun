# AnvilRun（铸程）

[![CI](https://github.com/wonghuan0303/AnviRun/actions/workflows/ci.yml/badge.svg)](https://github.com/wonghuan0303/AnviRun/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/wonghuan0303/AnviRun)](https://github.com/wonghuan0303/AnviRun/issues)

一个面向企业内网固定打包机的轻量构建任务平台。

管理员将 Git 仓库、构建命令、动态参数表单和指定打包机组合成构建模板；普通用户只需选择模板、填写分支和参数，即可发起构建、查看实时日志并下载产物。Rust Agent 使用打包机已有的 Git 凭据执行任务，平台本身不托管源码凭据。

当前版本已经完成第一版功能及端到端验收，主要面向 **Windows x64、可信内网、单实例、低并发** 场景。

> 项目处于早期阶段，接口、配置和数据库结构仍可能变化。欢迎试用、提交 Issue 和参与贡献。

## 为什么做这个项目

不少团队拥有少量固定的 Windows、macOS 或 Linux 打包机。真正发起构建的人未必熟悉 CI 配置，也不应该获得打包机远程登录权限。常见做法是让开发人员联系打包人员、手工运行脚本，再通过聊天工具传递日志和产物。这种流程容易出现参数遗漏、任务冲突、结果无法追溯和机器权限扩散。

AnvilRun 将这类流程收敛为几个明确角色：

- 管理员负责维护打包机 Agent、构建模板和可填写的参数。
- 用户只管理自己的项目、配置和构建任务。
- Agent 在固定机器上串行执行任务，并回传状态、日志和产物。
- Server 负责排队、权限、任务状态、日志与产物存储。

它的目标不是成为通用流水线编排系统，而是把“在指定机器上，按一组受控参数执行一条构建命令”这件事做得简单、可视和可追溯。

## 核心能力

- 本地账号、管理员/普通用户角色和项目所有权隔离。
- Agent 注册、启停、令牌轮换、在线状态和单执行槽管理。
- 构建模板管理：Git 地址、固定 Agent、构建命令、产物目录和超时。
- JSON 表单 Schema 驱动的动态项目配置，支持 9 种白名单控件、默认值和兼容性检查。
- 项目、任务、状态时间线、取消、停止和重新构建。
- Agent 自动拉取指定 Git 分支，记录实际 Commit SHA，并生成 `platform.config.json`。
- Windows Job Object / Unix 进程组终止构建进程树。
- stdout/stderr 实时日志、历史日志、断线续传和敏感值遮蔽。
- 产物递归收集、SHA-256 校验、流式上传、单文件下载和 ZIP 下载。
- Agent/Server 短暂断线恢复、租约校验和幂等任务结果。
- Windows 内网部署、健康检查、PostgreSQL/日志/产物备份恢复及发布门禁。

## 与已有平台的区别

| 方案                         | 更适合的场景                            | AnvilRun 的区别                                                         |
| ---------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| Jenkins、TeamCity            | 多步骤流水线、插件生态和复杂 CI/CD 编排 | 本项目只聚焦固定打包机上的单命令构建，配置和使用成本更低                |
| GitHub Actions、GitLab CI    | 以代码仓库和 YAML 工作流为中心的 CI/CD  | 用户无需编辑仓库工作流；构建机现有 Git 权限保留在本机 Agent             |
| Buildkite 等 Runner 平台     | 大规模、弹性和多队列执行                | 本项目采用模板固定绑定 Agent、每个 Agent 单任务串行，更适合少量专用机器 |
| 共享脚本、远程桌面、人工打包 | 临时或人数很少的流程                    | 本项目补齐账号隔离、排队、实时日志、取消、产物归档和历史追溯            |

如果你需要多步骤流水线、矩阵构建、自动部署、Kubernetes 弹性执行、定时任务或大规模并发，成熟 CI 平台通常更合适。如果你的核心问题是“让非运维用户使用几台固定打包机”，本项目会更直接。

## 工作方式

```text
管理员 ──创建 Agent/模板──▶ Server ◀──创建项目/发起构建── 用户
                              │
                       WebSocket / HTTP
                              │
                              ▼
                  Rust Agent（固定打包机）
                  Git clone → 写入配置 → 执行命令
                       → 上传日志与产物
```

每个构建模板固定绑定一个 Agent。相同 Agent 的任务按队列串行执行，不同 Agent 可以并行。构建工作区相互隔离，任务完成、失败或取消后由 Agent 清理。

## 技术栈

- Web：Vue 3、TypeScript、Vite、Element Plus、Pinia、Vue Router
- Server：NestJS、TypeScript、Prisma、PostgreSQL、原生 WebSocket
- Agent：Rust、Tokio、系统 Git、Windows Job Object / Unix process group
- 公共协议：TypeScript contracts、Rust Serde DTO、共享 JSON fixtures

## 快速开始

### 环境要求

| 工具    | 要求                                        |
| ------- | ------------------------------------------- |
| Node.js | `>=20.19.0`，推荐使用 `.nvmrc` 中的版本     |
| pnpm    | `>=10`，仓库当前固定为 `10.15.0`            |
| Rust    | stable `>=1.82`，包含 `rustfmt` 和 `clippy` |
| Docker  | 用于运行 PostgreSQL                         |
| Git     | Agent 调用系统 Git 拉取项目                 |

### 1. 安装并启动数据库

```powershell
corepack enable pnpm
pnpm install
docker compose -f docker-compose.dev.yml up -d

Copy-Item apps/server/.env.example apps/server/.env
Copy-Item apps/web/.env.example apps/web/.env

pnpm run db:generate
pnpm run db:migrate:deploy
pnpm run contracts:build
```

示例配置只用于本地开发，不包含生产凭据。Unix 环境可将 `Copy-Item` 替换为 `cp`。

### 2. 初始化管理员

CLI 会在终端中隐藏密码输入：

```powershell
pnpm --filter @anvilrun/server run admin:init -- --username admin
```

按照提示输入密码。密码需要 8～128 个 Unicode 字符。

### 3. 启动 Server 和 Web

分别打开两个终端：

```powershell
pnpm run dev:server
```

```powershell
pnpm run dev:web
```

打开 `http://localhost:5173`，使用刚创建的管理员登录。

### 4. 注册 Agent

1. 在“Agent 管理”页面创建 Agent，并复制只显示一次的注册令牌。
2. 复制 `agent/build-agent.toml.example` 为自己的配置文件。
3. 填写 Server 地址、注册令牌和工作区目录。
4. 启动 Agent：

```powershell
cargo run --manifest-path agent/Cargo.toml -p build-agent -- --config C:\path\to\build-agent.toml
```

Agent 上线后即可在管理页面创建构建模板。

### 5. 发起第一次构建

1. 管理员创建构建模板，配置 Git 地址、Agent、命令、产物相对目录和动态表单 Schema。
2. 普通用户选择模板创建项目，填写 Git 分支和项目参数。
3. 在项目任务页面发起构建。
4. 查看状态时间线与实时日志，任务成功后下载单个产物或 ZIP。

Agent 使用运行机器现有的 Git 凭据。平台不会保存 Git 用户名、密码或 SSH 私钥。

## Windows 内网部署

当前提供的正式部署形态是：PostgreSQL 运行在 Docker 中，Server 和 Rust Agent 在 Windows 主机以前台进程运行，Web 构建结果由 Server 同源托管。

```powershell
pwsh -File .\deploy\windows\build.ps1
pwsh -File .\deploy\windows\start-server.ps1 -EnvironmentFile C:\AnvilRun\config\server.env
pwsh -File .\deploy\windows\start-agent.ps1 -ConfigPath C:\AnvilRun\config\build-agent.toml
```

完整目录规划、生产配置、管理员初始化、健康检查和升级方法见 [Windows 部署文档](docs/windows-deployment.md)。备份恢复与故障排查见 [运维文档](docs/operations.md)。

## 开发与验证

```powershell
# Node、Web、Server 与数据库
pnpm run lint
pnpm run type-check
pnpm run test
pnpm run build
pnpm run db:test

# Rust Agent
pnpm run agent:fmt:check
pnpm run agent:lint
pnpm run agent:test
pnpm run agent:build

# Windows 第一版完整发布门禁
pwsh -File .\deploy\windows\release-check.ps1
```

发布门禁会使用隔离数据库运行真实 Server + Rust Agent + PostgreSQL 构建闭环，并自动清理测试资源。详见 [发布检查文档](docs/release-check.md)。

## 仓库结构

```text
anvilrun/
├─ apps/
│  ├─ web/                 # Vue Web 管理端
│  └─ server/              # NestJS API、WebSocket 与静态托管
├─ agent/                  # Rust Agent 与 Rust 协议包
├─ packages/contracts/     # TypeScript 公共契约、校验器与 fixtures
├─ deploy/windows/         # Windows 构建、运行、备份和发布门禁脚本
└─ docs/                   # 产品设计、部署、运维和实现文档
```

## 当前边界

第一版暂不提供：

- Server/Web Docker 镜像和 Kubernetes 部署。
- Windows Service、自动更新和自动日志轮转。
- Linux/macOS 安装包（Agent 代码保留跨平台实现）。
- 多 Agent 自动调度、单 Agent 并发任务和分布式部署。
- 多步骤流水线、定时任务、Webhook、审批、任务优先级和自动重试。
- 平台托管 Git 凭据、对象存储和产物自动过期。

这些是明确的产品边界，并不影响 Windows 可信内网第一版的完整构建闭环。

## 文档

- [产品与系统设计](docs/product-design.md)
- [本地开发说明](docs/local-development.md)
- [Windows 部署说明](docs/windows-deployment.md)
- [运维与备份恢复](docs/operations.md)
- [发布验收与门禁](docs/release-check.md)
- [认证设计](docs/authentication.md)
- [Agent 配置与协议](docs/agents.md)
- [安全边界](docs/security.md)

## 参与贡献

欢迎提交缺陷报告、功能建议和 Pull Request。开始贡献前请阅读 [贡献指南](CONTRIBUTING.md) 与 [社区行为准则](CODE_OF_CONDUCT.md)。较大的功能或架构调整建议先创建 Issue 讨论。

如果发现安全漏洞，请不要创建公开 Issue，按照 [安全策略](SECURITY.md) 通过 GitHub Security Advisory 私下报告。

## 开源许可

AnvilRun 基于 [MIT License](LICENSE) 开源。你可以自由使用、复制、修改和分发本项目，但须保留许可证及版权声明；软件按“原样”提供，不附带任何担保。
