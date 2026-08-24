# Rust Agent

打包机上运行的构建 Agent，使用 Cargo workspace 管理。

当前状态（T0.1）：只包含可编译、可运行、可测试的骨架，启动后输出基础版本信息并退出。

- 连接、认证、心跳与重连：T2.2
- 工作区与 Git 拉取：T4.2
- 配置写入与命令执行：T4.3
- 取消与进程树终止：T5.2

## 目录

```text
agent/
├─ Cargo.toml               # workspace 定义
├─ rustfmt.toml
└─ crates/
   └─ build-agent/          # 可执行 crate
      ├─ Cargo.toml
      └─ src/
         ├─ lib.rs          # AgentBuildInfo 及单元测试
         └─ main.rs         # 可执行入口
```

## 命令

在 `agent/` 目录下执行：

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo build
cargo run -p build-agent
```

也可以在仓库根目录使用统一入口：

```bash
pnpm run agent:fmt:check
pnpm run agent:lint
pnpm run agent:test
pnpm run agent:build
pnpm run agent:run
```

`cargo run` 的预期输出形如：

```text
build-agent 0.1.0 (windows/x86_64)
```
