use std::time::Duration;

use build_agent_contracts::TaskAssignmentPayload;
use thiserror::Error;
use tokio::sync::oneshot;
use tracing::warn;

use crate::git::{GitClient, GitError};
use crate::workspace::{TaskWorkspace, WorkspaceError, WorkspaceManager};

#[derive(Debug, Error)]
#[error("{code}: {message}")]
pub struct PreparationFailure {
    pub code: &'static str,
    pub message: String,
    pub canceled: bool,
    pub workspace: Option<Box<TaskWorkspace>>,
}

#[derive(Debug)]
pub struct PreparationResult {
    pub task_id: String,
    pub workspace: TaskWorkspace,
    pub source_commit: String,
}

impl PreparationFailure {
    fn workspace(error: WorkspaceError) -> Self {
        Self {
            code: error.code(),
            message: safe_workspace_message(&error),
            canceled: false,
            workspace: None,
        }
    }

    fn git(error: GitError) -> Self {
        Self {
            code: error.code(),
            message: safe_git_message(&error),
            canceled: false,
            workspace: None,
        }
    }

    fn canceled(workspace: Option<TaskWorkspace>) -> Self {
        Self {
            code: "TASK_CANCELED",
            message: "task preparation was canceled".to_string(),
            canceled: true,
            workspace: workspace.map(Box::new),
        }
    }
}

#[allow(dead_code)]
pub async fn prepare_task(
    workspace_manager: WorkspaceManager,
    git: GitClient,
    assignment: TaskAssignmentPayload,
) -> Result<PreparationResult, PreparationFailure> {
    prepare_task_inner(workspace_manager, git, assignment, None).await
}

pub async fn prepare_task_with_cancel(
    workspace_manager: WorkspaceManager,
    git: GitClient,
    assignment: TaskAssignmentPayload,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<PreparationResult, PreparationFailure> {
    prepare_task_inner(workspace_manager, git, assignment, Some(cancel)).await
}

async fn prepare_task_inner(
    workspace_manager: WorkspaceManager,
    git: GitClient,
    assignment: TaskAssignmentPayload,
    mut cancel: Option<&mut oneshot::Receiver<()>>,
) -> Result<PreparationResult, PreparationFailure> {
    workspace_manager
        .preflight()
        .map_err(PreparationFailure::workspace)?;
    let availability = match cancel.as_mut() {
        Some(cancel) => git.check_available_with_cancel(cancel).await,
        None => git.check_available().await,
    };
    if let Err(error) = availability {
        return Err(if matches!(error, GitError::Canceled) {
            PreparationFailure::canceled(None)
        } else {
            PreparationFailure::git(error)
        });
    }

    let workspace = workspace_manager
        .create_task(&assignment.task_id)
        .map_err(PreparationFailure::workspace)?;
    let timeout = Duration::from_secs(assignment.timeout_seconds.max(1));
    let result: Result<String, GitError> = async {
        let clone = match cancel.as_mut() {
            Some(cancel) => {
                git.clone_repository_with_cancel(
                    &assignment.git.url,
                    &assignment.git.branch,
                    workspace.source_path(),
                    timeout,
                    cancel,
                )
                .await
            }
            None => {
                git.clone_repository(
                    &assignment.git.url,
                    &assignment.git.branch,
                    workspace.source_path(),
                    timeout,
                )
                .await
            }
        };
        clone?;
        let rev_parse = match cancel.as_mut() {
            Some(cancel) => {
                git.rev_parse_with_cancel(workspace.source_path(), timeout, cancel)
                    .await
            }
            None => git.rev_parse(workspace.source_path(), timeout).await,
        };
        let source_commit = rev_parse?;
        Ok::<String, GitError>(source_commit)
    }
    .await;

    match result {
        Ok(source_commit) => Ok(PreparationResult {
            task_id: assignment.task_id,
            workspace,
            source_commit,
        }),
        Err(GitError::Canceled) => Err(PreparationFailure::canceled(Some(workspace))),
        Err(error) => {
            if let Err(cleanup_error) = workspace.cleanup() {
                warn!(
                    error_code = cleanup_error.code(),
                    task_id = %assignment.task_id,
                    "task workspace cleanup was refused or failed"
                );
            }
            drop(workspace);
            Err(PreparationFailure::git(error))
        }
    }
}

fn safe_workspace_message(error: &WorkspaceError) -> String {
    match error {
        WorkspaceError::Invalid => "workspace configuration is invalid".to_string(),
        WorkspaceError::NotWritable => "workspace is not writable".to_string(),
        WorkspaceError::PathEscape => "workspace path is outside the allowed task root".to_string(),
        WorkspaceError::AlreadyExists => "task workspace already exists".to_string(),
        WorkspaceError::CleanupRefused => "unsafe workspace cleanup was refused".to_string(),
        WorkspaceError::InsufficientDiskSpace => {
            "minimum free disk space is not available".to_string()
        }
    }
}

fn safe_git_message(error: &GitError) -> String {
    match error {
        GitError::NotFound => "system Git was not found".to_string(),
        GitError::StartFailed => "system Git could not be started".to_string(),
        GitError::Unavailable => "system Git is unavailable".to_string(),
        GitError::CloneFailed { .. } => "Git clone failed".to_string(),
        GitError::BranchNotFound { .. } => "requested Git branch was not found".to_string(),
        GitError::AuthFailed { .. } => "Git authentication or permission failed".to_string(),
        GitError::Timeout => "Git operation timed out".to_string(),
        GitError::Canceled => "Git operation was canceled".to_string(),
        GitError::CommitInvalid => "Git returned an invalid commit SHA".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use build_agent_contracts::TaskGitSource;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git(directory: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(directory)
            .status()
            .expect("git should start");
        assert!(status.success(), "git command failed: {args:?}");
    }

    #[tokio::test]
    async fn preparation_keeps_workspace_after_success() {
        let source = tempfile::tempdir().expect("source");
        git(source.path(), &["init"]);
        git(source.path(), &["config", "user.name", "Build Agent Test"]);
        git(
            source.path(),
            &["config", "user.email", "build-agent@example.test"],
        );
        fs::write(source.path().join("file.txt"), "content").expect("file");
        git(source.path(), &["add", "file.txt"]);
        git(source.path(), &["commit", "-m", "fixture"]);
        let manager_root = tempfile::tempdir().expect("workspace root");
        let manager = WorkspaceManager::new(manager_root.path(), 0).expect("manager");
        let assignment = TaskAssignmentPayload {
            task_id: uuid::Uuid::new_v4().to_string(),
            lease_token: "lease-token-000001".to_string(),
            lease_expires_at: "2026-08-30T03:00:00Z".to_string(),
            agent_id: "agent-test".to_string(),
            project_id: uuid::Uuid::new_v4().to_string(),
            build_template_id: uuid::Uuid::new_v4().to_string(),
            git: TaskGitSource {
                url: source.path().to_string_lossy().into_owned(),
                branch: "master".to_string(),
            },
            command: "echo test".to_string(),
            artifact_dir: "dist".to_string(),
            timeout_seconds: 10,
            config: serde_json::Map::new(),
            sensitive_config_keys: Vec::new(),
        };
        let result = prepare_task(manager, GitClient::new(), assignment)
            .await
            .expect("preparation should succeed");
        assert_eq!(result.source_commit.len(), 40);
        assert!(result.workspace.source_path().join("file.txt").is_file());
        assert!(result.workspace.task_dir().is_dir());
    }
}
