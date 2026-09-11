# Linux 内网本机部署

本文面向单台 x86_64 Linux 内网主机：PostgreSQL 可运行在 Docker 或现有数据库中，Server 和 Web 直接运行在主机，Rust Agent 以前台进程运行。部署脚本支持常见的 Bash 4.3+ Linux 发行版，不创建应用镜像，也不自动安装 systemd 服务。

## 目录建议

```text
/opt/anvilrun/
  app/                    # 仓库或构建产物
    web/                  # apps/web/dist 的内容
  data/
    artifacts/
    task-logs/
  agent-workspace/
/etc/anvilrun/            # server.env、build-agent.toml
```

配置目录应仅允许运行账户读取。不要把数据库密码、认证密钥或 Agent Token 提交到仓库。

## 前置条件

- x86_64 Linux、Bash 4.3+、Git、curl。
- Node.js >=20.19、pnpm >=10、Rust stable >=1.82。
- 可访问的 PostgreSQL 16；使用仓库 Compose 时还需要 Docker Compose。
- 生产环境建议使用 HTTPS 反向代理。示例中的 HTTP 模式仅适合隔离且可信的内网。

## 构建和配置

在仓库根目录执行：

```bash
bash deploy/linux/build.sh
sudo install -d -o "$USER" /opt/anvilrun/{app/web,data/artifacts,data/task-logs,agent-workspace}
cp -a apps/web/dist/. /opt/anvilrun/app/web/
sudo install -d -m 700 /etc/anvilrun
sudo cp deploy/linux/server.env.example /etc/anvilrun/server.env
sudo cp deploy/linux/build-agent.toml.example /etc/anvilrun/build-agent.toml
sudo chown "$USER" /etc/anvilrun/server.env /etc/anvilrun/build-agent.toml
sudo chmod 600 /etc/anvilrun/server.env /etc/anvilrun/build-agent.toml
```

编辑两个配置文件，替换所有占位值。`ACCESS_TOKEN_SECRET` 和 `REFRESH_TOKEN_HASH_SECRET` 必须是两个不同的高强度随机值；`build-agent.toml` 中使用在管理页面生成、只展示一次的 Agent 注册令牌。

如果使用仓库自带的开发 PostgreSQL（仅适合验证）：

```bash
docker compose -f docker-compose.dev.yml up -d
```

正式环境应使用独立数据库名、强密码和持久化/备份策略，不要复用 `buildplatform_dev`。

## 一键启动

以下命令会执行 Prisma migration、启动 Server、等待 `/health/ready` 成功，再启动 Agent。两个进程由脚本共同监管，按 Ctrl+C 会停止二者：

```bash
bash deploy/linux/start-all.sh \
  /etc/anvilrun/server.env \
  /etc/anvilrun/build-agent.toml
```

默认 Agent 路径是 `agent/target/release/build-agent`。使用单独发布目录时，把可执行文件作为第三个参数传入。健康检查会自动读取 `server.env` 中的 `SERVER_PORT`，并连接本机的对应端口。

也可以分别以前台方式运行：

```bash
bash deploy/linux/start-server.sh /etc/anvilrun/server.env
bash deploy/linux/start-agent.sh /etc/anvilrun/build-agent.toml /opt/anvilrun/bin/build-agent
bash deploy/linux/check-health.sh http://127.0.0.1:3000
```

脚本不会启动或删除 PostgreSQL、创建管理员、打印秘密、自动提权或把进程安装为系统服务。生产常驻运行可在验证配置后为上述两个前台命令编写 systemd unit，并使用同一个低权限专用账户。

## 初始化管理员

Server 启动后，在仓库根目录运行：

```bash
pnpm --filter @anvilrun/server run admin:init -- --username admin
```

CLI 会在终端中隐藏密码输入。不要通过命令行参数、shell 历史或日志传递密码。

## 健康检查、升级与回滚

`/health/live` 检查进程响应；`/health/ready` 还会检查数据库、数据目录以及 Web 入口。升级前应停止新任务并等待活动任务结束，备份数据库、Artifact 和 Task log，记录 Git Commit；然后停止进程、切换版本、重新构建并启动。Prisma migration 默认只向前，应用代码回滚不等于数据库回滚。

当前仓库的自动备份/恢复和完整 E2E 发布门禁脚本仍是 Windows PowerShell 版本；Linux 上应使用 PostgreSQL `pg_dump`/`pg_restore` 和 tar 建立同批次、可校验的备份流程后再投入生产。
