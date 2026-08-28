use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use build_agent_contracts::{
    parse_message, AgentHeartbeatPayload, AgentHelloPayload, AgentRegisteredPayload,
    BuildTaskStatus, DecodedMessage, LogStream, MessageType, ProtocolEnvelope, ProtocolVersion,
    RequiredNullable, TaskAcceptedPayload, TaskAssignmentPayload, TaskClaimPayload,
    TaskFailedPayload, TaskLogAckPayload, TaskLogPayload, TaskStatusPayload,
};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
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

use crate::config::ConfigError;
use crate::execution::{start_command, ExecutionEvent, ExecutionResult};
use crate::git::GitClient;
use crate::log_buffer::{BufferedLogEntry, LogBuffer, LogBufferError};
use crate::preparation::{prepare_task, PreparationFailure, PreparationResult};
use crate::task_config::write_platform_config;
use crate::workspace::{WorkspaceError, WorkspaceManager};
use crate::{AgentBuildInfo, AgentConfig};

type AgentSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
const COMMAND_REPORT_RESERVE: Duration = Duration::from_secs(2);

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
    #[error("failed to encode protocol message: {0}")]
    Encode(#[from] serde_json::Error),
    #[error("Agent task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Git(#[from] crate::git::GitError),
    #[error(transparent)]
    Preparation(#[from] PreparationFailure),
    #[error(transparent)]
    LogBuffer(#[from] LogBufferError),
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

#[derive(Debug)]
struct ActiveTask {
    task_id: String,
    lease_token: String,
    lease_expires_at: String,
    source_commit: Option<String>,
    command: String,
    config: serde_json::Map<String, Value>,
    stdout_log_redactor: SensitiveLogRedactor,
    stderr_log_redactor: SensitiveLogRedactor,
    timeout_seconds: u64,
    next_log_sequence: u64,
    log_buffer: LogBuffer,
    workspace: Option<crate::workspace::TaskWorkspace>,
    preparation: Option<JoinHandle<()>>,
    execution: Option<JoinHandle<()>>,
}

#[derive(Debug)]
struct PendingLog {
    task_id: String,
    lease_token: String,
    log_buffer: LogBuffer,
}

type PreparationEventResult = Result<PreparationResult, PreparationFailure>;

#[derive(Debug)]
struct PreparationEvent {
    task_id: String,
    result: PreparationEventResult,
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
    workspace: Option<WorkspaceManager>,
    git: GitClient,
    pending_logs: HashMap<String, PendingLog>,
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
            workspace: None,
            git: GitClient::new(),
            pending_logs: HashMap::new(),
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
        let workspace = WorkspaceManager::new(
            &self.config.workspace_root,
            self.config.minimum_free_space_bytes,
        )?;
        workspace.preflight()?;
        let git = GitClient::new();
        git.check_available().await?;
        self.workspace = Some(workspace);
        self.git = git;

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
        info!(server_url = %url, agent_id = ?self.agent_id, "connecting Agent WebSocket");
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
                return Ok(ConnectionExit::TokenRevoked { reason })
            }
        };
        let heartbeat_seconds = self.record_registered(&registered)?;
        self.replay_pending_logs(&mut socket).await?;
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
        active: Option<&ActiveTask>,
    ) -> Result<(), AgentError> {
        let payload = AgentHeartbeatPayload {
            agent_id: agent_id.to_string(),
            current_task_id: RequiredNullable(active.map(|task| task.task_id.clone())),
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
                    return Ok(RegisteredResult::Registered(envelope.payload))
                }
                DecodedMessage::AgentTokenRevoked(envelope) => {
                    return Ok(RegisteredResult::TokenRevoked {
                        reason: envelope.payload.reason,
                    });
                }
                _ => {
                    return Err(AgentError::Protocol(
                        "expected agent.registered as the first Server message".to_string(),
                    ))
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
        &mut self,
        socket: &mut AgentSocket,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat_seconds: u64,
    ) -> Result<ConnectionExit, AgentError> {
        let (result_sender, mut result_receiver) = mpsc::unbounded_channel::<PreparationEvent>();
        let mut active: Option<ActiveTask> = None;
        let mut execution_receiver = None;
        let mut pending_logs = std::mem::take(&mut self.pending_logs);
        let result = self
            .run_connected_loop(
                socket,
                shutdown,
                heartbeat_seconds,
                &result_sender,
                &mut result_receiver,
                &mut active,
                &mut execution_receiver,
                &mut pending_logs,
            )
            .await;
        let pending =
            cancel_active_task(&mut active, &mut result_receiver, &mut execution_receiver).await;
        if matches!(&result, Ok(ConnectionExit::Disconnected) | Err(_)) {
            if let Some(pending) = pending {
                pending_logs.insert(pending.task_id.clone(), pending);
            }
        }
        self.pending_logs = pending_logs;
        drop(result_sender);
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_connected_loop(
        &self,
        socket: &mut AgentSocket,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat_seconds: u64,
        result_sender: &mpsc::UnboundedSender<PreparationEvent>,
        result_receiver: &mut mpsc::UnboundedReceiver<PreparationEvent>,
        active: &mut Option<ActiveTask>,
        execution_receiver: &mut Option<mpsc::Receiver<ExecutionEvent>>,
        pending_logs: &mut HashMap<String, PendingLog>,
    ) -> Result<ConnectionExit, AgentError> {
        let agent_id = self.agent_id.as_deref().ok_or_else(|| {
            AgentError::Protocol("agentId was not available after registration".to_string())
        })?;
        let mut heartbeat = time::interval(Duration::from_secs(heartbeat_seconds));
        heartbeat.tick().await;

        loop {
            tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() || shutdown_requested(shutdown) {
                        close_socket(socket).await;
                        return Ok(ConnectionExit::Shutdown);
                    }
                }
                _ = heartbeat.tick() => {
                    self.send_heartbeat(socket, agent_id, active.as_ref()).await?;
                }
                incoming = read_message(socket) => {
                    match incoming? {
                        Some(DecodedMessage::AgentTokenRevoked(envelope)) => {
                            if envelope.payload.agent_id != agent_id {
                                return Err(AgentError::Protocol("token revocation message has a different agentId".to_string()));
                            }
                            return Ok(ConnectionExit::TokenRevoked { reason: envelope.payload.reason });
                        }
                        Some(DecodedMessage::TaskLogAck(envelope)) => {
                            self.handle_log_ack(&envelope.payload, active, pending_logs).await?;
                        }
                        Some(DecodedMessage::TaskAvailable(envelope)) => {
                            let payload = envelope.payload;
                            if payload.agent_id != agent_id || active.is_some() {
                                continue;
                            }
                            self.send_claim(socket, agent_id).await?;
                        }
                        Some(DecodedMessage::TaskAssignment(envelope)) => {
                            self.handle_assignment(socket, active, result_sender, envelope.payload).await?;
                        }
                        Some(DecodedMessage::AgentRegistered(_)) => {
                            debug!("received duplicate agent.registered message");
                        }
                        Some(_) => {
                            debug!("received a Server message outside T4.2 scope");
                        }
                        None => return Ok(ConnectionExit::Disconnected),
                    }
                }
                Some(event) = result_receiver.recv(), if active.as_ref().is_some_and(|task| task.preparation.is_some()) => {
                    self.handle_preparation_event(socket, active, execution_receiver, event).await?;
                }
                event = receive_execution_event(execution_receiver), if execution_receiver.is_some() => {
                    self.handle_execution_event(socket, active, execution_receiver, event).await?;
                }
            }
        }
    }

    async fn send_claim(&self, socket: &mut AgentSocket, agent_id: &str) -> Result<(), AgentError> {
        let payload = TaskClaimPayload {
            agent_id: agent_id.to_string(),
            task_id: None,
        };
        send_envelope(
            socket,
            MessageType::TaskClaim,
            serde_json::to_value(payload)?,
        )
        .await
    }

    async fn handle_assignment(
        &self,
        socket: &mut AgentSocket,
        active: &mut Option<ActiveTask>,
        result_sender: &mpsc::UnboundedSender<PreparationEvent>,
        assignment: TaskAssignmentPayload,
    ) -> Result<(), AgentError> {
        let agent_id = self.agent_id.as_deref().ok_or_else(|| {
            AgentError::Protocol("agentId was not available after registration".to_string())
        })?;
        validate_assignment(agent_id, &assignment)?;

        if let Some(current) = active.as_ref() {
            if current.task_id == assignment.task_id
                && current.lease_token == assignment.lease_token
            {
                debug!(task_id = %assignment.task_id, "ignored duplicate task assignment");
            } else {
                warn!(task_id = %assignment.task_id, "ignored task assignment while Agent is busy");
            }
            return Ok(());
        }

        let task_id = assignment.task_id.clone();
        let lease_token = assignment.lease_token.clone();
        let log_buffer = LogBuffer::new(
            &self.config.workspace_root,
            &task_id,
            self.config.log_buffer_max_bytes,
        )?;
        *active = Some(ActiveTask {
            task_id: task_id.clone(),
            lease_token: lease_token.clone(),
            lease_expires_at: assignment.lease_expires_at.clone(),
            source_commit: None,
            command: assignment.command.clone(),
            config: assignment.config.clone(),
            stdout_log_redactor: SensitiveLogRedactor::new(
                &assignment.config,
                &assignment.sensitive_config_keys,
            ),
            stderr_log_redactor: SensitiveLogRedactor::new(
                &assignment.config,
                &assignment.sensitive_config_keys,
            ),
            timeout_seconds: assignment.timeout_seconds,
            next_log_sequence: 1,
            log_buffer,
            workspace: None,
            preparation: None,
            execution: None,
        });
        let accepted = TaskAcceptedPayload {
            task_id: task_id.clone(),
            lease_token,
            accepted_at: utc_now(),
        };
        if let Err(error) = send_envelope(
            socket,
            MessageType::TaskAccepted,
            serde_json::to_value(accepted)?,
        )
        .await
        {
            active.take();
            return Err(error);
        }

        let manager = self.workspace.clone().ok_or_else(|| {
            AgentError::Protocol("workspace was not initialized before assignment".to_string())
        })?;
        let git = self.git.clone();
        let result_sender = result_sender.clone();
        let event_task_id = task_id.clone();
        let handle = tokio::spawn(async move {
            let result = prepare_task(manager, git, assignment).await;
            let _ = result_sender.send(PreparationEvent {
                task_id: event_task_id,
                result,
            });
        });
        active
            .as_mut()
            .expect("active task was just initialized")
            .preparation = Some(handle);
        Ok(())
    }

    async fn handle_preparation_event(
        &self,
        socket: &mut AgentSocket,
        active: &mut Option<ActiveTask>,
        execution_receiver: &mut Option<mpsc::Receiver<ExecutionEvent>>,
        event: PreparationEvent,
    ) -> Result<(), AgentError> {
        let Some(current) = active.as_mut() else {
            return Ok(());
        };
        if current.task_id != event.task_id {
            return Ok(());
        }
        if let Some(handle) = current.preparation.take() {
            let _ = handle.await;
        }

        match event.result {
            Ok(result) => {
                if result.task_id != current.task_id {
                    return Err(AgentError::Protocol(
                        "preparation result taskId did not match active task".to_string(),
                    ));
                }
                if DateTime::parse_from_rfc3339(&current.lease_expires_at)
                    .map(|value| value.with_timezone(&Utc) <= Utc::now())
                    .unwrap_or(true)
                {
                    return self
                        .fail_active_task(
                            socket,
                            active,
                            "COMMAND_TIMEOUT: task lease expired before command start",
                            None,
                        )
                        .await;
                }

                current.source_commit = Some(result.source_commit.clone());
                current.workspace = Some(result.workspace);
                debug!(
                    task_id = %current.task_id,
                    source_commit = %result.source_commit,
                    "Git preparation completed"
                );
                let status = TaskStatusPayload {
                    task_id: current.task_id.clone(),
                    lease_token: current.lease_token.clone(),
                    status: BuildTaskStatus::Preparing,
                    occurred_at: utc_now(),
                    reason: None,
                    source_commit: Some(result.source_commit),
                };
                send_envelope(
                    socket,
                    MessageType::TaskStatus,
                    serde_json::to_value(status)?,
                )
                .await?;

                let source_path = current
                    .workspace
                    .as_ref()
                    .expect("workspace was just stored")
                    .source_path()
                    .to_path_buf();
                if let Err(error) = write_platform_config(&source_path, &current.config) {
                    return self
                        .fail_active_task(socket, active, &error.to_string(), None)
                        .await;
                }

                let lease_remaining = DateTime::parse_from_rfc3339(&current.lease_expires_at)
                    .ok()
                    .and_then(|value| (value.with_timezone(&Utc) - Utc::now()).to_std().ok());
                let Some(lease_remaining) = lease_remaining else {
                    return self
                        .fail_active_task(
                            socket,
                            active,
                            "COMMAND_TIMEOUT: task lease expired before command start",
                            None,
                        )
                        .await;
                };
                let command_budget = lease_remaining.saturating_sub(COMMAND_REPORT_RESERVE);
                if command_budget.is_zero() {
                    return self
                        .fail_active_task(
                            socket,
                            active,
                            "COMMAND_TIMEOUT: insufficient lease time for command and status reporting",
                            None,
                        )
                        .await;
                }
                let command_timeout =
                    Duration::from_secs(current.timeout_seconds).min(command_budget);
                let shell = if cfg!(windows) {
                    "cmd.exe /D /S /C"
                } else {
                    "/bin/sh -lc"
                };
                debug!(task_id = %current.task_id, shell, "Starting build command");
                let execution = match start_command(&current.command, &source_path, command_timeout)
                {
                    Ok(execution) => execution,
                    Err(error) => {
                        return self
                            .fail_active_task(socket, active, &error.to_string(), None)
                            .await;
                    }
                };
                *execution_receiver = Some(execution.receiver);
                current.execution = Some(execution.task);
                let running = TaskStatusPayload {
                    task_id: current.task_id.clone(),
                    lease_token: current.lease_token.clone(),
                    status: BuildTaskStatus::Running,
                    occurred_at: utc_now(),
                    reason: None,
                    source_commit: current.source_commit.clone(),
                };
                send_envelope(
                    socket,
                    MessageType::TaskStatus,
                    serde_json::to_value(running)?,
                )
                .await
            }
            Err(error) => {
                self.fail_active_task(
                    socket,
                    active,
                    &format!("{}: {}", error.code, error.message),
                    None,
                )
                .await
            }
        }
    }

    async fn handle_execution_event(
        &self,
        socket: &mut AgentSocket,
        active: &mut Option<ActiveTask>,
        execution_receiver: &mut Option<mpsc::Receiver<ExecutionEvent>>,
        event: ExecutionEvent,
    ) -> Result<(), AgentError> {
        match event {
            ExecutionEvent::Output { stream, chunk } => {
                let Some(current) = active.as_mut() else {
                    return Ok(());
                };
                let chunk = match stream {
                    LogStream::Stdout => current.stdout_log_redactor.redact(&chunk),
                    LogStream::Stderr => current.stderr_log_redactor.redact(&chunk),
                };
                if chunk.is_empty() {
                    return Ok(());
                }
                let sequence = current.next_log_sequence;
                let log = TaskLogPayload {
                    task_id: current.task_id.clone(),
                    lease_token: current.lease_token.clone(),
                    sequence,
                    stream,
                    chunk,
                    emitted_at: utc_now(),
                };
                self.persist_and_send_log(socket, current, log).await
            }
            ExecutionEvent::Finished(result) => {
                let pending_logs = if let Some(current) = active.as_mut() {
                    let mut pending_logs = Vec::new();
                    let stdout_tail = current.stdout_log_redactor.finish();
                    if !stdout_tail.is_empty() {
                        pending_logs.push((LogStream::Stdout, stdout_tail));
                    }
                    let stderr_tail = current.stderr_log_redactor.finish();
                    if !stderr_tail.is_empty() {
                        pending_logs.push((LogStream::Stderr, stderr_tail));
                    }
                    pending_logs
                } else {
                    Vec::new()
                };
                if let Some(current) = active.as_mut() {
                    if let Some(handle) = current.execution.take() {
                        let _ = handle.await;
                    }
                }
                execution_receiver.take();
                for (stream, chunk) in pending_logs {
                    if let Some(current) = active.as_mut() {
                        let sequence = current.next_log_sequence;
                        let log = TaskLogPayload {
                            task_id: current.task_id.clone(),
                            lease_token: current.lease_token.clone(),
                            sequence,
                            stream,
                            chunk,
                            emitted_at: utc_now(),
                        };
                        self.persist_and_send_log(socket, current, log).await?;
                    }
                }

                if result.output_failed {
                    return self
                        .fail_active_task(
                            socket,
                            active,
                            "COMMAND_OUTPUT_FAILED: command output could not be read",
                            None,
                        )
                        .await;
                }
                if result.timed_out {
                    return self
                        .fail_active_task(
                            socket,
                            active,
                            "COMMAND_TIMEOUT: build command timed out",
                            None,
                        )
                        .await;
                }
                match result.exit_code {
                    Some(0) => {
                        let Some(current) = active.as_ref() else {
                            return Ok(());
                        };
                        let uploading = TaskStatusPayload {
                            task_id: current.task_id.clone(),
                            lease_token: current.lease_token.clone(),
                            status: BuildTaskStatus::Uploading,
                            occurred_at: utc_now(),
                            reason: None,
                            source_commit: current.source_commit.clone(),
                        };
                        send_envelope(
                            socket,
                            MessageType::TaskStatus,
                            serde_json::to_value(uploading)?,
                        )
                        .await
                    }
                    Some(exit_code) => {
                        self.fail_active_task(
                            socket,
                            active,
                            "COMMAND_FAILED: build command exited with non-zero status",
                            Some(exit_code),
                        )
                        .await
                    }
                    None => {
                        self.fail_active_task(
                            socket,
                            active,
                            "COMMAND_FAILED: build command ended without a normal exit code",
                            None,
                        )
                        .await
                    }
                }
            }
        }
    }

    async fn fail_active_task(
        &self,
        socket: &mut AgentSocket,
        active: &mut Option<ActiveTask>,
        reason: &str,
        exit_code: Option<i32>,
    ) -> Result<(), AgentError> {
        let Some(current) = active.as_ref() else {
            return Ok(());
        };
        let failed = TaskFailedPayload {
            task_id: current.task_id.clone(),
            lease_token: current.lease_token.clone(),
            reason: reason.to_string(),
            failed_at: utc_now(),
            exit_code,
        };
        send_envelope(
            socket,
            MessageType::TaskFailed,
            serde_json::to_value(failed)?,
        )
        .await?;
        active.take();
        Ok(())
    }

    async fn persist_and_send_log(
        &self,
        socket: &mut AgentSocket,
        active: &mut ActiveTask,
        log: TaskLogPayload,
    ) -> Result<(), AgentError> {
        let entry = BufferedLogEntry {
            sequence: log.sequence,
            stream: log.stream,
            chunk: log.chunk.clone(),
            emitted_at: log.emitted_at.clone(),
        };
        if !append_log_and_advance(
            &mut active.log_buffer,
            &mut active.next_log_sequence,
            &entry,
        )? {
            warn!(
                task_id = %active.task_id,
                "task log buffer reached its configured limit; subsequent output is truncated"
            );
            return Ok(());
        }
        send_log_best_effort(socket, log).await?;
        Ok(())
    }

    async fn replay_pending_logs(&mut self, socket: &mut AgentSocket) -> Result<(), AgentError> {
        for pending in self.pending_logs.values_mut() {
            let acknowledged = pending.log_buffer.acknowledged_sequence();
            let mut reader = pending.log_buffer.pending_reader()?;
            while let Some(entry) = reader.next()? {
                if entry.sequence <= acknowledged {
                    continue;
                }
                let payload = TaskLogPayload {
                    task_id: pending.task_id.clone(),
                    lease_token: pending.lease_token.clone(),
                    sequence: entry.sequence,
                    stream: entry.stream,
                    chunk: entry.chunk,
                    emitted_at: entry.emitted_at,
                };
                send_envelope(socket, MessageType::TaskLog, serde_json::to_value(payload)?).await?;
            }
        }
        Ok(())
    }

    async fn handle_log_ack(
        &self,
        payload: &TaskLogAckPayload,
        active: &mut Option<ActiveTask>,
        pending_logs: &mut HashMap<String, PendingLog>,
    ) -> Result<(), AgentError> {
        if let Some(current) = active.as_mut() {
            if current.task_id == payload.task_id {
                current
                    .log_buffer
                    .acknowledge(payload.acknowledged_sequence)?;
                return Ok(());
            }
        }
        if let Some(pending) = pending_logs.get_mut(&payload.task_id) {
            pending
                .log_buffer
                .acknowledge(payload.acknowledged_sequence)?;
            if pending.log_buffer.is_empty() {
                pending_logs.remove(&payload.task_id);
            }
        }
        Ok(())
    }
}

