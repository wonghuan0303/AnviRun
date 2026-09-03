use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use fs2::{available_space, FileExt};
use safe_write::safe_write;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("WORKSPACE_INVALID: workspace configuration is invalid")]
    Invalid,
    #[error("WORKSPACE_NOT_WRITABLE: workspace is not writable")]
    NotWritable,
    #[error("WORKSPACE_PATH_ESCAPE: workspace path escapes its allowed root")]
    PathEscape,
    #[error("WORKSPACE_ALREADY_EXISTS: task workspace already exists")]
    AlreadyExists,
    #[error("WORKSPACE_CLEANUP_REFUSED: unsafe workspace cleanup was refused")]
    CleanupRefused,
    #[error("WORKSPACE_PROJECT_BUSY: project workspace is already in use")]
    ProjectBusy,
    #[error("INSUFFICIENT_DISK_SPACE: minimum free disk space is not available")]
    InsufficientDiskSpace,
}

impl WorkspaceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid => "WORKSPACE_INVALID",
            Self::NotWritable => "WORKSPACE_NOT_WRITABLE",
            Self::PathEscape => "WORKSPACE_PATH_ESCAPE",
            Self::AlreadyExists => "WORKSPACE_ALREADY_EXISTS",
            Self::CleanupRefused => "WORKSPACE_CLEANUP_REFUSED",
            Self::ProjectBusy => "WORKSPACE_PROJECT_BUSY",
            Self::InsufficientDiskSpace => "INSUFFICIENT_DISK_SPACE",
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceManager {
    root: PathBuf,
    tasks_root: PathBuf,
    projects_root: PathBuf,
    minimum_free_space_bytes: u64,
}

#[derive(Debug)]
pub struct TaskWorkspace {
    task_id: String,
    tasks_root: PathBuf,
    task_dir: PathBuf,
    source_path: PathBuf,
    active_lock: Mutex<Option<File>>,
}

pub type ProjectWorkspace = TaskWorkspace;

const ACTIVE_LOCK_FILE: &str = ".build-agent-active.lock";

