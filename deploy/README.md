# deploy

部署与运维资产目录。

当前状态（T0.1）：目录已建立，**尚未包含任何部署配置**。按实施计划，以下内容在 T6.3 加入：

- `docker-compose.yml`：Server、Web、PostgreSQL 与持久化存储卷
- 数据库迁移、备份恢复与日志轮转脚本
- Windows Service、launchd、systemd 的 Agent 安装模板
- 管理员手册、Agent 安装手册与故障排查文档

在此之前不要向本目录写入任何真实主机名、IP、账号或令牌。
