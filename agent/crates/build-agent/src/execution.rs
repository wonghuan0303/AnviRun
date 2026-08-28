//! Cross-platform execution of one administrator-provided build command.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use build_agent_contracts::LogStream;
use command_group::{AsyncCommandGroup, AsyncGroupChild};
#[cfg(unix)]
use command_group::{Signal, UnixChildExt};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time;

const OUTPUT_CHANNEL_CAPACITY: usize = 64;
const OUTPUT_CHUNK_BYTES: usize = 4 * 1024;
const DRAIN_GRACE_TIMEOUT: Duration = Duration::from_secs(1);
#[cfg(unix)]
const TERMINATION_GRACE_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Error)]
pub enum ExecutionError {
    #[error("SHELL_NOT_FOUND: configured command shell was not found")]
    ShellNotFound,
    #[error("COMMAND_START_FAILED: build command could not be started")]
    CommandStartFailed,
    #[error("COMMAND_OUTPUT_FAILED: build command output could not be read")]
    OutputFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionResult {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output_failed: bool,
}

#[derive(Debug)]
pub enum ExecutionEvent {
    Output { stream: LogStream, chunk: String },
    Finished(ExecutionResult),
}

#[derive(Debug)]
pub struct CommandExecution {
    pub receiver: mpsc::Receiver<ExecutionEvent>,
    pub task: JoinHandle<()>,
    pub cancel: Option<oneshot::Sender<()>>,
}

pub fn start_command(
    command: &str,
    source: &Path,
    timeout: Duration,
) -> Result<CommandExecution, ExecutionError> {
    let mut process = shell_command(command);
    process
        .current_dir(source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut group = process.group();
    group.kill_on_drop(true);
    let mut child = group.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ExecutionError::ShellNotFound
        } else {
            ExecutionError::CommandStartFailed
        }
    })?;
    let stdout = child
        .inner()
        .stdout
        .take()
        .ok_or(ExecutionError::OutputFailed)?;
    let stderr = child
        .inner()
        .stderr
        .take()
        .ok_or(ExecutionError::OutputFailed)?;
    let (sender, receiver) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
    let (cancel, cancel_requested) = oneshot::channel();
    let task = tokio::spawn(run_child(
        child,
        stdout,
        stderr,
        sender,
        timeout.max(Duration::from_millis(1)),
        cancel_requested,
    ));
    Ok(CommandExecution {
        receiver,
        task,
        cancel: Some(cancel),
    })
}

#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("cmd.exe");
    process.args(["/D", "/S", "/C", command]);
    process
}

#[cfg(unix)]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("/bin/sh");
    process.args(["-lc", command]);
    process
}

#[cfg(not(any(windows, unix)))]
fn shell_command(_command: &str) -> Command {
    Command::new("")
}

async fn run_child<R1, R2>(
    mut child: AsyncGroupChild,
    stdout: R1,
    stderr: R2,
    sender: mpsc::Sender<ExecutionEvent>,
    timeout: Duration,
    cancel_requested: oneshot::Receiver<()>,
) where
    R1: AsyncRead + Unpin + Send + 'static,
    R2: AsyncRead + Unpin + Send + 'static,
{
    let mut stdout_task = tokio::spawn(read_stream(stdout, LogStream::Stdout, sender.clone()));
    let mut stderr_task = tokio::spawn(read_stream(stderr, LogStream::Stderr, sender.clone()));
    tokio::pin!(cancel_requested);
    let timeout_sleep = time::sleep(timeout);
    tokio::pin!(timeout_sleep);

    enum ChildOutcome {
        Finished(std::io::Result<std::process::ExitStatus>),
        Canceled,
        TimedOut,
    }

    let outcome = tokio::select! {
        cancel = &mut cancel_requested => {
            if cancel.is_ok() {
                ChildOutcome::Canceled
            } else {
                ChildOutcome::Finished(child.wait().await)
            }
        }
        result = child.wait() => ChildOutcome::Finished(result),
        _ = &mut timeout_sleep => ChildOutcome::TimedOut,
    };
    let (exit_code, timed_out, output_failed) = match outcome {
        ChildOutcome::Finished(Ok(status)) => {
            let output_failed = drain_readers(&mut stdout_task, &mut stderr_task).await;
            (status.code(), false, output_failed)
        }
        ChildOutcome::Finished(Err(_)) => {
            let output_failed = drain_readers(&mut stdout_task, &mut stderr_task).await;
            (None, false, output_failed)
        }
        ChildOutcome::Canceled => {
            terminate_process_tree(&mut child).await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            (None, false, false)
        }
        ChildOutcome::TimedOut => {
            terminate_process_tree(&mut child).await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            (None, true, false)
        }
    };
    let _ = sender
        .send(ExecutionEvent::Finished(ExecutionResult {
            exit_code,
            timed_out,
            output_failed,
        }))
        .await;
}