fn append_log_and_advance(
    buffer: &mut LogBuffer,
    next_sequence: &mut u64,
    entry: &BufferedLogEntry,
) -> Result<bool, LogBufferError> {
    if entry.sequence != *next_sequence {
        return Err(LogBufferError::InvalidRecord);
    }
    let appended = buffer.append(entry)?;
    if appended {
        *next_sequence = (*next_sequence).saturating_add(1);
    }
    Ok(appended)
}

async fn send_log_best_effort(
    socket: &mut AgentSocket,
    log: TaskLogPayload,
) -> Result<(), AgentError> {
    let send = send_envelope(socket, MessageType::TaskLog, serde_json::to_value(log)?);
    match time::timeout(Duration::from_millis(100), send).await {
        Ok(result) => result,
        Err(_) => Ok(()),
    }
}
async fn receive_execution_event(
    receiver: &mut Option<mpsc::Receiver<ExecutionEvent>>,
) -> ExecutionEvent {
    match receiver.as_mut() {
        Some(receiver) => {
            receiver
                .recv()
                .await
                .unwrap_or(ExecutionEvent::Finished(ExecutionResult {
                    exit_code: None,
                    timed_out: false,
                    output_failed: true,
                }))
        }
        None => std::future::pending::<ExecutionEvent>().await,
    }
}

