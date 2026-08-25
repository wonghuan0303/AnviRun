use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use thiserror::Error;
use url::Url;

const CONFIG_FILE_ENV: &str = "BUILD_AGENT_CONFIG_FILE";
const SERVER_URL_ENV: &str = "BUILD_AGENT_SERVER_URL";
const TOKEN_ENV: &str = "BUILD_AGENT_TOKEN";
const WORKSPACE_ROOT_ENV: &str = "BUILD_AGENT_WORKSPACE_ROOT";
const LOG_LEVEL_ENV: &str = "BUILD_AGENT_LOG_LEVEL";
const STATE_FILE_ENV: &str = "BUILD_AGENT_STATE_FILE";

const DEFAULT_RECONNECT_INITIAL: Duration = Duration::from_secs(1);
const DEFAULT_RECONNECT_MAX: Duration = Duration::from_secs(60);

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read configuration file {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse configuration file {path}: {source}")]
    Parse {
        path: PathBuf,
        source: Box<toml::de::Error>,
    },
    #[error("configuration field {field} is required")]
    Missing { field: &'static str },
    #[error("configuration field {field} is invalid: {reason}")]
    Invalid { field: &'static str, reason: String },
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    server_url: Option<String>,
    token: Option<String>,
    workspace_root: Option<String>,
    log_level: Option<String>,
    state_file: Option<String>,
}

/// Runtime configuration for one Agent process.
///
/// The token is intentionally not exposed by `Debug`; logging this value would
/// make a configuration mistake equivalent to credential disclosure.
pub struct AgentConfig {
    pub server_url: Url,
    pub token: String,
    pub workspace_root: PathBuf,
    pub log_level: String,
    pub state_file: PathBuf,
    pub(crate) reconnect_initial: Duration,
    pub(crate) reconnect_max: Duration,
}

impl fmt::Debug for AgentConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentConfig")
            .field("server_url", &self.server_url)
            .field("token", &"[REDACTED]")
            .field("workspace_root", &self.workspace_root)
            .field("log_level", &self.log_level)
            .field("state_file", &self.state_file)
            .field("reconnect_initial", &self.reconnect_initial)
            .field("reconnect_max", &self.reconnect_max)
            .finish()
    }
}

impl AgentConfig {
    /// Load configuration, with environment variables taking precedence over
    /// the optional TOML file.
    pub fn load(config_file: Option<&Path>) -> Result<Self, ConfigError> {
        let env_config_path = env_value(CONFIG_FILE_ENV)?;
        let config_path = config_file
            .map(PathBuf::from)
            .or_else(|| env_config_path.clone().map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("build-agent.toml"));
        let explicit_config = config_file.is_some() || env_config_path.is_some();

        let file = match fs::read_to_string(&config_path) {
            Ok(contents) => {
                toml::from_str::<FileConfig>(&contents).map_err(|source| ConfigError::Parse {
                    path: config_path.clone(),
                    source: Box::new(source),
                })?
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound && !explicit_config => {
                FileConfig::default()
            }
            Err(source) => {
                return Err(ConfigError::Read {
                    path: config_path,
                    source,
                });
            }
        };
        let base_dir = config_path.parent().unwrap_or_else(|| Path::new("."));

        let server_url = parse_server_url(&required_value(
            SERVER_URL_ENV,
            file.server_url,
            "server_url",
        )?)?;
        let token = required_value(TOKEN_ENV, file.token, "token")?;
        validate_text(&token, "token", 4096)?;
        let workspace_root =
            required_value(WORKSPACE_ROOT_ENV, file.workspace_root, "workspace_root")?;
        validate_text(&workspace_root, "workspace_root", 4096)?;
        let log_level =
            optional_value(LOG_LEVEL_ENV, file.log_level).unwrap_or_else(|| "info".to_string());
        validate_text(&log_level, "log_level", 32)?;

        let state_file = optional_value(STATE_FILE_ENV, file.state_file)
            .map(|value| resolve_path(base_dir, value))
            .unwrap_or_else(|| base_dir.join("agent-state.json"));

        Ok(Self {
            server_url,
            token,
            workspace_root: PathBuf::from(workspace_root),
            log_level,
            state_file,
            reconnect_initial: DEFAULT_RECONNECT_INITIAL,
            reconnect_max: DEFAULT_RECONNECT_MAX,
        })
    }

    /// Convert the configured HTTP(S) endpoint to the Agent WebSocket URL.
    pub fn websocket_url(&self) -> Result<Url, ConfigError> {
        if self.server_url.username() != ""
            || self.server_url.password().is_some()
            || self.server_url.query().is_some()
            || self.server_url.fragment().is_some()
        {
            return Err(ConfigError::Invalid {
                field: "server_url",
                reason: "credentials, query parameters, and fragments are not allowed".to_string(),
            });
        }

        let mut url = self.server_url.clone();
        let scheme = match url.scheme() {
            "http" | "ws" => "ws",
            "https" | "wss" => "wss",
            other => {
                return Err(ConfigError::Invalid {
                    field: "server_url",
                    reason: format!("unsupported scheme {other}; use http(s) or ws(s)"),
                });
            }
        };
        url.set_scheme(scheme).map_err(|_| ConfigError::Invalid {
            field: "server_url",
            reason: "could not set WebSocket scheme".to_string(),
        })?;

        let path = url.path().trim_end_matches('/');
        if path.is_empty() || path == "/" {
            url.set_path("/ws/agent");
        } else if !path.ends_with("/ws/agent") {
            url.set_path(&format!("{path}/ws/agent"));
        }
        Ok(url)
    }

    pub fn with_reconnect_policy(mut self, initial: Duration, maximum: Duration) -> Self {
        self.reconnect_initial = initial;
        self.reconnect_max = maximum.max(initial);
        self
    }
}

fn env_value(name: &str) -> Result<Option<String>, ConfigError> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(ConfigError::Invalid {
            field: "environment",
            reason: format!("{name} is not valid Unicode"),
        }),
    }
}

