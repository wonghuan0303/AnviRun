# @buildplatform/contracts

Web、Server 与 Rust Agent 之间共享的公共业务契约。T0.2 建立了角色、Agent 状态、任务状态机、动态表单、WebSocket 消息和 REST 错误响应的协议基线。

## 目录

```text
packages/contracts/
├─ src/auth/          # ADMIN / USER
├─ src/agent/         # ONLINE / OFFLINE / DISABLED
├─ src/task/          # 任务状态、转换表和日志流
├─ src/form-schema/   # 判别联合、运行时校验器和 JSON Schema
├─ src/websocket/     # 信封、payload DTO 类型和运行时校验器
├─ src/api/           # 稳定错误码与错误响应校验器
├─ fixtures/          # TypeScript 与 Rust 共用的 JSON
└─ schemas/           # 面向非 TypeScript 消费方的 JSON Schema
```

## 命令

```bash
pnpm --filter @buildplatform/contracts run build
pnpm --filter @buildplatform/contracts run type-check
pnpm --filter @buildplatform/contracts run test
cargo test --manifest-path agent/Cargo.toml
```

根目录的 `pnpm lint`、`pnpm type-check`、`pnpm test` 和 `pnpm build` 会覆盖 Node workspace；Rust 验收命令见根 README。

## 协议版本和破坏性变更

WebSocket 信封使用数字 `protocolVersion`，当前版本为 `1`。未知版本必须拒绝，不能静默降级。新增可选字段或新消息一般是兼容变更；删除/重命名字段、改变字段类型、改变枚举字面量、改变状态转换或改变错误码均属于破坏性变更，需要升级协议版本并同步 TypeScript、Rust 与 fixtures。

所有消息使用 ISO 8601 UTC 字符串。任务消息携带 `taskId` 和 `leaseToken`；Git 凭据和产物文件内容不得进入 WebSocket，产物只通过 `task.artifact-manifest` 传输元信息，Server ACK 后文件本体使用租约认证的 HTTP 流上传。

## 产物协议

命令成功后 Agent 发送 `task.status(UPLOADING)`，再发送 `task.artifact-manifest`，其中包含相对路径、字节数和 SHA-256。Server 校验清单后返回 `task.artifact-manifest-ack`；该 ACK 只表示元数据被接受，不代表文件已经落盘。Agent 对每个文件执行带 `leaseToken` 的 HTTP 流式上传，全部文件上传并校验成功后发送 `task.completed`。Server 只有在清单中的每个文件都已确认、统计值一致且租约有效时，才将任务推进到 `SUCCEEDED`。

产物路径只允许安全的相对路径；文件内容不在 WebSocket 中传输。实现层必须限制单任务总大小、校验流式 SHA-256、拒绝符号链接或 reparse point，并使用独占临时文件和刷盘后的安全移动。下载 API 不属于公共 WebSocket 协议，仍需复用 Server 的项目所有权授权。

## 如何扩展

1. 增加消息：在 `message-types.ts` 注册方向，在 `server-to-agent.ts` 或 `agent-to-server.ts` 增加 payload 映射，并在 `validate.ts` 增加运行时校验；随后为两侧各增加 fixture。
2. 修改状态机：只修改 `task-status-transitions.ts`，同步状态机测试、Rust `BuildTaskStatus` 和设计文档；终态不得产生出边。
3. 增加表单控件：在 `field-types.ts` 增加判别联合与允许属性，在 `validate.ts`、`json-schema.ts`、fixtures 和测试中同步规则。未知属性默认拒绝。
4. 修改 API 错误：在 `error-codes.ts` 注册稳定错误码、HTTP 映射和默认文案，并补充错误响应测试；错误详情不得含堆栈、令牌或密码。

Rust crate `agent/crates/build-agent-contracts` 通过 `src/lib_t02.rs` 中的 Serde DTO 读取 `packages/contracts/fixtures`，不维护副本。共享 fixtures 的路径按 `CARGO_MANIFEST_DIR` 相对解析，兼容 Windows、macOS 和 Linux。

## 任务日志协议

Agent 到 Server 的 `task.log` 携带任务租约、每任务连续序号、流向和 UTF-8 分片；分片最大字节数由 `TASK_LOG_CHUNK_MAX_BYTES` 约束。Server 成功追加后发送 `task.log.ack`，ACK 只确认已持久化的连续序号和文件偏移；重复序号可安全重试，跳号不会被写入。Agent 端可使用有界本地缓冲支持短暂断线回放。

浏览器日志订阅不是 Agent 协议：客户端先在 `/ws/client` 发送 access token 认证，再发送任务和 offset 订阅。Server 通过现有任务所有权服务授权，历史和实时 payload 均不携带租约哈希、令牌或配置秘密。

## 项目配置值校验

`src/form-schema/values.ts` 提供 Project.config 与后续 Web 共用的确定性运行时能力：

- `validateFormConfigValues(schema, input)`：要求普通 JSON 对象，按控件类型、required、长度/正则、数字范围/步长、options 和日期规则校验；成功结果已过滤未知字段并应用默认值。
- `normalizeFormConfigValues(schema, input)`：返回规范化的 `FormConfigValues`，失败时抛出带 `path`/`pointer` 的 `ContractValidationError`。
- `analyzeFormConfigCompatibility(schema, storedConfig)`：不写数据库，计算 `effectiveConfig`、`missingFields`、`obsoleteFields`、`typeConflictFields` 和字段级 `issues`。

`input`、`textarea`、`password` 接收字符串，`number` 接收有限数字，`select/radio` 接收声明过的字符串或数字，`checkbox` 接收不重复的 options 数组，`switch` 接收布尔值，`date` 接收真实的 `YYYY-MM-DD`。可选字段的 `null` 表示未填写；required 缺失或为 null 会报错；disabled 字段只使用模板默认值。未知配置字段会被过滤，并在兼容性分析中列为 obsolete，但不会单独导致 invalid。校验 issue 只返回安全的类型/形状信息，不回显具体配置值。

## 构建产物

本包同时输出 CommonJS (`dist/cjs`) 与 ESM (`dist/esm`)。Server 使用 `require`，Web 使用 ESM；两者都从包根入口导入，所有公共契约由 `src/index.ts` 统一导出。
