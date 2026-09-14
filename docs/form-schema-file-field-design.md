# FormSchema 文件上传字段设计

## 1. 目标与范围

在现有动态 `FormSchema` 中新增单文件控件 `file`，允许模板管理员限制：

- 可上传的文件扩展名，例如 `.zip`、`.tar.gz`；
- 原始文件名（包名）规则；
- 单文件最大字节数；
- 是否必填。

用户在新建项目或编辑项目配置时上传文件。构建任务创建时必须快照当时绑定的文件；Agent 接单后通过独立 HTTP 流下载、校验并落盘，再把本地相对路径写入 `platform.config.json`。

第一版只支持一个 `file` 字段对应一个文件，不支持多文件、目录上传、远程 URL、Base64 内嵌、断点上传或在线解压。这里的“格式限制”指文件名扩展名限制；浏览器上报的 MIME 类型不可信，不作为安全判定。若将来要求校验 ZIP/APK 等真实内容格式，应为已知格式增加服务端文件签名/容器校验，不能只看 MIME。

## 2. FormSchema 契约

新增字段类型：

```ts
export interface FileFormField {
  readonly type: 'file';
  readonly name: string;
  readonly label: string;
  readonly required?: boolean;
  readonly description?: string;
  readonly allowedExtensions: readonly string[];
  readonly fileNamePattern?: string;
  readonly maxSizeBytes?: number;
}
```

示例：

```json
{
  "type": "file",
  "name": "packageFile",
  "label": "安装包",
  "description": "上传正式构建包",
  "required": true,
  "allowedExtensions": [".zip", ".tar.gz"],
  "fileNamePattern": "my-app-[0-9]+\\.[0-9]+\\.[0-9]+\\.(zip|tar\\.gz)",
  "maxSizeBytes": 536870912
}
```

约束如下：

- `allowedExtensions` 必填，数量 `1..16`，按大小写不敏感去重。
- 每个扩展名必须以 `.` 开头，只允许 ASCII 字母、数字、点、下划线、加号和连字符；单项最长 32 个字符。支持 `.tar.gz` 这类复合扩展名，校验时按完整后缀匹配。
- `fileNamePattern` 是可选的 ECMAScript 正则源码，无 flags，最长 256 个字符；服务端和 Web 都按完整文件名匹配，即使用 `^(?:pattern)$` 包裹。
- 为避免 ReDoS，模板校验必须拒绝反向引用、lookaround 和嵌套/重复量词等高风险结构；可以引入经过维护的安全正则检查库，但最终服务端仍是权威校验方。
- `maxSizeBytes` 是正安全整数。未配置时默认 256 MiB；契约硬上限 2 GiB。服务端环境变量可以设置更低的全局上限，实际限制取字段限制与全局限制的较小值。
- `file` 不允许 `defaultValue`、`placeholder`、`minLength`、`options`、`sensitive` 等无意义属性，未知属性继续拒绝。
- 原始文件名必须是 basename：拒绝 `/`、`\`、NUL、控制字符、`.`、`..`、Windows 保留设备名及 UTF-8 超长名称。建议限制为最多 255 个 UTF-8 字节。
- 扩展名和文件名规则都要满足，不能二选一。

公开的配置值新增文件引用对象：

```ts
export interface FileConfigValue {
  readonly fileId: string;
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}

export type FormFieldValue =
  string | number | boolean | readonly FormFieldOptionValue[] | FileConfigValue | null;
```

客户端提交的 `fileName`、`size`、`sha256` 仅用于显示，不能作为权限或完整性依据。服务端必须用 `fileId` 查询数据库后重新生成规范化对象，并验证文件所有者、模板、字段和项目绑定关系，拒绝伪造引用。

## 3. 为什么采用临时上传

新建项目时还没有 `projectId`，但必填文件又必须在创建项目之前上传。因此采用两阶段流程：

1. 登录用户针对某个模板和字段上传文件，得到一个本人所有的临时 `FileConfigValue`；
2. 创建项目或保存项目配置时，在同一数据库事务中校验并绑定该文件；
3. 用户取消操作后留下的未绑定文件，在 24 小时后由清理任务删除。

禁止把文件转成 Base64 写进 `Project.config` 或 `task.assignment.config`。当前 JSON/Agent WebSocket 单消息都有 1 MiB 上限，大文件必须始终走流式 HTTP。

## 4. 数据模型

建议新增两个模型，文件内容不可变：

```prisma
model ConfigFile {
  id              String    @id @default(uuid()) @db.Uuid
  ownerId         String    @db.Uuid
  projectId       String?   @db.Uuid
  buildTemplateId String    @db.Uuid
  fieldName       String    @db.VarChar(64)
  originalName    String    @db.VarChar(512)
  size            BigInt
  sha256          String    @db.Char(64)
  storagePath     String    @db.VarChar(4096)
  contentType     String?   @db.VarChar(255)
  expiresAt       DateTime?
  detachedAt      DateTime?
  createdAt       DateTime  @default(now())
  project         Project?  @relation(fields: [projectId], references: [id], onDelete: NoAction)
  taskInputs      BuildTaskInputFile[]

  @@index([ownerId, expiresAt])
  @@index([projectId, fieldName])
  @@index([buildTemplateId, fieldName])
}

