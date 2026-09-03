//! T0.2 cross-language protocol DTOs. This crate has no networking or build execution.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

/// Must stay synchronized with `@anvilrun/contracts` WebSocket limits.
pub const MAX_AGENT_WS_MESSAGE_BYTES: usize = 1024 * 1024;

/// Protocol versions are deliberately closed: an unknown number is rejected by Serde.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub enum ProtocolVersion {
    V1 = 1,
}

impl TryFrom<u8> for ProtocolVersion {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::V1),
            other => Err(format!("unsupported protocol version: {other}")),
        }
    }
}

impl From<ProtocolVersion> for u8 {
    fn from(value: ProtocolVersion) -> Self {
        value as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentStatus {
    Online,
    Offline,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BuildTaskStatus {
    Created,
    WaitingAgent,
    Queued,
    Dispatched,
    Preparing,
    Running,
    Uploading,
    Succeeded,
    Failed,
    Canceling,
    Canceled,
    AgentLost,
}

impl BuildTaskStatus {
    pub fn is_agent_reportable(self) -> bool {
        matches!(self, Self::Preparing | Self::Running | Self::Uploading)
    }
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Canceled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageType {
    #[serde(rename = "agent.registered")]
    AgentRegistered,
    #[serde(rename = "task.available")]
    TaskAvailable,
    #[serde(rename = "task.log.ack")]
    TaskLogAck,
    #[serde(rename = "task.artifact-manifest-ack")]
    TaskArtifactManifestAck,
    #[serde(rename = "task.recovery")]
    TaskRecovery,
    #[serde(rename = "task.result.ack")]
    TaskResultAck,
    #[serde(rename = "task.assignment")]
    TaskAssignment,
    #[serde(rename = "task.cancel")]
    TaskCancel,
    #[serde(rename = "agent.token.revoked")]
    AgentTokenRevoked,
    #[serde(rename = "agent.hello")]
    AgentHello,
    #[serde(rename = "agent.heartbeat")]
    AgentHeartbeat,
    #[serde(rename = "task.claim")]
    TaskClaim,
    #[serde(rename = "task.accepted")]
    TaskAccepted,
    #[serde(rename = "task.status")]
    TaskStatus,
    #[serde(rename = "task.log")]
    TaskLog,
    #[serde(rename = "task.artifact-manifest")]
    TaskArtifactManifest,
    #[serde(rename = "task.completed")]
    TaskCompleted,
    #[serde(rename = "task.failed")]
    TaskFailed,
    #[serde(rename = "task.canceled")]
    TaskCanceled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolEnvelope {
    pub id: String,
    #[serde(rename = "type")]
    pub message_type: MessageType,
    pub timestamp: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: ProtocolVersion,
    pub payload: Value,
}

macro_rules! dto {
    ($name:ident { $( $(#[$meta:meta])* $field:ident : $ty:ty ),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $( $(#[$meta])* pub $field: $ty, )* }
    };
}

dto!(AgentRegisteredPayload {
    agent_id: String,
    agent_name: String,
    heartbeat_interval_seconds: u64,
    heartbeat_timeout_seconds: u64,
    server_time: String
});
dto!(TaskAvailablePayload {
    agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    queued_task_count: Option<u64>
});
dto!(TaskLogAckPayload {
    task_id: String,
    acknowledged_sequence: u64,
    persisted_offset: u64
});
dto!(TaskArtifactManifestAckPayload {
    task_id: String,
    accepted: bool,
    artifact_count: u64,
    artifact_bytes: u64
});
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskRecoveryAction {
    Resume,
    Cancel,
    Abandon,
}
dto!(TaskRecoveryPayload {
    task_id: String,
    action: TaskRecoveryAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<BuildTaskStatus>,
    acknowledged_log_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_deadline_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>
});
dto!(TaskResultAckPayload {
    task_id: String,
    status: BuildTaskStatus,
    acknowledged_at: String
});
dto!(TaskGitSource {
    url: String,
    branch: String
});
dto!(TaskAssignmentPayload {
    task_id: String, lease_token: String, lease_expires_at: String, agent_id: String,
    project_id: String, build_template_id: String, git: TaskGitSource, command: String,
    artifact_dir: String, timeout_seconds: u64, config: serde_json::Map<String, Value>,
    sensitive_config_keys: Vec<String>
});
dto!(TaskCancelPayload {
    task_id: String,
    lease_token: String,
    requested_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>
});
dto!(AgentTokenRevokedPayload {
    agent_id: String,
    revoked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>
});
dto!(AgentCurrentTask {
    task_id: String,
    lease_token: String,
    status: BuildTaskStatus,
    last_log_sequence: u64
});
dto!(AgentHelloPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    agent_version: String,
    hostname: String,
    os: String,
    arch: String,
    workspace_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_task: Option<AgentCurrentTask>
});
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RequiredNullable<T>(pub Option<T>);

impl<'de, T> Deserialize<'de> for RequiredNullable<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(Self(Option::<T>::deserialize(deserializer)?))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHeartbeatPayload {
    pub agent_id: String,
    pub current_task_id: RequiredNullable<String>,
}
dto!(TaskClaimPayload {
    agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>
});
dto!(TaskAcceptedPayload {
    task_id: String,
    lease_token: String,
    accepted_at: String
});
dto!(TaskStatusPayload {
    task_id: String,
    lease_token: String,
    status: BuildTaskStatus,
    occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_commit: Option<String>
});
dto!(TaskLogPayload {
    task_id: String,
    lease_token: String,
    sequence: u64,
    stream: LogStream,
    chunk: String,
    emitted_at: String
});
dto!(ArtifactManifestEntry {
    relative_path: String,
    size: u64,
    sha256: String
});
dto!(TaskArtifactManifestPayload {
    task_id: String, lease_token: String, artifact_dir: String, total_bytes: u64,
    files: Vec<ArtifactManifestEntry>
});
dto!(TaskCompletedPayload {
    task_id: String,
    lease_token: String,
    exit_code: i32,
    finished_at: String,
    artifact_count: u64,
    artifact_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_commit: Option<String>
});
dto!(TaskFailedPayload {
    task_id: String,
    lease_token: String,
    reason: String,
    failed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>
});
dto!(TaskCanceledPayload {
    task_id: String,
    lease_token: String,
    canceled_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>
});

#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolEnvelopeTyped<T> {
    pub id: String,
    pub message_type: MessageType,
    pub timestamp: String,
    pub protocol_version: ProtocolVersion,
    pub payload: T,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DecodedMessage {
    AgentRegistered(ProtocolEnvelopeTyped<AgentRegisteredPayload>),
    TaskAvailable(ProtocolEnvelopeTyped<TaskAvailablePayload>),
    TaskLogAck(ProtocolEnvelopeTyped<TaskLogAckPayload>),
    TaskArtifactManifestAck(ProtocolEnvelopeTyped<TaskArtifactManifestAckPayload>),
    TaskRecovery(ProtocolEnvelopeTyped<TaskRecoveryPayload>),
    TaskResultAck(ProtocolEnvelopeTyped<TaskResultAckPayload>),
    TaskAssignment(ProtocolEnvelopeTyped<TaskAssignmentPayload>),
    TaskCancel(ProtocolEnvelopeTyped<TaskCancelPayload>),
    AgentTokenRevoked(ProtocolEnvelopeTyped<AgentTokenRevokedPayload>),
    AgentHello(ProtocolEnvelopeTyped<AgentHelloPayload>),
    AgentHeartbeat(ProtocolEnvelopeTyped<AgentHeartbeatPayload>),
    TaskClaim(ProtocolEnvelopeTyped<TaskClaimPayload>),
    TaskAccepted(ProtocolEnvelopeTyped<TaskAcceptedPayload>),
    TaskStatus(ProtocolEnvelopeTyped<TaskStatusPayload>),
    TaskLog(ProtocolEnvelopeTyped<TaskLogPayload>),
    TaskArtifactManifest(ProtocolEnvelopeTyped<TaskArtifactManifestPayload>),
    TaskCompleted(ProtocolEnvelopeTyped<TaskCompletedPayload>),
    TaskFailed(ProtocolEnvelopeTyped<TaskFailedPayload>),
    TaskCanceled(ProtocolEnvelopeTyped<TaskCanceledPayload>),
}

fn payload<T: DeserializeOwned>(raw: &ProtocolEnvelope) -> Result<T, String> {
    serde_json::from_value(raw.payload.clone()).map_err(|error| error.to_string())
}

fn typed<T>(raw: ProtocolEnvelope, payload: T) -> ProtocolEnvelopeTyped<T> {
    ProtocolEnvelopeTyped {
        id: raw.id,
        message_type: raw.message_type,
        timestamp: raw.timestamp,
        protocol_version: raw.protocol_version,
        payload,
    }
}

fn valid_id(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(format!("{field} has invalid protocol id"));
    }
    Ok(())
}

fn valid_lease(value: &str) -> Result<(), String> {
    if value.len() < 16
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("leaseToken has invalid format".to_string());
    }
    Ok(())
}

fn valid_task(task_id: &str, lease_token: &str) -> Result<(), String> {
    valid_id(task_id, "taskId")?;
    valid_lease(lease_token)
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn decimal_digit(value: u8) -> Option<u32> {
    value.is_ascii_digit().then(|| (value - b'0') as u32)
}

fn valid_iso8601_utc(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return false;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return false;
    }

    let fraction_digits = if bytes.len() == 20 {
        if bytes[19] != b'Z' {
            return false;
        }
        0
    } else {
        if bytes[19] != b'.' || bytes[bytes.len() - 1] != b'Z' {
            return false;
        }
        let count = bytes.len() - 21;
        if !(1..=9).contains(&count) || !bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit) {
            return false;
        }
        count
    };
    let _ = fraction_digits;
    for index in [0usize, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !bytes[index].is_ascii_digit() {
            return false;
        }
    }

    let year = (decimal_digit(bytes[0]).unwrap_or(10) * 1000)
        + (decimal_digit(bytes[1]).unwrap_or(10) * 100)
        + (decimal_digit(bytes[2]).unwrap_or(10) * 10)
        + decimal_digit(bytes[3]).unwrap_or(10);
    let month =
        (decimal_digit(bytes[5]).unwrap_or(10) * 10) + decimal_digit(bytes[6]).unwrap_or(10);
    let day = (decimal_digit(bytes[8]).unwrap_or(10) * 10) + decimal_digit(bytes[9]).unwrap_or(10);
    let hour =
        (decimal_digit(bytes[11]).unwrap_or(10) * 10) + decimal_digit(bytes[12]).unwrap_or(10);
    let minute =
        (decimal_digit(bytes[14]).unwrap_or(10) * 10) + decimal_digit(bytes[15]).unwrap_or(10);
    let second =
        (decimal_digit(bytes[17]).unwrap_or(10) * 10) + decimal_digit(bytes[18]).unwrap_or(10);

    let leap_year = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 0,
    };

    days_in_month > 0
        && day >= 1
        && day <= days_in_month
        && hour <= 23
        && minute <= 59
        && second <= 59
}

fn valid_timestamp(value: &str, field: &str) -> Result<(), String> {
    if valid_iso8601_utc(value) {
        Ok(())
    } else {
        Err(format!("{field} must be ISO 8601 UTC"))
    }
}

fn valid_safe_non_negative(value: u64, field: &str) -> Result<(), String> {
    if value <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(format!("{field} exceeds JavaScript safe integer range"))
    }
}

fn git_url_has_forbidden_user_info(url: &str) -> bool {
    let Some(separator) = url.find("://") else {
        return false;
    };
    let scheme = &url[..separator];
    let authority_start = separator + 3;
    let authority_end = url[authority_start..]
        .find(['/', '?', '#'])
        .map_or(url.len(), |offset| authority_start + offset);
    let authority = &url[authority_start..authority_end];
    match authority.rfind('@') {
        Some(at) => {
            let user_info = &authority[..at];
            !(scheme.eq_ignore_ascii_case("ssh") && user_info == "git")
        }
        None => false,
    }
}

/// Parse a shared JSON message into a strongly typed DTO.
pub fn parse_message(value: Value) -> Result<DecodedMessage, String> {
    let raw: ProtocolEnvelope = serde_json::from_value(value).map_err(|error| error.to_string())?;
    valid_id(&raw.id, "id")?;
    valid_timestamp(&raw.timestamp, "timestamp")?;

    match raw.message_type {
        MessageType::AgentRegistered => {
            let value: AgentRegisteredPayload = payload(&raw)?;
            valid_timestamp(&value.server_time, "serverTime")?;
            Ok(DecodedMessage::AgentRegistered(typed(raw, value)))
        }
        MessageType::TaskAvailable => Ok(DecodedMessage::TaskAvailable(typed(
            raw.clone(),
            payload(&raw)?,
        ))),
        MessageType::TaskLogAck => {
            let value: TaskLogAckPayload = payload(&raw)?;
            valid_id(&value.task_id, "taskId")?;
            valid_safe_non_negative(value.acknowledged_sequence, "acknowledgedSequence")?;
            valid_safe_non_negative(value.persisted_offset, "persistedOffset")?;
            Ok(DecodedMessage::TaskLogAck(typed(raw, value)))
        }
        MessageType::TaskArtifactManifestAck => {
            let value: TaskArtifactManifestAckPayload = payload(&raw)?;
            valid_id(&value.task_id, "taskId")?;
            valid_safe_non_negative(value.artifact_count, "artifactCount")?;
            valid_safe_non_negative(value.artifact_bytes, "artifactBytes")?;
            Ok(DecodedMessage::TaskArtifactManifestAck(typed(raw, value)))
        }
        MessageType::TaskRecovery => {
            let value: TaskRecoveryPayload = payload(&raw)?;
            valid_id(&value.task_id, "taskId")?;
            valid_safe_non_negative(value.acknowledged_log_sequence, "acknowledgedLogSequence")?;
            if matches!(
                value.action,
                TaskRecoveryAction::Resume | TaskRecoveryAction::Cancel
            ) && value.status.is_none()
            {
                return Err("RESUME or CANCEL recovery requires status".to_string());
            }
            if value
                .status
                .is_some_and(|status| !status.is_agent_reportable())
            {
                return Err("task recovery status must be agent-reportable".to_string());
            }
            if let Some(deadline) = &value.recovery_deadline_at {
                valid_timestamp(deadline, "recoveryDeadlineAt")?;
            }
            Ok(DecodedMessage::TaskRecovery(typed(raw, value)))
        }
        MessageType::TaskResultAck => {
            let value: TaskResultAckPayload = payload(&raw)?;
            valid_id(&value.task_id, "taskId")?;
            if !value.status.is_terminal() {
                return Err("task.result.ack status must be terminal".to_string());
            }
            valid_timestamp(&value.acknowledged_at, "acknowledgedAt")?;
            Ok(DecodedMessage::TaskResultAck(typed(raw, value)))
        }
        MessageType::TaskAssignment => {
            let value: TaskAssignmentPayload = payload(&raw)?;
            valid_task(&value.task_id, &value.lease_token)?;
            valid_timestamp(&value.lease_expires_at, "leaseExpiresAt")?;
            if git_url_has_forbidden_user_info(&value.git.url) {
                return Err("Git credentials are forbidden".to_string());
            }
            Ok(DecodedMessage::TaskAssignment(typed(raw, value)))
        }
        MessageType::TaskCancel => {
            let value: TaskCancelPayload = payload(&raw)?;
            valid_task(&value.task_id, &value.lease_token)?;
            valid_timestamp(&value.requested_at, "requestedAt")?;
            Ok(DecodedMessage::TaskCancel(typed(raw, value)))
        }
        MessageType::AgentTokenRevoked => {
            let value: AgentTokenRevokedPayload = payload(&raw)?;
            valid_timestamp(&value.revoked_at, "revokedAt")?;
            Ok(DecodedMessage::AgentTokenRevoked(typed(raw, value)))
        }
        MessageType::AgentHello => Ok(DecodedMessage::AgentHello(typed(
            raw.clone(),
            payload(&raw)?,
        ))),
        MessageType::AgentHeartbeat => {
            if raw.payload.get("currentTaskId").is_none() {
                return Err("currentTaskId is required, but may be null".to_string());
            }
            Ok(DecodedMessage::AgentHeartbeat(typed(
                raw.clone(),
                payload(&raw)?,
            )))
        }
        MessageType::TaskClaim => Ok(DecodedMessage::TaskClaim(typed(
            raw.clone(),
            payload(&raw)?,
        ))),
        MessageType::TaskAccepted => {
            let value: TaskAcceptedPayload = payload(&raw)?;
            valid_task(&value.task_id, &value.lease_token)?;
            valid_timestamp(&value.accepted_at, "acceptedAt")?;
            Ok(DecodedMessage::TaskAccepted(typed(raw, value)))
        }
        MessageType::TaskStatus => {
            let value: TaskStatusPayload = payload(&raw)?;
            valid_task(&value.task_id, &value.lease_token)?;
            if !value.status.is_agent_reportable() {
                return Err("task.status state is not agent-reportable".to_string());
            }
            valid_timestamp(&value.occurred_at, "occurredAt")?;
            Ok(DecodedMessage::TaskStatus(typed(raw, value)))
        }
        MessageType::TaskLog => {
            let value: TaskLogPayload = payload(&raw)?;
            valid_task(&value.task_id, &value.lease_token)?;
            if value.sequence == 0 || value.chunk.len() > 64 * 1024 {
                return Err("task.log sequence or chunk is invalid".to_string());
            }
            valid_safe_non_negative(value.sequence, "sequence")?;
            valid_timestamp(&value.emitted_at, "emittedAt")?;
            Ok(DecodedMessage::TaskLog(typed(raw, value)))
        }
        MessageType::TaskArtifactManifest => {
            let value: TaskArtifactManifestPayload = payload(&raw)?;
            valid_task(&value.task_id, &value.lease_token)?;
            valid_safe_non_negative(value.total_bytes, "totalBytes")?;
            for file in &value.files {
                valid_safe_non_negative(file.size, "artifact file size")?;
            }
            Ok(DecodedMessage::TaskArtifactManifest(typed(raw, value)))
        }
        MessageType::TaskCompleted => {
            let value: TaskCompletedPayload = payload(&raw)?;
            valid_task(&value.task_id, &value.lease_token)?;
            valid_timestamp(&value.finished_at, "finishedAt")?;
            valid_safe_non_negative(value.artifact_count, "artifactCount")?;
            valid_safe_non_negative(value.artifact_bytes, "artifactBytes")?;
            Ok(DecodedMessage::TaskCompleted(typed(raw, value)))
        }
        MessageType::TaskFailed => {
            let value: TaskFailedPayload = payload(&raw)?;
            valid_task(&value.task_id, &value.lease_token)?;
            valid_timestamp(&value.failed_at, "failedAt")?;
            Ok(DecodedMessage::TaskFailed(typed(raw, value)))
        }
        MessageType::TaskCanceled => {
            let value: TaskCanceledPayload = payload(&raw)?;
            valid_task(&value.task_id, &value.lease_token)?;
            valid_timestamp(&value.canceled_at, "canceledAt")?;
            Ok(DecodedMessage::TaskCanceled(typed(raw, value)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = format!(
            "{}/../../../packages/contracts/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture should exist"))
            .expect("fixture should be JSON")
    }

    fn messages(name: &str) -> Vec<Value> {
        fixture(name)
            .as_array()
            .expect("fixture should be an array")
            .clone()
    }

    #[test]
    fn shared_server_messages_decode() {
        for message in messages("server-to-agent-messages.json") {
            parse_message(message).expect("server message should decode");
        }
    }

    #[test]
    fn shared_agent_messages_decode() {
        for message in messages("agent-to-server-messages.json") {
            parse_message(message).expect("agent message should decode");
        }
    }

    #[test]
    fn invalid_messages_and_versions_are_rejected() {
        for (index, message) in messages("invalid-messages.json").into_iter().enumerate() {
            assert!(
                parse_message(message).is_err(),
                "invalid fixture at index {index} should be rejected"
            );
        }
        let mut message = messages("agent-to-server-messages.json")[0].clone();
        message["protocolVersion"] = Value::from(99);
        assert!(parse_message(message).is_err());
    }

    #[test]
    fn rust_round_trip_keeps_wire_names() {
        let message = messages("agent-to-server-messages.json")[5].clone();
        let raw: ProtocolEnvelope = serde_json::from_value(message).expect("raw envelope");
        let serialized = serde_json::to_value(raw).expect("serialized envelope");
        assert_eq!(serialized["type"], "task.log");
        assert_eq!(serialized["protocolVersion"], 1);
        assert_eq!(serialized["payload"]["leaseToken"], "lease-token-000001");
    }

    #[test]
    fn optional_wire_fields_are_omitted_when_absent() {
        let status = TaskStatusPayload {
            task_id: "task-1".to_string(),
            lease_token: "lease-token-000001".to_string(),
            status: BuildTaskStatus::Preparing,
            occurred_at: "2026-08-25T00:00:00Z".to_string(),
            reason: None,
            source_commit: None,
        };
        let serialized = serde_json::to_value(status).expect("task status should serialize");
        assert!(serialized.get("reason").is_none());
        assert!(serialized.get("sourceCommit").is_none());

        let failed = TaskFailedPayload {
            task_id: "task-1".to_string(),
            lease_token: "lease-token-000001".to_string(),
            reason: "safe failure".to_string(),
            failed_at: "2026-08-25T00:00:00Z".to_string(),
            exit_code: None,
        };
        let serialized = serde_json::to_value(failed).expect("task failure should serialize");
        assert!(serialized.get("exitCode").is_none());
    }

    #[test]
    fn enum_names_match_typescript() {
        assert_eq!(
            serde_json::to_string(&AgentStatus::Online).unwrap(),
            "\"ONLINE\""
        );
        assert_eq!(
            serde_json::to_string(&BuildTaskStatus::AgentLost).unwrap(),
            "\"AGENT_LOST\""
        );
        assert_eq!(
            serde_json::to_string(&LogStream::Stderr).unwrap(),
            "\"stderr\""
        );
        assert!(serde_json::from_str::<BuildTaskStatus>("\"DONE\"").is_err());
        assert!(fixture("valid-form-schema.json").is_array());
    }

    #[test]
    fn websocket_message_limit_matches_typescript_contract() {
        assert_eq!(MAX_AGENT_WS_MESSAGE_BYTES, 1024 * 1024);
    }
}
