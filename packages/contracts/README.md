# @buildplatform/contracts

Web、Server 与 Rust Agent 之间共享的公共契约包。

当前状态（T0.1）：只建立包结构、构建配置和导出入口，**不包含业务协议**。

T0.2 将在本包中定义：

- 角色、Agent 状态、任务状态与状态转换表
- 配置表单字段 JSON Schema 与运行时校验器
- WebSocket 消息信封（`id`、`type`、`timestamp`、`payload`、`protocolVersion`）
- API 错误码
- 与 Rust Serde DTO 对齐的共享 JSON fixtures

## 命令

```bash
pnpm --filter @buildplatform/contracts run build       # 输出 dist/cjs（+ d.ts）与 dist/esm
pnpm --filter @buildplatform/contracts run type-check
pnpm --filter @buildplatform/contracts run test
```

## 被依赖方式

`apps/web` 与 `apps/server` 通过 `workspace:*` 引用本包，导入路径为包名：

```ts
import { getContractsPackageInfo } from '@buildplatform/contracts';
```

本包同时提供两份产物，因此 CommonJS 的 NestJS 服务端与 ESM 打包的 Vite 前端都能直接消费：

| 消费方                      | 解析入口                   | 产物                  |
| --------------------------- | -------------------------- | --------------------- |
| `apps/server`（CommonJS）   | `main` / `exports.require` | `dist/cjs/index.js`   |
| `apps/web`（Vite / Rollup） | `exports.import`           | `dist/esm/index.js`   |
| 类型                        | `types` / `exports.types`  | `dist/cjs/index.d.ts` |

`dist/esm/package.json`（内容为 `{"type":"module"}`）由 `scripts/finalize-esm.mjs` 在构建时
生成，用于告诉 Node 与打包器该目录内是 ES Module。

包的入口是编译产物，因此在对 Web/Server 执行 `type-check`、`test`、`build`
之前必须先构建本包。仓库根目录的 `pnpm run type-check` / `test` / `build` 已经处理了该顺序。
