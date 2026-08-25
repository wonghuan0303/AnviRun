//! 通用构建任务平台 Agent 的公共库入口。
//!
//! T2.2 提供配置加载、Server WebSocket 连接、注册、心跳、重连和优雅退出。
//! 任务领取、Git、命令执行、日志和产物上传保留到后续阶段。

mod config;
mod connection;

pub use config::{AgentConfig, ConfigError};
pub use connection::{Agent, AgentError, RunExit};

/// Agent 的基础标识信息，用于启动日志与后续向 Server 上报。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentBuildInfo {
    /// 可执行程序名称。
    pub name: &'static str,
    /// Agent 版本，来自 Cargo 包版本。
    pub version: &'static str,
    /// 目标操作系统，例如 `windows`、`macos`、`linux`。
    pub os: &'static str,
    /// 目标架构，例如 `x86_64`、`aarch64`。
    pub arch: &'static str,
}

impl AgentBuildInfo {
    /// 读取当前编译目标的基础信息。
    #[must_use]
    pub const fn current() -> Self {
        Self {
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }

    /// 生成单行版本描述，格式为 `name version (os/arch)`。
    #[must_use]
    pub fn version_line(&self) -> String {
        format!("{} {} ({}/{})", self.name, self.version, self.os, self.arch)
    }
}

impl Default for AgentBuildInfo {
    fn default() -> Self {
        Self::current()
    }
}

#[cfg(test)]
mod tests {
    use super::AgentBuildInfo;

    #[test]
    fn current_info_is_populated() {
        let info = AgentBuildInfo::current();

        assert_eq!(info.name, "build-agent");
        assert!(!info.version.is_empty());
        assert!(!info.os.is_empty());
        assert!(!info.arch.is_empty());
    }

    #[test]
    fn version_line_contains_name_version_os_and_arch() {
        let info = AgentBuildInfo::current();
        let line = info.version_line();

        assert!(line.starts_with("build-agent "));
        assert!(line.contains(info.version));
        assert!(line.contains(info.os));
        assert!(line.contains(info.arch));
    }

    #[test]
    fn default_matches_current() {
        assert_eq!(AgentBuildInfo::default(), AgentBuildInfo::current());
    }
}
