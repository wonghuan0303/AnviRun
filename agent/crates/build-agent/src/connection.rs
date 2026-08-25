use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use build_agent_contracts::{
    parse_message, AgentHeartbeatPayload, AgentHelloPayload, AgentRegisteredPayload,
    DecodedMessage, MessageType, ProtocolEnvelope, ProtocolVersion, RequiredNullable,
};
use chrono::{SecondsFormat, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::time;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        error::Error as TungsteniteError,
        http::{header::AUTHORIZATION, HeaderValue},
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::{config::ConfigError, AgentBuildInfo, AgentConfig};

type AgentSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error(transparent)]
    Configuration(Box<ConfigError>),
    #[error("failed to read agent state {path}: {source}")]
    StateRead {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to write agent state {path}: {source}")]
    StateWrite {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("agent state file {path} is invalid")]
    StateInvalid { path: PathBuf },
    #[error("WebSocket authentication was rejected by the Server")]
    AuthenticationRejected,
    #[error("WebSocket connection failed: {message}")]
    WebSocket { message: String },
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("Agent task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
    #[error("failed to encode protocol message: {0}")]
    Encode(#[from] serde_json::Error),
    #[error("Agent token was revoked by the Server")]
    TokenRevoked { reason: Option<String> },
}

impl From<ConfigError> for AgentError {
    fn from(error: ConfigError) -> Self {
        Self::Configuration(Box::new(error))
    }
}

impl AgentError {
    pub fn configuration(error: ConfigError) -> Self {
        Self::Configuration(Box::new(error))
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunExit {
    Shutdown,
    TokenRevoked { reason: Option<String> },
}

#[derive(Debug)]
enum ConnectionExit {
    Disconnected,
    Shutdown,
    TokenRevoked { reason: Option<String> },
}

#[derive(Debug)]
enum RegisteredResult {
    Registered(AgentRegisteredPayload),
    Disconnected,
    Shutdown,
    TokenRevoked { reason: Option<String> },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedState {
    agent_id: String,
}

#[derive(Debug)]
struct RetryState {
    initial: Duration,
    maximum: Duration,
    current: Duration,
}

impl RetryState {
    fn new(initial: Duration, maximum: Duration) -> Self {
        Self {
            initial,
            maximum: maximum.max(initial),
            current: initial,
        }
    }

    fn reset(&mut self) {
        self.current = self.initial;
    }

    fn next_delay(&mut self) -> Duration {
        let delay = self.current;
        self.current = self
            .current
            .checked_mul(2)
            .unwrap_or(self.maximum)
            .min(self.maximum);
        delay
    }
}

/// Long-running Rust Agent connection process.
pub struct Agent {
    config: AgentConfig,
    build_info: AgentBuildInfo,
    hostname: String,
    agent_id: Option<String>,
}

impl Agent {
    pub fn from_config(config: AgentConfig) -> Result<Self, AgentError> {
        let hostname = hostname::get()
            .map(|value| value.to_string_lossy().into_owned())
            .map_err(|source| AgentError::StateRead {
                path: PathBuf::from("<hostname>"),
                source,
            })?;
        let agent_id = load_state(&config.state_file)?;

        Ok(Self {
            config,
            build_info: AgentBuildInfo::current(),
            hostname,
            agent_id,
        })
    }

    #[must_use]
    pub fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    #[must_use]
    pub fn config(&self) -> &AgentConfig {
        &self.config
    }

    /// Run until the process is asked to stop or the Server revokes the token.
    pub async fn run(
        &mut self,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<RunExit, AgentError> {
        let mut retry = RetryState::new(self.config.reconnect_initial, self.config.reconnect_max);

        loop {
            if shutdown_requested(&shutdown) {
                return Ok(RunExit::Shutdown);
            }

            let result = self.connect_once(shutdown.clone()).await;
            let disconnected = matches!(&result, Ok(ConnectionExit::Disconnected));
            match result {
                Ok(ConnectionExit::Shutdown) => return Ok(RunExit::Shutdown),
                Ok(ConnectionExit::TokenRevoked { reason }) => {
                    return Ok(RunExit::TokenRevoked { reason });
                }
                Ok(ConnectionExit::Disconnected) => {
                    retry.reset();
                    info!("Agent WebSocket disconnected");
                }
                Err(error) => {
                    let delay = retry.next_delay();
                    warn!(
                        error = %error,
                        retry_after_seconds = delay.as_secs_f64(),
                        "Agent WebSocket connection failed; retrying"
                    );
                    if wait_for_retry(delay, &mut shutdown).await {
                        return Ok(RunExit::Shutdown);
                    }
                }
            }

            if disconnected {
                let delay = retry.next_delay();
                if wait_for_retry(delay, &mut shutdown).await {
                    return Ok(RunExit::Shutdown);
                }
            }
        }
    }

    async fn connect_once(
        &mut self,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<ConnectionExit, AgentError> {
        let url = self.config.websocket_url()?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(map_websocket_error)?;
        let authorization = format!("Bearer {}", self.config.token);
        let header = HeaderValue::from_str(&authorization).map_err(|_| {
            AgentError::Protocol(
                "configured token cannot be used in Authorization header".to_string(),
            )
        })?;
        request.headers_mut().insert(AUTHORIZATION, header);

        info!(
            server_url = %url,
            agent_id = ?self.agent_id,
            "connecting Agent WebSocket"
        );
        let (mut socket, _) = connect_async(request).await.map_err(map_websocket_error)?;
        if shutdown_requested(&shutdown) {
            close_socket(&mut socket).await;
            return Ok(ConnectionExit::Shutdown);
        }

        self.send_hello(&mut socket).await?;
        let registered = match self.wait_for_registered(&mut socket, &mut shutdown).await? {
            RegisteredResult::Registered(payload) => payload,
            RegisteredResult::Disconnected => return Ok(ConnectionExit::Disconnected),
            RegisteredResult::Shutdown => {
                close_socket(&mut socket).await;
                return Ok(ConnectionExit::Shutdown);
            }
            RegisteredResult::TokenRevoked { reason } => {
                return Ok(ConnectionExit::TokenRevoked { reason });
            }
        };

        let heartbeat_seconds = self.record_registered(&registered)?;
        retry_log_connected(self.agent_id.as_deref(), heartbeat_seconds);
        self.run_connected(&mut socket, &mut shutdown, heartbeat_seconds)
            .await
    }

    async fn send_hello(&self, socket: &mut AgentSocket) -> Result<(), AgentError> {
        let payload = AgentHelloPayload {
            agent_id: self.agent_id.clone(),
            agent_version: self.build_info.version.to_string(),
            hostname: self.hostname.clone(),
            os: self.build_info.os.to_string(),
            arch: self.build_info.arch.to_string(),
            workspace_root: self.config.workspace_root.to_string_lossy().into_owned(),
            current_task: None,
        };
        send_envelope(
            socket,
            MessageType::AgentHello,
            serde_json::to_value(payload)?,
        )
        .await
    }

    async fn send_heartbeat(
        &self,
        socket: &mut AgentSocket,
        agent_id: &str,
    ) -> Result<(), AgentError> {
        let payload = AgentHeartbeatPayload {
            agent_id: agent_id.to_string(),
            current_task_id: RequiredNullable(None),
        };
        send_envelope(
            socket,
            MessageType::AgentHeartbeat,
            serde_json::to_value(payload)?,
        )
        .await
    }

    async fn wait_for_registered(
        &self,
        socket: &mut AgentSocket,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<RegisteredResult, AgentError> {
        loop {
            let incoming = tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() || shutdown_requested(shutdown) {
                        return Ok(RegisteredResult::Shutdown);
                    }
                    continue;
                }
                incoming = read_message(socket) => incoming?,
            };

            let Some(message) = incoming else {
                return Ok(RegisteredResult::Disconnected);
            };
            match message {
                DecodedMessage::AgentRegistered(envelope) => {
                    return Ok(RegisteredResult::Registered(envelope.payload));
                }
                DecodedMessage::AgentTokenRevoked(envelope) => {
                    return Ok(RegisteredResult::TokenRevoked {
                        reason: envelope.payload.reason,
                    });
                }
                _ => {
                    return Err(AgentError::Protocol(
                        "expected agent.registered as the first Server message".to_string(),
                    ));
                }
            }
        }
    }

    fn record_registered(&mut self, payload: &AgentRegisteredPayload) -> Result<u64, AgentError> {
        if !valid_protocol_id(&payload.agent_id) {
            return Err(AgentError::Protocol(
                "Server returned an invalid agentId".to_string(),
            ));
        }
        if payload.heartbeat_interval_seconds == 0 || payload.heartbeat_timeout_seconds == 0 {
            return Err(AgentError::Protocol(
                "Server returned an invalid heartbeat interval".to_string(),
            ));
        }
        if let Some(existing) = &self.agent_id {
            if existing != &payload.agent_id {
                return Err(AgentError::Protocol(
                    "Server returned a different agentId than the local state".to_string(),
                ));
            }
        } else {
            save_state(&self.config.state_file, &payload.agent_id)?;
            self.agent_id = Some(payload.agent_id.clone());
        }
        Ok(payload.heartbeat_interval_seconds)
    }

    async fn run_connected(
        &self,
        socket: &mut AgentSocket,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat_seconds: u64,
    ) -> Result<ConnectionExit, AgentError> {
        let agent_id = self.agent_id.as_deref().ok_or_else(|| {
            AgentError::Protocol("agentId was not available after registration".to_string())
        })?;
        let mut heartbeat = time::interval(Duration::from_secs(heartbeat_seconds));
        heartbeat.tick().await;

        loop {
            let event = tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() || shutdown_requested(shutdown) {
                        close_socket(socket).await;
                        return Ok(ConnectionExit::Shutdown);
                    }
                    continue;
                }
                tick = heartbeat.tick() => tick,
                incoming = read_message(socket) => {
                    match incoming? {
                        Some(DecodedMessage::AgentTokenRevoked(envelope)) => {
                            if envelope.payload.agent_id != agent_id {
                                return Err(AgentError::Protocol(
                                    "token revocation message has a different agentId".to_string(),
                                ));
                            }
                            return Ok(ConnectionExit::TokenRevoked {
                                reason: envelope.payload.reason,
                            });
                        }
                        Some(DecodedMessage::AgentRegistered(_)) => {
                            debug!("received duplicate agent.registered message");
                            continue;
                        }
                        Some(_) => {
                            debug!("received a Server message outside T2.2 scope");
                            continue;
                        }
                        None => return Ok(ConnectionExit::Disconnected),
                    }
                }
            };
            let _ = event;
            self.send_heartbeat(socket, agent_id).await?;
        }
    }
}

fn retry_log_connected(agent_id: Option<&str>, heartbeat_seconds: u64) {
    info!(
        agent_id = ?agent_id,
        heartbeat_interval_seconds = heartbeat_seconds,
        "Agent WebSocket registered"
    );
}

async fn send_envelope(
    socket: &mut AgentSocket,
    message_type: MessageType,
    payload: Value,
) -> Result<(), AgentError> {
    let envelope = ProtocolEnvelope {
        id: Uuid::new_v4().to_string(),
        message_type,
        timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        protocol_version: ProtocolVersion::V1,
        payload,
    };
    let text = serde_json::to_string(&envelope)?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(map_websocket_error)
}

async fn read_message(socket: &mut AgentSocket) -> Result<Option<DecodedMessage>, AgentError> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let value = serde_json::from_str::<Value>(text.as_ref())
                    .map_err(|_| AgentError::Protocol("received invalid JSON".to_string()))?;
                let message = parse_message(value).map_err(|_| {
                    AgentError::Protocol("received invalid protocol message".to_string())
                })?;
                return Ok(Some(message));
            }
            Some(Ok(Message::Binary(bytes))) => {
                let value = serde_json::from_slice::<Value>(&bytes)
                    .map_err(|_| AgentError::Protocol("received invalid JSON".to_string()))?;
                let message = parse_message(value).map_err(|_| {
                    AgentError::Protocol("received invalid protocol message".to_string())
                })?;
                return Ok(Some(message));
            }
            Some(Ok(Message::Ping(payload))) => {
                socket
                    .send(Message::Pong(payload))
                    .await
                    .map_err(map_websocket_error)?;
            }
            Some(Ok(Message::Pong(_))) => {}
            Some(Ok(Message::Close(_))) | None => return Ok(None),
            Some(Ok(Message::Frame(_))) => {}
            Some(Err(error)) => return Err(map_websocket_error(error)),
        }
    }
}

