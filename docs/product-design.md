# AnvilRun（铸程）构建任务平台：产品与系统设计

## 1. 产品目标

平台用于统一管理公司固定打包机上的软件构建任务。管理员维护构建模板与 Agent，普通用户创建自己的项目、填写动态参数并发起构建。Agent 在打包机本地使用已有 Git 凭据拉取源码，将参数写入工程根目录的 `platform.config.json`，执行一条管理员配置的命令，并将日志与指定目录中的产物回传平台。

第一版聚焦“通用构建”，不扩展为任意测试、部署或运维脚本平台。

## 2. 已确认的范围

### 2.1 第一版包含

- 平台本地账号登录。
- 管理员、普通用户两种角色。
- 管理员创建和维护 Agent、构建模板及用户。
- 构建模板固定绑定一个 Agent；一个 Agent 可以绑定多个构建模板。
- 普通用户只能查看和管理自己的项目、任务、日志与产物。
- 用户创建项目时选择构建模板并手动填写 Git 分支。
- 一个项目保存一份独立配置。
- 管理员上传 JSON 表单模板，平台使用 Element Plus 白名单组件生成配置页面。
- 构建时在源码根目录生成 UTF-8 JSON 文件 `platform.config.json`。
- 一个构建模板只配置一条构建命令，命令工作目录固定为源码根目录。
- 每个模板配置一个相对源码根目录的产物目录，Agent 递归上传其中全部文件。
- 每个 Agent 同时执行一个任务；同一 Agent 的任务串行排队，不同 Agent 可以并行。
- 支持等待 Agent、取消、停止、重新构建、实时日志和历史日志。
- Agent 使用打包机本机已有 Git 权限，平台不管理 Git 凭据。
- Agent 使用 Rust 实现，支持 Windows x64、macOS Intel/Apple Silicon、Linux x64。
- 产物第一版保存在平台服务器本地磁盘，单任务总量不超过 2 GB。
- 每个任务使用独立工作区，任务结束后无论成功失败都清理。

### 2.2 第一版不包含

- 模板 Git 同步、模板版本和模板快照。
- 多租户、项目共享和项目成员协作。
- 一个项目保存多套环境配置。
- 多 Agent 自动调度、标签匹配和负载均衡。
- 一台 Agent 并发执行多个任务。
- 多步骤构建流水线。
- 定时任务、Webhook、审批、自动重试和任务优先级。
- Docker/虚拟机任务隔离。
- 平台托管 Git 凭据。
- 对象存储和产物自动过期。

## 3. 术语与数据归属

| 概念 | 定义 | 管理者 |
| --- | --- | --- |
| Agent | 安装在固定打包机上的执行程序 | 管理员 |
| 构建模板 | Git 地址、命令、产物目录、配置表单模板及固定 Agent 的集合 | 管理员 |
| 配置表单模板 | 管理员上传的 JSON 字段数组，是构建模板的一部分 | 管理员 |
| 项目 | 用户创建的构建对象，绑定构建模板和一个手工填写的分支 | 项目所有者 |
| 项目配置 | 按表单模板填写并独立保存在项目下的 JSON 参数 | 项目所有者 |
| 构建任务 | 某次项目构建，保存本次实际项目参数及执行结果 | 平台 |
| 构建产物 | Agent 从模板指定目录中收集并上传的文件 | 平台 |

构建模板只保留当前内容。任务不保存模板版本或模板副本；任务创建时复制本次项目配置，防止项目随后修改影响已创建任务。任务执行完成后记录 Agent 实际 checkout 的源码 Commit SHA。

## 4. 用户与权限

### 4.1 管理员

- 登录平台。
- 创建、禁用、重置本地用户。
- 创建 Agent、生成或轮换 Agent 注册令牌、启用或停用 Agent。
- 查看所有 Agent 的在线状态和当前任务。
- 创建、编辑、启用、停用、删除构建模板。
- 上传和校验配置表单模板。
- 查看所有项目、任务、日志与产物。
- 取消或重新构建任意任务。

### 4.2 普通用户

- 登录平台。
- 查看已启用的构建模板摘要。
- 只能创建、查看、编辑和软删除自己的项目。
- 只能保存自己项目的配置。
- 只能创建、取消和重新构建自己项目下的任务。
- 只能查看和删除自己项目下的产物。

所有资源归属校验必须在服务端完成。禁止依赖前端菜单或按钮隐藏实现授权。

第一版不开放自主注册。系统通过初始化命令创建首个管理员；密码使用 Argon2id 哈希。Web 登录建议使用短期访问令牌与 HttpOnly Refresh Cookie，退出和重置密码时可使刷新令牌失效。

## 5. 核心业务流程

### 5.1 Agent 注册

