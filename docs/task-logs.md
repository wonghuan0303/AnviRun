# T5.1 任务日志

T5.1 采用文件型日志正文、PostgreSQL 元数据和单实例内存广播的最小闭环。它不引入日志数据库表、Redis 或外部消息队列，也不改变任务状态机。

## Server

Server 将每个任务的日志追加到 TASK_LOG_ROOT 下的两级路径：

```text
<TASK_LOG_ROOT>/<taskId 前两位>/<taskId>.ndjson
```

每行包含 sequence、stream、chunk 和 emittedAt。BuildTask 只保存 lastLogSequence、logSize、logLeaseHash、logLeaseExpiresAt 和创建派发时的敏感键快照。重复序号返回当前 ACK，跳号不落盘；追加和 PostgreSQL 偏移更新按任务串行化。Server 首次访问、进程重启或发现文件大小异常时扫描并恢复文件：残缺、非法或跳号尾部会被截断，只有完整、连续且已 sync 的文件记录才推进数据库游标和 ACK；正常追加使用缓存游标，不逐条全文件扫描。历史接口为 GET /api/tasks/:taskId/logs?offset=&limit=，读取有界字节，不把完整日志加载到内存。

Agent 的 task.log 必须使用有效的执行租约；任务进入终态后，在短期 log lease 内允许补齐已产生的日志。Server 依据模板敏感字段和配置值做第二次遮蔽，遮蔽器跨分片保留必要的短后缀。日志错误不返回令牌、密码、配置正文或堆栈。

## Agent

Agent 先把每个任务的日志写入 workspace_root/log-buffer/<taskId>.ndjson，文件大小受 BUILD_AGENT_LOG_BUFFER_MAX_BYTES 限制，再发送 task.log。Server 返回 task.log.ack 后，Agent 校验 ACK 不得超前；小 ACK 只推进内存游标，达到压缩阈值或全部确认时才压缩已确认前缀。启动时会截断残缺或不连续尾部；压缩使用跨平台安全替换，替换失败时保留原缓冲。连接短暂断开时，同一进程重连后回放未确认分片；进程退出后不做跨进程日志恢复，这属于后续可靠性阶段。

sensitiveConfigKeys 只用于 Agent 日志和诊断遮蔽。它不会从 task.assignment.payload.config 或 platform.config.json 删除字段，构建程序仍可读取完整配置。

## 浏览器

浏览器通过 /ws/client 建立独立日志连接，第一条消息为 auth/accessToken，随后按 taskId 和 offset 订阅。订阅先固定文件尾偏移，再以有界分页回放到该偏移；回放期间到达的实时事件暂存并按 offset 去重衔接，避免大于 1MiB 的历史日志缺页或重复。连接最多保持少量订阅并受发送缓冲上限保护；订阅、历史读取和实时广播都复用任务所有权检查。跨用户任务统一拒绝，不暴露任务是否存在。

T5.1 不实现任务取消、完整进程树终止、断线后的跨进程对账、产物上传或日志 UI；分别留给后续 T5/T6 阶段。
