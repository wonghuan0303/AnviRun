# Build Agent

Rust Agent 是一个长期运行的跨平台连接进程，负责连接 Server、注册、心跳、领取任务，以及在任务工作区中准备 Git 源码。

当前能力：

- 使用 `build-agent.toml` 或 `--config <path>` 读取配置，环境变量覆盖 TOML。
- 通过原生 WebSocket/WSS 和 `Authorization: Bearer <agent token>` 连接 `/ws/agent`。
- 接收 `task.available` 后在空闲时发送 `task.claim`，校验 `task.assignment` 并发送 `task.accepted`。
- 在 `<workspace_root>/tasks/<taskId>/source` 中执行系统 Git 的参数数组 clone，读取 HEAD Commit SHA 并回传 `task.status`。
- Git 或工作区准备失败时发送结构化 `task.failed`，并仅清理经过验证的当前任务目录。
- 心跳持续发送，`currentTaskId` 在 accepted/准备期间为任务 ID，空闲时为 `null`。
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

所有清理都经过 `TaskWorkspace` 的集中验证，只删除 `<workspace_root>/tasks/<有效 UUID>`。递归清理不跟随仓库中的符号链接，因此不会通过链接越过任务目录。连接断开或进程关闭时，当前准备任务会被取消，部分工作区会安全清理；成功 Git 准备的工作区在连接保持期间保留，供 T4.3 后续写入配置和执行命令。

Git 使用系统 `git`，不依赖 libgit2，也不调用 shell。clone 使用 `git clone --branch <branch> --single-branch -- <url> <source>` 参数数组，设置 `GIT_TERMINAL_PROMPT=0`，超时受任务 `timeoutSeconds` 限制。Git 凭据必须由 Agent 主机已有配置提供，协议和日志不传递凭据。成功后使用 `git -C <source> rev-parse --verify HEAD`，只接受 40 或 64 位十六进制 SHA，并统一回传小写。

失败原因使用稳定代码和安全消息，例如 `GIT_BRANCH_NOT_FOUND: requested Git branch was not found`、`GIT_TIMEOUT: Git operation timed out`；不会包含 token、完整 config、密码或堆栈。

## 手工 Git smoke

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

当前阶段未实现 platform.config.json、构建命令、日志/产物上传、任务完成/取消、断线续传和自动重试构建。
