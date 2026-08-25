//! Agent 可执行入口。
//!
//! T2.2 启动长期运行的 Server WebSocket 连接进程。

use std::path::PathBuf;
use std::str::FromStr;

use build_agent::{Agent, AgentConfig, AgentError, ConfigError, RunExit};
use tokio::sync::watch;
use tracing::{error, info};
use tracing_subscriber::filter::LevelFilter;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        error_or_stderr(&error);
        std::process::exit(1);
    }
}

async fn run() -> Result<(), AgentError> {
    let config_path = parse_config_path().map_err(|reason| {
        AgentError::configuration(ConfigError::Invalid {
            field: "arguments",
            reason,
        })
    })?;
    let config = AgentConfig::load(config_path.as_deref())?;
    init_tracing(&config.log_level)?;
    info!(config = ?config, "starting build Agent");

    let mut agent = Agent::from_config(config)?;
    let (shutdown_sender, shutdown_receiver) = watch::channel(false);
    let mut agent_task = tokio::spawn(async move { agent.run(shutdown_receiver).await });

    tokio::select! {
        result = &mut agent_task => handle_agent_result(result??),
        signal_name = shutdown_signal() => {
            info!(signal = signal_name, "shutdown requested");
            let _ = shutdown_sender.send(true);
            handle_agent_result(agent_task.await??)
        }
    }
}

fn handle_agent_result(exit: RunExit) -> Result<(), AgentError> {
    match exit {
        RunExit::Shutdown => Ok(()),
        RunExit::TokenRevoked { reason } => {
            error!(reason = ?reason, "Agent token was revoked; stopping");
            Err(AgentError::TokenRevoked { reason })
        }
    }
}

fn parse_config_path() -> Result<Option<PathBuf>, String> {
    let mut args = std::env::args_os().skip(1);
    let mut config_path = None;
    while let Some(argument) = args.next() {
        if argument == "--config" {
            let value = args
                .next()
                .ok_or_else(|| "--config requires a file path".to_string())?;
            config_path = Some(PathBuf::from(value));
        } else if argument == "--version" {
            println!("{}", build_agent::AgentBuildInfo::current().version_line());
            std::process::exit(0);
        } else {
            return Err(format!("unknown argument {}", argument.to_string_lossy()));
        }
    }
    Ok(config_path)
}

fn init_tracing(level: &str) -> Result<(), AgentError> {
    let level = LevelFilter::from_str(level).map_err(|_| {
        AgentError::configuration(ConfigError::Invalid {
            field: "log_level",
            reason: format!("unsupported log level {level}"),
        })
    })?;
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_current_span(false)
        .with_span_list(false)
        .with_max_level(level)
        .try_init()
        .map_err(|error| {
            AgentError::configuration(ConfigError::Invalid {
                field: "log_level",
                reason: format!("could not initialize logging: {error}"),
            })
        })
}

fn error_or_stderr(error: &AgentError) {
    if tracing::dispatcher::has_been_set() {
        error!(error = %error, "build Agent stopped");
    } else {
        eprintln!("build Agent stopped: {error}");
    }
}

async fn shutdown_signal() -> &'static str {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler should be installable");
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.expect("Ctrl+C handler should be installable");
                "ctrl_c"
            }
            _ = terminate.recv() => "sigterm",
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .expect("Ctrl+C handler should be installable");
        "ctrl_c"
    }
}
