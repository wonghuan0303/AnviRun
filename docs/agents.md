# Agent 管理与连接

T2.1 实现 Server 侧 Agent 管理 API 和单实例原生 RFC 6455 WebSocket 网关；T4.1～T4.3 已接入任务领取、Git 准备、配置写入和最小命令执行，T5.1 已接入实时与历史日志，T5.2 已接入取消与跨平台进程树终止，T5.3 已接入产物清单、流式上传、下载和成功闭环。

## 管理 API

所有接口都要求 `Authorization: Bearer <Access Token>`，并按 `AccessTokenGuard, AdminGuard` 顺序执行。

- `POST /api/admin/agents`：创建 Agent。请求只包含 `name`，名称会去除首尾空白，长度为 1～128。响应中的 `registrationToken` 只出现这一次。
- `GET /api/admin/agents?page=&pageSize=&search=`：分页和名称搜索，响应只返回 Agent 摘要。
- `GET /api/admin/agents/:id`：查询 Agent 摘要。
- `PATCH /api/admin/agents/:id`：第一版只允许修改 `name`。
- `POST /api/admin/agents/:id/enable`：启用并保持当前令牌；无连接时状态为 `OFFLINE`。
- `POST /api/admin/agents/:id/disable`：停用、状态置为 `DISABLED`，并吊销连接。
- `POST /api/admin/agents/:id/token/rotate`：原子替换令牌哈希，旧令牌立即失效并吊销旧连接。
- `DELETE /api/admin/agents/:id`：存在 BuildTemplate、BuildTask 或 activeTaskId 引用时返回 `VALIDATION_FAILED`；无引用时物理删除。

Agent 注册令牌使用 `crypto.randomBytes(32)` 生成，格式为 `bpa_<base64url>`；数据库只保存 SHA-256 哈希。列表、详情、审计、错误响应和 WebSocket payload 都不包含令牌、令牌哈希或 Authorization Header。

`/ws/agent` 单条消息限制为 1 MiB，超限由 WebSocket 层安全关闭；Agent 发送产物 manifest 前会先计算完整 UTF-8 envelope 大小，超限发送固定 `ARTIFACT_MANIFEST_TOO_LARGE` 的 `task.failed`，避免 WebSocket 1009 后重复重连。消息限制不影响产物内容，因为产物继续通过带租约的流式 HTTP 上传。Agent 日志和任务错误只输出脱敏后的安全原因，不输出完整配置、密码、Token 或 lease。

## WebSocket

连接地址：`ws://<server>/ws/agent`。令牌只通过握手 Header 传递：

```text
Authorization: Bearer <agent-token>
```

连接通过令牌哈希和 Agent 的 `enabled/status` 校验后建立。Server 使用单实例内存 `AgentConnectionRegistry`，同一 Agent 只保留一个连接；新连接会关闭旧连接，旧连接的 close 回调不会覆盖新连接状态。

Agent 首条消息使用 contracts 中的 `agent.hello` envelope。`agentId` 可以缺失或为 `null`，也可以填写与令牌对应的 ID；填写其他 ID 会断开。合法 hello 更新 hostname、os、arch、version、lastSeenAt 并将状态置为 `ONLINE`，随后返回 contracts 中的 `agent.registered`，其中心跳间隔为 15 秒、超时为 45 秒。

Agent 使用 contracts 中的 `agent.heartbeat` 每 15 秒上报。Server 校验 agentId，更新 lastSeenAt 并保持 ONLINE。无效或不属于当前 Agent 的 currentTaskId 不会越权修改 activeTaskId；T2.1 不处理任务状态。

连续 45 秒未收到心跳时，Server 清理连接并将启用中的 Agent 置为 `OFFLINE`；停用 Agent 始终保持 `DISABLED`。应用关闭时会清理定时器、升级监听器和连接。

停用或轮换令牌会先发送 contracts 的 `agent.token.revoked`，再关闭旧连接。发送失败也会清理连接。轮换后旧令牌不能重新连接，新令牌可以连接；停用期间令牌不能连接，重新启用后保留原令牌。

## T6.4 任务交互输入

支持交互输入的 Agent 在 `agent.hello.capabilities` 声明 `task-input-v1`。Server 只向具备该能力的
Agent 发送带 `interactiveInputEnabled=true` 的 assignment 和 `task.input`；旧 Agent 仍可执行普通
任务，交互任务在不兼容时保持等待或以安全原因拒绝，不依据版本字符串猜测能力。