async fn close_socket(socket: &mut AgentSocket) {
    let _ = socket.send(Message::Close(None)).await;
    let _ = time::timeout(Duration::from_secs(2), socket.next()).await;
}

fn map_websocket_error(error: TungsteniteError) -> AgentError {
    if let TungsteniteError::Http(response) = &error {
        if response.status().as_u16() == 401 {
            return AgentError::AuthenticationRejected;
        }
    }
    AgentError::WebSocket {
        message: error.to_string(),
    }
}

fn valid_protocol_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn load_state(path: &Path) -> Result<Option<String>, AgentError> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(AgentError::StateRead {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    let state = serde_json::from_str::<PersistedState>(&contents).map_err(|_| {
        AgentError::StateInvalid {
            path: path.to_path_buf(),
        }
    })?;
    if valid_protocol_id(&state.agent_id) {
        Ok(Some(state.agent_id))
    } else {
        Err(AgentError::StateInvalid {
            path: path.to_path_buf(),
        })
    }
}

fn save_state(path: &Path, agent_id: &str) -> Result<(), AgentError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| AgentError::StateWrite {
            path: path.to_path_buf(),
            source,
        })?;
    }
    let contents = serde_json::to_vec(&PersistedState {
        agent_id: agent_id.to_string(),
    })?;
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    fs::write(&temporary, contents).map_err(|source| AgentError::StateWrite {
        path: temporary.clone(),
        source,
    })?;
    if path.exists() {
        fs::remove_file(path).map_err(|source| AgentError::StateWrite {
            path: path.to_path_buf(),
            source,
        })?;
    }
    fs::rename(&temporary, path).map_err(|source| AgentError::StateWrite {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn shutdown_requested(shutdown: &watch::Receiver<bool>) -> bool {
    *shutdown.borrow()
}

async fn wait_for_retry(delay: Duration, shutdown: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        () = time::sleep(delay) => false,
        changed = shutdown.changed() => changed.is_err() || shutdown_requested(shutdown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };

    #[test]
    fn retry_backoff_is_bounded_and_resettable() {
        let mut retry = RetryState::new(Duration::from_millis(10), Duration::from_millis(25));
        assert_eq!(retry.next_delay(), Duration::from_millis(10));
        assert_eq!(retry.next_delay(), Duration::from_millis(20));
        assert_eq!(retry.next_delay(), Duration::from_millis(25));
        retry.reset();
        assert_eq!(retry.next_delay(), Duration::from_millis(10));
    }

    #[test]
    fn protocol_ids_are_restricted_to_wire_safe_characters() {
        assert!(valid_protocol_id("agent-01"));
        assert!(valid_protocol_id("A_b"));
        assert!(!valid_protocol_id(""));
        assert!(!valid_protocol_id("agent/01"));
        assert!(!valid_protocol_id(&"a".repeat(129)));
    }
    fn test_config(server_url: &str, state_file: std::path::PathBuf) -> AgentConfig {
        AgentConfig {
            server_url: url::Url::parse(server_url).expect("test server URL"),
            token: "bpa_test_token".to_string(),
            workspace_root: std::path::PathBuf::from("C:/build-agent-test"),
            log_level: "info".to_string(),
            state_file,
            reconnect_initial: Duration::from_millis(10),
            reconnect_max: Duration::from_millis(30),
        }
    }

    fn registered_message(agent_id: &str) -> Value {
        serde_json::json!({
            "id": "server-registered",
            "type": "agent.registered",
            "timestamp": "2026-08-24T03:00:00Z",
            "protocolVersion": 1,
            "payload": {
                "agentId": agent_id,
                "agentName": "Test Agent",
                "heartbeatIntervalSeconds": 1,
                "heartbeatTimeoutSeconds": 3,
                "serverTime": "2026-08-24T03:00:00Z"
            }
        })
    }

    async fn next_json(
        socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> Value {
        while let Some(message) = socket.next().await {
            match message.expect("server WebSocket message") {
                Message::Text(text) => {
                    return serde_json::from_str(text.as_ref()).expect("JSON message");
                }
                Message::Ping(payload) => {
                    socket
                        .send(Message::Pong(payload))
                        .await
                        .expect("Pong should be sent");
                }
                Message::Close(_) => panic!("Agent closed before sending expected message"),
                _ => {}
            }
        }
        panic!("Agent WebSocket ended before sending expected message");
    }

    #[tokio::test]
    async fn connects_with_header_sends_hello_and_heartbeat_and_persists_id() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let authorization = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let authorization_for_server = authorization.clone();
        let heartbeat_seen = tokio::sync::oneshot::channel::<()>();
        let heartbeat_sender = heartbeat_seen.0;
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("Agent TCP connection");
            let callback = move |request: &Request, response: Response| {
                let value = request
                    .headers()
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(str::to_owned);
                *authorization_for_server.lock().expect("authorization lock") = value;
                Ok(response)
            };
            let mut socket = accept_hdr_async(stream, callback)
                .await
                .expect("WebSocket handshake");
            let hello = next_json(&mut socket).await;
            assert_eq!(hello["type"], "agent.hello");
            assert_eq!(hello["payload"]["agentId"], Value::Null);
            assert_eq!(hello["payload"]["workspaceRoot"], "C:/build-agent-test");
            socket
                .send(Message::Text(
                    registered_message("agent-test").to_string().into(),
                ))
                .await
                .expect("registered message");
            let heartbeat = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let message = next_json(&mut socket).await;
                    if message["type"] == "agent.heartbeat" {
                        break message;
                    }
                }
            })
            .await
            .expect("heartbeat timeout");
            assert_eq!(heartbeat["payload"]["agentId"], "agent-test");
            assert_eq!(heartbeat["payload"]["currentTaskId"], Value::Null);
            heartbeat_sender.send(()).expect("heartbeat signal");
        });

        let directory = tempfile::tempdir().expect("temporary directory");
        let state_file = directory.path().join("state.json");
        let config = test_config(&format!("ws://{address}"), state_file.clone());
        let mut agent = Agent::from_config(config).expect("Agent should initialize");
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let run_task = tokio::spawn(async move { agent.run(shutdown_receiver).await });

        tokio::time::timeout(Duration::from_secs(5), heartbeat_seen.1)
            .await
            .expect("heartbeat signal timeout")
            .expect("heartbeat signal");
        shutdown_sender.send(true).expect("shutdown signal");
        let exit = tokio::time::timeout(Duration::from_secs(5), run_task)
            .await
            .expect("Agent shutdown timeout")
            .expect("Agent task")
            .expect("Agent run");
        assert_eq!(exit, RunExit::Shutdown);
        server_task.await.expect("server task");
        assert_eq!(
            authorization.lock().expect("authorization lock").as_deref(),
            Some("Bearer bpa_test_token")
        );
        let state: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(state_file).expect("state file"))
                .expect("state JSON");
        assert_eq!(state["agentId"], "agent-test");
    }

    #[tokio::test]
    async fn token_revocation_stops_without_reconnect() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("Agent TCP connection");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("WebSocket handshake");
            let hello = next_json(&mut socket).await;
            assert_eq!(hello["type"], "agent.hello");
            socket
                .send(Message::Text(
                    registered_message("agent-test").to_string().into(),
                ))
                .await
                .expect("registered message");
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "id": "server-revoked",
                        "type": "agent.token.revoked",
                        "timestamp": "2026-08-24T03:00:01Z",
                        "protocolVersion": 1,
                        "payload": {
                            "agentId": "agent-test",
                            "revokedAt": "2026-08-24T03:00:01Z",
                            "reason": "rotation"
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("revocation message");
        });

        let directory = tempfile::tempdir().expect("temporary directory");
        let config = test_config(
            &format!("ws://{address}"),
            directory.path().join("state.json"),
        );
        let mut agent = Agent::from_config(config).expect("Agent should initialize");
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);
        let exit = tokio::time::timeout(Duration::from_secs(5), agent.run(shutdown_receiver))
            .await
            .expect("revocation timeout")
            .expect("Agent run");
        assert_eq!(
            exit,
            RunExit::TokenRevoked {
                reason: Some("rotation".to_string())
            }
        );
        server_task.await.expect("server task");
    }
    #[tokio::test]
    async fn reconnects_after_disconnect_with_persisted_agent_id() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let second_registered = tokio::sync::oneshot::channel::<()>();
        let second_registered_sender = second_registered.0;
        let server_task = tokio::spawn(async move {
            for attempt in 0..2 {
                let (stream, _) = listener.accept().await.expect("Agent TCP connection");
                let mut socket = tokio_tungstenite::accept_async(stream)
                    .await
                    .expect("WebSocket handshake");
                let hello = next_json(&mut socket).await;
                if attempt == 0 {
                    assert_eq!(hello["payload"]["agentId"], Value::Null);
                } else {
                    assert_eq!(hello["payload"]["agentId"], "agent-test");
                }
                socket
                    .send(Message::Text(
                        registered_message("agent-test").to_string().into(),
                    ))
                    .await
                    .expect("registered message");
                if attempt == 0 {
                    socket.close(None).await.expect("close first connection");
                } else {
                    second_registered_sender
                        .send(())
                        .expect("second registration signal");
                    return;
                }
            }
        });

        let directory = tempfile::tempdir().expect("temporary directory");
        let state_file = directory.path().join("state.json");
        let config = test_config(&format!("ws://{address}"), state_file);
        let mut agent = Agent::from_config(config).expect("Agent should initialize");
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let run_task = tokio::spawn(async move { agent.run(shutdown_receiver).await });

        tokio::time::timeout(Duration::from_secs(5), second_registered.1)
            .await
            .expect("reconnect timeout")
            .expect("second registration signal");
        shutdown_sender.send(true).expect("shutdown signal");
        let exit = tokio::time::timeout(Duration::from_secs(5), run_task)
            .await
            .expect("Agent shutdown timeout")
            .expect("Agent task")
            .expect("Agent run");
        assert_eq!(exit, RunExit::Shutdown);
        server_task.await.expect("server task");
    }
}
