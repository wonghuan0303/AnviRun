use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use fs2::available_space;
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
            Self::InsufficientDiskSpace => "INSUFFICIENT_DISK_SPACE",
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceManager {
    root: PathBuf,
    tasks_root: PathBuf,
    minimum_free_space_bytes: u64,
}

#[derive(Debug)]
pub struct TaskWorkspace {
    task_id: String,
    tasks_root: PathBuf,
    task_dir: PathBuf,
    source_path: PathBuf,
}

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
        let manager = Self {
            root,
            tasks_root,
            minimum_free_space_bytes,
        };
        manager.check_writable()?;
        manager.check_disk_space()?;
        Ok(manager)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn tasks_root(&self) -> &Path {
        &self.tasks_root
    }

    pub fn minimum_free_space_bytes(&self) -> u64 {
        self.minimum_free_space_bytes
    }

    pub fn preflight(&self) -> Result<(), WorkspaceError> {
        self.check_writable()?;
        self.check_disk_space()
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
        };
        workspace.verify_paths()?;
        Ok(workspace)
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
}

impl TaskWorkspace {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn task_dir(&self) -> &Path {
        &self.task_dir
    }

    pub fn source_path(&self) -> &Path {
        &self.source_path
    }

    pub fn cleanup(&self) -> Result<(), WorkspaceError> {
        self.cleanup_inner()
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
        let source_metadata =
            fs::symlink_metadata(&self.source_path).map_err(|_| WorkspaceError::Invalid)?;
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
        let _ = self.cleanup_inner();
    }
}

fn remove_tree_safe(path: &Path) -> Result<(), WorkspaceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| WorkspaceError::CleanupRefused)?;
    if has_reparse_metadata(&metadata) || metadata.file_type().is_symlink() {
        fs::remove_file(path).map_err(|_| WorkspaceError::CleanupRefused)?;
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
        };
        assert!(matches!(
            invalid.cleanup(),
            Err(WorkspaceError::CleanupRefused)
        ));
        assert!(workspace.task_dir().exists());
    }
}