`task.input` 只允许 RUNNING 任务接收最多 4096 UTF-8 字节的单行文本，Agent 自动补一次换行并 flush
stdin，再回传不含正文的 `task.input.ack`。PREPARING、UPLOADING、CANCELING、AGENT_LOST、终态、
进程退出、取消、超时和断线清理都会关闭输入通道；输入不缓存、不自动重发，也不会传递给后续任务。
普通 assignment 继续使用 null stdin。

敏感输入在写入前加入当前任务的 stdout/stderr 脱敏器，并且不进入 Server 日志、任务日志、审计或数据库。
该能力只提供按行 stdin，不支持 GUI 弹窗、完整终端、PTY/ConPTY、控制序列或终端尺寸同步；生产环境
必须使用 WSS/HTTPS。

## T2.2 接入提示

Rust Agent 只需使用公共 contracts 规定的 envelope、protocolVersion、`agent.hello`、`agent.heartbeat`、`agent.registered` 和 `agent.token.revoked`。工作区根目录仅作为诊断元数据上报，不应通过 URL 或消息传递令牌。T2.2 再实现 WSS、重连、退避和 Agent 本地配置；T2.1 不引入 Redis、消息队列、mTLS 或任务执行逻辑。

## T2.2 Rust Agent

T2.2 的 Rust Agent 是长期运行的连接进程，当前只负责连接闭环，不领取或执行构建任务。