#[derive(Debug, Default)]
struct SensitiveLogRedactor {
    values: Vec<String>,
    pending: String,
}

impl SensitiveLogRedactor {
    fn new(config: &serde_json::Map<String, Value>, sensitive_config_keys: &[String]) -> Self {
        let mut values = Vec::new();
        for key in sensitive_config_keys {
            if let Some(value) = config.get(key) {
                collect_sensitive_representations(value, &mut values);
            }
        }
        values.retain(|value| !value.is_empty());
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        values.dedup();
        Self {
            values,
            pending: String::new(),
        }
    }

    fn redact(&mut self, chunk: &str) -> String {
        if self.values.is_empty() {
            return chunk.to_string();
        }

        let mut combined = std::mem::take(&mut self.pending);
        combined.push_str(chunk);
        let max_value_len = self
            .values
            .iter()
            .map(String::len)
            .max()
            .expect("redactor values are not empty");
        if combined.len() <= max_value_len {
            self.pending = combined;
            return String::new();
        }

        let mut split = combined.len() - max_value_len;
        while split > 0 && !combined.is_char_boundary(split) {
            split -= 1;
        }
        let safe_prefix = &combined[..split];
        let mut overlap = 0;
        for value in &self.values {
            for (prefix_len, _) in value.char_indices().skip(1) {
                if prefix_len < value.len()
                    && prefix_len <= safe_prefix.len()
                    && safe_prefix.ends_with(&value[..prefix_len])
                {
                    overlap = overlap.max(prefix_len);
                }
            }
        }
        let process_end = split - overlap;
        self.pending = combined[process_end..].to_string();
        redact_text(&combined[..process_end], &self.values)
    }

