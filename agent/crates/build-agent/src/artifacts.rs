use std::fs;
use std::path::{Component, Path, PathBuf};

use build_agent_contracts::ArtifactManifestEntry;
use reqwest::header::CONTENT_TYPE;
use reqwest::Client;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::time::{self, Duration};
use tokio_util::io::ReaderStream;
use url::Url;

pub const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const HASH_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Error)]
pub enum ArtifactError {
    #[error("ARTIFACT_SCAN_FAILED: artifact directory is invalid or empty")]
    ScanInvalid,
    #[error("ARTIFACT_SCAN_FAILED: artifact directory contains an unsafe entry")]
    ScanUnsafe,
    #[error("ARTIFACT_SCAN_FAILED: artifact data changed while being read")]
    ScanChanged,
    #[error("ARTIFACT_SIZE_LIMIT_EXCEEDED: artifact output is too large")]
    SizeLimit,
    #[error("ARTIFACT_UPLOAD_FAILED: artifact upload was not accepted")]
    UploadFailed,
    #[error("ARTIFACT_UPLOAD_TIMEOUT: artifact upload timed out")]
    UploadTimeout,
}

#[derive(Debug, Clone)]
pub struct ScannedArtifact {
    pub relative_path: String,
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct ArtifactManifest {
    pub files: Vec<ScannedArtifact>,
    pub total_bytes: u64,
}

impl ArtifactManifest {
    pub fn entries(&self) -> Vec<ArtifactManifestEntry> {
        self.files
            .iter()
            .map(|file| ArtifactManifestEntry {
                relative_path: file.relative_path.clone(),
                size: file.size,
                sha256: file.sha256.clone(),
            })
            .collect()
    }
}

pub async fn scan_artifacts(
    source: &Path,
    artifact_dir: &str,
) -> Result<ArtifactManifest, ArtifactError> {
    validate_relative_path(artifact_dir)?;
    let root = source.join(artifact_dir);
    reject_unsafe_path(source, &root)?;
    let metadata = fs::symlink_metadata(&root).map_err(|_| ArtifactError::ScanInvalid)?;
    if !metadata.is_dir() || has_reparse_metadata(&metadata) {
        return Err(ArtifactError::ScanInvalid);
    }

    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    scan_directory(&root, &root, &mut files, &mut total_bytes).await?;
    if files.is_empty() {
        return Err(ArtifactError::ScanInvalid);
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(ArtifactManifest { files, total_bytes })
}

async fn scan_directory(
    root: &Path,
    current: &Path,
    files: &mut Vec<ScannedArtifact>,
    total_bytes: &mut u64,
) -> Result<(), ArtifactError> {
    let mut entries = tokio::fs::read_dir(current)
        .await
        .map_err(|_| ArtifactError::ScanInvalid)?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|_| ArtifactError::ScanInvalid)?
    {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| ArtifactError::ScanInvalid)?;
        if has_reparse_metadata(&metadata) {
            return Err(ArtifactError::ScanUnsafe);
        }
        if metadata.is_dir() {
            Box::pin(scan_directory(root, &path, files, total_bytes)).await?;
            continue;
        }
        if !metadata.is_file() {
            return Err(ArtifactError::ScanUnsafe);
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| ArtifactError::ScanUnsafe)?;
        let relative_path = relative_path(relative)?;
        let scanned = hash_file(path.clone(), metadata.len()).await?;
        *total_bytes = total_bytes
            .checked_add(scanned.0)
            .ok_or(ArtifactError::SizeLimit)?;
        if *total_bytes > MAX_ARTIFACT_BYTES {
            return Err(ArtifactError::SizeLimit);
        }
        files.push(ScannedArtifact {
            relative_path,
            path,
            size: scanned.0,
            sha256: scanned.1,
        });
    }
    Ok(())
}

