# 第一版发布验收与门禁（T6.4）

本文定义当前 Windows x64 可信内网部署的第一版发布门禁。它使用现有
`buildplatform-postgres-t11` Docker PostgreSQL、编译后的 Nest Server、Web 静态文件和
`x86_64-pc-windows-msvc` Rust Agent；不创建应用 Docker 镜像、不安装 Windows Service，
也不依赖公网 Git 或外部服务。

## 一键入口

在仓库根目录执行：

```powershell
pwsh -File .\deploy\windows\release-check.ps1
```

门禁默认只把 Prisma 回归和 `db:test` 指向 `buildplatform_test`。脚本不会清理或重置
`buildplatform_dev`。如测试容器使用不同的连接串，通过环境变量传入，而不要把密码写入
命令行：

```powershell
$env:BUILDPLATFORM_TEST_DATABASE_URL = 'postgresql://<user>:<password>@127.0.0.1:54329/buildplatform_test'
pwsh -File .\deploy\windows\release-check.ps1
```

凭据只在当前进程环境中使用，脚本不会回显连接串。

`release-check.ps1` 按以下顺序执行，任一步失败即返回非零退出码：

1. `pnpm install --frozen-lockfile`
2. Prisma generate、migration deploy（`buildplatform_test`）
3. `pnpm lint`、`pnpm type-check`、`pnpm test`、`pnpm build`
4. 完整 `db:test`
5. `deploy/windows/e2e.ps1`：创建随机隔离 E2E 数据库、临时目录和端口，运行真实编译 Server 与 Windows x64 Agent
6. Rust fmt、clippy、全特性测试、构建和 Windows x64 release 构建
7. Agent ZIP 打包及 `--version` 冒烟
8. `git diff --check`

E2E 自身执行 Prisma migration，结束时关闭 Server/Agent、删除自己创建的随机数据库、
测试 Git 仓库、工作区、日志、产物、Web 静态副本和日志文件。打包检查产生的 ZIP 和
SHA-256 也在门禁结束时删除，不会写入仓库。

## E2E 架构

`deploy/windows/e2e.ps1` 负责生命周期编排：

- 使用 `buildplatform_e2e_<随机后缀>` 数据库名，并在删除前再次校验名称；不可能将清理目标解析为 `buildplatform_dev`。
- 使用随机临时根目录，分别保存 Agent workspace、Artifact、task log、Web 静态副本、Git fixture、Agent 配置和进程输出。
- 绑定独立本机端口，等待编译 Server `/health/ready` 返回 200 后才开始业务验收。
- 真实启动 `apps/server/dist/main.js` 和 `agent/target/x86_64-pc-windows-msvc/release/build-agent.exe`。

`deploy/windows/e2e.mjs` 通过真实 HTTP、`/ws/client` 和 Agent 进程完成验收。确定性
构建夹具是 `deploy/windows/e2e-fixture/build-fixture.mjs`，读取
`platform.config.json`，输出 stdout/stderr，生成嵌套目录、Unicode 文件和空目录，
并支持 success、cancel、nonzero、empty 模式。模板创建先走正式 API；由于生产 Git URL
规则不接受 `file:` URL，脚本只在隔离 E2E 数据库中把该模板的 Git 地址替换为本地
fixture 路径，不改变生产校验规则。

## 产品设计第 13 节验收映射