async fn terminate_process_tree(child: &mut AsyncGroupChild) {
    #[cfg(unix)]
    {
        let _ = child.signal(Signal::SIGTERM);
        time::sleep(TERMINATION_GRACE_TIMEOUT).await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

async fn drain_readers(
    stdout_task: &mut JoinHandle<Result<(), ()>>,
    stderr_task: &mut JoinHandle<Result<(), ()>>,
) -> bool {
    let result = time::timeout(DRAIN_GRACE_TIMEOUT, async {
        tokio::join!((&mut *stdout_task), (&mut *stderr_task))
    })
    .await;

    match result {
        Ok((stdout, stderr)) => reader_failed(stdout) || reader_failed(stderr),
        Err(_) => {
            stdout_task.abort();
            stderr_task.abort();
            let stdout = (&mut *stdout_task).await;
            let stderr = (&mut *stderr_task).await;
            reader_io_failed(stdout) || reader_io_failed(stderr)
        }
    }
}

fn reader_failed(result: Result<Result<(), ()>, tokio::task::JoinError>) -> bool {
    !matches!(result, Ok(Ok(())))
}

fn reader_io_failed(result: Result<Result<(), ()>, tokio::task::JoinError>) -> bool {
    match result {
        Ok(Err(())) => true,
        Err(error) => !error.is_cancelled(),
        Ok(Ok(())) => false,
    }
}

async fn read_stream<R>(
    mut reader: R,
    stream: LogStream,
    sender: mpsc::Sender<ExecutionEvent>,
) -> Result<(), ()>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; OUTPUT_CHUNK_BYTES];
    loop {
        let count = reader.read(&mut buffer).await.map_err(|_| ())?;
        if count == 0 {
            return Ok(());
        }
        let chunk = String::from_utf8_lossy(&buffer[..count]).into_owned();
        sender
            .send(ExecutionEvent::Output { stream, chunk })
            .await
            .map_err(|_| ())?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Instant;

    async fn collect_until_finished(
        mut execution: CommandExecution,
    ) -> (Vec<(LogStream, String)>, ExecutionResult) {
        let mut output = Vec::new();
        let result = loop {
            match execution.receiver.recv().await.expect("execution event") {
                ExecutionEvent::Output { stream, chunk } => output.push((stream, chunk)),
                ExecutionEvent::Finished(result) => break result,
            }
        };
        execution.task.await.expect("execution task");
        (output, result)
    }

    #[tokio::test]
    async fn command_runs_in_source_and_reads_platform_config() {
        let directory = tempfile::tempdir().expect("source");
        fs::write(
            directory.path().join("platform.config.json"),
            "{\"answer\":42}\n",
        )
        .expect("configuration");
        let command = if cfg!(windows) {
            "type platform.config.json"
        } else {
            "while IFS= read -r line; do printf '%s\\n' \"$line\"; done < platform.config.json"
        };
        let execution =
            start_command(command, directory.path(), Duration::from_secs(5)).expect("start");
        let (output, result) = collect_until_finished(execution).await;
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(output
            .iter()
            .any(|(_, chunk)| chunk.contains("\"answer\":42")));
    }

    #[tokio::test]
    async fn stdout_and_stderr_are_chunked_and_non_utf8_is_tolerated() {
        let directory = tempfile::tempdir().expect("source");
        let command = if cfg!(windows) {
            "echo stdout & echo stderr 1>&2"
        } else {
            "printf 'stdout'; printf '\\377stderr' 1>&2"
        };
        let execution =
            start_command(command, directory.path(), Duration::from_secs(5)).expect("start");
        let (output, result) = collect_until_finished(execution).await;
        assert_eq!(result.exit_code, Some(0));
        assert!(output
            .iter()
            .any(|(stream, chunk)| { *stream == LogStream::Stdout && chunk.contains("stdout") }));
        assert!(output
            .iter()
            .any(|(stream, chunk)| { *stream == LogStream::Stderr && chunk.contains("stderr") }));
    }

    #[tokio::test]
    async fn non_zero_exit_and_timeout_are_reported_without_panicking() {
        let directory = tempfile::tempdir().expect("source");
        let failing_command = if cfg!(windows) { "exit /B 7" } else { "exit 7" };
        let execution = start_command(failing_command, directory.path(), Duration::from_secs(5))
            .expect("start");
        let (_, result) = collect_until_finished(execution).await;
        assert_eq!(result.exit_code, Some(7));
        assert!(!result.timed_out);

        let waiting_command = if cfg!(windows) {
            "ping 127.0.0.1 -n 4 >NUL"
        } else {
            "while :; do :; done"
        };
        let execution = start_command(waiting_command, directory.path(), Duration::from_millis(50))
            .expect("start");
        let (_, result) = collect_until_finished(execution).await;
        assert!(result.timed_out);
        assert_eq!(result.exit_code, None);
        assert!(!result.output_failed);
    }

    #[tokio::test]
    async fn explicit_cancellation_finishes_without_waiting_for_descendant_pipes() {
        let directory = tempfile::tempdir().expect("source");
        let command = if cfg!(windows) {
            r#"start "" /B cmd.exe /C "ping 127.0.0.1 -n 30 >NUL 2>NUL" & ping 127.0.0.1 -n 30 >NUL 2>NUL"#
        } else {
            "sleep 30 & wait"
        };
        let execution =
            start_command(command, directory.path(), Duration::from_secs(30)).expect("start");
        let mut execution = execution;
        execution
            .cancel
            .take()
            .expect("cancel channel")
            .send(())
            .expect("cancel request");
        let (_, result) =
            tokio::time::timeout(Duration::from_secs(5), collect_until_finished(execution))
                .await
                .expect("cancellation should finish promptly");
        assert!(!result.timed_out);
        assert!(!result.output_failed);
    }

    #[tokio::test]
    async fn timeout_aborts_readers_when_descendant_holds_pipes() {
        let directory = tempfile::tempdir().expect("source");
        let command = if cfg!(windows) {
            r#"start "" /B cmd.exe /C "ping 127.0.0.1 -n 10 >NUL 2>NUL" & ping 127.0.0.1 -n 10 >NUL 2>NUL"#
        } else {
            "sleep 2 & wait"
        };
        let started = Instant::now();
        let execution =
            start_command(command, directory.path(), Duration::from_millis(50)).expect("start");
        let (_, result) =
            tokio::time::timeout(Duration::from_secs(2), collect_until_finished(execution))
                .await
                .expect("timeout should not wait for descendant EOF");

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(result.timed_out);
        assert_eq!(result.exit_code, None);
        assert!(!result.output_failed);
    }

    fn process_tree_probe_command() -> &'static str {
        "(trap '' TERM; while :; do printf x >> probe.txt; sleep 0.02; done) & wait"
    }

    fn write_windows_process_tree_probe(directory: &std::path::Path) {
        if cfg!(windows) {
            fs::write(
                directory.join("probe-child.cmd"),
                r#"@echo off
:loop
echo x>>probe.txt
ping -n 2 127.0.0.1 >NUL
goto loop
"#,
            )
            .expect("probe child script");
            fs::write(
                directory.join("probe.cmd"),
                r#"@echo off
start "" /B cmd.exe /D /S /C call probe-child.cmd
ping -n 100 127.0.0.1 >NUL
"#,
            )
            .expect("probe script");
        }
    }

    async fn wait_for_probe(path: &std::path::Path) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if fs::metadata(path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("process tree probe did not start");
    }

    async fn assert_probe_stops(path: &std::path::Path) {
        let size = fs::metadata(path).expect("probe metadata").len();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(fs::metadata(path).expect("probe metadata").len(), size);
    }

    #[tokio::test]
    async fn cancellation_stops_parent_and_child_processes_without_killing_next_task() {
        let directory = tempfile::tempdir().expect("source");
        write_windows_process_tree_probe(directory.path());
        let probe = directory.path().join("probe.txt");
        let command = if cfg!(windows) {
            "probe.cmd"
        } else {
            process_tree_probe_command()
        };
        let execution =
            start_command(command, directory.path(), Duration::from_secs(30)).expect("start");
        wait_for_probe(&probe).await;
        let mut execution = execution;
        execution
            .cancel
            .take()
            .expect("cancel channel")
            .send(())
            .expect("cancel request");
        let (_, result) =
            tokio::time::timeout(Duration::from_secs(5), collect_until_finished(execution))
                .await
                .expect("cancellation should finish");
        assert!(!result.timed_out);
        assert!(!result.output_failed);
        assert_probe_stops(&probe).await;

        let next = start_command("echo next", directory.path(), Duration::from_secs(5))
            .expect("next task should start");
        let (output, result) = collect_until_finished(next).await;
        assert_eq!(result.exit_code, Some(0));
        assert!(output.iter().any(|(_, chunk)| chunk.contains("next")));
        assert_probe_stops(&probe).await;
    }

    #[tokio::test]
    async fn timeout_stops_parent_and_child_processes() {
        let directory = tempfile::tempdir().expect("source");
        write_windows_process_tree_probe(directory.path());
        let probe = directory.path().join("probe.txt");
        let command = if cfg!(windows) {
            "probe.cmd"
        } else {
            process_tree_probe_command()
        };
        let execution =
            start_command(command, directory.path(), Duration::from_millis(500)).expect("start");
        wait_for_probe(&probe).await;
        let (_, result) =
            tokio::time::timeout(Duration::from_secs(5), collect_until_finished(execution))
                .await
                .expect("timeout should finish");
        assert!(result.timed_out);
        assert!(!result.output_failed);
        assert_probe_stops(&probe).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn normal_exit_has_a_bounded_drain_when_descendant_holds_pipes() {
        let directory = tempfile::tempdir().expect("source");
        let command = "sleep 10 & exit 0";
        let execution =
            start_command(command, directory.path(), Duration::from_secs(5)).expect("start");
        let (_, result) = tokio::time::timeout(
            DRAIN_GRACE_TIMEOUT + Duration::from_secs(3),
            collect_until_finished(execution),
        )
        .await
        .expect("normal exit should have bounded pipe draining");

        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(!result.output_failed);
    }

    #[tokio::test]
    async fn output_backpressure_does_not_stop_either_pipe_reader() {
        let directory = tempfile::tempdir().expect("source");
        let line = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(16);
        let command = if cfg!(windows) {
            format!(
                "(for /L %i in (1,1,512) do @echo {line}) & (for /L %i in (1,1,512) do @echo {line} 1>&2)"
            )
        } else {
            format!(
                "i=0; while [ $i -lt 512 ]; do printf '%s\\n' '{line}'; printf '%s\\n' '{line}' >&2; i=$((i+1)); done"
            )
        };
        let execution =
            start_command(&command, directory.path(), Duration::from_secs(30)).expect("start");
        let mut receiver = execution.receiver;
        let mut output_bytes = 0_usize;
        let mut saw_stdout = false;
        let mut saw_stderr = false;
        let result = tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                match receiver.recv().await.expect("execution event") {
                    ExecutionEvent::Output { stream, chunk } => {
                        output_bytes += chunk.len();
                        saw_stdout |= stream == LogStream::Stdout;
                        saw_stderr |= stream == LogStream::Stderr;
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    ExecutionEvent::Finished(result) => break result,
                }
            }
        })
        .await
        .expect("slow consumer should not deadlock the bounded channel");
        execution.task.await.expect("execution task");

        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(!result.output_failed);
        assert!(saw_stdout);
        assert!(saw_stderr);
        assert!(output_bytes > OUTPUT_CHANNEL_CAPACITY * OUTPUT_CHUNK_BYTES);
    }
}
