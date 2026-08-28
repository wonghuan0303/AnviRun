use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use build_agent_contracts::LogStream;
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use thiserror::Error;
use uuid::Uuid;

const LOG_BUFFER_DIRECTORY: &str = "log-buffer";
const COMPACTION_SEQUENCE_THRESHOLD: u64 = 256;

#[derive(Debug, Error)]
pub enum LogBufferError {
    #[error("invalid log buffer path")]
    InvalidPath,
    #[error("log buffer I/O failed")]
    Io(#[source] std::io::Error),
    #[error("log buffer record is invalid")]
    InvalidRecord,
    #[error("log buffer acknowledgement is invalid")]
    InvalidAcknowledgement,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BufferedLogEntry {
    pub sequence: u64,
    pub stream: LogStream,
    pub chunk: String,
    pub emitted_at: String,
}

/// Bounded, token-free NDJSON buffer for one task's unacknowledged logs.
#[derive(Debug)]
pub struct LogBuffer {
    path: PathBuf,
    max_bytes: u64,
    file_bytes: u64,
    last_appended_sequence: u64,
    last_compacted_sequence: u64,
    acknowledged_sequence: u64,
    bytes_since_compaction: u64,
    full: bool,
}

impl LogBuffer {
    pub fn new(
        workspace_root: &Path,
        task_id: &str,
        max_bytes: u64,
    ) -> Result<Self, LogBufferError> {
        let task_id = Uuid::parse_str(task_id)
            .map_err(|_| LogBufferError::InvalidPath)?
            .to_string();
        if max_bytes == 0 || is_filesystem_root(workspace_root) {
            return Err(LogBufferError::InvalidPath);
        }
        let workspace_root = fs::canonicalize(workspace_root).map_err(LogBufferError::Io)?;
        if is_filesystem_root(&workspace_root) {
            return Err(LogBufferError::InvalidPath);
        }
        reject_reparse(&workspace_root)?;
        let directory = workspace_root.join(LOG_BUFFER_DIRECTORY);
        fs::create_dir_all(&directory).map_err(LogBufferError::Io)?;
        reject_reparse(&directory)?;
        let path = directory.join(format!("{}.ndjson", task_id));
        reject_reparse_if_present(&path)?;

        let (file_bytes, last_appended_sequence) = recover_file(&path)?;
        Ok(Self {
            path,
            max_bytes,
            file_bytes,
            last_appended_sequence,
            last_compacted_sequence: 0,
            acknowledged_sequence: 0,
            bytes_since_compaction: file_bytes,
            full: false,
        })
    }

    pub fn append(&mut self, entry: &BufferedLogEntry) -> Result<bool, LogBufferError> {
        if self.full {
            return Ok(false);
        }
        let encoded = serde_json::to_vec(entry).map_err(|_| LogBufferError::InvalidRecord)?;
        let bytes = encoded.len() as u64 + 1;
        if entry.sequence == 0
            || (self.last_appended_sequence > 0
                && entry.sequence != self.last_appended_sequence.saturating_add(1))
        {
            return Err(LogBufferError::InvalidRecord);
        }

        reject_reparse_if_present(&self.path)?;
        let current = file_len(&self.path)?;
        if current != self.file_bytes {
            let (recovered_bytes, recovered_sequence) = recover_file(&self.path)?;
            self.file_bytes = recovered_bytes;
            self.last_appended_sequence = recovered_sequence;
            self.bytes_since_compaction = self.bytes_since_compaction.max(recovered_bytes);
            if self.last_appended_sequence > 0
                && entry.sequence != self.last_appended_sequence.saturating_add(1)
            {
                return Err(LogBufferError::InvalidRecord);
            }
        }
        if self.file_bytes.saturating_add(bytes) > self.max_bytes {
            self.full = true;
            return Ok(false);
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(LogBufferError::Io)?;
        file.write_all(&encoded).map_err(LogBufferError::Io)?;
        file.write_all(b"\n").map_err(LogBufferError::Io)?;
        file.sync_data().map_err(LogBufferError::Io)?;
        self.file_bytes = self.file_bytes.saturating_add(bytes);
        self.bytes_since_compaction = self.bytes_since_compaction.saturating_add(bytes);
        self.last_appended_sequence = entry.sequence;
        Ok(true)
    }

    pub fn acknowledge(&mut self, sequence: u64) -> Result<(), LogBufferError> {
        if sequence > self.last_appended_sequence {
            return Err(LogBufferError::InvalidAcknowledgement);
        }
        if sequence <= self.acknowledged_sequence {
            return Ok(());
        }
        let previous_acknowledged_sequence = self.acknowledged_sequence;

        let current = file_len(&self.path)?;
        if current == 0 {
            self.file_bytes = 0;
            self.acknowledged_sequence = sequence;
            self.full = false;
            return Ok(());
        }
        if current != self.file_bytes {
            let (recovered_bytes, recovered_sequence) = recover_file(&self.path)?;
            self.file_bytes = recovered_bytes;
            self.last_appended_sequence = recovered_sequence;
        }

        let sequence_threshold_reached = self
            .last_appended_sequence
            .saturating_sub(sequence.min(self.last_appended_sequence))
            == 0
            || self.bytes_since_compaction >= self.max_bytes.max(1) / 2
            || sequence.saturating_sub(self.last_compacted_sequence)
                >= COMPACTION_SEQUENCE_THRESHOLD;
        if sequence_threshold_reached {
            self.acknowledged_sequence = sequence;
            if let Err(error) = self.compact() {
                self.acknowledged_sequence = previous_acknowledged_sequence;
                return Err(error);
            }
        } else {
            self.acknowledged_sequence = sequence;
        }
        self.full = false;
        Ok(())
    }

    pub fn pending_reader(&self) -> Result<BufferedLogReader, LogBufferError> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BufferedLogReader { reader: None })
            }
            Err(error) => return Err(LogBufferError::Io(error)),
        };
        Ok(BufferedLogReader {
            reader: Some(BufReader::new(file)),
        })
    }

    pub fn acknowledged_sequence(&self) -> u64 {
        self.acknowledged_sequence
    }

    pub fn is_empty(&self) -> bool {
        file_len(&self.path).unwrap_or(0) == 0
    }

    fn compact(&mut self) -> Result<(), LogBufferError> {
        reject_reparse(&self.path)?;
        let source_file = File::open(&self.path).map_err(LogBufferError::Io)?;
        let parent = self.path.parent().ok_or(LogBufferError::InvalidPath)?;
        let mut temporary = NamedTempFile::new_in(parent).map_err(LogBufferError::Io)?;
        let mut writer = BufWriter::new(temporary.as_file_mut());
        let mut retained = false;
        let mut line = Vec::new();
        let mut reader = BufReader::new(source_file);
        loop {
            line.clear();
            let count = reader
                .read_until(b'\n', &mut line)
                .map_err(LogBufferError::Io)?;
            if count == 0 {
                break;
            }
            if line.last() != Some(&b'\n') {
                return Err(LogBufferError::InvalidRecord);
            }
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let entry: BufferedLogEntry =
                serde_json::from_slice(&line).map_err(|_| LogBufferError::InvalidRecord)?;
            if entry.sequence > self.acknowledged_sequence {
                serde_json::to_writer(&mut writer, &entry)
                    .map_err(|_| LogBufferError::InvalidRecord)?;
                writer.write_all(b"\n").map_err(LogBufferError::Io)?;
                retained = true;
            }
        }
        drop(reader);
        writer.flush().map_err(LogBufferError::Io)?;
        writer.get_ref().sync_data().map_err(LogBufferError::Io)?;
        drop(writer);

        if retained {
            let retained_bytes = temporary
                .as_file()
                .metadata()
                .map_err(LogBufferError::Io)?
                .len();
            persist_temporary(temporary, &self.path)?;
            self.file_bytes = retained_bytes;
        } else {
            drop(temporary);
            fs::remove_file(&self.path).map_err(LogBufferError::Io)?;
            self.file_bytes = 0;
        }
        self.bytes_since_compaction = 0;
        self.last_compacted_sequence = self.acknowledged_sequence;
        Ok(())
    }
}