impl WorkspaceManager {
    pub fn new(root: &Path, minimum_free_space_bytes: u64) -> Result<Self, WorkspaceError> {
        if root.as_os_str().is_empty() {
            return Err(WorkspaceError::Invalid);
        }
        fs::create_dir_all(root).map_err(|_| WorkspaceError::NotWritable)?;
        let root = fs::canonicalize(root).map_err(|_| WorkspaceError::Invalid)?;
        if is_filesystem_root(&root) || has_reparse_point(&root) {
            return Err(WorkspaceError::Invalid);
        }

        let tasks_path = root.join("tasks");
        if let Ok(metadata) = fs::symlink_metadata(&tasks_path) {
            if has_reparse_metadata(&metadata) || !metadata.is_dir() {
                return Err(WorkspaceError::PathEscape);
            }
        } else {
            fs::create_dir(&tasks_path).map_err(|_| WorkspaceError::NotWritable)?;
        }
        let tasks_root = fs::canonicalize(&tasks_path).map_err(|_| WorkspaceError::PathEscape)?;
        if !is_within(&root, &tasks_root)
            || tasks_root == root
            || contains_reparse_point(&root, &tasks_root)
        {
            return Err(WorkspaceError::PathEscape);
        }
        let projects_path = root.join("projects");
        if let Ok(metadata) = fs::symlink_metadata(&projects_path) {
            if has_reparse_metadata(&metadata) || !metadata.is_dir() {
                return Err(WorkspaceError::PathEscape);
            }
        } else {
            fs::create_dir(&projects_path).map_err(|_| WorkspaceError::NotWritable)?;
        }
        let projects_root =
            fs::canonicalize(&projects_path).map_err(|_| WorkspaceError::PathEscape)?;
        if !is_within(&root, &projects_root)
            || projects_root == root
            || contains_reparse_point(&root, &projects_root)
        {
            return Err(WorkspaceError::PathEscape);
        }
        let manager = Self {
            root,
            tasks_root,
            projects_root,
            minimum_free_space_bytes,
        };
        manager.check_writable()?;
        manager.check_disk_space()?;
        manager.cleanup_stale_task_workspaces()?;
        Ok(manager)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn tasks_root(&self) -> &Path {
        &self.tasks_root
    }

    pub fn projects_root(&self) -> &Path {
        &self.projects_root
    }

    pub fn minimum_free_space_bytes(&self) -> u64 {
        self.minimum_free_space_bytes
    }

    pub fn preflight(&self) -> Result<(), WorkspaceError> {
        self.check_writable()?;
        self.check_disk_space()
    }

    /// Open a persistent project checkout and hold its exclusive lock until
    /// the build reaches its terminal-result acknowledgement.
    pub fn open_project(&self, project_id: &str) -> Result<TaskWorkspace, WorkspaceError> {
        self.preflight()?;
        let canonical_id = Uuid::parse_str(project_id)
            .map_err(|_| WorkspaceError::Invalid)?
            .to_string();
        let project_dir = self.projects_root.join(&canonical_id);
        match fs::symlink_metadata(&project_dir) {
            Ok(metadata) if has_reparse_metadata(&metadata) || !metadata.is_dir() => {
                return Err(WorkspaceError::PathEscape);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&project_dir).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        WorkspaceError::ProjectBusy
                    } else {
                        WorkspaceError::NotWritable
                    }
                })?;
            }
            Err(_) => return Err(WorkspaceError::PathEscape),
        }
        let workspace = TaskWorkspace {
            task_id: canonical_id,
            tasks_root: self.projects_root.clone(),
            task_dir: project_dir.clone(),
            source_path: project_dir.join("source"),
            active_lock: Mutex::new(None),
        };
        workspace.verify_project_dir()?;
        let lock_path = workspace.task_dir.join(".build-agent-project.lock");
        if let Ok(metadata) = fs::symlink_metadata(&lock_path) {
            if has_reparse_metadata(&metadata) || !metadata.is_file() {
                return Err(WorkspaceError::PathEscape);
            }
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|_| WorkspaceError::ProjectBusy)?;
        if lock.try_lock_exclusive().is_err() {
            drop(lock);
            return Err(WorkspaceError::ProjectBusy);
        }
        *workspace
            .active_lock
            .lock()
            .map_err(|_| WorkspaceError::CleanupRefused)? = Some(lock);
        Ok(workspace)
    }

    pub fn create_task(&self, task_id: &str) -> Result<TaskWorkspace, WorkspaceError> {
        self.preflight()?;
        let uuid = Uuid::parse_str(task_id).map_err(|_| WorkspaceError::Invalid)?;
        let canonical_id = uuid.to_string();
        let task_dir = self.tasks_root.join(&canonical_id);
        let source_path = task_dir.join("source");

        if has_parent_escape_components(&canonical_id) {
            return Err(WorkspaceError::PathEscape);
        }
        if fs::symlink_metadata(&task_dir).is_ok() {
            return Err(WorkspaceError::AlreadyExists);
        }
        fs::create_dir(&task_dir).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                WorkspaceError::AlreadyExists
            } else {
                WorkspaceError::NotWritable
            }
        })?;
        if let Err(error) = fs::create_dir(&source_path) {
            let workspace = TaskWorkspace {
                task_id: canonical_id,
                tasks_root: self.tasks_root.clone(),
                task_dir,
                source_path,
                active_lock: Mutex::new(None),
            };
            let _ = workspace.cleanup_inner();
            return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                WorkspaceError::AlreadyExists
            } else {
                WorkspaceError::NotWritable
            });
        }

        let workspace = TaskWorkspace {
            task_id: canonical_id,
            tasks_root: self.tasks_root.clone(),
            task_dir,
            source_path,
            active_lock: Mutex::new(None),
        };
        if let Err(error) = workspace.verify_paths() {
            let _ = workspace.cleanup_inner();
            return Err(error);
        }
        let lock_path = workspace.task_dir.join(ACTIVE_LOCK_FILE);
        let lock = match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(lock) => lock,
            Err(_) => {
                let _ = workspace.cleanup_inner();
                return Err(WorkspaceError::CleanupRefused);
            }
        };
        if lock.try_lock_exclusive().is_err() {
            drop(lock);
            let _ = workspace.cleanup_inner();
            return Err(WorkspaceError::CleanupRefused);
        }
        *workspace
            .active_lock
            .lock()
            .map_err(|_| WorkspaceError::CleanupRefused)? = Some(lock);
        Ok(workspace)
    }

    pub fn cleanup_task(&self, task_id: &str) -> Result<(), WorkspaceError> {
        let canonical_id = Uuid::parse_str(task_id)
            .map_err(|_| WorkspaceError::Invalid)?
            .to_string();
        let task_dir = self.tasks_root.join(&canonical_id);
        match fs::symlink_metadata(&task_dir) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(WorkspaceError::CleanupRefused),
        }
        TaskWorkspace {
            task_id: canonical_id,
            tasks_root: self.tasks_root.clone(),
            source_path: task_dir.join("source"),
            task_dir,
            active_lock: Mutex::new(None),
        }
        .cleanup()
    }

    fn check_writable(&self) -> Result<(), WorkspaceError> {
        let probe_path = self
            .tasks_root
            .join(format!(".write-probe-{}", Uuid::new_v4()));
        let result = (|| -> Result<(), std::io::Error> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&probe_path)?;
            file.write_all(b"build-agent")?;
            file.sync_all()?;
            drop(file);
            fs::remove_file(&probe_path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&probe_path);
            return Err(WorkspaceError::NotWritable);
        }
        Ok(())
    }

    fn check_disk_space(&self) -> Result<(), WorkspaceError> {
        if available_space(&self.tasks_root).map_err(|_| WorkspaceError::Invalid)?
            < self.minimum_free_space_bytes
        {
            return Err(WorkspaceError::InsufficientDiskSpace);
        }
        Ok(())
    }

    /// Remove task directories left by an Agent process that no longer owns
    /// the per-task lock. A held lock means another Agent process can still
    /// be using the workspace, so it is never removed during startup.
    fn cleanup_stale_task_workspaces(&self) -> Result<(), WorkspaceError> {
        for entry in fs::read_dir(&self.tasks_root).map_err(|_| WorkspaceError::PathEscape)? {
            let entry = entry.map_err(|_| WorkspaceError::PathEscape)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| WorkspaceError::PathEscape)?;
            if has_reparse_metadata(&metadata) || !metadata.is_dir() {
                return Err(WorkspaceError::PathEscape);
            }
            let name = entry.file_name();
            let name = name.to_str().ok_or(WorkspaceError::PathEscape)?;
            let task_id = Uuid::parse_str(name).map_err(|_| WorkspaceError::PathEscape)?;
            let canonical_id = task_id.to_string();
            if name != canonical_id {
                return Err(WorkspaceError::PathEscape);
            }
            let lock_path = path.join(ACTIVE_LOCK_FILE);
            if let Ok(lock_metadata) = fs::symlink_metadata(&lock_path) {
                if has_reparse_metadata(&lock_metadata) || !lock_metadata.is_file() {
                    return Err(WorkspaceError::PathEscape);
                }
            }
            let lock = match OpenOptions::new()
                .read(true)
                .write(true)
                .truncate(false)
                .create(true)
                .open(&lock_path)
            {
                Ok(lock) => lock,
                // Windows reports a sharing violation while another Agent
                // still owns the lock file. Preserve that workspace.
                Err(_) => continue,
            };
            match lock.try_lock_exclusive() {
                Ok(()) => {
                    let _ = FileExt::unlock(&lock);
                    drop(lock);
                    self.cleanup_task(&canonical_id)?;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::PermissionDenied
                    ) => {}
                // If lock status cannot be determined, preserve the
                // workspace rather than risking deletion of a live task.
                Err(_) => {}
            }
        }
        Ok(())
    }
}

