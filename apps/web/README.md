# @buildplatform/web

通用构建任务平台的 Web 前端：Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router。

当前状态（T0.1）：只包含应用引导、路由骨架、一个 Pinia store 和一个概览页面，
没有登录、管理台、动态表单和任务页面。

## 本地运行

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
pnpm run contracts:build      # 首次运行前需要构建共享契约包（在仓库根目录执行）
pnpm --filter @buildplatform/web run dev
```

默认地址 `http://127.0.0.1:5173/`，页面显示应用名称、共享契约包版本和 API 基地址。

## 命令

```bash
pnpm --filter @buildplatform/web run dev
pnpm --filter @buildplatform/web run build        # vite build -> dist/
pnpm --filter @buildplatform/web run preview
pnpm --filter @buildplatform/web run type-check   # vue-tsc + tsc（构建脚本）
pnpm --filter @buildplatform/web run test         # vitest + jsdom
```

## 约定

- Element Plus 采用完整引入并设置 `zh-cn` 语言包；类型通过 `element-plus/global` 提供。
- `@/` 别名指向 `src/`，同时在 `vite.config.ts` 和 `tsconfig.json` 中声明。
- 动态表单渲染只允许使用 Element Plus 白名单组件，禁止动态渲染任意组件（见 T3.4）。
