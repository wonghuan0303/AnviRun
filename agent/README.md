# AnvilRun Agent

Rust Agent 是一个长期运行的跨平台连接进程，负责连接 Server、注册、心跳、领取任务、准备 Git 源码并运行最小构建命令。

当前能力：

- 使用 `build-agent.toml` 或 `--config <path>` 读取配置，环境变量覆盖 TOML。
- 通过原生 WebSocket/WSS 和 `Authorization: Bearer <agent token>` 连接 `/ws/agent`。
- 接收 `task.available` 后在空闲时发送 `task.claim`，校验 `task.assignment` 并发送 `task.accepted`。
- 首次为项目在 `<workspace_root>/projects/<projectId>/source` 中执行系统 Git 的参数数组 clone，后续构建复用该项目缓存，fetch 并对齐 assignment branch，读取 HEAD Commit SHA，生成 `platform.config.json` 后运行模板命令。
- Git 或工作区准备失败时发送结构化 `task.failed`；任务终态 ACK 后只释放项目锁，不删除项目源码缓存。
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

工作区根目录启动时会创建并规范化为绝对路径；根目录不能是文件系统根。`tasks` 和 `projects` 根目录必须位于工作区根目录内且可写。projectId 必须先解析为 UUID，再作为单一路径组件使用。项目目录和 source 创建/复用前后都会检查路径边界与符号链接/reparse point；每个项目目录持有跨进程独占锁，避免另一个 Agent 进程或重启场景同时使用同一缓存。

项目缓存按 `<workspace_root>/projects/<有效 projectId>/source` 隔离，保存 URL 的 SHA-256 指纹而不保存凭据或完整 URL。URL 改变、指纹缺失、缓存不是合法 Git 仓库或缓存损坏时，只在持有项目锁的情况下安全移除该 projectId 下的 source 并重新 clone；删除递归不跟随符号链接/reparse point，不会越过项目目录。任务成功、失败、取消、短断线和 Agent 重启都保留项目源码；任务终态仅在收到匹配的 `task.result.ack` 后释放项目锁和本地活动状态。

Git 使用系统 `git`，不依赖 libgit2，也不调用 shell。首次 clone 使用 `git clone --branch <branch> --single-branch -- <url> <source>`；缓存命中使用参数数组执行 `git -C <source> fetch --prune --no-tags origin <refspec>`，再强制 checkout 到 `refs/remotes/origin/<branch>`，确保工作树可靠对齐最新远端提交。所有 Git 操作设置 `GIT_TERMINAL_PROMPT=0`，超时受任务 `timeoutSeconds` 限制。Git 凭据必须由 Agent 主机已有配置提供，协议、指纹文件和日志不传递凭据。成功后使用 `git -C <source> rev-parse --verify HEAD`，只接受 40 或 64 位十六进制 SHA，并统一回传小写。

失败原因使用稳定代码和安全消息，例如 `GIT_BRANCH_NOT_FOUND: requested Git branch was not found`、`GIT_TIMEOUT: Git operation timed out`；不会包含 token、完整 config、密码或堆栈。

T5.1 日志链路：每个任务的 stdout/stderr 日志按 UTF-8 NDJSON 分片写入 `log-buffer/<taskId>.ndjson` 有界缓冲后发送 `task.log`；Server 持久化成功后返回 `task.log.ack`。`log_buffer_max_bytes` / `BUILD_AGENT_LOG_BUFFER_MAX_BYTES` 控制本地缓冲上限，短暂断线时同一 Agent 进程会从未确认的序号继续回放。Agent 发送和 Server 日志广播都会遮蔽敏感配置值，但 `platform.config.json` 仍完整保留 assignment config。

## T4.3 配置文件与构建命令

收到有效 `task.assignment` 后，Agent 从 `payload.config` 完整生成 `<workspace_root>/projects/<projectId>/source/platform.config.json`，每次构建覆盖上一次配置。配置只使用 assignment payload，不把配置插入命令、环境变量或参数；`sensitiveConfigKeys` 只用于 Agent 输出的敏感值遮蔽，不会删除或改变配置文件内容。文件使用 UTF-8、pretty JSON、恰好一个末尾换行；通过同一 source 目录内的唯一临时文件写入、`sync_all` 后替换，且拒绝 source 或目标文件的符号链接/reparse point。启动命令前仅清理本次 assignment 的 artifactDir，避免旧产物混入，同时保留依赖和其他源码。

