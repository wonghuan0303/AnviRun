# 参与贡献

感谢你愿意参与 AnvilRun。提交代码前，请先阅读本指南与 [行为准则](CODE_OF_CONDUCT.md)。

## 开始之前

- 缺陷与功能建议优先通过 GitHub Issue 讨论。
- 较大的功能、协议变更或架构调整，请先创建 Issue 说明使用场景和方案，避免重复工作。
- 安全漏洞不要创建公开 Issue，请按照 [安全策略](SECURITY.md) 私下报告。

## 本地开发

环境要求与启动步骤见 [README](README.md#快速开始) 和 [本地开发说明](docs/local-development.md)。推荐从最新的 `main` 分支创建功能分支：

```bash
git checkout -b feat/short-description
```

提交前至少运行与改动相关的检查。完整检查命令如下：

```bash
pnpm run lint
pnpm run type-check
pnpm run test
pnpm run build

pnpm run agent:fmt:check
pnpm run agent:lint
pnpm run agent:test
```

涉及数据库行为时，还应运行 `pnpm run db:test`；涉及完整 Windows 构建链路时，请参考 `deploy/windows/release-check.ps1`。

## Pull Request

- 一个 PR 聚焦一个问题，并保持变更范围尽量小。
- 清楚说明动机、主要变更、验证方式和兼容性影响。
- 新增或修复行为时补充相应测试。
- 不要提交真实密码、令牌、私钥、内部仓库地址或生产环境配置。
- 确保 CI 通过，并及时处理评审意见。

提交即表示你同意以仓库的 [MIT License](LICENSE) 发布你的贡献。