| 场景                                   | 自动证据                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 管理员创建用户、Agent、模板并上线   | `e2e.mjs` 管理员初始化、登录、用户/Agent/模板 API，真实 Agent `agent.registered` 后状态为 ONLINE                                                               |
| 2. 所有权隔离                          | E2E 用户 B 对用户 A 的 Project、Task、Artifact 下载均得到 `404 RESOURCE_NOT_FOUND`；详细矩阵由 `apps/server/test/authorization`、tasks、artifacts 集成测试覆盖 |
| 3. 项目配置刷新保留                    | E2E 创建项目、PUT config、GET project，并比较规范化配置                                                                                                        |
| 4. 分支、配置和 Commit SHA             | 真实 Agent clone `main`；fixture 生成 branch/config 产物；任务 `sourceCommit` 与本地 Git HEAD 比较                                                             |
| 5. 同 Agent 串行、不同 Agent 并行      | 队列/执行槽 PostgreSQL/WebSocket 测试覆盖；E2E 连续执行同 Agent 的 success、cancel、empty 三类任务                                                             |
| 6. Agent 离线等待并恢复                | E2E 停止 Agent 后新任务为 `WAITING_AGENT`，同一 Agent 重连后任务成功完成                                                                                       |
| 7. 实时与历史日志                      | E2E `/ws/client` 收到 `task.log`，随后 HTTP history 同时包含 stdout 和 stderr；T5.1/T5.4 测试覆盖偏移续读和断线回放                                            |
| 8. 产物校验与空目录失败                | E2E 验证嵌套/Unicode/配置副本、单文件下载及 ZIP 解压内容；empty 模式进入 FAILED；T5.3 测试覆盖大小和 SHA-256                                                   |
| 9. 运行中取消                          | E2E cancel 模式在 PREPARING/RUNNING 后取消，最终 CANCELED 且执行槽释放；跨平台进程终止由 T5.2 Rust 测试覆盖                                                    |
| 10. 短重启与幂等                       | T6.1 PostgreSQL/WebSocket 恢复测试覆盖；E2E 验证 Agent 停止/重连不产生第二个活动槽                                                                             |
| 11. 非法路径、超限、错误租约、越权下载 | T5.3/T6.2 真实 API/WebSocket/路径测试覆盖；E2E 验证越权下载                                                                                                    |

除 E2E 外，门禁还运行完整 Node、数据库和 Rust 回归，因此不会把单一冒烟脚本当作
全部边界证明。

## 发布检查表与缺陷规则

- [ ] Docker PostgreSQL healthy，目标只包含隔离测试库；`buildplatform_dev` 未被清理或重置。
- [ ] Node 安装、lint、type-check、unit/component test、build 全部通过。
- [ ] Server/Agent/Web 产物可构建，Windows Agent ZIP 的 SHA-256 与文件一致。
- [ ] 真实 Server + Agent + PostgreSQL success 闭环通过，并验证日志、产物、下载、取消、离线恢复和所有权。
- [ ] Rust fmt、clippy、全特性测试、构建和 Windows x64 release build 全部通过。
- [ ] 没有 P0/P1 未解决问题；没有秘密、Cookie、Token、完整配置或备份进入产物/报告。
- [ ] `git diff --check` 通过，发布前由上级 Agent 审阅工作区后再决定是否 commit。

缺陷判定：P0 是数据丢失、越权、秘密泄露、任务无法终态或会破坏现有数据的阻断问题；
P1 是核心成功闭环、取消/恢复、产物完整性、发布脚本清理或跨平台构建不可用的问题。
存在 P0/P1 时门禁必须失败或不得将 T6.4 标为完成。P2/P3 可记录为后续改进，但不能
掩盖门禁失败。

## 发布产物

- Server 编译输出 `apps/server/dist`。
- Web 静态输出 `apps/web/dist`，部署时复制到 `WEB_STATIC_ROOT`。
- `build-agent-<version>-windows-x64.zip` 和同名 `.sha256`，由 `package-agent.ps1` 生成。
- 真实发布包不包含 Token、state、workspace、task log、Artifact、源码或 `target`。

## 升级、回滚和已知限制

升级仍按 [`windows-deployment.md`](windows-deployment.md) 和
[`operations.md`](operations.md) 执行：暂停新任务、备份数据库与本地数据、保存旧
Commit/产物、构建新版本、migration deploy、检查 live/ready 后再启动 Agent。
Prisma migration 默认只向前；不提供破坏性 down migration。结构不兼容时恢复到新的
隔离数据库再切换连接，不能直接覆盖 `buildplatform_dev`。

当前第一版刻意不提供 Server/Web Docker 镜像、Windows Service、自动更新、HTTPS/反向
代理自动配置、Linux/macOS 发布包、对象存储、日志轮转和完整发布平台。HTTPS、配置静态
加密和企业级限流仍是后续工作；T6.3 的可信内网 HTTP 模式必须按其文档使用，不能作为
公网部署方案。
