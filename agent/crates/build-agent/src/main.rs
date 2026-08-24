//! Agent 可执行入口。
//!
//! T0.1 只输出基础版本信息后正常退出，不连接 Server、不执行构建任务。

use build_agent::AgentBuildInfo;

fn main() {
    println!("{}", AgentBuildInfo::current().version_line());
}