impl TaskWorkspace {
    pub fn project_id(&self) -> &str {
        &self.task_id
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn task_dir(&self) -> &Path {
        &self.task_dir
    }

    pub fn source_path(&self) -> &Path {
        &self.source_path
    }

    /// Release the project lock without deleting the persistent source.
    pub fn release(&self) -> Result<(), WorkspaceError> {
        let Some(lock) = self
            .active_lock
            .lock()
            .map_err(|_| WorkspaceError::CleanupRefused)?
            .take()
        else {
            return Ok(());
        };
        FileExt::unlock(&lock).map_err(|_| WorkspaceError::CleanupRefused)?;
        drop(lock);
        Ok(())
    }

    pub fn cache_matches_url(&self, url: &str) -> Result<bool, WorkspaceError> {
        self.verify_project_dir()?;
        let source_metadata = match fs::symlink_metadata(&self.source_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Ok(false),
        };
        if has_reparse_metadata(&source_metadata) || !source_metadata.is_dir() {
            return Ok(false);
        }
        let git_path = self.source_path.join(".git");
        let git_metadata = match fs::symlink_metadata(&git_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Ok(false),
        };
        if has_reparse_metadata(&git_metadata) || !git_metadata.is_dir() {
            return Ok(false);
        }
        let fingerprint_path = self.task_dir.join(".build-agent-url.sha256");
        let fingerprint_metadata = match fs::symlink_metadata(&fingerprint_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Ok(false),
        };
        if has_reparse_metadata(&fingerprint_metadata) || !fingerprint_metadata.is_file() {
            return Ok(false);
        }
        let actual = match fs::read_to_string(fingerprint_path) {
            Ok(actual) => actual,
            Err(_) => return Ok(false),
        };
        Ok(actual.trim() == url_fingerprint(url))
    }

    /// Rebuild only this project cache. The removal is non-following and is
    /// scoped to the validated `<projects_root>/<projectId>` directory.
    pub fn rebuild_source(&self) -> Result<(), WorkspaceError> {
        self.verify_project_dir()?;
        remove_entry_if_present(&self.source_path)?;
        remove_entry_if_present(&self.task_dir.join(".build-agent-url.sha256"))?;
        Ok(())
    }

    pub fn record_url(&self, url: &str) -> Result<(), WorkspaceError> {
        self.verify_project_dir()?;
        let path = self.task_dir.join(".build-agent-url.sha256");
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if has_reparse_metadata(&metadata) || !metadata.is_file() {
                return Err(WorkspaceError::PathEscape);
            }
        }
        let value = format!("{}\n", url_fingerprint(url));
        safe_write(&path, value.into_bytes()).map_err(|_| WorkspaceError::NotWritable)
    }