fn persist_temporary(temporary: NamedTempFile, destination: &Path) -> Result<(), LogBufferError> {
    temporary
        .persist(destination)
        .map(|_| ())
        .map_err(|error| LogBufferError::Io(error.error))
}

pub struct BufferedLogReader {
    reader: Option<BufReader<File>>,
}

impl BufferedLogReader {
    pub fn next(&mut self) -> Result<Option<BufferedLogEntry>, LogBufferError> {
        let Some(reader) = self.reader.as_mut() else {
            return Ok(None);
        };
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(LogBufferError::Io)? == 0 {
            return Ok(None);
        }
        serde_json::from_str(line.trim_end())
            .map(Some)
            .map_err(|_| LogBufferError::InvalidRecord)
    }
}

fn recover_file(path: &Path) -> Result<(u64, u64), LogBufferError> {
    let file_bytes = file_len(path)?;
    if file_bytes == 0 {
        return Ok((0, 0));
    }
    let source_file = File::open(path).map_err(LogBufferError::Io)?;
    let mut reader = BufReader::new(source_file);
    let mut line = Vec::new();
    let mut valid_bytes = 0u64;
    let mut last_sequence = 0u64;
    loop {
        line.clear();
        let count = reader
            .read_until(b'\n', &mut line)
            .map_err(LogBufferError::Io)?;
        if count == 0 {
            break;
        }
        if line.last() != Some(&b'\n') {
            break;
        }
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        let entry: BufferedLogEntry = match serde_json::from_slice(&line) {
            Ok(entry) => entry,
            Err(_) => break,
        };
        if entry.sequence == 0
            || (last_sequence > 0 && entry.sequence != last_sequence.saturating_add(1))
        {
            break;
        }
        valid_bytes = valid_bytes.saturating_add(count as u64);
        last_sequence = entry.sequence;
    }
    if valid_bytes < file_bytes {
        let file = OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(LogBufferError::Io)?;
        file.set_len(valid_bytes).map_err(LogBufferError::Io)?;
        file.sync_data().map_err(LogBufferError::Io)?;
    }
    Ok((valid_bytes, last_sequence))
}

