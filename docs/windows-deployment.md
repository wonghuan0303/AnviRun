# Windows 内网本机部署（T6.3 精简版）

本文面向单台 Windows 内网主机：PostgreSQL 继续运行在现有 Docker 容器中，Server 和 Web 直接运行在主机，Rust Agent 运行 `build-agent.exe`。本方案不创建 Server/Web 镜像、不安装 Windows Service，也不提供自动更新。

第一版发布前应运行 [`release-check.md`](release-check.md) 中的统一门禁。它会在独立的随机 `buildplatform_e2e_*` 数据库和临时目录中运行真实 Server/Agent 构建闭环；`buildplatform_dev` 永远不作为门禁清理目标。

## 目录建议

目录可以自定义，脚本不依赖固定盘符。一个可用的示例是：

```text
C:\AnvilRun\
  app\                 # 仓库或构建产物
    web\               # apps/web/dist 的内容
  data\
    artifacts\
    task-logs\
  agent\
  config\
  backups\
  logs\
```

## 前置条件

- Windows x64。
- Node.js >=20.19、pnpm 10、Rust stable、Git。
- Docker Desktop 已启动，PostgreSQL 容器可访问。
- 默认生产模式使用受信任的内网 HTTPS 反向代理；本阶段不自动配置证书或 IIS/Nginx/Caddy。
- 若当前没有 HTTPS，可使用示例文件默认开启的可信内网 HTTP 模式；该模式只适合隔离内网，不适合公网。

## 构建

在仓库根目录执行：

```powershell
pwsh -File .\deploy\windows\build.ps1
```

脚本会检查 Node/pnpm/Cargo，执行 `pnpm install --frozen-lockfile`，构建 contracts、Server、Web，并执行 Rust release 构建。脚本不会修改数据库，也不会写入生产环境变量。

将 `apps\web\dist` 复制到部署目录，例如 `C:\AnvilRun\app\web`。

## Server 配置与启动

复制并编辑 `deploy/windows/server.env.example`。必须替换数据库连接中的占位密码，并生成两个相互独立的高复杂度密钥：

```powershell
Copy-Item .\deploy\windows\server.env.example C:\AnvilRun\config\server.env
pwsh -File .\deploy\windows\start-server.ps1 -EnvironmentFile C:\AnvilRun\config\server.env
```

启动脚本会先执行 `prisma migrate deploy`，迁移失败时不会启动 Server；Server 以前台进程运行，使用 Ctrl+C 停止。它不会 seed、创建默认管理员或打印环境变量。

生产默认仍要求 `AUTH_COOKIE_SECURE=true`、`__Host-` Cookie、Path=/、无 Domain 和 HTTPS。当前精简版示例明确使用可信内网 HTTP 模式：`NODE_ENV=production`、`ALLOW_INSECURE_HTTP=true`、`AUTH_COOKIE_SECURE=false`、非 `__Host-` Cookie 名、`SameSite=Strict` 且无 Domain。启动时会输出不含秘密的 warning，说明 Cookie 未使用 Secure、该模式不适合公网部署。

不要用 `NODE_ENV=development` 替代正式内网部署；生产 HTTP 模式仍执行两个独立强密钥校验，Access Token 仍只保存在 Web 内存，refresh/logout 仍校验 CSRF。后续接入 HTTPS 后，关闭 `ALLOW_INSECURE_HTTP`，恢复 `AUTH_COOKIE_SECURE=true` 和 `__Host-` Cookie。

Web 同源托管通过 `WEB_STATIC_ROOT` 开启。根目录必须包含可读的 `index.html`：

- `/`、`/projects` 等无扩展名 GET/HEAD 路径回退到 `index.html`。
- 已知 `/api/*`、`/health/*`、`/ws/*` 永不由 SPA 回退接管。
- 带扩展名的不存在资源返回 404，不返回 `index.html`。
- 静态中间件不提供目录列表，回退只发送固定入口文件。
- 不设置 `WEB_STATIC_ROOT` 时，Server 保持仅 API/health/WebSocket 的现有行为。

## 管理员初始化

生产部署不自动创建管理员。启动 Server 后，在仓库根目录运行。密码只在 PowerShell 内存中短暂存在，通过 stdin 交给 CLI，不写入命令行、脚本或日志：

```powershell
$secure = Read-Host 'Admin password' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $password | pnpm --filter @anvilrun/server run admin:init -- --username admin --password-stdin
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Variable password -ErrorAction SilentlyContinue
}
```

