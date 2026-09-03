# T6.2 内网部署安全边界

AnvilRun 面向可信内网、单 Server 实例和固定用户/Agent 部署。部署仍应使用独立账号、最小权限，并避免在日志、工单或聊天中粘贴密码、Cookie、CSRF Token、Access/Refresh Token、Agent 注册令牌或任务租约。

## 认证与所有权

- Access Token 只由 Web 前端保存在内存；Token、Cookie 和租约不会放入 URL、API 响应、普通日志或审计 metadata。
- Refresh Cookie 保持 HttpOnly、SameSite=Strict；refresh/logout 继续校验 CSRF。生产默认使用 `__Host-` Cookie、Secure=true、Path=/ 且不设置 Domain；可信内网 HTTP 例外必须显式启用 `ALLOW_INSECURE_HTTP` 并改用非 `__Host-`、非 Secure Cookie。
- USER 只能访问自己 Project.ownerId 继承的任务、日志和 Artifact；ADMIN 可访问全部未软删除资源。跨用户、非法 UUID、不存在和软删除资源统一表现为 `RESOURCE_NOT_FOUND`。

## 请求和消息边界

- JSON 和 URL encoded 请求体上限为 1 MiB，超限返回结构化 `VALIDATION_FAILED`，不返回解析器堆栈。
- `/ws/agent` 单条消息上限为 1 MiB；`/ws/client` 单条消息上限为 64 KiB。产物内容不经过 JSON parser，而是继续使用流式上传和 manifest 限制。
- 产物单任务总大小为 2 GiB，文件数量上限为 65,535；Agent 发送前还会按完整 UTF-8 协议 envelope 检查 manifest 必须不超过 `/ws/agent` 上限，超限以 `ARTIFACT_MANIFEST_TOO_LARGE` 失败收尾，不进入重连循环。路径拒绝绝对路径、盘符、UNC、`..`、控制字符、符号链接和 Windows reparse point。

## 审计

现有 `AuditService`/`AuditLog` 记录登录成功/失败、用户创建/禁用/密码重置、Agent 管理、模板管理、项目变更、任务创建/取消/重建和产物软删除。每条审计包含操作者（无身份失败可为空）、动作、资源、requestId（如请求提供）和 `metadata.result`（`SUCCESS` 或 `FAILURE`）。metadata 仅保留非敏感的 ID、名称、角色和有限状态信息；不会记录密码、Hash、Token、Authorization Header、Cookie、完整 config、敏感值或 storagePath。

## 已知限制

本阶段不提供配置静态加密、KMS/Vault、通用分布式限流、HTTPS 证书加载、强制 HTTPS/HSTS、复杂 CORS/CSP 策略或审计管理页面。T6.3 精简版提供 Windows 可信内网 HTTP 例外和基础备份恢复，但不自动配置 HTTPS/WSS、反向代理或 Agent 服务安装；第一版发布门禁由 T6.4 的 `deploy/windows/release-check.ps1` 覆盖；HTTPS、反向代理和服务安装仍按当前需求延期。

官方 npm audit 当前报告的两个高危 advisory（`effect` 的 GHSA-38f7-945m-qr2g/CVE-2026-32887、`deepmerge-ts` 的 GHSA-ggr8-5vv4-36mx/CVE-2026-40345）路径均为 `@prisma/client -> prisma -> @prisma/config`。它们属于 Prisma CLI/config 开发工具链；本仓库不通过 root override 强制替换其跨主版本传递依赖，生产安装应排除 `prisma` 开发依赖。待 Prisma 发布兼容修复后再按直接父包升级。