    fn finish(&mut self) -> String {
        redact_text(&std::mem::take(&mut self.pending), &self.values)
    }
}

#[cfg(test)]
fn redact_sensitive_output(
    chunk: &str,
    config: &serde_json::Map<String, Value>,
    sensitive_config_keys: &[String],
) -> String {
    let mut redactor = SensitiveLogRedactor::new(config, sensitive_config_keys);
    let mut redacted = redactor.redact(chunk);
    redacted.push_str(&redactor.finish());
    redacted
}

fn redact_text(text: &str, values: &[String]) -> String {
    let mut redacted = text.to_string();
    for value in values {
        redacted = redacted.replace(value, "[REDACTED]");
    }
    redacted
}

fn collect_sensitive_representations(value: &Value, representations: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            representations.push(text.clone());
            if let Ok(encoded) = serde_json::to_string(value) {
                representations.push(encoded);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_sensitive_representations(value, representations);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_sensitive_representations(value, representations);
            }
        }
        Value::Null => {}
        _ => {
            if let Ok(encoded) = serde_json::to_string(value) {
                representations.push(encoded);
            }
        }
    }
}

fn validate_assignment(
    agent_id: &str,
    assignment: &TaskAssignmentPayload,
) -> Result<(), AgentError> {
    if assignment.agent_id != agent_id
        || Uuid::parse_str(&assignment.task_id).is_err()
        || Uuid::parse_str(&assignment.project_id).is_err()
        || Uuid::parse_str(&assignment.build_template_id).is_err()
    {
        return Err(AgentError::Protocol(
            "task assignment contains an invalid identity".to_string(),
        ));
    }
    if !valid_lease_token(&assignment.lease_token) {
        return Err(AgentError::Protocol(
            "task assignment contains an invalid lease token".to_string(),
        ));
    }
    let expires_at = DateTime::parse_from_rfc3339(&assignment.lease_expires_at)
        .map_err(|_| AgentError::Protocol("task assignment lease expiry is invalid".to_string()))?
        .with_timezone(&Utc);
    if expires_at <= Utc::now() {
        return Err(AgentError::Protocol(
            "task assignment lease has expired".to_string(),
        ));
    }
    if assignment.timeout_seconds == 0
        || !safe_text(&assignment.git.url)
        || !safe_text(&assignment.git.branch)
        || !safe_text(&assignment.artifact_dir)
        || !safe_relative_path(&assignment.artifact_dir)
    {
        return Err(AgentError::Protocol(
            "task assignment contains invalid Git or workspace metadata".to_string(),
        ));
    }
    Ok(())
}