1. 管理员在平台创建 Agent，平台只显示一次明文注册令牌，数据库仅保存令牌哈希。
2. 管理员在打包机配置平台地址、令牌和工作区根目录。
3. Agent 首次连接后上报稳定 Agent ID、主机名、操作系统、架构、Agent 版本和工作区信息。
4. Server 验证令牌并建立 WebSocket 长连接。
5. Agent 每 15 秒发送心跳；Server 在连续 45 秒未收到心跳后标记离线。

### 5.2 创建构建模板

管理员填写：

- 名称和说明。
- 固定 Agent。
- Git 仓库地址。
- 单条构建命令。
- 产物目录，例如 `dist`。
- 配置表单模板 JSON，可为空数组。
- 可选任务超时，默认 60 分钟。

Server 校验：

- Git 地址、命令非空且满足长度限制。
- 产物目录必须是安全的相对路径，不允许绝对路径、盘符或 `..`。
- 表单字段类型属于白名单，`name` 唯一且格式合法。
- 下拉、单选和多选字段必须提供合法选项。
- 模板绑定的 Agent 存在且未停用。

### 5.3 创建项目

1. 用户填写项目名称。
2. 选择一个已启用的构建模板。
3. 手动填写分支名称；平台只做非空、长度和控制字符校验，不访问 Git。
4. 平台根据模板当前表单 JSON 生成配置页。
5. 用户填写参数；Server 使用当前表单模板再次校验后，将配置独立保存到项目。

模板表单更新后，项目配置按字段 `name` 合并：新增字段使用默认值；删除字段不展示、不下发；类型不兼容或必填字段缺失时禁止构建，要求用户重新保存配置。

### 5.4 创建并执行构建任务

1. 用户在自己的项目中点击构建。
2. Server 校验项目、当前构建模板、Agent 及项目配置。
3. Server 创建任务并复制本次项目配置。
4. 若 Agent 离线，任务进入 `WAITING_AGENT`；若在线但忙碌，进入 `QUEUED`。
5. Agent 空闲时领取自己绑定模板中创建时间最早的任务。
6. Agent 创建 `<workspace>/tasks/<taskId>/source`。
7. Agent 使用系统 Git 拉取模板的 Git 地址，并 checkout 项目填写的分支。
8. Agent 获取并上报实际 Commit SHA。
9. Agent 在源码根目录原子写入 `platform.config.json`。
10. Agent 使用当前操作系统 Shell 执行模板的一条命令，实时回传 stdout/stderr。
11. 命令退出码为 0 后，Agent 校验产物目录并递归生成产物清单。
12. Agent 逐个流式上传产物及 SHA-256；全部上传并确认后任务成功。
13. 命令非零退出、超时、Git 失败、配置写入失败、产物目录缺失/为空、校验或上传失败均使任务失败。
14. Agent 在终态确认后清理整个任务工作区。

### 5.5 取消与重新构建

- 排队或等待 Agent 的任务可直接取消。
- 执行中的任务进入 `CANCELING`，Server 通知 Agent 终止整个进程树。
- Windows 使用 Job Object 或等效方式终止进程树；Unix 使用进程组信号，并在宽限期后强制终止。
- 重新构建总是创建新任务，使用当前项目配置和当前模板内容；旧任务保持不变。
- 第一版不自动重试。

## 6. 配置表单模板协议

### 6.1 示例

```json
[
  {
    "type": "select",
    "label": "版本号",
    "name": "version",
    "required": true,
    "options": [
      { "label": "1.0.0", "value": "1.0.0" },
      { "label": "2.0.0", "value": "2.0.0" }
    ]
  },
  {
    "type": "input",
    "label": "产品名称",
    "name": "name",
    "defaultValue": "安全客户端",
    "placeholder": "请输入产品名称",
    "required": true
  }
]
```

项目配置保存为：

```json
{
  "version": "1.0.0",
  "name": "零信任安全客户端"
}
```

### 6.2 第一版字段

| type | 值类型 | 特有属性 |
| --- | --- | --- |
| `input` | string | `minLength`、`maxLength`、`pattern` |
| `textarea` | string | `minLength`、`maxLength` |
| `number` | number | `min`、`max`、`step` |
| `select` | string/number | `options` |
| `radio` | string/number | `options` |
| `checkbox` | array | `options` |
| `switch` | boolean | 无 |
| `date` | ISO 日期字符串 | 无 |
| `password` | string | 默认 `sensitive: true` |

公共属性：