fn required_value(
    env_name: &str,
    file_value: Option<String>,
    field: &'static str,
) -> Result<String, ConfigError> {
    optional_value(env_name, file_value).ok_or(ConfigError::Missing { field })
}

fn optional_value(env_name: &str, file_value: Option<String>) -> Option<String> {
    env_value(env_name).ok().flatten().or(file_value)
}

fn validate_text(value: &str, field: &'static str, maximum: usize) -> Result<(), ConfigError> {
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(ConfigError::Invalid {
            field,
            reason: format!(
                "must be non-empty, at most {maximum} bytes, and contain no control characters"
            ),
        });
    }
    Ok(())
}

fn parse_server_url(value: &str) -> Result<Url, ConfigError> {
    Url::parse(value).map_err(|error| ConfigError::Invalid {
        field: "server_url",
        reason: error.to_string(),
    })
}

fn resolve_path(base_dir: &Path, value: String) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn loads_toml_and_builds_websocket_endpoint() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("agent.toml");
        let mut file = fs::File::create(&path).expect("configuration file");
        writeln!(
            file,
            "server_url = \"https://example.test/base\"\ntoken = \"bpa_secret\"\nworkspace_root = \"C:/agent-workspace\"\nstate_file = \"state.json\""
        )
        .expect("configuration contents");

        let config = AgentConfig::load(Some(&path)).expect("configuration should load");
        assert_eq!(
            config.websocket_url().unwrap().as_str(),
            "wss://example.test/base/ws/agent"
        );
        assert_eq!(config.state_file, directory.path().join("state.json"));
    }

    #[test]
    fn debug_output_redacts_token() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("agent.toml");
        fs::write(
            &path,
            "server_url = \"http://127.0.0.1:3000\"\ntoken = \"bpa_do_not_log\"\nworkspace_root = \"workspace\"",
        )
        .expect("configuration file");
        let config = AgentConfig::load(Some(&path)).expect("configuration should load");
        let debug = format!("{config:?}");
        assert!(!debug.contains("bpa_do_not_log"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn rejects_unsupported_server_scheme() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("agent.toml");
        fs::write(
            &path,
            "server_url = \"ftp://example.test\"\ntoken = \"bpa_secret\"\nworkspace_root = \"workspace\"",
        )
        .expect("configuration file");
        let config = AgentConfig::load(Some(&path)).expect("configuration should load");
        assert!(config.websocket_url().is_err());
    }
}
