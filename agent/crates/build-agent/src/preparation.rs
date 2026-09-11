use std::time::Duration;

use crate::git::{GitClient, GitError};
use crate::workspace::{TaskWorkspace, WorkspaceError, WorkspaceManager};
use build_agent_contracts::TaskAssignmentPayload;
use thiserror::Error;
use tokio::sync::oneshot;

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

    fn git(error: GitError, workspace: Option<TaskWorkspace>) -> Self {
        Self {
            code: error.code(),
            message: safe_git_message(&error),
            canceled: false,
            workspace: workspace.map(Box::new),
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
            PreparationFailure::git(error, None)
        });
    }

    let workspace = workspace_manager
        .open_project(&assignment.project_id)
        .map_err(PreparationFailure::workspace)?;
    let timeout = Duration::from_secs(assignment.timeout_seconds.max(1));
    let mut clone_required = !workspace
        .cache_matches_url(&assignment.git.url)
        .map_err(PreparationFailure::workspace)?;
    if !clone_required {
        let repository = match cancel.as_mut() {
            Some(cancel) => {
                git.verify_repository_with_cancel(workspace.source_path(), timeout, cancel)
                    .await
            }
            None => {
                git.verify_repository(workspace.source_path(), timeout)
                    .await
            }
        };
        match repository {
            Ok(()) => {}
            Err(GitError::RepositoryInvalid) => clone_required = true,
            Err(GitError::Canceled) => return Err(PreparationFailure::canceled(Some(workspace))),
            Err(error) => return Err(PreparationFailure::git(error, Some(workspace))),
        }
    }
    if clone_required {
        workspace
            .rebuild_source()
            .map_err(PreparationFailure::workspace)?;
    }
    let result: Result<String, GitError> = async {
        if clone_required {
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
        } else {
            let update = match cancel.as_mut() {
                Some(cancel) => {
                    git.fetch_and_checkout_with_cancel(
                        workspace.source_path(),
                        &assignment.git.branch,
                        timeout,
                        cancel,
                    )
                    .await
                }
                None => {
                    git.fetch_and_checkout(workspace.source_path(), &assignment.git.branch, timeout)
                        .await
                }
            };
            update?;
        }
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
        Ok(source_commit) => {
            if clone_required {
                workspace
                    .record_url(&assignment.git.url)
                    .map_err(PreparationFailure::workspace)?;
            }
            Ok(PreparationResult {
                task_id: assignment.task_id,
                workspace,
                source_commit,
            })
        }
        Err(GitError::Canceled) => Err(PreparationFailure::canceled(Some(workspace))),
        Err(GitError::RepositoryInvalid) => {
            // A repository can become corrupt after the initial validity
            // check. Rebuild once under the held project lock.
            workspace
                .rebuild_source()
                .map_err(PreparationFailure::workspace)?;
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
            match clone {
                Ok(()) => {
                    let source_commit = match match cancel.as_mut() {
                        Some(cancel) => {
                            git.rev_parse_with_cancel(workspace.source_path(), timeout, cancel)
                                .await
                        }
                        None => git.rev_parse(workspace.source_path(), timeout).await,
                    } {
                        Ok(source_commit) => source_commit,
                        Err(GitError::Canceled) => {
                            return Err(PreparationFailure::canceled(Some(workspace)))
                        }
                        Err(error) => return Err(PreparationFailure::git(error, Some(workspace))),
                    };
                    workspace
                        .record_url(&assignment.git.url)
                        .map_err(PreparationFailure::workspace)?;
                    Ok(PreparationResult {
                        task_id: assignment.task_id,
                        workspace,
                        source_commit,
                    })
                }
                Err(GitError::Canceled) => Err(PreparationFailure::canceled(Some(workspace))),
                Err(error) => Err(PreparationFailure::git(error, Some(workspace))),
            }
        }
        Err(error) => Err(PreparationFailure::git(error, Some(workspace))),
    }
}

