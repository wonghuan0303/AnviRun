//! Atomic task configuration materialization inside a prepared source tree.

use std::fs;

use std::path::Path;

use safe_write::safe_write;
use serde_json::{Map, Value};
use thiserror::Error;

const CONFIG_FILE_NAME: &str = "platform.config.json";

#[derive(Debug, Error)]
pub enum TaskConfigError {
    #[error("CONFIG_WRITE_FAILED: task source directory is invalid")]
    InvalidSource,
    #[error("CONFIG_WRITE_FAILED: could not write task configuration")]
    Write,
    #[error("CONFIG_REPLACE_FAILED: could not replace task configuration")]
    Replace,
}

pub fn write_platform_config(
    source: &Path,
    config: &Map<String, Value>,
) -> Result<(), TaskConfigError> {
    let source_metadata =
        fs::symlink_metadata(source).map_err(|_| TaskConfigError::InvalidSource)?;
    if !source_metadata.is_dir() || has_reparse_metadata(&source_metadata) {
        return Err(TaskConfigError::InvalidSource);
    }

    let target = source.join(CONFIG_FILE_NAME);
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if has_reparse_metadata(&metadata) || !metadata.is_file() {
            return Err(TaskConfigError::InvalidSource);
        }
    }

    let mut contents = serde_json::to_vec_pretty(config).map_err(|_| TaskConfigError::Write)?;
    contents.push(b'\n');
    safe_write(&target, contents).map_err(|_| TaskConfigError::Replace)
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

    #[test]
    fn writes_formatted_json_with_newline_and_preserves_types() {
        let directory = tempfile::tempdir().expect("source");
        let mut config = Map::new();
        config.insert("text".to_string(), Value::String("你好".to_string()));
        config.insert("number".to_string(), Value::from(3));
        config.insert("enabled".to_string(), Value::Bool(true));
        config.insert("empty".to_string(), Value::Null);
        config.insert("items".to_string(), serde_json::json!(["a", 2]));

        write_platform_config(directory.path(), &config).expect("configuration should be written");
        let path = directory.path().join(CONFIG_FILE_NAME);
        let bytes = fs::read(&path).expect("configuration file");
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert!(!bytes.starts_with(&[0xef, 0xbb, 0xbf]));
        let value: Value = serde_json::from_slice(&bytes).expect("valid JSON");
        assert_eq!(value["text"], "你好");
        assert_eq!(value["number"], 3);
        assert_eq!(value["enabled"], true);
        assert_eq!(value["empty"], Value::Null);
        assert_eq!(value["items"][1], 2);
    }

    #[test]
    fn empty_config_is_written_as_an_empty_object_with_one_newline() {
        let directory = tempfile::tempdir().expect("source");
        write_platform_config(directory.path(), &Map::new())
            .expect("configuration should be written");
        let bytes = fs::read(directory.path().join(CONFIG_FILE_NAME)).expect("configuration file");
        assert_eq!(bytes, b"{}\n");
    }
    #[test]
    fn replaces_existing_file_and_leaves_no_temporary_file() {
        let directory = tempfile::tempdir().expect("source");
        let path = directory.path().join(CONFIG_FILE_NAME);
        fs::write(&path, b"{\"old\":true}\n").expect("old configuration");
        let config = Map::from_iter([(String::from("new"), Value::Bool(true))]);

        write_platform_config(directory.path(), &config).expect("configuration should be replaced");
        let value: Value = serde_json::from_slice(&fs::read(&path).expect("new configuration"))
            .expect("valid JSON");
        assert_eq!(value, serde_json::json!({"new": true}));
        assert_eq!(
            fs::read_dir(directory.path())
                .expect("source entries")
                .count(),
            1
        );
    }

    #[test]
    fn rejects_source_file_without_leaking_config() {
        let directory = tempfile::tempdir().expect("parent");
        let source = directory.path().join("source");
        fs::write(&source, b"not a directory").expect("source file");
        let config =
            Map::from_iter([(String::from("secret"), Value::String("hidden".to_string()))]);
        let error = write_platform_config(&source, &config).expect_err("source should fail");
        let message = error.to_string();
        assert!(!message.contains("hidden"));
        assert!(!message.contains("secret"));
    }
}