    pub fn cleanup(&self) -> Result<(), WorkspaceError> {
        self.cleanup_inner()
    }

    fn verify_project_dir(&self) -> Result<(), WorkspaceError> {
        let projects_root =
            fs::canonicalize(&self.tasks_root).map_err(|_| WorkspaceError::PathEscape)?;
        let metadata = fs::symlink_metadata(&self.task_dir).map_err(|_| WorkspaceError::Invalid)?;
        if has_reparse_metadata(&metadata) || !metadata.is_dir() {
            return Err(WorkspaceError::PathEscape);
        }
        let canonical = fs::canonicalize(&self.task_dir).map_err(|_| WorkspaceError::PathEscape)?;
        let expected = Uuid::parse_str(&self.task_id)
            .map_err(|_| WorkspaceError::Invalid)?
            .to_string();
        if !is_within(&projects_root, &canonical)
            || canonical == projects_root
            || canonical.file_name().and_then(|name| name.to_str()) != Some(expected.as_str())
        {
            return Err(WorkspaceError::PathEscape);
        }
        Ok(())
    }

    fn verify_paths(&self) -> Result<(), WorkspaceError> {
        let tasks_root =
            fs::canonicalize(&self.tasks_root).map_err(|_| WorkspaceError::CleanupRefused)?;
        if !is_within(&tasks_root, &self.task_dir) || self.task_dir == tasks_root {
            return Err(WorkspaceError::PathEscape);
        }
        let task_metadata =
            fs::symlink_metadata(&self.task_dir).map_err(|_| WorkspaceError::Invalid)?;
        if has_reparse_metadata(&task_metadata) || !task_metadata.is_dir() {
            return Err(WorkspaceError::PathEscape);
        }
        let canonical_task =
            fs::canonicalize(&self.task_dir).map_err(|_| WorkspaceError::PathEscape)?;
        if !is_within(&tasks_root, &canonical_task) || canonical_task == tasks_root {
            return Err(WorkspaceError::PathEscape);
        }
        let expected_name = Uuid::parse_str(&self.task_id)
            .map_err(|_| WorkspaceError::Invalid)?
            .to_string();
        if canonical_task.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str())
        {
            return Err(WorkspaceError::PathEscape);
        }
        let source_metadata = match fs::symlink_metadata(&self.source_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(WorkspaceError::Invalid),
        };
        if has_reparse_metadata(&source_metadata) || !source_metadata.is_dir() {
            return Err(WorkspaceError::PathEscape);
        }
        let canonical_source =
            fs::canonicalize(&self.source_path).map_err(|_| WorkspaceError::PathEscape)?;
        if !is_within(&canonical_task, &canonical_source) || canonical_source == canonical_task {
            return Err(WorkspaceError::PathEscape);
        }
        Ok(())
    }

    fn cleanup_inner(&self) -> Result<(), WorkspaceError> {
        if let Some(lock) = self
            .active_lock
            .lock()
            .map_err(|_| WorkspaceError::CleanupRefused)?
            .take()
        {
            FileExt::unlock(&lock).map_err(|_| WorkspaceError::CleanupRefused)?;
            drop(lock);
        }
        let tasks_root =
            fs::canonicalize(&self.tasks_root).map_err(|_| WorkspaceError::CleanupRefused)?;
        let task_metadata = match fs::symlink_metadata(&self.task_dir) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(WorkspaceError::CleanupRefused),
        };
        if has_reparse_metadata(&task_metadata) || !task_metadata.is_dir() {
            return Err(WorkspaceError::CleanupRefused);
        }
        let canonical_task =
            fs::canonicalize(&self.task_dir).map_err(|_| WorkspaceError::CleanupRefused)?;
        let expected_id = Uuid::parse_str(&self.task_id)
            .map_err(|_| WorkspaceError::CleanupRefused)?
            .to_string();
        if !is_within(&tasks_root, &canonical_task)
            || canonical_task == tasks_root
            || canonical_task.file_name().and_then(|name| name.to_str())
                != Some(expected_id.as_str())
        {
            return Err(WorkspaceError::CleanupRefused);
        }
        remove_tree_safe(&self.task_dir)
    }
}