async fn hash_file(path: PathBuf, expected_size: u64) -> Result<(u64, String), ArtifactError> {
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ArtifactError::ScanInvalid)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_CHUNK_BYTES];
    let mut size = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|_| ArtifactError::ScanInvalid)?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(read as u64)
            .ok_or(ArtifactError::SizeLimit)?;
        hasher.update(&buffer[..read]);
    }
    if size != expected_size {
        return Err(ArtifactError::ScanChanged);
    }
    let final_size = fs::metadata(path)
        .map_err(|_| ArtifactError::ScanChanged)?
        .len();
    if final_size != size {
        return Err(ArtifactError::ScanChanged);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

pub async fn upload_manifest(
    client: &Client,
    server_url: &Url,
    task_id: &str,
    lease_token: &str,
    manifest: &ArtifactManifest,
) -> Result<(), ArtifactError> {
    let upload_base = artifact_upload_base_url(server_url)?;
    let path_prefix = upload_base.path().trim_end_matches('/').to_owned();
    for artifact in &manifest.files {
        let mut url = upload_base.clone();
        let path = format!("{path_prefix}/api/agent/tasks/{task_id}/artifacts/content");
        url.set_path(&path);
        url.set_query(None);
        url.query_pairs_mut()
            .append_pair("relativePath", &artifact.relative_path);
        let file = tokio::fs::File::open(&artifact.path)
            .await
            .map_err(|_| ArtifactError::UploadFailed)?;
        let stream = ReaderStream::with_capacity(file, HASH_CHUNK_BYTES);
        let response = time::timeout(
            Duration::from_secs(30 * 60),
            client
                .put(url)
                .bearer_auth(lease_token)
                .header(CONTENT_TYPE, "application/octet-stream")
                .body(reqwest::Body::wrap_stream(stream))
                .send(),
        )
        .await
        .map_err(|_| ArtifactError::UploadTimeout)?
        .map_err(|_| ArtifactError::UploadFailed)?;
        if !response.status().is_success() {
            return Err(ArtifactError::UploadFailed);
        }
    }
    Ok(())
}

fn artifact_upload_base_url(server_url: &Url) -> Result<Url, ArtifactError> {
    let mut url = server_url.clone();
    let scheme = match url.scheme() {
        "http" | "ws" => "http",
        "https" | "wss" => "https",
        _ => return Err(ArtifactError::UploadFailed),
    };
    url.set_scheme(scheme)
        .map_err(|_| ArtifactError::UploadFailed)?;
    Ok(url)
}

fn validate_relative_path(value: &str) -> Result<(), ArtifactError> {
    if value.is_empty()
        || value.contains('\\')
        || value.contains('\0')
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains(':')
        || value.chars().any(char::is_control)
        || !Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(ArtifactError::ScanInvalid);
    }
    Ok(())
}

fn relative_path(path: &Path) -> Result<String, ArtifactError> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(value) = component else {
            return Err(ArtifactError::ScanUnsafe);
        };
        let value = value.to_str().ok_or(ArtifactError::ScanUnsafe)?;
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err(ArtifactError::ScanUnsafe);
        }
        parts.push(value.to_string());
    }
    if parts.is_empty() {
        return Err(ArtifactError::ScanUnsafe);
    }
    Ok(parts.join("/"))
}

fn reject_unsafe_path(source: &Path, target: &Path) -> Result<(), ArtifactError> {
    let relative = target
        .strip_prefix(source)
        .map_err(|_| ArtifactError::ScanUnsafe)?;
    let mut current = source.to_path_buf();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err(ArtifactError::ScanUnsafe);
        };
        current.push(value);
        let metadata = fs::symlink_metadata(&current).map_err(|_| ArtifactError::ScanInvalid)?;
        if has_reparse_metadata(&metadata) {
            return Err(ArtifactError::ScanUnsafe);
        }
    }
    Ok(())
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

    #[tokio::test]
    async fn scans_nested_files_and_hashes_without_loading_the_file_as_a_whole() {
        let directory = tempfile::tempdir().expect("directory");
        fs::create_dir_all(directory.path().join("dist/nested")).expect("nested directory");
        fs::write(directory.path().join("dist/a.txt"), b"a").expect("file");
        fs::write(directory.path().join("dist/nested/a.txt"), b"nested").expect("file");
        let manifest = scan_artifacts(directory.path(), "dist")
            .await
            .expect("manifest");
        assert_eq!(manifest.total_bytes, 7);
        assert_eq!(
            manifest
                .files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt", "nested/a.txt"]
        );
    }

    #[tokio::test]
    async fn rejects_empty_directories_and_unsafe_paths() {
        let directory = tempfile::tempdir().expect("directory");
        fs::create_dir(directory.path().join("dist")).expect("directory");
        assert!(matches!(
            scan_artifacts(directory.path(), "dist").await,
            Err(ArtifactError::ScanInvalid)
        ));
        assert!(matches!(
            scan_artifacts(directory.path(), "../dist").await,
            Err(ArtifactError::ScanInvalid)
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_entries() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().expect("directory");
        fs::create_dir(directory.path().join("dist")).expect("directory");
        let outside = tempfile::NamedTempFile::new().expect("outside");
        symlink(outside.path(), directory.path().join("dist/link")).expect("symlink");
        assert!(matches!(
            scan_artifacts(directory.path(), "dist").await,
            Err(ArtifactError::ScanUnsafe)
        ));
    }

    #[test]
    fn keeps_error_messages_free_of_paths_and_content() {
        let message = ArtifactError::ScanUnsafe.to_string();
        assert!(!message.contains("secret"));
        assert!(!message.contains("dist"));
    }

    #[test]
    fn converts_websocket_server_urls_to_http_upload_urls() {
        let websocket = Url::parse("wss://example.test/base").expect("URL");
        let upload = artifact_upload_base_url(&websocket).expect("upload URL");
        assert_eq!(upload.as_str(), "https://example.test/base");
    }
}