- `type`：必填，白名单控件类型。
- `name`：必填，配置键；第一版只允许 `[A-Za-z_][A-Za-z0-9_.-]{0,63}`，同一模板内唯一。
- `label`：必填，页面显示名称。
- `defaultValue`：可选。
- `required`：可选，默认 false。
- `placeholder`、`description`：可选纯文本。
- `disabled`：可选；禁用字段仍可使用默认值。
- `sensitive`：可选；敏感值在展示、日志和数据库导出中必须遮蔽。

模板不得指定任意 Vue/Element Plus 组件名、事件、插槽、HTML 或未批准属性。Server 和 Web 共享同一份 JSON Schema/类型定义并执行双重校验。

### 6.3 platform.config.json

- 文件固定生成在源码根目录。
- UTF-8、格式化 JSON、结尾换行。
- 使用临时文件写入后原子替换。
- 只包含当前模板仍声明的字段。
- 空模板生成 `{}`。
- 只存在于任务工作区，不提交或推送 Git。
- 日志不得打印完整配置；敏感字段必须遮蔽。

## 7. 任务状态机

```text
CREATED
  ├─ Agent 离线 ─> WAITING_AGENT ─┐
  └─ Agent 在线 ─> QUEUED ────────┤
                                   ▼
                              DISPATCHED
                                   ▼
                               PREPARING
                                   ▼
                                RUNNING
                                   ▼
                               UPLOADING
                                   ▼
                                SUCCEEDED

任意非终态 ─> CANCELING ─> CANCELED
准备/执行/上传阶段发生错误 ─> FAILED
运行中 Agent 失联 ─> AGENT_LOST ─> 恢复原阶段或超时后 FAILED
```

约束：

- `SUCCEEDED`、`FAILED`、`CANCELED` 为终态。
- 每次状态变化记录时间、来源和可展示原因。
- Server 使用数据库事务保证一个 Agent 最多拥有一个活动任务。
- WebSocket 只负责通知；数据库始终是任务状态的事实来源。
- Agent 领取任务时获得一次性租约令牌，后续状态、日志和上传都必须携带。
- Agent 断线重连时上报当前任务和租约；Server 校验后允许续传。
- Agent 失联超过任务租约恢复窗口（建议 5 分钟）后任务失败。

## 8. 系统架构

```text
Browser
  │ HTTPS / WebSocket
  ▼
Vue Web ──────────────┐
                      ▼
                 NestJS Server
                 ├─ Auth/RBAC
                 ├─ Template/Project
                 ├─ Task Queue
                 ├─ Agent Gateway
                 ├─ Log Service
                 └─ Artifact Service
                      │
               PostgreSQL + Local Storage
                      ▲
                      │ WSS 控制/日志 + HTTPS 上传
                      │
                 Rust Agents
                 ├─ Windows
                 ├─ macOS
                 └─ Linux
```

推荐技术选择：

- Web：Vue 3、TypeScript、Vite、Element Plus、Pinia、Vue Router。
- Server：NestJS、TypeScript、PostgreSQL、Prisma、Socket.IO 或标准 WebSocket。
- Agent：Rust、Tokio、Reqwest、Serde、Tracing；使用系统 Git 和系统 Shell。
- 日志：服务端追加写入 `storage/logs/<taskId>.log`，WebSocket 实时广播，HTTP 分页/按偏移读取历史。
- 产物：`storage/artifacts/<taskId>/<relativePath>`，元数据和 SHA-256 存数据库。
- 队列：第一版使用 PostgreSQL 事务队列，不引入 Redis。

## 9. 核心数据模型

### User

- `id`, `username`, `passwordHash`
- `role`: `ADMIN | USER`
- `status`: `ACTIVE | DISABLED`
- `tokenVersion`, `createdAt`, `updatedAt`

### RefreshToken

- `id`, `userId`, `tokenHash`, `expiresAt`, `revokedAt`
- 记录客户端摘要和最后使用时间，用于撤销。

### Agent

- `id`, `name`, `tokenHash`, `enabled`
- `status`: `ONLINE | OFFLINE | DISABLED`
- `hostname`, `os`, `arch`, `version`
- `lastSeenAt`, `activeTaskId`
- 工作区根目录由 Agent 本地配置，上报的信息仅用于诊断。

### BuildTemplate

- `id`, `name`, `description`
- `agentId`, `gitUrl`, `command`, `artifactDir`
- `formSchema` JSONB
- `timeoutSeconds`, `enabled`
- `createdBy`, `createdAt`, `updatedAt`

### Project

- `id`, `ownerId`, `buildTemplateId`
- `name`, `description`, `branch`
- `config` JSONB
- `createdAt`, `updatedAt`, `deletedAt`

### BuildTask

- `id`, `projectId`, `buildTemplateId`, `agentId`, `createdBy`
- `status`, `statusReason`
- `branch`, `config` JSONB
- `sourceCommit`, `exitCode`
- `queuedAt`, `startedAt`, `finishedAt`
- `cancelRequestedAt`, `leaseHash`, `leaseExpiresAt`
- `logSize`, `artifactCount`, `artifactBytes`