impl Drop for TaskWorkspace {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

fn url_fingerprint(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn remove_entry_if_present(path: &Path) -> Result<(), WorkspaceError> {
    match fs::symlink_metadata(path) {
        Ok(_) => remove_tree_safe(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(WorkspaceError::CleanupRefused),
    }
}

fn remove_tree_safe(path: &Path) -> Result<(), WorkspaceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| WorkspaceError::CleanupRefused)?;
    if has_reparse_metadata(&metadata) || metadata.file_type().is_symlink() {
        let result = if metadata.is_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        };
        result.map_err(|_| WorkspaceError::CleanupRefused)?;
        return Ok(());
    }
    if !metadata.is_dir() {
        fs::remove_file(path).map_err(|_| WorkspaceError::CleanupRefused)?;
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|_| WorkspaceError::CleanupRefused)? {
        let entry = entry.map_err(|_| WorkspaceError::CleanupRefused)?;
        remove_tree_safe(&entry.path())?;
    }
    fs::remove_dir(path).map_err(|_| WorkspaceError::CleanupRefused)
}

fn has_parent_escape_components(value: &str) -> bool {
    value.is_empty()
        || value.chars().any(char::is_control)
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

fn is_within(base: &Path, candidate: &Path) -> bool {
    let base = path_key(base);
    let candidate = path_key(candidate);
    candidate == base
        || candidate.starts_with(&(base + std::path::MAIN_SEPARATOR.to_string().as_str()))
}

#[cfg(windows)]
fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

#[cfg(not(windows))]
fn path_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn contains_reparse_point(base: &Path, target: &Path) -> bool {
    let relative = match target.strip_prefix(base) {
        Ok(relative) => relative,
        Err(_) => return true,
    };
    let mut current = base.to_path_buf();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return true;
        }
        current.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if has_reparse_metadata(&metadata) {
                return true;
            }
        }
    }
    false
}

