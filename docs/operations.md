# Windows 内网运维与故障排查

本项目面向可信内网、单 Server 实例和低并发部署。账号仍应独立使用并遵守最小权限；不要在日志、工单或截图中粘贴密码、Cookie、CSRF、Access/Refresh/Agent/lease Token、完整敏感配置或本地绝对路径。

## 常见故障

| 现象                                    | 检查与处理                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Docker PostgreSQL 未启动                | `docker ps`、`docker inspect buildplatform-postgres-t11`；启动现有容器后再运行 health 检查。不要删除开发库。                     |
| DATABASE_URL 错误                       | 核对主机端口、数据库名和凭据；只在受限配置文件中修改，不把完整 URL 发到工单。                                                    |
| migration 失败                          | 停止启动流程，保存安全错误和 Git Commit；修正 schema/连接后重新执行 `prisma migrate deploy`，不要直接手工改生产表。              |
| live=200、ready=503                     | 根据 ready 的组件状态检查数据库、`TASK_LOG_ROOT`、`ARTIFACT_STORAGE_ROOT` 和 Web `index.html`。                                  |
| 目录不可写                              | 确认运行账户权限、磁盘空间和目录不是文件/重解析点；重新运行 ready。                                                              |
| Web 刷新子路由 404                      | 确认 `WEB_STATIC_ROOT` 指向包含 `index.html` 的目录，且由同一个 Server 提供请求。带扩展名资源不存在时 404 是预期行为。           |
| Agent Token 错误或一直 OFFLINE          | 检查配置文件中的 Server URL、一次性 Token、Agent 是否 enabled，以及 `/health/ready`；不要打印 Token。                            |
| Git 不存在或无权限                      | 在 Agent 主机检查 `git --version`、本地凭据和 workspace 权限；Agent 不接收命令行密码。                                           |
| workspace_root 不可写/磁盘不足          | 检查目录边界、剩余空间和活动锁；不要手工删除未知任务目录。                                                                       |
| 任务停在 AGENT_LOST/CANCELING/UPLOADING | 先保留任务 ID 和时间，检查 Server/Agent 进程和日志租约；停止创建新任务，按当前恢复/取消语义处理，必要时使用备份前的应用 Commit。 |
| 日志或产物下载失败                      | 检查对应本地目录、文件完整性和 ready；不要把 storagePath 或敏感配置复制到工单。                                                  |

## 安全收集信息

可以提供：时间、任务 ID、非敏感状态、HTTP 状态码、`requestId`、Git Commit、组件 ready 状态和脱敏后的错误代码。必须删除：密码、Authorization Header、Cookie、CSRF、所有 Token/lease、完整 `config`、sensitive 值、storagePath、堆栈和本地绝对路径。

## 备份原则

数据库、Artifact、Task log 由同一次 backup.ps1 生成并以 manifest 校验；Artifact 和 Task log 使用 Windows `tar.exe` 的 `tar.gz` 归档，适合大目录且不把完整数据加载到 PowerShell 内存。恢复会先校验条目安全性并解压到唯一临时目录，再移动到空目标；失败回滚本次文件并清理本次创建的隔离数据库。恢复优先到新的数据库和新目录，验证后再切换应用配置；禁止把 `buildplatform_dev` 当作恢复目标。当前不提供自动日志轮转、自动清理、对象存储、Windows Service 或自动更新。
