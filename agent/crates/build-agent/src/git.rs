use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use command_group::AsyncCommandGroup;
#[cfg(unix)]
use command_group::{Signal, UnixChildExt};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::time;

const GIT_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DIAGNOSTIC_BYTES: usize = 512;
#[cfg(unix)]
const TERMINATION_GRACE_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Error)]
pub enum GitError {
    #[error("GIT_NOT_FOUND: system Git was not found")]
    NotFound,
    #[error("GIT_START_FAILED: system Git could not be started")]
    StartFailed,
    #[error("GIT_UNAVAILABLE: system Git is unavailable")]
    Unavailable,
    #[error("GIT_CLONE_FAILED: Git clone failed")]
    CloneFailed { diagnostic: String },
    #[error("GIT_BRANCH_NOT_FOUND: requested Git branch was not found")]
    BranchNotFound { diagnostic: String },
    #[error("GIT_AUTH_FAILED: Git authentication or permission failed")]
    AuthFailed { diagnostic: String },
    #[error("GIT_TIMEOUT: Git operation timed out")]
    Timeout,
    #[error("GIT_CANCELED: Git operation was canceled")]
    Canceled,
    #[error("GIT_COMMIT_INVALID: Git returned an invalid commit SHA")]
    CommitInvalid,
}

impl GitError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "GIT_NOT_FOUND",
            Self::StartFailed => "GIT_START_FAILED",
            Self::Unavailable => "GIT_UNAVAILABLE",
            Self::CloneFailed { .. } => "GIT_CLONE_FAILED",
            Self::BranchNotFound { .. } => "GIT_BRANCH_NOT_FOUND",
            Self::AuthFailed { .. } => "GIT_AUTH_FAILED",
            Self::Timeout => "GIT_TIMEOUT",
            Self::Canceled => "GIT_CANCELED",
            Self::CommitInvalid => "GIT_COMMIT_INVALID",
        }
    }

    pub fn diagnostic(&self) -> Option<&str> {
        match self {
            Self::CloneFailed { diagnostic }
            | Self::BranchNotFound { diagnostic }
            | Self::AuthFailed { diagnostic } => Some(diagnostic),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GitClient {
    executable: PathBuf,
}

#[derive(Debug)]
struct GitOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Default for GitClient {
    fn default() -> Self {
        Self::new()
    }
}

impl GitClient {
    pub fn new() -> Self {
        Self {
            executable: PathBuf::from("git"),
        }
    }

    #[cfg(test)]
    pub fn with_executable(executable: PathBuf) -> Self {
        Self { executable }
    }

    pub async fn check_available(&self) -> Result<(), GitError> {
        let output = self
            .run(&[OsString::from("--version")], None, GIT_PROBE_TIMEOUT)
            .await?;
        if !output.success {
            return Err(GitError::Unavailable);
        }
        let version = String::from_utf8_lossy(&output.stdout);
        if !version.trim_start().starts_with("git version ") {
            return Err(GitError::Unavailable);
        }
        Ok(())
    }

    pub async fn check_available_with_cancel(
        &self,
        cancel: &mut oneshot::Receiver<()>,
    ) -> Result<(), GitError> {
        let output = self
            .run_with_cancel(
                &[OsString::from("--version")],
                None,
                GIT_PROBE_TIMEOUT,
                cancel,
            )
            .await?;
        if !output.success {
            return Err(GitError::Unavailable);
        }
        let version = String::from_utf8_lossy(&output.stdout);
        if !version.trim_start().starts_with("git version ") {
            return Err(GitError::Unavailable);
        }
        Ok(())
    }

    pub async fn clone_repository(
        &self,
        url: &str,
        branch: &str,
        destination: &Path,
        timeout: Duration,
    ) -> Result<(), GitError> {
        let args = vec![
            OsString::from("clone"),
            OsString::from("--branch"),
            OsString::from(branch),
            OsString::from("--single-branch"),
            OsString::from("--"),
            OsString::from(url),
            process_path(destination).as_os_str().to_os_string(),
        ];
        let output = self.run(&args, None, timeout).await?;
        if output.success {
            return Ok(());
        }
        let diagnostic = sanitized_diagnostic(&output.stderr);

        let lower = diagnostic.to_ascii_lowercase();
        if (lower.contains("remote branch") && lower.contains("not found"))
            || lower.contains("couldn't find remote ref")
            || lower.contains("pathspec") && lower.contains("did not match")
        {
            return Err(GitError::BranchNotFound { diagnostic });
        }
        if lower.contains("authentication failed")
            || lower.contains("could not read username")
            || lower.contains("permission denied")
            || lower.contains("access denied")
            || lower.contains("403")
        {
            return Err(GitError::AuthFailed { diagnostic });
        }
        Err(GitError::CloneFailed { diagnostic })
    }

    pub async fn clone_repository_with_cancel(
        &self,
        url: &str,
        branch: &str,
        destination: &Path,
        timeout: Duration,
        cancel: &mut oneshot::Receiver<()>,
    ) -> Result<(), GitError> {
        let args = vec![
            OsString::from("clone"),
            OsString::from("--branch"),
            OsString::from(branch),
            OsString::from("--single-branch"),
            OsString::from("--"),
            OsString::from(url),
            process_path(destination).as_os_str().to_os_string(),
        ];
        let output = self.run_with_cancel(&args, None, timeout, cancel).await?;
        if output.success {
            return Ok(());
        }
        let diagnostic = sanitized_diagnostic(&output.stderr);

        let lower = diagnostic.to_ascii_lowercase();
        if (lower.contains("remote branch") && lower.contains("not found"))
            || lower.contains("couldn't find remote ref")
            || lower.contains("pathspec") && lower.contains("did not match")
        {
            return Err(GitError::BranchNotFound { diagnostic });
        }
        if lower.contains("authentication failed")
            || lower.contains("could not read username")
            || lower.contains("permission denied")
            || lower.contains("access denied")
            || lower.contains("403")
        {
            return Err(GitError::AuthFailed { diagnostic });
        }
        Err(GitError::CloneFailed { diagnostic })
    }

    pub async fn rev_parse(
        &self,
        source_path: &Path,
        timeout: Duration,
    ) -> Result<String, GitError> {
        let args = vec![
            OsString::from("-C"),
            process_path(source_path).as_os_str().to_os_string(),
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("HEAD"),
        ];
        let output = self.run(&args, None, timeout).await?;
        if !output.success {
            return Err(GitError::CommitInvalid);
        }
        let value = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_ascii_lowercase();
        if (value.len() == 40 || value.len() == 64)
            && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Ok(value);
        }
        Err(GitError::CommitInvalid)
    }

    pub async fn rev_parse_with_cancel(
        &self,
        source_path: &Path,
        timeout: Duration,
        cancel: &mut oneshot::Receiver<()>,
    ) -> Result<String, GitError> {
        let args = vec![
            OsString::from("-C"),
            process_path(source_path).as_os_str().to_os_string(),
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("HEAD"),
        ];
        let output = self.run_with_cancel(&args, None, timeout, cancel).await?;
        if !output.success {
            return Err(GitError::CommitInvalid);
        }
        let value = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_ascii_lowercase();
        if (value.len() == 40 || value.len() == 64)
            && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Ok(value);
        }
        Err(GitError::CommitInvalid)
    }

    async fn run(
        &self,
        args: &[OsString],
        current_dir: Option<&Path>,
        timeout: Duration,
    ) -> Result<GitOutput, GitError> {
        let mut command = Command::new(&self.executable);
        command
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(directory) = current_dir {
            command.current_dir(directory);
        }
        let mut group = command.group();
        group.kill_on_drop(true);
        let mut child = group.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GitError::NotFound
            } else {
                GitError::StartFailed
            }
        })?;
        let stdout = child.inner().stdout.take().ok_or(GitError::StartFailed)?;
        let stderr = child.inner().stderr.take().ok_or(GitError::StartFailed)?;
        let result = time::timeout(timeout, async {
            let wait = child.wait();
            let stdout = read_capped(stdout);
            let stderr = read_capped(stderr);
            let (status, stdout, stderr) = tokio::join!(wait, stdout, stderr);
            let status = status.map_err(|_| GitError::StartFailed)?;
            let stdout = stdout.map_err(|_| GitError::StartFailed)?;
            let stderr = stderr.map_err(|_| GitError::StartFailed)?;
            Ok::<GitOutput, GitError>(GitOutput {
                success: status.success(),
                stdout,
                stderr,
            })
        })
        .await;
        match result {
            Ok(output) => output,
            Err(_) => {
                terminate_process_group(&mut child).await;
                Err(GitError::Timeout)
            }
        }
    }

    async fn run_with_cancel(
        &self,
        args: &[OsString],
        current_dir: Option<&Path>,
        timeout: Duration,
        cancel: &mut oneshot::Receiver<()>,
    ) -> Result<GitOutput, GitError> {
        let mut command = Command::new(&self.executable);
        command
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(directory) = current_dir {
            command.current_dir(directory);
        }
        let mut group = command.group();
        group.kill_on_drop(true);
        let mut child = group.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GitError::NotFound
            } else {
                GitError::StartFailed
            }
        })?;
        let stdout = child.inner().stdout.take().ok_or(GitError::StartFailed)?;
        let stderr = child.inner().stderr.take().ok_or(GitError::StartFailed)?;
        let operation = async {
            let wait = child.wait();
            let stdout = read_capped(stdout);
            let stderr = read_capped(stderr);
            let (status, stdout, stderr) = tokio::join!(wait, stdout, stderr);
            let status = status.map_err(|_| GitError::StartFailed)?;
            let stdout = stdout.map_err(|_| GitError::StartFailed)?;
            let stderr = stderr.map_err(|_| GitError::StartFailed)?;
            Ok::<GitOutput, GitError>(GitOutput {
                success: status.success(),
                stdout,
                stderr,
            })
        };
        tokio::select! {
            result = time::timeout(timeout, operation) => match result {
                Ok(result) => result,
                Err(_) => {
                    terminate_process_group(&mut child).await;
                    Err(GitError::Timeout)
                }
            },
            _ = &mut *cancel => {
                terminate_process_group(&mut child).await;
                Err(GitError::Canceled)
            },
        }
    }
}

