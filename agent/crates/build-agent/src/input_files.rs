use build_agent_contracts::TaskInputFileAssignment;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use url::Url;

#[derive(Debug, Error)]
pub enum InputFileError {
    #[error("CONFIG_FILE_DOWNLOAD_FAILED")]
    Download,
    #[error("CONFIG_FILE_HASH_MISMATCH")]
    Integrity,
    #[error("CONFIG_FILE_PATH_INVALID")]
    Path,
}

pub async fn download_input_files(
    client: &Client,
    server: &Url,
    task_id: &str,
    lease: &str,
    source: &Path,
    files: &[TaskInputFileAssignment],
    config: &mut Map<String, Value>,
) -> Result<(), InputFileError> {
    for item in files {
        let relative = Path::new(&item.target_relative_path);
        if item.target_relative_path.contains('\\')
            || item.target_relative_path.contains(':')
            || !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(InputFileError::Path);
        }
        let target = source.join(relative);
        let parent = target.parent().ok_or(InputFileError::Path)?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| InputFileError::Path)?;
        reject_symlink_parents(source, parent)?;
        let temporary = target.with_extension("anvilrun-part");
        let mut url = server.clone();
        url.set_scheme(match url.scheme() {
            "ws" | "http" => "http",
            "wss" | "https" => "https",
            _ => return Err(InputFileError::Download),
        })
        .map_err(|_| InputFileError::Download)?;
        let base = url.path().trim_end_matches('/').to_owned();
        url.set_path(&format!(
            "{base}/api/agent/tasks/{task_id}/input-files/{}/content",
            item.file_id
        ));
        url.set_query(None);
        let response = client
            .get(url)
            .bearer_auth(lease)
            .send()
            .await
            .map_err(|_| InputFileError::Download)?;
        if !response.status().is_success() {
            return Err(InputFileError::Download);
        }
        if response
            .content_length()
            .is_some_and(|size| size != item.size)
        {
            return Err(InputFileError::Integrity);
        }
        let _ = tokio::fs::remove_file(&temporary).await;
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await
            .map_err(|_| InputFileError::Path)?;
        let mut stream = response.bytes_stream();
        let mut hasher = Sha256::new();
        let mut size = 0_u64;
        let transfer = async {
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| InputFileError::Download)?;
                size = size
                    .checked_add(chunk.len() as u64)
                    .ok_or(InputFileError::Integrity)?;
                if size > item.size {
                    return Err(InputFileError::Integrity);
                }
                hasher.update(&chunk);
                output
                    .write_all(&chunk)
                    .await
                    .map_err(|_| InputFileError::Path)?;
            }
            output.sync_all().await.map_err(|_| InputFileError::Path)
        }
        .await;
        drop(output);
        if let Err(error) = transfer {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        if size != item.size || format!("{:x}", hasher.finalize()) != item.sha256 {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(InputFileError::Integrity);
        }
        if tokio::fs::try_exists(&target).await.unwrap_or(false) {
            tokio::fs::remove_file(&target)
                .await
                .map_err(|_| InputFileError::Path)?;
        }
        tokio::fs::rename(&temporary, &target)
            .await
            .map_err(|_| InputFileError::Path)?;
        config.insert(
            item.field_name.clone(),
            serde_json::json!({
                "fileId": item.file_id, "fileName": item.file_name, "size": item.size,
                "sha256": item.sha256, "path": item.target_relative_path
            }),
        );
    }
    Ok(())
}

fn reject_symlink_parents(source: &Path, parent: &Path) -> Result<(), InputFileError> {
    let relative = parent
        .strip_prefix(source)
        .map_err(|_| InputFileError::Path)?;
    let mut current = source.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&current).map_err(|_| InputFileError::Path)?;
        if metadata.file_type().is_symlink() || has_reparse_point(&metadata) || !metadata.is_dir() {
            return Err(InputFileError::Path);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn has_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn has_reparse_point(_: &std::fs::Metadata) -> bool {
    false
}