fn has_reparse_point(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| has_reparse_metadata(&metadata))
        .unwrap_or(true)
}

#[cfg(unix)]
fn has_reparse_metadata(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn has_reparse_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(any(unix, windows)))]
fn has_reparse_metadata(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn task_id() -> String {
        Uuid::new_v4().to_string()
    }

    #[test]
    fn creates_normalizes_and_cleans_a_task_workspace() {
        let root = tempfile::tempdir().expect("temporary directory");
        let manager = WorkspaceManager::new(root.path().join("relative").as_path(), 0)
            .expect("workspace manager");
        let workspace = manager.create_task(&task_id()).expect("task workspace");
        assert!(workspace.source_path().starts_with(manager.tasks_root()));
        assert!(workspace.source_path().is_dir());
        workspace.cleanup().expect("safe cleanup");
        assert!(!workspace.task_dir().exists());
    }

    #[test]
    fn rejects_root_and_invalid_task_ids() {
        let root = Path::new(std::path::MAIN_SEPARATOR_STR);
        assert!(matches!(
            WorkspaceManager::new(root, 0),
            Err(WorkspaceError::Invalid)
        ));
        let directory = tempfile::tempdir().expect("temporary directory");
        let manager = WorkspaceManager::new(directory.path(), 0).expect("workspace manager");
        for invalid in [
            "..",
            "../outside",
            "/absolute",
            "C:\\outside",
            "\\\\server\\share",
        ] {
            assert!(
                manager.create_task(invalid).is_err(),
                "{invalid} must be rejected"
            );
        }
    }

    #[test]
    fn does_not_reuse_or_delete_an_existing_task_directory() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let manager = WorkspaceManager::new(directory.path(), 0).expect("workspace manager");
        let id = task_id();
        let existing = manager.tasks_root().join(&id);
        fs::create_dir_all(existing.join("source")).expect("existing workspace");
        assert!(matches!(
            manager.create_task(&id),
            Err(WorkspaceError::AlreadyExists)
        ));
        assert!(existing.exists());
    }

    #[test]
    fn startup_cleans_an_unlocked_orphaned_task_workspace() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let manager = WorkspaceManager::new(directory.path(), 0).expect("workspace manager");
        let id = task_id();
        let orphan = manager.tasks_root().join(&id);
        fs::create_dir_all(orphan.join("source")).expect("orphan workspace");
        drop(manager);

        let restarted = WorkspaceManager::new(directory.path(), 0).expect("restarted manager");
        assert!(!restarted.tasks_root().join(id).exists());
    }

    #[test]
    fn startup_preserves_a_workspace_with_an_active_lock() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let manager = WorkspaceManager::new(directory.path(), 0).expect("workspace manager");
        let id = task_id();
        let workspace = manager.create_task(&id).expect("active workspace");

        let restarted = WorkspaceManager::new(directory.path(), 0).expect("restarted manager");
        assert!(restarted.tasks_root().join(&id).exists());

        drop(restarted);
        workspace.cleanup().expect("workspace cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_task_symlink_that_escapes_tasks_root() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().expect("temporary directory");
        let manager = WorkspaceManager::new(directory.path(), 0).expect("workspace manager");
        let external = tempfile::tempdir().expect("external directory");
        let id = task_id();
        symlink(external.path(), manager.tasks_root().join(&id)).expect("task symlink");
        assert!(matches!(
            manager.create_task(&id),
            Err(WorkspaceError::AlreadyExists)
        ));
        assert!(!external.path().join("source").exists());
    }

    #[test]
    fn cleanup_cannot_target_tasks_root_or_other_task() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let manager = WorkspaceManager::new(directory.path(), 0).expect("workspace manager");
        let workspace = manager.create_task(&task_id()).expect("task workspace");
        let invalid = TaskWorkspace {
            task_id: workspace.task_id.clone(),
            tasks_root: manager.tasks_root().to_path_buf(),
            task_dir: manager.tasks_root().to_path_buf(),
            source_path: manager.tasks_root().join("source"),
            active_lock: Mutex::new(None),
        };
        assert!(matches!(
            invalid.cleanup(),
            Err(WorkspaceError::CleanupRefused)
        ));
        assert!(workspace.task_dir().exists());
    }

    #[test]
    fn url_change_and_corrupt_source_rebuild_only_the_project_cache() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let manager = WorkspaceManager::new(directory.path(), 0).expect("workspace manager");
        let project_id = task_id();
        let project = manager
            .open_project(&project_id)
            .expect("project workspace");
        fs::create_dir_all(project.source_path().join(".git")).expect("git directory");
        fs::write(project.source_path().join("keep.txt"), "cached").expect("cached source");
        project
            .record_url("https://example.test/old.git")
            .expect("fingerprint");
        let project_dir = project.task_dir().to_path_buf();
        project.release().expect("release");
        drop(project);

        let project = manager.open_project(&project_id).expect("reopen project");
        assert!(project
            .cache_matches_url("https://example.test/old.git")
            .expect("cache check"));
        assert!(!project
            .cache_matches_url("https://example.test/new.git")
            .expect("changed URL cache check"));
        fs::remove_dir_all(project.source_path()).expect("corrupt source");
        fs::write(project.source_path(), "not a directory").expect("corrupt marker");
        project.rebuild_source().expect("safe rebuild");
        assert!(project_dir.is_dir());
        assert!(!project.source_path().exists());
        assert!(project_dir.starts_with(manager.projects_root()));
    }

    #[test]
    fn project_lock_is_non_blocking_and_reopens_after_release() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let manager = WorkspaceManager::new(directory.path(), 0).expect("workspace manager");
        let project_id = task_id();
        let first = manager
            .open_project(&project_id)
            .expect("first project workspace");
        fs::create_dir_all(first.source_path().join(".git")).expect("git directory");
        fs::write(first.source_path().join("keep.txt"), "cached").expect("cached source");

        let started = std::time::Instant::now();
        assert!(matches!(
            manager.open_project(&project_id),
            Err(WorkspaceError::ProjectBusy)
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));

        first.release().expect("release first lock");
        let reopened = manager
            .open_project(&project_id)
            .expect("reopen project workspace");
        assert_eq!(
            fs::read_to_string(reopened.source_path().join("keep.txt")).unwrap(),
            "cached"
        );
    }
}