任务保存项目配置副本，但不保存构建模板副本或模板版本。排队任务在派发时读取构建模板当前内容。

### Artifact

- `id`, `taskId`, `relativePath`, `fileName`
- `size`, `sha256`, `storagePath`
- `createdAt`, `deletedAt`

## 10. API 边界

### Web REST API

- `/api/auth/login|refresh|logout|me`
- `/api/admin/users`
- `/api/admin/agents`、`/:id/token/rotate`
- `/api/build-templates`
- `/api/build-templates/:id/schema/validate`
- `/api/projects`
- `/api/projects/:id/config`
- `/api/projects/:id/tasks`
- `/api/tasks/:id`
- `/api/tasks/:id/cancel`
- `/api/tasks/:id/rebuild`
- `/api/tasks/:id/logs?offset=&limit=`
- `/api/tasks/:id/artifacts`
- `/api/artifacts/:id/download|delete`
- `/api/tasks/:id/artifacts/archive`

所有列表使用分页；所有修改接口使用 DTO 校验；错误返回稳定业务错误码。下载接口在授权后流式返回文件，不暴露服务器真实路径。

### Agent WebSocket 消息

Server 到 Agent：

- `agent.registered`
- `task.available`
- `task.assignment`
- `task.cancel`
- `agent.token.revoked`

Agent 到 Server：

- `agent.hello`
- `agent.heartbeat`
- `task.claim`
- `task.accepted`
- `task.status`
- `task.log`
- `task.artifact-manifest`
- `task.completed`
- `task.failed`
- `task.canceled`

产物内容不通过 WebSocket。Agent 使用带任务租约的 HTTP 流式上传接口；Server 校验相对路径、大小、Hash、任务归属和总量上限。

## 11. Agent 执行约束

- Agent 只能领取绑定到自身的构建模板任务。
- 所有路径必须在规范化后验证仍位于当前任务工作区。
- Git 使用参数数组启动，禁止拼接 Shell 字符串。
- 构建命令是管理员明确授权的 Shell 字符串；普通用户数据不得拼入命令。
- 用户配置只写入 JSON，禁止作为命令行参数或环境变量隐式展开。
- stdout/stderr 按字节流读取，做 UTF-8 容错、分块、限速和敏感值遮蔽。
- 日志上传失败时本地短暂缓冲，连接恢复后续传；设置缓冲上限防止磁盘耗尽。
- Agent 必须验证磁盘空间、Git 可用性和工作区可写性。
- 清理时只能删除已解析且位于配置工作区根目录下的具体任务目录。
- Agent 收到终态确认后清理；若 Server 不可达，保留最小任务状态直到重连确认，再清理工作区。

## 12. 安全与可靠性

- 生产环境默认必须使用 HTTPS/WSS；T6.3 精简部署仅在明确启用可信内网 HTTP 开关时允许非 Secure Cookie。
- 用户接口和 Agent 接口使用不同认证 Guard。
- Agent 注册令牌和 Refresh Token 只保存哈希。
- 敏感配置字段使用服务端主密钥进行字段级加密，日志与 API 默认遮蔽。
- 登录、令牌轮换、模板修改、任务取消、产物删除写入审计记录。
- 所有上传采用流式处理，并限制单文件、单任务总量和请求超时。
- 防止路径穿越、符号链接逃逸和重复相对路径覆盖。
- Server 重启后从数据库恢复非终态任务；Agent 重连后进行租约对账。
- 任务创建、领取、终态提交和取消必须幂等。
- 提供 `/health/live` 和 `/health/ready`，后者检查数据库和存储目录。

## 13. 第一版验收场景

1. 管理员创建用户、Agent 和构建模板，Agent 成功上线。
2. 普通用户看不到其他用户项目及其任务、日志和产物，直接调用 API 也返回 403/404。
3. 用户创建项目、填写分支和动态配置，刷新页面后配置仍存在。
4. 构建生成正确的 `platform.config.json`，拉取正确分支并记录 Commit SHA。
5. 两个绑定同一 Agent 的模板同时创建任务时串行执行；绑定不同 Agent 时可并行。
6. Agent 离线时任务等待，恢复连接后自动执行。
7. 实时日志可查看，刷新后可从历史偏移继续读取。
8. 成功任务上传所有产物并校验 SHA-256；空产物目录导致失败。
9. 运行中取消能终止整个进程树并清理工作区。
10. Server 或 Agent 短暂重启后不会重复执行或产生两个活动任务。
11. 非法产物路径、超限文件、错误租约和越权下载均被拒绝。

