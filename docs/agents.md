# Agent 管理与连接

T2.1 实现 Server 侧 Agent 管理 API 和单实例原生 RFC 6455 WebSocket 网关。当前阶段不处理任务领取、执行、日志或产物。

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

Rust Agent 使用 rustls native roots 支持 WSS，避免依赖系统 OpenSSL；任务领取、Git、命令执行、日志和产物处理分别留给后续 T4/T5 阶段。

## T4.2 Rust Agent 工作区与 Git 执行

T4.2 在 T2.2 连接闭环上增加最小任务准备流程：Agent 收到 `task.available` 后仅在空闲时发送 `task.claim`，校验匹配的 `task.assignment`，先发送 `task.accepted`，再通过受控 Tokio 任务准备工作区。准备期间心跳持续发送 `currentTaskId`，单个 Agent 不会并行准备第二个任务；重复 assignment 不会创建第二份工作区或启动第二次 Git。

工作区根目录在 Agent 启动时创建并规范化为绝对路径，不能是文件系统根目录。任务目录固定为 `<workspace_root>/tasks/<UUID>/source`，taskId 必须先解析为 UUID，路径创建前后检查边界、符号链接和 Windows reparse point。清理只接受已验证的 `TaskWorkspace`，安全递归删除不跟随仓库中的符号链接；连接断开或关闭时中止准备任务并清理部分工作区，当前阶段不做断线续传。

Agent 启动和接收 assignment 时检查 workspace 可写性、`tasks` 目录写探针、最低可用磁盘空间和系统 Git。新增配置 `minimum_free_space_bytes` / `BUILD_AGENT_MINIMUM_FREE_SPACE_BYTES`，默认 `1073741824` 字节（1 GiB），必须是 0 到 JavaScript 安全整数范围内的非负整数，环境变量优先于 TOML。相对 `workspace_root` 按配置文件所在目录解析。

Git 只调用系统 `git`，不使用 libgit2、Shell 或脚本解释器。clone 使用参数数组 `git clone --branch <branch> --single-branch -- <url> <source>`，设置 `GIT_TERMINAL_PROMPT=0`，超时受 assignment 的 `timeoutSeconds` 限制。成功后执行 `git -C <source> rev-parse --verify HEAD`，只接受 40/64 位十六进制 SHA 并以小写回传。工作区/Git 失败发送 `CODE: safe message` 格式的 `task.failed`，不包含 token、配置值、凭据或堆栈。

Server 最小接收闭环只处理 `task.status` 且 status 为 `PREPARING` 的 sourceCommit，以及 `task.failed` 的 PREPARING 任务；它们会校验 Agent、activeTaskId、租约和状态，使用同一事务保存 SHA 或转为 FAILED 并清理执行槽。T4.2 不实现 platform.config.json、构建命令、日志/产物上传、任务完成/取消、断线续传或自动重试。
