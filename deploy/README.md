# deploy

部署与运维资产目录。T6.3～T6.4 精简版覆盖 Windows x64 内网本机部署与第一版发布门禁：

- `windows/build.ps1`：安装锁定依赖并构建 contracts、Server、Web、Rust Agent。
- `windows/start-server.ps1`：加载指定环境文件、执行 Prisma migration、前台启动 Server。
- `windows/start-agent.ps1`：验证配置和 `build-agent.exe` 后前台运行 Agent。
- `windows/check-health.ps1`：检查 `/health/live` 和 `/health/ready`。
- `windows/backup.ps1`：使用 Windows tar 备份 PostgreSQL、Artifact、Task log 并生成 SHA-256 manifest。
- `windows/restore.ps1`：校验 tar 条目和 manifest 后，安全恢复到新的数据库和空目录。
- `windows/package-agent.ps1`：构建 Windows x64 Agent ZIP 和 SHA-256。
- `windows/e2e.ps1`：使用隔离 PostgreSQL、真实编译 Server/Agent 和临时数据目录运行 E2E.
- `windows/release-check.ps1`：统一执行 Node、Prisma、数据库、E2E、Rust 和 Agent 发布门禁。
- `windows/server.env.example`：生产占位环境变量示例。

详细流程见 [`docs/windows-deployment.md`](../docs/windows-deployment.md)、[`docs/operations.md`](../docs/operations.md) 和 [`docs/release-check.md`](../docs/release-check.md)。不向本目录写入真实主机名、IP、账号、密码、Token 或备份。不提供 Docker 应用镜像、Windows Service、Linux/macOS 安装模板或自动更新。