管理员初始化行为以 CLI 当前实现为准，已存在管理员时不会重复创建。

## Agent

构建 Windows x64 发布包：

```powershell
pwsh -File .\deploy\windows\package-agent.ps1 -OutputDirectory C:\AnvilRun\releases
```

脚本生成 `build-agent-<version>-windows-x64.zip` 及同名 `.sha256`，内容仅包含 `build-agent.exe`、配置示例、版本和说明，不包含源码、target、state、工作区、日志或真实 Token。解压后编辑配置，再以前台方式运行：

```powershell
pwsh -File C:\AnvilRun\app\deploy\windows\start-agent.ps1 -ConfigPath C:\AnvilRun\config\build-agent.toml -AgentExecutable C:\AnvilRun\agent\build-agent.exe
```

Ctrl+C 会停止 Agent。当前不安装 Windows Service；Agent Token 只放在受限配置文件中，不作为命令行参数、不粘贴到工单。

## 健康检查

```powershell
pwsh -File .\deploy\windows\check-health.ps1 -ServerUrl http://127.0.0.1:3000
```

- `/health/live` 只验证 Node 进程可响应，即使数据库或存储不可用仍返回 200。
- `/health/ready` 执行 `SELECT 1`，对任务日志目录、产物目录写入并删除独占探针文件；若配置 Web，则检查 `index.html` 可读。成功为 200，失败为 503。
- readiness 响应只返回组件状态和简短原因，不包含 URL、密钥、绝对路径、堆栈或 Prisma 错误。

## PostgreSQL 与数据备份

不要清理或重置 `buildplatform_dev`。备份脚本要求显式输出目录和数据目录：

```powershell
pwsh -File .\deploy\windows\backup.ps1 `
  -OutputDirectory C:\AnvilRun\backups `
  -PostgresContainer buildplatform-postgres-t11 `
  -DatabaseName buildplatform_dev `
  -DatabaseUser buildplatform `
  -ArtifactDirectory C:\AnvilRun\data\artifacts `
  -TaskLogDirectory C:\AnvilRun\data\task-logs
```

脚本生成唯一备份目录，使用容器内 `pg_dump --format=custom`、Windows `tar.exe` 生成 `artifacts.tar.gz` 和 `task-logs.tar.gz`，以及 `manifest.json`。tar 从数据根目录执行，保留隐藏文件、空目录和完整相对目录结构，不写入源目录绝对路径；tar 不可用时明确失败，不回退到 ZIP。manifest 记录文件名、SHA-256、数据库名、创建时间和可获得的 Git Commit。源目录不存在会失败，不伪造成功；不会读取 `.env`、删除既有备份或打印数据库密码。

恢复必须使用新的数据库名和空目标目录：

```powershell
pwsh -File .\deploy\windows\restore.ps1 `
  -BackupDirectory C:\AnvilRun\backups\buildplatform-backup-... `
  -TargetDatabaseName buildplatform_restore_20260901 `
  -TargetArtifactDirectory C:\AnvilRun\restore\artifacts `
  -TargetTaskLogDirectory C:\AnvilRun\restore\task-logs `
  -PostgresContainer buildplatform-postgres-t11 `
  -DatabaseUser buildplatform
```

恢复前验证 manifest 和三个 SHA-256，并使用 tar 列出每个归档条目，拒绝绝对路径、盘符、UNC、`..`、控制字符、越界路径和符号/硬链接。归档先完整解压到唯一临时目录并检查 reparse point，再移动到明确为空的目标目录；失败会回滚本次已移动文件，最终目标保持为空。目标数据库必须不存在，脚本记录本次创建状态；pg_restore 或文件恢复失败时只删除本次创建且名称已验证的隔离数据库。脚本明确拒绝 `buildplatform_dev`，不会对未验证路径做递归删除。

## 升级与回滚

1. 暂停创建新任务，等待活动任务结束或取消。
2. 运行 backup.ps1，并保存当前 Git Commit、构建产物和备份 manifest。
3. 停止 Server/Agent，切换到新 Commit。
4. 执行 `pnpm install --frozen-lockfile`、build.ps1，运行 `prisma migrate deploy`。
5. 启动 Server，检查 live/ready，再启动 Agent。
6. 登录并验证项目、任务、日志、产物和权限。

应用代码可以回到上一 Commit，但 Prisma migration 默认只向前，不执行 down migration。若数据库结构不兼容，应将备份恢复到新数据库后切换连接配置；Artifact、Task log 与数据库必须使用同一批次备份。没有自动破坏性回滚脚本。