model BuildTaskInputFile {
  id                 String     @id @default(uuid()) @db.Uuid
  taskId             String     @db.Uuid
  configFileId       String     @db.Uuid
  fieldName          String     @db.VarChar(64)
  targetRelativePath String     @db.VarChar(2048)
  originalName       String     @db.VarChar(512)
  size               BigInt
  sha256             String     @db.Char(64)
  createdAt          DateTime   @default(now())
  task               BuildTask  @relation(fields: [taskId], references: [id], onDelete: Cascade)
  configFile         ConfigFile @relation(fields: [configFileId], references: [id], onDelete: NoAction)

  @@unique([taskId, fieldName])
  @@index([configFileId])
}
```

同时给 `User`、`Project`、`BuildTask` 增加对应 relation 字段。

设计原则：

- `ConfigFile` 一经成功上传，内容、大小、Hash 和存储路径不可更新；替换文件必须创建新行。
- `Project.config` 保存规范化 `FileConfigValue`，`ConfigFile.projectId` 是当前绑定的权威关系。
- 保存配置时，新引用绑定到项目；被替换的旧文件设置 `detachedAt`，但只要仍有任务快照引用，就不能删除物理内容。
- 创建任务时在事务内建立 `BuildTaskInputFile`，快照名称、大小、Hash 和目标路径。模板或项目之后的修改不能影响已经创建的任务。
- 文件的 `storagePath` 永不返回给 Web、Agent、日志或审计记录。

## 5. Web API

### 5.1 上传临时配置文件

```http
POST /api/config-files?buildTemplateId=<uuid>&fieldName=<name>&fileName=<url-encoded-name>
Authorization: Bearer <access-token>
Content-Type: application/octet-stream
Content-Length: <bytes>
X-CSRF-Token: <token，沿用现有前端约定>
```

返回 `201`：

```json
{
  "file": {
    "fileId": "uuid",
    "fileName": "my-app-1.2.3.zip",
    "size": 123456,
    "sha256": "64位小写十六进制"
  }
}
```

上传实现要求：

- 要求用户已登录，查询并校验启用的模板及指定 `file` 字段；不能接受客户端传入 ownerId、size 或 sha256。
- `Content-Length` 缺失、非整数或超过有效上限时在读正文前拒绝；即使声明合法，流读取仍必须累计字节并在超限时立即中止。
- 流式写入同一存储卷上的唯一 `.part` 文件，同时增量计算 SHA-256；禁止把整个文件读入内存。
- 写完后 `fsync`、复核大小，再原子移动到最终路径并写数据库。数据库失败时安全清理临时/孤儿文件；清理失败只记录不含本地路径和文件名敏感内容的安全日志。
- 文件名扩展名匹配大小写不敏感，`fileNamePattern` 按原始 basename 完整匹配。
- `Content-Type` 仅记录为诊断元数据，不用于授权或格式判定。
- 存储根使用独立的 `CONFIG_FILE_STORAGE_ROOT`，启动时拒绝文件系统根路径，并加入 `/health/ready` 写入/同步/删除探针。

建议补充：

```http
GET    /api/config-files/:fileId/download
DELETE /api/config-files/:fileId
```

两者都必须校验所有权。DELETE 对仍被当前项目配置或任一任务引用的文件返回 `409`；从配置中移除文件应通过保存配置完成，而不是绕过配置一致性直接删除。

### 5.2 创建项目和保存配置

现有接口保持不变：

```http
POST /api/projects
PUT  /api/projects/:projectId/config
```

事务中对每个 `file` 值执行：

- 必须是严格的 `FileConfigValue` 对象，未知属性拒绝；
- `fileId` 对应文件必须属于当前用户，且 `buildTemplateId`、`fieldName` 与当前 Schema 一致；
- 临时文件必须未过期，已绑定文件必须绑定当前项目；
- 从数据库重新生成文件名、大小和 Hash 后，再运行格式、包名和大小校验；
- 同一个文件 ID 不允许同时用于两个字段或两个项目；
- 成功后把临时文件绑定到项目并清除 `expiresAt`；
- 项目配置更新与文件绑定/解绑必须在同一事务完成。

普通字段继续沿用现在的兼容性分析。文件被删除、过期、字段类型变化或不再满足新版 Schema 时，项目 `configCompatibility.valid=false` 且不可构建。

## 6. 任务创建、协议和 Agent

### 6.1 任务快照

创建任务时，在现有事务内：

1. 校验项目配置和所有文件引用；
2. 写入 `BuildTask.config` 的规范化快照；
3. 为每个文件字段写入 `BuildTaskInputFile`；
4. 生成固定目标路径 `.anvilrun/inputs/<fieldName>/<safe-original-name>`。

`fieldName` 已受现有 Schema 名称规则限制；文件名仍必须经过 basename 和平台保留名检查。解析后的绝对路径必须始终位于项目 source 下。任务快照创建后，即使用户替换项目文件，旧任务仍使用原文件。

### 6.2 Server → Agent 契约

给 `TaskAssignmentPayload` 增加：

```ts
export interface TaskInputFileAssignment {
  readonly fileId: string;
  readonly fieldName: string;
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
  readonly targetRelativePath: string;
}