fn file_len(path: &Path) -> Result<u64, LogBufferError> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(LogBufferError::Io(error)),
    }
}

fn reject_reparse(path: &Path) -> Result<(), LogBufferError> {
    let metadata = fs::symlink_metadata(path).map_err(LogBufferError::Io)?;
    if has_reparse(&metadata) {
        Err(LogBufferError::InvalidPath)
    } else {
        Ok(())
    }
}

fn reject_reparse_if_present(path: &Path) -> Result<(), LogBufferError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => reject_reparse_metadata(&metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(LogBufferError::Io(error)),
    }
}

fn reject_reparse_metadata(metadata: &fs::Metadata) -> Result<(), LogBufferError> {
    if has_reparse(metadata) {
        Err(LogBufferError::InvalidPath)
    } else {
        Ok(())
    }
}

fn has_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x0400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(sequence: u64) -> BufferedLogEntry {
        BufferedLogEntry {
            sequence,
            stream: LogStream::Stdout,
            chunk: "masked".to_string(),
            emitted_at: "2026-08-27T00:00:00Z".to_string(),
        }
    }

    fn buffer_path(root: &Path, task_id: &str) -> PathBuf {
        root.join(LOG_BUFFER_DIRECTORY)
            .join(format!("{}.ndjson", Uuid::parse_str(task_id).unwrap()))
    }

    #[test]
    fn buffer_never_writes_lease_tokens_and_ack_is_monotonic() {
        let root = tempfile::tempdir().expect("workspace root");
        let task_id = Uuid::new_v4().to_string();
        let mut buffer = LogBuffer::new(root.path(), &task_id, 1024).expect("buffer");
        assert!(buffer.append(&entry(1)).expect("append"));
        assert!(!fs::read_dir(root.path().join(LOG_BUFFER_DIRECTORY))
            .expect("buffer directory")
            .filter_map(Result::ok)
            .any(|item| {
                fs::read_to_string(item.path())
                    .unwrap_or_default()
                    .contains("lease")
            }));
        buffer.acknowledge(1).expect("ack");
        buffer.acknowledge(0).expect("old ack");
        assert!(buffer.is_empty());
    }

    #[test]
    fn acknowledgements_compact_only_after_a_threshold_or_when_fully_acked() {
        let root = tempfile::tempdir().expect("workspace root");
        let task_id = Uuid::new_v4().to_string();
        let mut buffer = LogBuffer::new(root.path(), &task_id, 16 * 1024).expect("buffer");
        for sequence in 1..=3 {
            assert!(buffer.append(&entry(sequence)).expect("append"));
        }
        let path = buffer_path(root.path(), &task_id);
        let before = fs::read_to_string(&path).expect("buffer contents");
        buffer.acknowledge(1).expect("ack");
        assert_eq!(fs::read_to_string(&path).expect("buffer contents"), before);
        buffer.acknowledge(2).expect("ack");
        assert_eq!(fs::read_to_string(&path).expect("buffer contents"), before);
        buffer.acknowledge(3).expect("final ack");
        assert!(buffer.is_empty());
    }

    #[test]
    fn future_acknowledgement_is_rejected_without_deleting_unconfirmed_records() {
        let root = tempfile::tempdir().expect("workspace root");
        let task_id = Uuid::new_v4().to_string();
        let mut buffer = LogBuffer::new(root.path(), &task_id, 16 * 1024).expect("buffer");
        assert!(buffer.append(&entry(1)).expect("append"));
        let path = buffer_path(root.path(), &task_id);
        let before = fs::read_to_string(&path).expect("buffer contents");
        assert!(matches!(
            buffer.acknowledge(2),
            Err(LogBufferError::InvalidAcknowledgement)
        ));
        assert_eq!(fs::read_to_string(&path).expect("buffer contents"), before);
    }

    #[test]
    fn incomplete_and_non_contiguous_tail_is_recovered_before_append() {
        let root = tempfile::tempdir().expect("workspace root");
        let task_id = Uuid::new_v4().to_string();
        let mut buffer = LogBuffer::new(root.path(), &task_id, 16 * 1024).expect("buffer");
        assert!(buffer.append(&entry(1)).expect("append"));
        let path = buffer_path(root.path(), &task_id);
        let valid = fs::read(&path).expect("valid buffer");
        fs::write(
            &path,
            [
                valid.as_slice(),
                br#"{"sequence":3,"stream":"stdout","chunk":"gap","emittedAt":"2026-08-27T00:00:00Z"}
"#,
                br#"{"sequence":4,"stream":"stdout","chunk":"partial""#,
            ]
            .concat(),
        )
        .expect("corrupt tail");

        drop(buffer);
        let mut recovered = LogBuffer::new(root.path(), &task_id, 16 * 1024).expect("recovered");
        assert!(recovered.append(&entry(2)).expect("append after recovery"));
        let mut reader = recovered.pending_reader().expect("reader");
        assert_eq!(reader.next().expect("entry").unwrap().sequence, 1);
        assert_eq!(reader.next().expect("entry").unwrap().sequence, 2);
        assert!(reader.next().expect("eof").is_none());
    }

    #[test]
    fn streaming_replacement_failure_keeps_original_buffer() {
        let root = tempfile::tempdir().expect("workspace root");
        let original = root.path().join("original-buffer.ndjson");
        fs::write(&original, b"unconfirmed-record\n").expect("original buffer");
        let temporary = NamedTempFile::new_in(root.path()).expect("temporary");
        fs::write(temporary.path(), b"replacement\n").expect("replacement");
        temporary.as_file().sync_data().expect("sync replacement");

        let result = persist_temporary(
            temporary,
            &root.path().join("missing-directory").join("buffer.ndjson"),
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read(&original).expect("original buffer"),
            b"unconfirmed-record\n"
        );
    }

    #[test]
    fn large_compaction_streams_retained_records_without_loading_the_buffer() {
        let root = tempfile::tempdir().expect("workspace root");
        let task_id = Uuid::new_v4().to_string();
        let mut buffer = LogBuffer::new(root.path(), &task_id, 2 * 1024 * 1024).expect("buffer");
        let chunk = "x".repeat(4096);
        for sequence in 1..=300 {
            assert!(buffer
                .append(&BufferedLogEntry {
                    sequence,
                    stream: LogStream::Stdout,
                    chunk: chunk.clone(),
                    emitted_at: "2026-08-27T00:00:00Z".to_string(),
                })
                .expect("append"));
        }

        let path = buffer_path(root.path(), &task_id);
        let before = fs::metadata(&path).expect("buffer metadata").len();
        assert!(before > 1024 * 1024);
        buffer.acknowledge(1).expect("compact");

        let mut reader = buffer.pending_reader().expect("reader");
        for expected in 2..=300 {
            assert_eq!(reader.next().expect("record").unwrap().sequence, expected);
        }
        assert!(reader.next().expect("eof").is_none());
        assert!(fs::metadata(&path).expect("compacted metadata").len() < before);
    }
}
