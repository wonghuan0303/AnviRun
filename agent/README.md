# Build Agent

Rust Agent 是一个长期运行的跨平台连接进程，负责连接 Server、注册、心跳、领取任务、准备 Git 源码并运行最小构建命令。

当前能力：

- 使用 `build-agent.toml` 或 `--config <path>` 读取配置，环境变量覆盖 TOML。
- 通过原生 WebSocket/WSS 和 `Authorization: Bearer <agent token>` 连接 `/ws/agent`。
- 接收 `task.available` 后在空闲时发送 `task.claim`，校验 `task.assignment` 并发送 `task.accepted`。
- 在 `<workspace_root>/tasks/<taskId>/source` 中执行系统 Git 的参数数组 clone，读取 HEAD Commit SHA，并生成 `platform.config.json` 后运行模板命令。
- Git 或工作区准备失败时发送结构化 `task.failed`，并仅清理经过验证的当前任务目录。
- 心跳持续发送，`currentTaskId` 在 accepted/准备/执行/上传期间为任务 ID，空闲时为 `null`。
- 命令使用 Windows `cmd.exe /D /S /C` 或 Unix `/bin/sh -lc`，stdout/stderr 以有界分片发送 `task.log`；成功发送 `RUNNING`、`UPLOADING`，扫描并上传产物后发送 `task.completed`，失败发送带安全原因和可选退出码的 `task.failed`。
- 连接断开使用指数退避重连；收到 `agent.token.revoked`、Ctrl+C 或 Unix SIGTERM 后优雅退出。

## 配置

| TOML                       | 环境变量                               | 默认值                            | 说明                                                   |
| -------------------------- | -------------------------------------- | --------------------------------- | ------------------------------------------------------ |
| `server_url`               | `BUILD_AGENT_SERVER_URL`               | 无                                | HTTP(S)/WS(S) Server 地址，连接时自动使用 `/ws/agent`  |
| `token`                    | `BUILD_AGENT_TOKEN`                    | 无                                | Agent 注册令牌，不写入日志或 state 文件                |
| `workspace_root`           | `BUILD_AGENT_WORKSPACE_ROOT`           | 无                                | 工作区根目录；相对路径相对配置文件目录解析             |
| `log_level`                | `BUILD_AGENT_LOG_LEVEL`                | `info`                            | tracing 日志级别                                       |
| `minimum_free_space_bytes` | `BUILD_AGENT_MINIMUM_FREE_SPACE_BYTES` | `1073741824`                      | 接受任务前要求的可用字节数，非负安全整数，环境变量优先 |
| `state_file`               | `BUILD_AGENT_STATE_FILE`               | 配置文件目录下 `agent-state.json` | 只保存稳定 `agentId`                                   |
| `log_buffer_max_bytes`     | `BUILD_AGENT_LOG_BUFFER_MAX_BYTES`     | `67108864`                        | 断线日志缓冲上限，最大 1 GiB                           |

示例：

```toml
server_url = "https://build.example.internal"
token = "bpa_replace_me"
workspace_root = "C:/build-agent"
minimum_free_space_bytes = 1073741824
```

运行：

```text
build-agent.exe --config C:\build-agent\build-agent.toml
```

## 工作区与 Git 安全边界

工作区根目录启动时会创建并规范化为绝对路径；根目录不能是文件系统根。`tasks` 根目录必须位于工作区根目录内且可写。任务 ID 必须先解析为 UUID，再作为单一路径组件使用。任务目录和 source 创建前后都会检查路径边界与符号链接/reparse point；未知已存在的任务目录不会复用。

所有清理都经过 `TaskWorkspace` 的集中验证，只删除 `<workspace_root>/tasks/<有效 UUID>`。递归清理不跟随仓库中的符号链接，因此不会通过链接越过任务目录。连接断开或进程关闭时，当前准备任务会收到取消信号并等待 Git 进程终止，再显式检查部分工作区清理结果；成功 Git 准备的工作区在连接保持期间保留，供 T4.3 写入配置并执行命令；命令成功后进入 `UPLOADING`，工作区继续保留到 T5.3 产物上传完成。

Git 使用系统 `git`，不依赖 libgit2，也不调用 shell。clone 使用 `git clone --branch <branch> --single-branch -- <url> <source>` 参数数组，设置 `GIT_TERMINAL_PROMPT=0`，超时受任务 `timeoutSeconds` 限制。Git 凭据必须由 Agent 主机已有配置提供，协议和日志不传递凭据。成功后使用 `git -C <source> rev-parse --verify HEAD`，只接受 40 或 64 位十六进制 SHA，并统一回传小写。

失败原因使用稳定代码和安全消息，例如 `GIT_BRANCH_NOT_FOUND: requested Git branch was not found`、`GIT_TIMEOUT: Git operation timed out`；不会包含 token、完整 config、密码或堆栈。