配置文件默认读取当前目录的 \`build-agent.toml\`，也可以通过 \`--config <path>\` 或 \`BUILD_AGENT_CONFIG_FILE\` 指定。配置文件字段：

\`\`\`toml
server_url = "http://127.0.0.1:3000"
token = "bpa_xxx"
workspace_root = "C:/build-agent"
log_level = "info"

# state_file = "agent-state.json"

\`\`\`

环境变量优先级高于配置文件：

- \`BUILD_AGENT_SERVER_URL\`
- \`BUILD_AGENT_TOKEN\`
- \`BUILD_AGENT_WORKSPACE_ROOT\`
- \`BUILD_AGENT_LOG_LEVEL\`
- \`BUILD_AGENT_STATE_FILE\`

\`http://\` 和 \`https://\` 会分别转换为 \`ws://\` 和 \`wss://\`，并连接 \`/ws/agent\`。令牌只放在 WebSocket 握手的 \`Authorization: Bearer\` Header，不会写入消息、状态文件或结构化日志。生产环境应使用 HTTPS/WSS。

首次收到 \`agent.registered\` 后，Agent 将 Server 返回的稳定 \`agentId\` 保存到状态文件；后续 hello 会带回该 ID。状态文件只包含 Agent ID，不包含令牌。Agent 按 Server 返回的心跳间隔发送 \`agent.heartbeat\`，当前 Server 默认值为 15 秒。

连接失败或断线使用 1 秒起步、最多 60 秒的指数退避；认证失败会输出明确诊断但不会高频重试。收到 \`agent.token.revoked\` 后停止进程，不继续使用旧连接。Ctrl+C 和 Unix SIGTERM 会发送 WebSocket close 并等待连接任务退出。

运行示例：

\`\`\`text
build-agent.exe --config C:/build-agent/build-agent.toml
\`\`\`

Rust Agent 使用 rustls native roots 支持 WSS，避免依赖系统 OpenSSL；任务领取、Git 准备、最小命令执行、T5.1 日志链路、T5.2 取消链路、T5.3 产物上传链路和 T6.1 短断线恢复已接入。

## T4.2 Rust Agent 工作区与 Git 执行

T4.2 在 T2.2 连接闭环上增加最小任务准备流程：Agent 收到 `task.available` 后仅在空闲时发送 `task.claim`，校验匹配的 `task.assignment`，先发送 `task.accepted`，再通过受控 Tokio 任务准备工作区。准备期间心跳持续发送 `currentTaskId`，单个 Agent 不会并行准备第二个任务；重复 assignment 不会创建第二份工作区或启动第二次 Git。

工作区根目录在 Agent 启动时创建并规范化为绝对路径，不能是文件系统根目录。项目目录固定为 `<workspace_root>/projects/<projectId>/source`，projectId 必须先解析为 UUID，路径创建/复用前后检查边界、符号链接和 Windows reparse point。每个项目工作区持有跨进程独占锁；Agent 重启不清理项目缓存，锁由操作系统释放后可安全复用，另一 Agent 进程不能同时使用同一 projectId。旧版 `<workspace_root>/tasks` 残留目录仍只在确认未持锁时清理。取消时在终态 ACK 前保留 ActiveTask、项目 source 和项目锁；进程关闭、token 撤销或 ABANDON 等无终态 ACK 的销毁路径才释放项目锁，普通 WebSocket 短断线则保留 ActiveTask、项目 source 和日志缓冲等待 T6.1 恢复裁决。

Agent 启动和接收 assignment 时检查 workspace 可写性、`tasks` 目录写探针、最低可用磁盘空间和系统 Git。新增配置 `minimum_free_space_bytes` / `BUILD_AGENT_MINIMUM_FREE_SPACE_BYTES`，默认 `1073741824` 字节（1 GiB），必须是 0 到 JavaScript 安全整数范围内的非负整数，环境变量优先于 TOML。相对 `workspace_root` 按配置文件所在目录解析。

Git 只调用系统 `git`，不使用 libgit2、Shell 或脚本解释器。项目首次构建使用 `git clone --branch <branch> --single-branch -- <url> <source>` 参数数组；后续构建使用 `git -C <source> fetch --prune --no-tags origin <refspec>` 并强制 checkout 到 `refs/remotes/origin/<branch>`，将工作树可靠对齐到 assignment branch 的最新远端提交。项目目录保存 URL 的 SHA-256 指纹，不保存完整 URL 或凭据；URL 改变、指纹缺失、缓存不是合法 Git 仓库或缓存损坏时，在项目锁内安全重建该 projectId 的 source。所有操作设置 `GIT_TERMINAL_PROMPT=0`，超时受任务 `timeoutSeconds` 限制。成功后执行 `git -C <source> rev-parse --verify HEAD`，只接受 40/64 位十六进制 SHA 并以小写回传。工作区/Git 失败发送 `CODE: safe message` 格式的 `task.failed`，不包含 token、配置值、凭据或堆栈。

## T4.3 Rust Agent 配置与命令执行

T4.3 在任务 source 目录写入 `platform.config.json`：完整保留 assignment `config` 的字段，按 UTF-8 pretty JSON 写入并保留一个末尾换行。`sensitiveConfigKeys` 不会删除或改变配置内容，只用于 Agent 输出中的敏感值遮蔽和诊断保护。写入使用 source 内 create-new 临时文件、刷盘后替换，拒绝 source/目标的符号链接或 Windows reparse point，不在错误和日志中输出完整配置。

配置写入成功后 Agent 发送 `PREPARING`、启动模板 command 并发送 `RUNNING`。Windows 使用 `cmd.exe /D /S /C`，Unix 使用 `/bin/sh -lc`，工作目录固定为 project source；每次构建覆盖本次 assignment 的 `platform.config.json`，并在启动命令前定向清理 artifactDir，避免旧 artifact 混入，同时保留依赖和其他源码。配置不会插入 command、环境变量或参数。stdout/stderr 并发以有界分片读取，非 UTF-8 使用 lossy 解码，日志序号按任务从 1 递增；Server 当前只安全接收而不持久化日志。命令预算不超过“租约剩余时间减去最终状态上报余量”；直接 Shell 超时会取消两个 reader，正常退出后的管道排空也有有限宽限期。0 退出发送 `UPLOADING`，仅扫描 artifactDir 根层大小写不敏感的 `.zip` 文件，忽略根层其他文件和全部子目录；没有有效根层 ZIP 时发送扫描失败的 `task.failed`。清单等待 Server ACK，再逐文件上传和发送 `task.completed`；非零、超时、启动、配置、输出或产物错误发送 `task.failed`，带可选 exitCode，但保留项目 source。

普通 WebSocket 短断线时，Server 将 PREPARING/RUNNING/UPLOADING 置为 `AGENT_LOST` 并保留租约、执行槽、日志和产物状态；Agent 重连 hello 携带 taskId、leaseToken、阶段和最后确认日志序号，Server 在 5 分钟恢复窗口内发送 `task.recovery(RESUME)`，超时或 Agent 重启且没有 currentTask 时以 `ABANDON`/`FAILED` 收尾。若任务已进入 `CANCELING`，Server 保留取消确认窗口并发送 `task.recovery(CANCEL)`，Agent 只停止任务、不删除项目 source，成功后回传 `task.canceled`。恢复不会重新执行 Git、命令或上传。任务成功、失败或取消事务提交后 Server 发送 `task.result.ack`，Agent 仅在匹配 ACK 后释放项目锁和本地 ActiveTask，项目缓存继续保留；重复终态消息不新增状态历史。token 撤销、进程退出和 ABANDON 等无终态 ACK 路径仍走终止/释放锁流程；用户取消则保留锁直到对应终态 ACK。

Server 接收 `task.status` 的 `PREPARING`、`RUNNING`、`UPLOADING` 状态，并按 Agent、activeTaskId、租约和当前状态顺序校验；合法转换统一经 TaskStateService，重复相同状态幂等。`task.failed` 可结束 PREPARING、RUNNING 或 UPLOADING，保存可选退出码、清理租约和执行槽。T5.1 的 `task.log` 会在校验租约和连续序号后落盘，Server 返回 `task.log.ack`；浏览器日志订阅另行校验项目所有权。
Server 接收 `task.status` 的 `PREPARING`、`RUNNING`、`UPLOADING` 状态，并按 Agent、activeTaskId、租约和当前状态顺序校验；合法转换统一经 TaskStateService，重复相同状态幂等。`task.failed` 可结束 PREPARING、RUNNING 或 UPLOADING，保存可选退出码、清理租约和执行槽。T5.1 的 `task.log` 会在校验租约和连续序号后落盘，Server 返回 `task.log.ack`；浏览器日志订阅另行校验项目所有权。

## T5.1 任务日志

## T5.2 取消协议

Server 通过 POST /api/tasks/:taskId/cancel 发起取消。排队任务直接以 CANCELING -> CANCELED 收尾；执行任务发送 task.cancel，payload 携带 taskId、进程内短暂租约明文、requestedAt 和可选 reason。Agent 只接受与当前任务及租约完全匹配的请求，停止整个任务进程树、确认清理 workspace 后回传 task.canceled，并在匹配的 `task.result.ack` 前保留项目锁；清理失败回传带 `TASK_CANCEL_CLEANUP_FAILED` 的安全 task.failed，同样等待终态 ACK 释放锁。重复取消请求/回执不重复写历史，取消期间普通 status 不能覆盖 CANCELING；合法 Agent、任务、活动租约和 leaseToken 的普通 task.failed 可以将 CANCELING 收尾为 FAILED。CANCELING 断线保留租约和执行槽，重连后通过 `task.recovery(CANCEL)` 完成清理；发送失败或超时未确认才由 Server 以 CANCELING -> FAILED 释放执行槽。

Rust 侧使用 Windows Job Object 或 Unix process group；Unix 先发送 SIGTERM，短暂宽限后发送 SIGKILL，Windows 使用 Job Object 的组级终止。T6.1 只处理单实例短断线恢复和幂等确认，不实现跨实例协调、自动重试或 T6.2 之后的安全/运维能力。

日志正文存放在 Server 的 `TASK_LOG_ROOT` 文件目录中，路径按任务 UUID 分片并使用 NDJSON。PostgreSQL 只记录最后连续序号、文件偏移和短期日志租约；文件恢复时会截断残缺、非法或跳号尾部，并以已同步的连续文件记录对齐元数据。Agent 使用 `BUILD_AGENT_LOG_BUFFER_MAX_BYTES` 控制有界本地缓冲，ACK 先校验上限，达到压缩阈值或全部确认时才安全压缩已确认前缀；同一进程短暂重连时回放未确认日志。服务端 HTTP 历史读取和 `/ws/client` 浏览器订阅都复用任务所有权检查，浏览器历史按固定订阅尾分页并与实时 offset 去重衔接。完整取消、进程树终止和产物上传不属于 T5.1。

## Windows 内网运行

当前 T6.3 只提供 Windows x64 前台运行包。使用 `deploy/windows/package-agent.ps1` 生成 ZIP
和 SHA-256，解压后以 `start-agent.ps1 -ConfigPath <build-agent.toml> -AgentExecutable <build-agent.exe>`
启动。该流程不安装 Windows Service；Token 只放在受限配置文件中。Server/Web 同源部署和备份
恢复见 `docs/windows-deployment.md`。