async fn terminate_process_group(child: &mut command_group::AsyncGroupChild) {
    #[cfg(unix)]
    {
        let _ = child.signal(Signal::SIGTERM);
        time::sleep(TERMINATION_GRACE_TIMEOUT).await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

async fn read_capped<R>(mut reader: R) -> Result<Vec<u8>, std::io::Error>
where
    R: AsyncRead + Unpin,
{
    let mut result = Vec::with_capacity(MAX_DIAGNOSTIC_BYTES);
    let mut buffer = [0_u8; 4096];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        if result.len() < MAX_DIAGNOSTIC_BYTES {
            let remaining = MAX_DIAGNOSTIC_BYTES - result.len();
            result.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
    Ok(result)
}

fn process_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
            return PathBuf::from(format!("\\\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix("\\\\?\\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}
pub fn sanitized_diagnostic(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_DIAGNOSTIC_BYTES)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn git(directory: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(directory)
            .status()
            .expect("git should start");
        assert!(status.success(), "git command failed: {args:?}");
    }

    #[tokio::test]
    async fn clones_local_fixture_with_argument_array_and_reads_commit_sha() {
        let source = tempfile::tempdir().expect("source directory");
        git(source.path(), &["init"]);
        git(source.path(), &["config", "user.name", "Build Agent Test"]);
        git(
            source.path(),
            &["config", "user.email", "build-agent@example.test"],
        );
        std::fs::write(source.path().join("README.md"), "fixture").expect("fixture file");
        git(source.path(), &["add", "README.md"]);
        git(source.path(), &["commit", "-m", "fixture"]);
        git(source.path(), &["branch", "-M", "main"]);
        git(source.path(), &["checkout", "-b", "feature/test"]);
        let bare = tempfile::tempdir().expect("bare directory");
        git(bare.path(), &["init", "--bare"]);
        let bare_url = bare.path().to_string_lossy().into_owned();
        git(source.path(), &["remote", "add", "origin", &bare_url]);
        git(source.path(), &["push", "origin", "main", "feature/test"]);

        let destination = tempfile::tempdir().expect("clone parent");
        let clone_path = destination.path().join("source");
        let client = GitClient::new();
        client.check_available().await.expect("system Git");
        client
            .clone_repository(
                &bare_url,
                "feature/test",
                &clone_path,
                Duration::from_secs(10),
            )
            .await
            .expect("clone fixture");
        let sha = client
            .rev_parse(&clone_path, Duration::from_secs(5))
            .await
            .expect("commit SHA");
        assert_eq!(sha.len(), 40);
        assert!(sha.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn missing_git_is_structured() {
        let client = GitClient::with_executable(PathBuf::from("definitely-missing-git"));
        assert!(matches!(
            client.check_available().await,
            Err(GitError::NotFound)
        ));
    }

    #[tokio::test]
    async fn cancellable_git_operation_terminates_without_waiting_for_process_exit() {
        let executable = if cfg!(windows) {
            PathBuf::from("ping.exe")
        } else {
            PathBuf::from("/bin/sleep")
        };
        let args = if cfg!(windows) {
            vec![
                OsString::from("127.0.0.1"),
                OsString::from("-n"),
                OsString::from("30"),
            ]
        } else {
            vec![OsString::from("30")]
        };
        let client = GitClient::with_executable(executable);
        let (cancel_sender, mut cancel_receiver) = oneshot::channel();
        let operation = tokio::spawn(async move {
            client
                .run_with_cancel(&args, None, Duration::from_secs(30), &mut cancel_receiver)
                .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel_sender.send(()).expect("cancel request");
        let result = tokio::time::timeout(Duration::from_secs(5), operation)
            .await
            .expect("Git cancellation should finish promptly")
            .expect("Git operation task");
        assert!(matches!(result, Err(GitError::Canceled)));
    }

    #[test]
    fn diagnostics_are_bounded_and_control_free() {
        let input = vec![b'x'; MAX_DIAGNOSTIC_BYTES + 100];
        let value = sanitized_diagnostic(&[input, b"\nsecret".to_vec()].concat());
        assert_eq!(value.len(), MAX_DIAGNOSTIC_BYTES);
        assert!(!value.chars().any(char::is_control));
    }

    #[test]
    fn invalid_commit_output_is_rejected_by_shape() {
        for value in ["", "abc", &"z".repeat(40), &"a".repeat(41)] {
            assert!(
                !((value.len() == 40 || value.len() == 64)
                    && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            );
        }
    }
}