T5.1 日志链路：每个任务的 stdout/stderr 日志按 UTF-8 NDJSON 分片写入 `log-buffer/<taskId>.ndjson` 有界缓冲后发送 `task.log`；Server 持久化成功后返回 `task.log.ack`。`log_buffer_max_bytes` / `BUILD_AGENT_LOG_BUFFER_MAX_BYTES` 控制本地缓冲上限，短暂断线时同一 Agent 进程会从未确认的序号继续回放。Agent 发送和 Server 日志广播都会遮蔽敏感配置值，但 `platform.config.json` 仍完整保留 assignment config。

## T4.3 配置文件与构建命令

收到有效 `task.assignment` 后，Agent 从 `payload.config` 完整生成 `<workspace_root>/tasks/<taskId>/source/platform.config.json`。配置只使用 assignment payload，不把配置插入命令、环境变量或参数；`sensitiveConfigKeys` 只用于 Agent 输出的敏感值遮蔽，不会删除或改变配置文件内容。文件使用 UTF-8、pretty JSON、恰好一个末尾换行；通过同一 source 目录内的唯一临时文件写入、`sync_all` 后替换，且拒绝 source 或目标文件的符号链接/reparse point。

准备成功后按顺序发送 `PREPARING` 和 `RUNNING`。命令工作目录是 source，Windows 使用 `cmd.exe /D /S /C <command>`，Unix 使用 `/bin/sh -lc <command>`。stdout/stderr 并发读取，每个分片最多 4 KiB，采用 lossy UTF-8 和每任务从 1 开始的单调序号；日志先写入每任务有界 NDJSON 缓冲，再发送 `task.log`，Server 持久化成功后以 `task.log.ack` 确认。断线恢复时同一进程从未确认序号继续回放；缓冲上限由 `log_buffer_max_bytes` 控制。命令预算取模板 timeout 与“租约剩余时间减去最终状态上报余量”的较小值；直接 Shell 超时会主动取消两个 reader，正常退出后的管道排空也有有限宽限期。超时、启动失败、输出读取失败或非零退出都会发送 `task.failed` 并清理任务工作区。退出码为 0 时发送 `UPLOADING`，扫描 artifactDir 生成清单，收到 Server ACK 后按文件流式上传；全部上传成功才发送 `task.completed`。

断线、token 撤销或进程退出会终止当前任务进程树、关闭输出读取任务并清理工作区；Server 会对执行中的失联任务做最小失败收尾。完整断线恢复对账和恢复窗口仍留给后续 T6。

## 手工 Git smoke

## T5.2 取消与跨平台进程树终止

收到 task.cancel 后，Agent 仅接受与当前任务和租约完全匹配的请求。准备阶段会向 Git 操作发送取消信号，并等待 Windows Job Object 或 Unix 进程组确认终止；执行阶段同样终止整个任务进程树，Unix 先发送 SIGTERM，短暂宽限后发送 SIGKILL。停止后显式清理并检查任务工作区，再回传 task.canceled；清理失败仅回传不含敏感值的结构化 `TASK_CANCEL_CLEANUP_FAILED` task.failed。

取消、超时、连接断开、token 撤销和优雅退出共用进程终止路径，输出 reader 的停止不会被误报为 COMMAND_OUTPUT_FAILED。取消期间保持心跳且不领取新任务；Server 等待固定取消确认期限，未确认时关闭连接并以失败收尾，避免 CANCELING 永久占用执行槽。任务日志缓冲仍按既有 T5.1 规则保留。完整断线恢复、租约对账和恢复窗口属于后续 T6。

准备一个本地 Git 仓库后，在配置的 Server 和 Agent 环境中创建指向该仓库的构建模板与项目，连接 Agent，观察 `task.claim`、`task.accepted` 和带 `sourceCommit` 的 `task.status`。手工验证命令示例：

```text
git --version
git clone --branch main --single-branch -- <local-or-remote-url> <temporary-directory>
git -C <temporary-directory> rev-parse --verify HEAD
```

不要把真实 registration token 写入配置示例、文档、测试输出或日志。

## 开发验证

在 `agent` 目录执行：

```text
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo build
```

当前 T4.3 已实现 platform.config.json、跨平台构建命令和 `RUNNING`/`UPLOADING`/`FAILED` 生命周期上报；T5.1 已实现有界磁盘日志缓冲、连续序号、Server ACK、同进程短暂断线回放、文件持久化和浏览器订阅；T5.3 已实现 artifactDir 扫描、清单 ACK、流式上传和 `SUCCEEDED` 闭环。任务详情页面与更完整的断线恢复属于后续 T5.4/T6。