fn safe_workspace_message(error: &WorkspaceError) -> String {
    match error {
        WorkspaceError::Invalid => "workspace configuration is invalid".to_string(),
        WorkspaceError::NotWritable => "workspace is not writable".to_string(),
        WorkspaceError::PathEscape => "workspace path is outside the allowed task root".to_string(),
        WorkspaceError::AlreadyExists => "task workspace already exists".to_string(),
        WorkspaceError::CleanupRefused => "unsafe workspace cleanup was refused".to_string(),
        WorkspaceError::ProjectBusy => "project workspace is already in use".to_string(),
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
        GitError::RepositoryInvalid => "cached Git repository is invalid".to_string(),
        GitError::FetchFailed { .. } => "Git fetch failed".to_string(),
        GitError::CheckoutFailed { .. } => "Git checkout failed".to_string(),
        GitError::CleanFailed { .. } => "previous artifact cleanup failed".to_string(),
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

    fn git_output(directory: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(directory)
            .output()
            .expect("git should start");
        assert!(output.status.success(), "git command failed: {args:?}");
        String::from_utf8(output.stdout)
            .expect("git output should be UTF-8")
            .trim()
            .to_string()
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
            interactive_input_enabled: false,
        };
        let result = prepare_task(manager, GitClient::new(), assignment)
            .await
            .expect("preparation should succeed");
        assert_eq!(result.source_commit.len(), 40);
        assert!(result.workspace.source_path().join("file.txt").is_file());
        assert!(result.workspace.task_dir().is_dir());
    }

    #[tokio::test]
    async fn reuses_project_cache_fetches_new_commit_switches_branch_and_keeps_source() {
        let source = tempfile::tempdir().expect("source");
        git(source.path(), &["init"]);
        git(source.path(), &["config", "user.name", "Build Agent Test"]);
        git(
            source.path(),
            &["config", "user.email", "build-agent@example.test"],
        );
        fs::write(source.path().join("README.md"), "main-1").expect("main fixture");
        git(source.path(), &["add", "README.md"]);
        git(source.path(), &["commit", "-m", "main-1"]);
        git(source.path(), &["branch", "-M", "main"]);
        let main_first = git_output(source.path(), &["rev-parse", "HEAD"]);
        git(source.path(), &["checkout", "-b", "feature"]);
        fs::write(source.path().join("feature.txt"), "feature").expect("feature fixture");
        git(source.path(), &["add", "feature.txt"]);
        git(source.path(), &["commit", "-m", "feature"]);
        let feature_commit = git_output(source.path(), &["rev-parse", "HEAD"]);
        git(source.path(), &["checkout", "main"]);

        let bare = tempfile::tempdir().expect("bare repository");
        git(bare.path(), &["init", "--bare"]);
        let bare_url = bare.path().to_string_lossy().into_owned();
        git(source.path(), &["remote", "add", "origin", &bare_url]);
        git(source.path(), &["push", "origin", "main", "feature"]);

        let manager_root = tempfile::tempdir().expect("workspace root");
        let manager = WorkspaceManager::new(manager_root.path(), 0).expect("manager");
        let project_id = uuid::Uuid::new_v4().to_string();
        let assignment = |task_id: String, branch: &str, value: &str| TaskAssignmentPayload {
            task_id,
            lease_token: "lease-token-000001".to_string(),
            lease_expires_at: "2099-08-30T03:00:00Z".to_string(),
            agent_id: "agent-test".to_string(),
            project_id: project_id.clone(),
            build_template_id: uuid::Uuid::new_v4().to_string(),
            git: TaskGitSource {
                url: bare_url.clone(),
                branch: branch.to_string(),
            },
            command: "echo build".to_string(),
            artifact_dir: "dist".to_string(),
            timeout_seconds: 20,
            config: serde_json::json!({"value": value})
                .as_object()
                .expect("object config")
                .clone(),
            sensitive_config_keys: Vec::new(),
            interactive_input_enabled: false,
        };

        let first = prepare_task(
            manager.clone(),
            GitClient::new(),
            assignment(uuid::Uuid::new_v4().to_string(), "main", "old"),
        )
        .await
        .expect("first clone");
        assert_eq!(first.source_commit, main_first);
        let cached_source = first.workspace.source_path().to_path_buf();
        fs::write(cached_source.join("cache-marker"), "keep").expect("cache marker");
        crate::task_config::write_platform_config(
            &cached_source,
            &serde_json::json!({"value": "old"})
                .as_object()
                .expect("old config")
                .clone(),
        )
        .expect("old config");
        fs::create_dir_all(cached_source.join("dist")).expect("artifact directory");
        fs::write(cached_source.join("dist/old.txt"), "old artifact").expect("old artifact");
        drop(first);

        git(source.path(), &["checkout", "main"]);
        fs::write(source.path().join("README.md"), "main-2").expect("main update");
        git(source.path(), &["add", "README.md"]);
        git(source.path(), &["commit", "-m", "main-2"]);
        let main_second = git_output(source.path(), &["rev-parse", "HEAD"]);
        git(source.path(), &["push", "origin", "main"]);

        let second = prepare_task(
            manager.clone(),
            GitClient::new(),
            assignment(uuid::Uuid::new_v4().to_string(), "main", "new"),
        )
        .await
        .expect("fetch latest main");
        assert_eq!(second.source_commit, main_second);
        assert_ne!(second.source_commit, main_first);
        assert!(second
            .workspace
            .source_path()
            .join("cache-marker")
            .is_file());
        let new_config = serde_json::json!({"value": "new"})
            .as_object()
            .expect("new config")
            .clone();
        crate::task_config::write_platform_config(second.workspace.source_path(), &new_config)
            .expect("overwrite config");
        let config =
            fs::read_to_string(second.workspace.source_path().join("platform.config.json"))
                .expect("config file");
        assert!(config.contains("new"));
        assert!(!config.contains("old"));
        crate::artifacts::validate_artifact_directory(second.workspace.source_path(), "dist")
            .expect("artifact path");
        GitClient::new()
            .clean_artifact_directory(
                second.workspace.source_path(),
                "dist",
                Duration::from_secs(10),
            )
            .await
            .expect("targeted artifact cleanup");
        assert!(!second.workspace.source_path().join("dist/old.txt").exists());
        drop(second);

        let third = prepare_task(
            manager,
            GitClient::new(),
            assignment(uuid::Uuid::new_v4().to_string(), "feature", "branch"),
        )
        .await
        .expect("switch to feature branch");
        assert_eq!(third.source_commit, feature_commit);
        assert!(third.workspace.source_path().join("feature.txt").is_file());
        assert_eq!(
            third
                .workspace
                .task_dir()
                .file_name()
                .and_then(|name| name.to_str()),
            Some(project_id.as_str())
        );
    }
}