准备成功后按顺序发送 `PREPARING` 和 `RUNNING`。命令工作目录是 project source，Windows 使用 `cmd.exe /D /S /C <command>`，Unix 使用 `/bin/sh -lc <command>`。stdout/stderr 并发读取，每个分片最多 4 KiB，采用 lossy UTF-8 和每任务从 1 开始的单调序号；日志先写入每任务有界 NDJSON 缓冲，再发送 `task.log`，Server 持久化成功后以 `task.log.ack` 确认。断线恢复时同一进程从未确认序号继续回放；缓冲上限由 `log_buffer_max_bytes` 控制。命令预算取模板 timeout 与“租约剩余时间减去最终状态上报余量”的较小值；直接 Shell 超时会主动取消两个 reader，正常退出后的管道排空也有有限宽限期。超时、启动失败、输出读取失败或非零退出都会发送 `task.failed`，但保留项目源码缓存。退出码为 0 时发送 `UPLOADING`，扫描 artifactDir 生成清单；清单序列化后的完整 UTF-8 envelope 必须小于等于共享的 1 MiB Agent WebSocket 上限，超限发送 `ARTIFACT_MANIFEST_TOO_LARGE` 的 `task.failed`，不发送 manifest 或进入重复重连；通过 Server ACK 后按文件流式上传，全部上传成功才发送 `task.completed`。

普通 WebSocket 短断线不会终止当前任务：Agent 保留 ActiveTask、项目工作区、执行句柄和未确认日志，并在重连 hello 中上报当前阶段、租约和最后确认日志序号，由 Server 在 5 分钟恢复窗口内裁决是否继续。每个项目工作区持有跨平台活动锁；Agent 重启时不清理项目缓存，锁由操作系统释放后可安全复用。token 撤销、显式关闭或本地真实失败仍终止进程树并释放项目锁；Agent 进程重启因失去内存执行上下文不会重跑旧任务，Server 对账后将其明确失败。

## 手工 Git smoke

## T5.2 取消与跨平台进程树终止

收到 task.cancel 后，Agent 仅接受与当前任务和租约完全匹配的请求。准备阶段会向 Git 操作发送取消信号，并等待 Windows Job Object 或 Unix 进程组确认终止；执行阶段同样终止整个任务进程树，Unix 先发送 SIGTERM，短暂宽限后发送 SIGKILL。停止后保留当前 workspace 和项目锁，再回传 task.canceled；收到匹配的 `task.result.ack` 后才释放项目锁和本地活动状态。Agent 退出、ABANDON 等没有终态 ACK 的销毁路径才直接释放锁；停止/清理失败回传不含敏感值的结构化 `TASK_CANCEL_CLEANUP_FAILED` task.failed，并同样等待终态 ACK。

取消、超时、token 撤销和优雅退出共用进程终止路径，输出 reader 的停止不会被误报为 COMMAND_OUTPUT_FAILED；普通 WebSocket 短断线则保留任务等待 T6.1 对账。取消期间保持心跳且不领取新任务；Server 等待固定取消确认期限，未确认时关闭连接并以失败收尾，避免 CANCELING 永久占用执行槽。任务日志缓冲仍按既有 T5.1 规则保留。

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

当前 T4.3 已实现 platform.config.json、跨平台构建命令和 `RUNNING`/`UPLOADING`/`FAILED` 生命周期上报；T5.1 已实现有界磁盘日志缓冲、连续序号、Server ACK、同进程短暂断线回放、文件持久化和浏览器订阅；T5.3 已实现 artifactDir 扫描、清单 ACK、流式上传和 `SUCCEEDED` 闭环；T6.1 已补充短断线恢复、终态 ACK 和任务创建幂等。T6.2～T6.4 已按 Windows 可信内网精简范围实现；第一版真实 Server + Rust Agent + PostgreSQL 验收入口为 `deploy/windows/release-check.ps1`。

## Windows x64 发布

T6.3 精简部署使用 `deploy/windows/package-agent.ps1` 构建
`x86_64-pc-windows-msvc` release 包，生成 `build-agent-<version>-windows-x64.zip` 和
同名 SHA-256 文件。发布包只包含可执行文件、配置示例、版本和说明，不包含 state、工作区、
日志、源码、target 或真实 Token。Agent 继续以前台进程运行，不安装 Windows Service；安装、
升级、备份恢复与故障排查见 `docs/windows-deployment.md` 和 `docs/operations.md`。

第一版发布验收可由仓库根目录的 deploy/windows/release-check.ps1 重复执行。它会使用临时本地 Git fixture、隔离 PostgreSQL 和真实 Windows x64 Agent，验证成功构建、日志、产物、取消、离线重连及 Agent 执行槽释放；详细映射见 docs/release-check.md。