readonly inputFiles: readonly TaskInputFileAssignment[];
```

不要在 WebSocket 中发送文件正文或带永久凭据的下载 URL。同步更新 TypeScript fixtures、JSON Schema（如有）、Rust DTO、序列化名称和 1 MiB envelope 测试。

Agent 下载接口：

```http
GET /api/agent/tasks/:taskId/input-files/:fileId/content
Authorization: Bearer <task lease token>
```

服务端必须校验任务、当前 Agent、活动任务、租约 Hash/有效期以及 `BuildTaskInputFile` 归属；只允许处于派发/准备阶段的对应 Agent 下载。响应流式返回正文，并带受控的 `Content-Length`、`Content-Type: application/octet-stream`，不暴露存储路径。

### 6.3 Agent 准备顺序

Agent 收到 assignment 后按以下顺序执行：

1. 完成现有 Git source 准备并持有项目工作区锁；
2. 创建/清理本次任务的 `.anvilrun/inputs` 受控目录；
3. 对每个输入文件下载到 create-new 临时文件；
4. 流式计算大小和 SHA-256，与 assignment 快照严格比对；
5. `sync_all` 后原子替换到目标相对路径；
6. 全部文件成功后生成 `platform.config.json`；
7. 启动模板命令。

任一下载、路径、大小或 Hash 校验失败都不得启动命令，应上报安全的 `task.failed` 原因。错误和日志不得输出租约、绝对存储路径或文件内容。

`platform.config.json` 中的文件字段写为：

```json
{
  "packageFile": {
    "fileId": "uuid",
    "fileName": "my-app-1.2.3.zip",
    "size": 123456,
    "sha256": "...",
    "path": ".anvilrun/inputs/packageFile/my-app-1.2.3.zip"
  }
}
```

`path` 使用 `/` 分隔的工作区相对路径，构建脚本不得依赖 Server 本地路径。Agent 生成 `platform.config.json` 时只给文件值增加 `path`；数据库中的 Project/Task 配置不保存 Agent 本地路径。

短断线恢复时重复下载必须幂等：若目标文件已存在，先流式校验大小和 Hash；一致则复用，不一致则安全重下。不得盲目信任仅有相同文件名的旧文件。

## 7. Web 交互

在 `FormConfigEditor.vue` 对 `file` 显式渲染白名单组件，不允许 Schema 指定任意 Vue 组件：

- 显示允许格式、文件名规则、大小上限；
- 选择文件时先做同样的本地预检，但服务端必须再次校验；
- 上传期间展示进度并禁用保存；
- 成功后显示文件名、大小、SHA-256 摘要，以及“替换”“移除”；
- 只有服务端返回成功后才更新 `modelValue[field.name]`；
- 上传失败保留原文件引用，不要把配置置空；
- `required` 文件移除后立即显示必填错误；
- 页面离开/取消不需要同步删除临时文件，由 24 小时清理负责；可以尽力 DELETE，但不能依赖它保证清理。

上传请求应使用 `XMLHttpRequest` 或支持上传进度的现有客户端封装；不要用 Base64 或普通 JSON body。

## 8. 安全与运维要求

- Web 上传只接受用户 access token；Agent 下载只接受该任务的短期 lease token，两种权限不能混用。
- 所有资源查询复用现有 ownership scope；非法 UUID、不存在、越权和软删除项目统一按现有策略返回 `404`。
- 原始文件名只作为受控元数据和相对 basename，不参与 Server 存储路径。实际存储路径由 UUID/Hash 生成。
- 防止路径穿越、符号链接、Windows reparse point、硬链接替换、临时文件竞争和跨卷非原子移动。
- 日志和审计只记录文件 ID、字段名、大小、Hash 前缀及成功/失败结果；不记录正文、租约、storagePath，敏感场景下也不记录原始文件名。
- 对上传接口增加用户级并发数/速率限制，避免磁盘耗尽；readiness 检查存储根可写性。
- 定期清理 `expiresAt < now()` 的未绑定文件，以及已 detached 且无任务引用的文件。先安全删除物理文件，再删除/标记数据库记录；失败可重试且必须幂等。
- 备份/恢复文档和脚本要包含 `CONFIG_FILE_STORAGE_ROOT` 与相关数据库表，并说明数据库和文件存储必须取一致快照。

建议错误码：

- `CONFIG_FILE_FIELD_INVALID`
- `CONFIG_FILE_NAME_INVALID`
- `CONFIG_FILE_EXTENSION_NOT_ALLOWED`
- `CONFIG_FILE_TOO_LARGE`
- `CONFIG_FILE_REFERENCE_INVALID`
- `CONFIG_FILE_EXPIRED`
- `CONFIG_FILE_DOWNLOAD_INVALID`
- `CONFIG_FILE_HASH_MISMATCH`

## 9. 实施顺序

1. contracts：新增 `file` 类型、Schema/配置值校验、兼容性分析、JSON Schema、fixtures 和单元测试。
2. Prisma：增加 `ConfigFile`、`BuildTaskInputFile` 和 migration。
3. Server 存储/API：实现临时流式上传、下载/删除、存储根检查与清理服务。
4. Projects：创建/保存配置时校验、认领、替换文件，并返回规范化引用。
5. Tasks：创建任务时快照输入文件；队列 assignment 增加 `inputFiles`。
6. Rust contracts/Agent：解析新协议，安全下载、Hash 校验、恢复复用，生成带 `path` 的配置。
7. Web：Schema 预览和项目配置页增加上传、进度、替换、移除交互。
8. 文档与部署：环境变量、readiness、备份恢复、Agent 行为和发布验收。

## 10. 必须覆盖的测试

### Contracts

- 合法单/复合扩展名、重复扩展名、非法字符、空数组和超量数组。
- 文件名正则编译失败、非完整匹配和高风险正则。
- `maxSizeBytes` 默认值、边界值、非整数和超上限。
- `file` 的未知/禁止属性、必填/null、伪造文件引用和模板兼容性变化。

### Server 集成测试

- 无 `Content-Length`、声明超限、实际流超限、空文件、连接中断、短写和 Hash 计算。
- 扩展名大小写、`.tar.gz` 完整后缀、包名不匹配、路径穿越和 Windows 保留名。
- 跨用户/跨模板/跨字段/跨项目复用 fileId 全部拒绝。
- 新建项目认领临时文件、编辑替换、取消产生的过期文件清理。
- 配置保存事务失败时绑定不发生，旧文件仍有效。
- 任务创建正确快照；项目替换文件后旧任务仍下载旧内容。
- Agent 使用错误/过期租约、错误 taskId/fileId 或非法状态下载均拒绝。
- 大文件上传和 Agent 下载保持有界内存。

### Agent 测试

- 多个输入文件顺序下载并在命令启动前全部就绪。
- 大小/Hash 不匹配、HTTP 中断和目标路径逃逸导致任务失败。
- 临时文件不会被构建命令看到；成功文件原子落盘。
- 重连恢复对一致文件复用，对损坏文件重下。
- `platform.config.json` 的文件元数据和相对 `path` 正确，Windows/Linux 分隔表现一致。

### Web/E2E

- 创建项目时先上传后保存；编辑时替换与移除。
- 客户端预检、上传进度、服务端错误展示和失败后保留旧值。
- 使用真实 Server + Rust Agent 构建，命令能读取 `platform.config.json` 中的路径和文件内容。

## 11. 完成标准

- 管理员可在模板 JSON 中声明 `file` 并限制扩展名、包名和大小。
- 用户可在新建项目和配置编辑页面上传、替换和移除文件。
- 客户端不能通过伪造 JSON 引用其他用户或其他项目的文件。
- 任务始终使用创建时快照的文件，项目后续替换不会改变排队中或历史任务。
- 文件正文不经过 JSON/WebSocket，不整文件入内存；Server 和 Agent 都复核大小与 SHA-256。
- Agent 只有全部输入文件安全落盘后才执行命令，构建可通过 `platform.config.json` 的相对路径读取文件。
- lint、type-check、Web/Server tests、Rust tests、build 和真实 E2E 均通过，并更新相关运维文档。