fn valid_lease_token(value: &str) -> bool {
    (16..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn safe_text(value: &str) -> bool {
    !value.is_empty() && !value.chars().any(char::is_control)
}

fn safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && !value.contains('\\')
        && path.components().all(|component| {
            matches!(component, std::path::Component::Normal(_)) && component.as_os_str() != ".."
        })
}
async fn cancel_active_task(
    active: &mut Option<ActiveTask>,
    result_receiver: &mut mpsc::UnboundedReceiver<PreparationEvent>,
    execution_receiver: &mut Option<mpsc::Receiver<ExecutionEvent>>,
) -> Option<PendingLog> {
    let mut pending = None;
    if let Some(mut task) = active.take() {
        if let Some(handle) = task.preparation.take() {
            handle.abort();
            let _ = handle.await;
        }
        if let Some(handle) = task.execution.take() {
            handle.abort();
            let _ = handle.await;
        }
        pending = Some(PendingLog {
            task_id: task.task_id,
            lease_token: task.lease_token,
            log_buffer: task.log_buffer,
        });
    }
    execution_receiver.take();
    while let Ok(event) = result_receiver.try_recv() {
        drop(event);
    }
    pending
}

fn utc_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
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
        timestamp: utc_now(),
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
            })
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
    fn protocol_and_assignment_paths_are_restricted() {
        assert!(valid_protocol_id("agent-01"));
        assert!(valid_lease_token("lease-token-000001"));
        assert!(safe_relative_path("dist/output"));
        assert!(!safe_relative_path("../outside"));
        assert!(!safe_relative_path("C:\\outside"));
        assert!(!valid_protocol_id(""));
        assert!(!valid_protocol_id("agent/01"));
        assert!(!valid_lease_token("short"));
        assert!(!valid_protocol_id(&"a".repeat(129)));
    }

    #[test]
    fn assignment_config_is_materialized_completely_and_sensitive_output_is_redacted() {
        let assignment = TaskAssignmentPayload {
            task_id: Uuid::new_v4().to_string(),
            lease_token: "lease-token-000001".to_string(),
            lease_expires_at: "2099-08-30T03:00:00Z".to_string(),
            agent_id: "agent-test".to_string(),
            project_id: Uuid::new_v4().to_string(),
            build_template_id: Uuid::new_v4().to_string(),
            git: build_agent_contracts::TaskGitSource {
                url: "https://example.test/repository.git".to_string(),
                branch: "main".to_string(),
            },
            command: "echo test".to_string(),
            artifact_dir: "dist".to_string(),
            timeout_seconds: 10,
            config: serde_json::json!({
                "safe": "value",
                "password": "secret-value"
            })
            .as_object()
            .expect("object config")
            .clone(),
            sensitive_config_keys: vec!["password".to_string()],
        };

        let materialized = assignment.config.clone();
        assert_eq!(
            materialized.get("safe"),
            Some(&Value::String("value".to_string()))
        );
        assert_eq!(
            materialized.get("password"),
            Some(&Value::String("secret-value".to_string()))
        );
        assert!(!serde_json::to_string(&materialized)
            .expect("materialized config")
            .contains("sensitiveConfigKeys"));

        let log = redact_sensitive_output(
            r#"{"safe":"value","password":"secret-value"}"#,
            &materialized,
            &assignment.sensitive_config_keys,
        );
        assert!(log.contains("value"));
        assert!(!log.contains("secret-value"));
        assert!(log.contains("[REDACTED]"));

        let mut redactor =
            SensitiveLogRedactor::new(&materialized, &assignment.sensitive_config_keys);
        let mut split_log = redactor.redact("prefix secret-");
        split_log.push_str(&redactor.redact("value suffix"));
        split_log.push_str(&redactor.finish());
        assert_eq!(split_log, "prefix [REDACTED] suffix");
    }

    #[test]
    fn full_log_buffer_does_not_consume_sequence_before_ack_releases_space() {
        let root = tempfile::tempdir().expect("workspace root");
        let task_id = Uuid::new_v4().to_string();
        let mut buffer = LogBuffer::new(root.path(), &task_id, 1024).expect("buffer");
        let mut next_sequence = 1;
        let first = BufferedLogEntry {
            sequence: next_sequence,
            stream: LogStream::Stdout,
            chunk: "x".repeat(700),
            emitted_at: "2026-08-24T03:00:00.000Z".to_string(),
        };
        assert!(
            append_log_and_advance(&mut buffer, &mut next_sequence, &first).expect("first append")
        );
        let dropped = BufferedLogEntry {
            sequence: next_sequence,
            stream: LogStream::Stdout,
            chunk: "y".repeat(700),
            emitted_at: "2026-08-24T03:00:01.000Z".to_string(),
        };
        assert!(
            !append_log_and_advance(&mut buffer, &mut next_sequence, &dropped)
                .expect("full buffer should be handled")
        );
        assert_eq!(next_sequence, 2);

        buffer.acknowledge(1).expect("acknowledgement");
        let next = BufferedLogEntry {
            sequence: next_sequence,
            stream: LogStream::Stdout,
            chunk: "next".to_string(),
            emitted_at: "2026-08-24T03:00:02.000Z".to_string(),
        };
        assert!(
            append_log_and_advance(&mut buffer, &mut next_sequence, &next)
                .expect("append after ack")
        );
        assert_eq!(next_sequence, 3);
        let mut reader = buffer.pending_reader().expect("pending reader");
        assert_eq!(reader.next().expect("next log").unwrap().sequence, 2);
        assert!(reader.next().expect("end of logs").is_none());
    }

    fn test_config(server_url: &str, state_file: PathBuf) -> AgentConfig {
        AgentConfig {
            server_url: url::Url::parse(server_url).expect("test server URL"),
            token: "bpa_test_token".to_string(),
            workspace_root: state_file.parent().expect("state parent").join("workspace"),
            log_level: "info".to_string(),
            minimum_free_space_bytes: 0,
            log_buffer_max_bytes: 1024 * 1024,
            state_file,
            reconnect_initial: Duration::from_millis(10),
            reconnect_max: Duration::from_millis(30),
        }
    }

    fn registered_message(agent_id: &str) -> Value {
        serde_json::json!({
            "id": "server-registered",
            "type": "agent.registered",
            "timestamp": "2026-08-24T03:00:00.000Z",
            "protocolVersion": 1,
            "payload": {
                "agentId": agent_id,
                "agentName": "Test Agent",
                "heartbeatIntervalSeconds": 1,
                "heartbeatTimeoutSeconds": 3,
                "serverTime": "2026-08-24T03:00:00.000Z"
            }
        })
    }

    async fn next_json(
        socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> Value {
        while let Some(message) = socket.next().await {
            match message.expect("server WebSocket message") {
                Message::Text(text) => {
                    return serde_json::from_str(text.as_ref()).expect("JSON message")
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
    async fn connects_with_auth_header_and_sends_heartbeat() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listener");
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
            socket
                .send(Message::Text(
                    registered_message("agent-test").to_string().into(),
                ))
                .await
                .expect("registered");
            loop {
                let message = next_json(&mut socket).await;
                if message["type"] == "agent.heartbeat" {
                    assert_eq!(message["payload"]["currentTaskId"], Value::Null);
                    heartbeat_sender.send(()).expect("heartbeat signal");
                    break;
                }
            }
        });
        let directory = tempfile::tempdir().expect("temporary directory");
        let state_file = directory.path().join("state.json");
        let config = test_config(&format!("ws://{address}"), state_file);
        let mut agent = Agent::from_config(config).expect("Agent should initialize");
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let run_task = tokio::spawn(async move { agent.run(shutdown_receiver).await });
        tokio::time::timeout(Duration::from_secs(5), heartbeat_seen.1)
            .await
            .expect("heartbeat timeout")
            .expect("heartbeat signal");
        shutdown_sender.send(true).expect("shutdown signal");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), run_task)
                .await
                .expect("shutdown timeout")
                .expect("Agent task")
                .expect("Agent run"),
            RunExit::Shutdown
        );
        server_task.await.expect("server task");
        assert_eq!(
            authorization.lock().expect("authorization lock").as_deref(),
            Some("Bearer bpa_test_token")
        );
    }
    #[tokio::test]
    async fn claims_assignment_prepares_git_and_reports_commit_with_busy_heartbeat() {
        let source = tempfile::tempdir().expect("source");
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(source.path())
                .status()
                .expect("git should start");
            assert!(status.success(), "git command failed: {args:?}");
        };
        git(&["init"]);
        git(&["config", "user.name", "Build Agent Test"]);
        git(&["config", "user.email", "build-agent@example.test"]);
        fs::write(source.path().join("README.md"), "fixture").expect("fixture file");
        git(&["add", "README.md"]);
        git(&["commit", "-m", "fixture"]);
        git(&["branch", "-M", "main"]);

        let task_id = Uuid::new_v4().to_string();
        let task_id_for_server = task_id.clone();
        let task_id_for_asserts = task_id.clone();
        let project_id = Uuid::new_v4().to_string();
        let template_id = Uuid::new_v4().to_string();
        let source_url = source.path().to_string_lossy().into_owned();
        let command_for_server = if cfg!(windows) {
            "type platform.config.json"
        } else {
            "cat platform.config.json"
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listener");
        let address = listener.local_addr().expect("listener address");
        let status_seen = tokio::sync::oneshot::channel::<String>();
        let status_sender = status_seen.0;
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("Agent TCP connection");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("handshake");
            let hello = next_json(&mut socket).await;
            assert_eq!(hello["type"], "agent.hello");
            socket
                .send(Message::Text(
                    registered_message("agent-test").to_string().into(),
                ))
                .await
                .expect("registered");
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "id": "server-available",
                        "type": "task.available",
                        "timestamp": "2026-08-24T03:00:00.000Z",
                        "protocolVersion": 1,
                        "payload": { "agentId": "agent-test", "queuedTaskCount": 1 }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("available");

            let claim = next_json(&mut socket).await;
            assert_eq!(claim["type"], "task.claim");
            assert_eq!(claim["payload"]["agentId"], "agent-test");
            assert_eq!(claim["payload"]["taskId"], Value::Null);
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "id": "server-assignment",
                        "type": "task.assignment",
                        "timestamp": "2026-08-24T03:00:00.100Z",
                        "protocolVersion": 1,
                        "payload": {
                            "taskId": task_id_for_server,
                            "leaseToken": "lease-token-000001",
                            "leaseExpiresAt": "2099-08-30T03:00:00.000Z",
                            "agentId": "agent-test",
                            "projectId": project_id,
                            "buildTemplateId": template_id,
                            "git": { "url": source_url, "branch": "main" },
                            "command": command_for_server,
                            "artifactDir": "dist",
                            "timeoutSeconds": 10,
                            "config": { "safe": "safe-value", "secret": "sensitive-value" },
                            "sensitiveConfigKeys": ["secret"]
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("assignment");

            let mut accepted = false;
            let mut preparing = false;
            let mut running = false;
            let mut output = String::new();
            let mut last_log_sequence = 0_u64;
            loop {
                let message = next_json(&mut socket).await;
                match message["type"].as_str() {
                    Some("task.accepted") => {
                        accepted = true;
                        assert_eq!(message["payload"]["taskId"], task_id_for_asserts);
                        assert_eq!(message["payload"]["leaseToken"], "lease-token-000001");
                    }
                    Some("agent.heartbeat") => {
                        if accepted {
                            assert_eq!(message["payload"]["currentTaskId"], task_id_for_asserts);
                        }
                    }
                    Some("task.status") => {
                        assert!(accepted);
                        assert_eq!(message["payload"]["taskId"], task_id_for_asserts);
                        match message["payload"]["status"].as_str() {
                            Some("PREPARING") => {
                                preparing = true;
                                let commit = message["payload"]["sourceCommit"]
                                    .as_str()
                                    .expect("commit SHA");
                                assert_eq!(commit.len(), 40);
                            }
                            Some("RUNNING") => {
                                assert!(preparing);
                                running = true;
                            }
                            Some("UPLOADING") => {
                                assert!(running);
                                assert!(output.contains("safe-value"));
                                assert!(!output.contains("sensitive-value"));
                                status_sender.send(output).expect("execution signal");
                                return;
                            }
                            status => panic!("unexpected task status: {status:?}"),
                        }
                    }
                    Some("task.log") => {
                        assert!(accepted);
                        let sequence = message["payload"]["sequence"]
                            .as_u64()
                            .expect("log sequence");
                        assert!(sequence > last_log_sequence);
                        last_log_sequence = sequence;
                        output.push_str(message["payload"]["chunk"].as_str().expect("log chunk"));
                    }
                    Some("task.failed") => panic!("unexpected task failure: {message:?}"),
                    _ => {}
                }
            }
        });

        let directory = tempfile::tempdir().expect("temporary directory");
        let config = test_config(
            &format!("ws://{address}"),
            directory.path().join("state.json"),
        );
        let mut agent = Agent::from_config(config).expect("Agent should initialize");
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let run_task = tokio::spawn(async move { agent.run(shutdown_receiver).await });
        let output = tokio::time::timeout(Duration::from_secs(10), status_seen.1)
            .await
            .expect("execution status timeout")
            .expect("execution signal");
        assert!(output.contains("safe-value"));
        assert!(!output.contains("sensitive-value"));
        let task_directory = directory
            .path()
            .join("workspace")
            .join("tasks")
            .join(&task_id);
        let config_contents =
            fs::read_to_string(task_directory.join("source").join("platform.config.json"))
                .expect("successful command should leave configuration available");
        assert!(config_contents.ends_with('\n'));
        assert!(config_contents.contains("safe-value"));
        assert!(config_contents.contains("sensitive-value"));
        assert!(!config_contents.contains("sensitiveConfigKeys"));
        let materialized: Value =
            serde_json::from_str(&config_contents).expect("materialized configuration JSON");
        assert_eq!(
            materialized,
            serde_json::json!({
                "safe": "safe-value",
                "secret": "sensitive-value"
            })
        );
        assert!(task_directory.is_dir());
        shutdown_sender.send(true).expect("shutdown signal");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), run_task)
                .await
                .expect("shutdown timeout")
                .expect("Agent task")
                .expect("Agent run"),
            RunExit::Shutdown
        );
        server_task.await.expect("server task");
        assert!(!directory
            .path()
            .join("workspace")
            .join("tasks")
            .join(&task_id)
            .exists());
    }

    #[tokio::test]
    async fn reports_preparation_failure_without_leaking_task_secrets_and_cleans_workspace() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let missing_source = directory.path().join("missing-source");
        let task_id = Uuid::new_v4().to_string();
        let task_id_for_server = task_id.clone();
        let project_id = Uuid::new_v4().to_string();
        let template_id = Uuid::new_v4().to_string();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listener");
        let address = listener.local_addr().expect("listener address");
        let failed_seen = tokio::sync::oneshot::channel::<String>();
        let failed_sender = failed_seen.0;
        let source_url = missing_source.to_string_lossy().into_owned();
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("Agent TCP connection");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("handshake");
            let _ = next_json(&mut socket).await;
            socket
                .send(Message::Text(
                    registered_message("agent-test").to_string().into(),
                ))
                .await
                .expect("registered");
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "id": "server-available",
                        "type": "task.available",
                        "timestamp": "2026-08-24T03:00:00.000Z",
                        "protocolVersion": 1,
                        "payload": { "agentId": "agent-test", "queuedTaskCount": 1 }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("available");
            let claim = next_json(&mut socket).await;
            assert_eq!(claim["type"], "task.claim");
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "id": "server-assignment",
                        "type": "task.assignment",
                        "timestamp": "2026-08-24T03:00:00.100Z",
                        "protocolVersion": 1,
                        "payload": {
                            "taskId": task_id_for_server,
                            "leaseToken": "lease-token-000001",
                            "leaseExpiresAt": "2099-08-30T03:00:00.000Z",
                            "agentId": "agent-test",
                            "projectId": project_id,
                            "buildTemplateId": template_id,
                            "git": { "url": source_url, "branch": "main" },
                            "command": "echo test",
                            "artifactDir": "dist",
                            "timeoutSeconds": 10,
                            "config": { "secret": "sensitive-value" },
                            "sensitiveConfigKeys": ["secret"]
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("assignment");
            loop {
                let message = next_json(&mut socket).await;
                if message["type"] == "task.failed" {
                    let reason = message["payload"]["reason"]
                        .as_str()
                        .expect("failure reason")
                        .to_string();
                    assert!(reason.starts_with("GIT_CLONE_FAILED:"));
                    assert!(!reason.contains("lease-token-000001"));
                    assert!(!reason.contains("sensitive-value"));
                    failed_sender.send(reason).expect("failure signal");
                    let _ = socket.send(Message::Close(None)).await;
                    return;
                }
            }
        });
        let config = test_config(
            &format!("ws://{address}"),
            directory.path().join("state.json"),
        );
        let mut agent = Agent::from_config(config).expect("Agent should initialize");
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let run_task = tokio::spawn(async move { agent.run(shutdown_receiver).await });
        let reason = tokio::time::timeout(Duration::from_secs(10), failed_seen.1)
            .await
            .expect("failure timeout")
            .expect("failure signal");
        assert!(reason.starts_with("GIT_CLONE_FAILED:"));
        shutdown_sender.send(true).expect("shutdown signal");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), run_task)
                .await
                .expect("shutdown timeout")
                .expect("Agent task")
                .expect("Agent run"),
            RunExit::Shutdown
        );
        server_task.await.expect("server task");
        assert!(!directory
            .path()
            .join("workspace")
            .join("tasks")
            .join(&task_id)
            .exists());
    }
    #[tokio::test]
    async fn token_revocation_stops_without_reconnect() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listener");
        let address = listener.local_addr().expect("listener address");
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("Agent TCP connection");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("handshake");
            let _ = next_json(&mut socket).await;
            socket
                .send(Message::Text(
                    registered_message("agent-test").to_string().into(),
                ))
                .await
                .expect("registered");
            socket.send(Message::Text(serde_json::json!({
                "id": "server-revoked",
                "type": "agent.token.revoked",
                "timestamp": "2026-08-24T03:00:01.000Z",
                "protocolVersion": 1,
                "payload": { "agentId": "agent-test", "revokedAt": "2026-08-24T03:00:01.000Z", "reason": "rotation" }
            }).to_string().into())).await.expect("revocation");
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
}
