use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const DATA_DIR_NAME: &str = ".liveagent";
const ARCHIVES_DIR_NAME: &str = "archives";
const ARCHIVE_PREFIX: &str = "legacy-archive-v1-";
const MANIFEST_NAME: &str = "manifest.json";
const FORMAT_VERSION: u32 = 1;
const STAGING_PREFIX: &str = ".legacy-archive-v1-";

static ARCHIVE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ArchivedFile {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ArchiveManifest {
    format_version: u32,
    created_at_ms: u64,
    files: Vec<ArchivedFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyArchiveSummary {
    pub path: String,
    pub created_at_ms: u64,
    pub file_count: usize,
}

pub fn archive_once() -> Result<LegacyArchiveSummary, String> {
    let lock = ARCHIVE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "legacy archive lock was poisoned".to_string())?;
    let root = data_root()?;
    archive_once_at(&root)
}

pub fn complete_archive_dir() -> Result<Option<PathBuf>, String> {
    let root = data_root()?;
    Ok(latest_complete_archive(&root)?.map(|(path, _)| path))
}

fn data_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(DATA_DIR_NAME))
        .ok_or_else(|| "无法定位用户数据目录".to_string())
}

fn archive_dir_for(root: &Path, created_at_ms: u64) -> PathBuf {
    root.join(ARCHIVES_DIR_NAME)
        .join(format!("{ARCHIVE_PREFIX}{created_at_ms}"))
}

fn staging_dir_for(root: &Path, created_at_ms: u64) -> PathBuf {
    root.join(ARCHIVES_DIR_NAME)
        .join(format!("{STAGING_PREFIX}{created_at_ms}"))
}

fn latest_complete_archive(root: &Path) -> Result<Option<(PathBuf, ArchiveManifest)>, String> {
    let archives_root = root.join(ARCHIVES_DIR_NAME);
    if !archives_root.is_dir() {
        return Ok(None);
    }

    let mut candidates = Vec::new();
    for entry in
        fs::read_dir(&archives_root).map_err(|error| format!("读取归档目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取归档目录项失败：{error}"))?;
        let path = entry.path();
        let entry_type = entry
            .file_type()
            .map_err(|error| format!("读取归档目录项类型失败 {}：{error}", path.display()))?;
        if !entry_type.is_dir() || entry_type.is_symlink() {
            continue;
        }

        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(timestamp) = name
            .strip_prefix(ARCHIVE_PREFIX)
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };

        // A malformed or partial archive is never a reason to overwrite it,
        // but it also must not prevent a new timestamped archive from being made.
        if let Ok(Some(manifest)) = read_complete_manifest(&path) {
            candidates.push((timestamp, path, manifest));
        }
    }

    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.as_os_str().cmp(right.1.as_os_str()))
    });
    Ok(candidates.pop().map(|(_, path, manifest)| (path, manifest)))
}

fn archive_once_at(root: &Path) -> Result<LegacyArchiveSummary, String> {
    archive_once_at_timestamp(root, timestamp_ms())
}

fn archive_once_at_timestamp(
    root: &Path,
    created_at_ms: u64,
) -> Result<LegacyArchiveSummary, String> {
    let archives_root = root.join(ARCHIVES_DIR_NAME);
    fs::create_dir_all(&archives_root).map_err(|error| format!("创建归档目录失败：{error}"))?;

    if let Some((path, manifest)) = latest_complete_archive(root)? {
        return Ok(summary_for(&path, &manifest));
    }

    let (created_at_ms, target, staging) = next_archive_paths(&archives_root, created_at_ms)?;
    fs::create_dir_all(&staging).map_err(|error| format!("创建归档临时目录失败：{error}"))?;

    let result = build_archive(root, &staging, created_at_ms);
    let manifest = match result {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("序列化归档manifest失败：{error}"))?;
    let manifest_path = staging.join(MANIFEST_NAME);
    let mut manifest_file =
        File::create(&manifest_path).map_err(|error| format!("创建归档manifest失败：{error}"))?;
    manifest_file
        .write_all(&manifest_bytes)
        .and_then(|_| manifest_file.sync_all())
        .map_err(|error| format!("写入归档manifest失败：{error}"))?;
    drop(manifest_file);

    if let Err(error) = fs::rename(&staging, &target) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("提交归档目录失败：{error}"));
    }

    Ok(summary_for(&target, &manifest))
}

fn next_archive_paths(
    archives_root: &Path,
    mut created_at_ms: u64,
) -> Result<(u64, PathBuf, PathBuf), String> {
    loop {
        let root = archives_root
            .parent()
            .ok_or_else(|| "归档根目录无效".to_string())?;
        let target = archive_dir_for(root, created_at_ms);
        let staging = staging_dir_for(root, created_at_ms);
        if !target.exists() && !staging.exists() {
            return Ok((created_at_ms, target, staging));
        }
        created_at_ms = created_at_ms
            .checked_add(1)
            .ok_or_else(|| "归档时间戳耗尽".to_string())?;
    }
}

fn build_archive(
    root: &Path,
    staging: &Path,
    created_at_ms: u64,
) -> Result<ArchiveManifest, String> {
    let mut files = Vec::new();

    for name in [
        "config.sqlite",
        "config.sqlite-shm",
        "config.sqlite-wal",
        "chat-history.sqlite3",
        "chat-history.sqlite3-shm",
        "chat-history.sqlite3-wal",
    ] {
        let source = root.join(name);
        if source.exists() {
            copy_file(root, &source, staging, &mut files)?;
        }
    }

    for directory in ["memory", "skills"] {
        let source = root.join(directory);
        if source.exists() {
            copy_directory(root, &source, staging, &mut files)?;
        }
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ArchiveManifest {
        format_version: FORMAT_VERSION,
        created_at_ms,
        files,
    })
}

fn copy_directory(
    root: &Path,
    source: &Path,
    staging: &Path,
    files: &mut Vec<ArchivedFile>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("读取归档目录失败 {}：{error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("归档源目录不能是符号链接：{}", source.display()));
    }

    for entry in fs::read_dir(source)
        .map_err(|error| format!("读取归档目录失败 {}：{error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("读取归档目录项失败：{error}"))?;
        let path = entry.path();
        let entry_type = entry
            .file_type()
            .map_err(|error| format!("读取归档目录项类型失败 {}：{error}", path.display()))?;
        if entry_type.is_symlink() {
            return Err(format!("归档源不能包含符号链接：{}", path.display()));
        }
        if entry_type.is_dir() {
            copy_directory(root, &path, staging, files)?;
        } else if entry_type.is_file() {
            copy_file(root, &path, staging, files)?;
        } else {
            return Err(format!("归档源包含不支持的文件类型：{}", path.display()));
        }
    }
    Ok(())
}

fn copy_file(
    root: &Path,
    source: &Path,
    staging: &Path,
    files: &mut Vec<ArchivedFile>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("读取归档文件失败 {}：{error}", source.display()))?;
    if !metadata.file_type().is_file() {
        return Err(format!("归档源不是普通文件：{}", source.display()));
    }

    let relative = source
        .strip_prefix(root)
        .map_err(|_| format!("归档路径越界：{}", source.display()))?;
    let target = staging.join(relative);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建归档文件目录失败：{error}"))?;
    }
    fs::copy(source, &target).map_err(|error| {
        format!(
            "复制归档文件失败 {} -> {}：{error}",
            source.display(),
            target.display()
        )
    })?;

    let (bytes, sha256) = hash_file(&target)?;
    files.push(ArchivedFile {
        path: relative.to_string_lossy().replace('\\', "/"),
        bytes,
        sha256,
    });
    Ok(())
}

fn hash_file(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("读取归档副本失败 {}：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("计算归档哈希失败 {}：{error}", path.display()))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let sha256 = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((bytes, sha256))
}

fn read_complete_manifest(target: &Path) -> Result<Option<ArchiveManifest>, String> {
    let Some(directory_name) = target.file_name().and_then(|value| value.to_str()) else {
        return Ok(None);
    };
    let Some(directory_timestamp) = directory_name
        .strip_prefix(ARCHIVE_PREFIX)
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return Ok(None);
    };

    let path = target.join(MANIFEST_NAME);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|error| format!("读取归档manifest失败：{error}"))?;
    let manifest = serde_json::from_slice::<ArchiveManifest>(&bytes)
        .map_err(|error| format!("解析归档manifest失败：{error}"))?;
    if manifest.format_version != FORMAT_VERSION
        || manifest.created_at_ms == 0
        || manifest.created_at_ms != directory_timestamp
    {
        return Ok(None);
    }

    let mut expected_paths = std::collections::HashSet::new();
    for archived in &manifest.files {
        let relative = Path::new(&archived.path);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::Prefix(_)
                        | std::path::Component::RootDir
                        | std::path::Component::ParentDir
                )
            })
            || archived.path.is_empty()
            || !expected_paths.insert(archived.path.clone())
        {
            return Ok(None);
        }
        let file = target.join(relative);
        let metadata = match fs::symlink_metadata(&file) {
            Ok(metadata) => metadata,
            Err(_) => return Ok(None),
        };
        if !metadata.file_type().is_file() {
            return Ok(None);
        }
        let (bytes, sha256) = match hash_file(&file) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if bytes != archived.bytes || sha256 != archived.sha256 {
            return Ok(None);
        }
    }

    let mut actual_paths = Vec::new();
    collect_archive_files(target, target, &mut actual_paths)
        .map_err(|_| "读取归档文件失败".to_string())?;
    actual_paths.sort();
    let mut manifest_paths = expected_paths.into_iter().collect::<Vec<_>>();
    manifest_paths.sort();
    if actual_paths != manifest_paths {
        return Ok(None);
    }
    Ok(Some(manifest))
}

fn collect_archive_files(
    root: &Path,
    directory: &Path,
    paths: &mut Vec<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        if relative == Path::new(MANIFEST_NAME) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!("归档包含符号链接：{}", path.display()));
        }
        if metadata.is_dir() {
            collect_archive_files(root, &path, paths)?;
        } else if metadata.is_file() {
            paths.push(relative.to_string_lossy().replace('\\', "/"));
        } else {
            return Err(format!("归档包含不支持的文件：{}", path.display()));
        }
    }
    Ok(())
}

fn summary_for(target: &Path, manifest: &ArchiveManifest) -> LegacyArchiveSummary {
    LegacyArchiveSummary {
        path: target.to_string_lossy().into_owned(),
        created_at_ms: manifest.created_at_ms,
        file_count: manifest.files.len(),
    }
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn archives_allowlisted_data_without_copying_workspace_or_uploads() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join(".liveagent");
        fs::create_dir_all(root.join("memory/project")).expect("memory");
        fs::create_dir_all(root.join("skills/demo")).expect("skills");
        fs::create_dir_all(root.join("workspace")).expect("workspace");
        fs::create_dir_all(root.join("uploads")).expect("uploads");
        fs::write(
            root.join("config.sqlite"),
            br#"{"apikey":"secret-not-in-manifest"}"#,
        )
        .expect("config");
        fs::write(root.join("config.sqlite-wal"), b"config-wal").expect("config wal");
        fs::write(root.join("config.sqlite-shm"), b"config-shm").expect("config shm");
        fs::write(root.join("chat-history.sqlite3"), b"history").expect("history");
        fs::write(root.join("chat-history.sqlite3-wal"), b"history-wal").expect("history wal");
        fs::write(root.join("chat-history.sqlite3-shm"), b"history-shm").expect("history shm");
        fs::write(root.join("memory/memory-index.sqlite3"), b"memory-index").expect("memory db");
        fs::write(root.join("memory/memory-index.sqlite3-wal"), b"memory-wal").expect("memory wal");
        fs::write(root.join("memory/memory-index.sqlite3-shm"), b"memory-shm").expect("memory shm");
        fs::write(root.join("memory/project/project_memory.md"), b"memory").expect("memory");
        fs::write(root.join("skills/demo/SKILL.md"), b"skill").expect("skill");
        fs::write(root.join("workspace/private.txt"), b"do not copy").expect("workspace");
        fs::write(root.join("uploads/private.txt"), b"do not copy").expect("uploads");

        let summary = archive_once_at(&root).expect("archive");
        let archive = PathBuf::from(&summary.path);
        assert_eq!(summary.file_count, 11);
        assert!(archive.join("config.sqlite").is_file());
        assert!(archive.join("config.sqlite-wal").is_file());
        assert!(archive.join("config.sqlite-shm").is_file());
        assert!(archive.join("chat-history.sqlite3").is_file());
        assert!(archive.join("chat-history.sqlite3-wal").is_file());
        assert!(archive.join("chat-history.sqlite3-shm").is_file());
        assert!(archive.join("memory/memory-index.sqlite3").is_file());
        assert!(archive.join("memory/memory-index.sqlite3-wal").is_file());
        assert!(archive.join("memory/memory-index.sqlite3-shm").is_file());
        assert!(archive.join("memory/project/project_memory.md").is_file());
        assert!(archive.join("skills/demo/SKILL.md").is_file());
        assert!(!archive.join("workspace/private.txt").exists());
        assert!(!archive.join("uploads/private.txt").exists());

        let manifest = fs::read_to_string(archive.join(MANIFEST_NAME)).expect("manifest");
        assert!(!manifest.contains("secret-not-in-manifest"));
        assert!(!manifest.contains("private.txt"));
    }

    #[test]
    fn repeated_archive_is_idempotent_and_does_not_overwrite_target() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join(".liveagent");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("config.sqlite"), b"first").expect("config");

        let first = archive_once_at(&root).expect("first archive");
        fs::write(root.join("config.sqlite"), b"changed-after-first-start").expect("config");
        let second = archive_once_at(&root).expect("second archive");

        assert_eq!(first, second);
        let archive = PathBuf::from(&first.path);
        assert!(archive
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with(ARCHIVE_PREFIX)));
        assert_eq!(fs::read(archive.join("config.sqlite")).unwrap(), b"first");
        assert!(read_complete_manifest(&archive)
            .expect("manifest read")
            .is_some());
    }

    #[test]
    fn tampered_archive_is_not_reused() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join(".liveagent");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("config.sqlite"), b"source").expect("config");

        let first = archive_once_at_timestamp(&root, 700).expect("first archive");
        let first_path = PathBuf::from(&first.path);
        fs::write(first_path.join("config.sqlite"), b"tampered").expect("tamper archive");
        fs::write(first_path.join("unexpected.txt"), b"extra").expect("extra archive file");

        assert!(read_complete_manifest(&first_path)
            .expect("tampered manifest read")
            .is_none());
        let second = archive_once_at_timestamp(&root, 700).expect("replacement archive");
        assert_eq!(second.created_at_ms, 701);
        assert_ne!(first.path, second.path);
        assert_eq!(
            fs::read(PathBuf::from(&second.path).join("config.sqlite"))
                .expect("replacement config"),
            b"source"
        );
        assert!(read_complete_manifest(&PathBuf::from(&second.path))
            .expect("replacement manifest read")
            .is_some());
        assert_eq!(
            fs::read(first_path.join("config.sqlite")).unwrap(),
            b"tampered"
        );
    }

    #[test]
    fn incomplete_target_is_never_overwritten() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join(".liveagent");
        let target = archive_dir_for(&root, 100);
        fs::create_dir_all(&target).expect("target");
        fs::write(target.join("user-file.txt"), b"preserve").expect("user file");

        let summary = archive_once_at_timestamp(&root, 100).expect("archive after partial target");
        assert_eq!(summary.created_at_ms, 101);
        assert_eq!(fs::read(target.join("user-file.txt")).unwrap(), b"preserve");
        assert!(PathBuf::from(&summary.path).is_dir());
    }

    #[test]
    fn timestamp_collision_advances_without_overwriting_partial_target() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join(".liveagent");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("config.sqlite"), b"source").expect("config");
        let occupied = archive_dir_for(&root, 500);
        fs::create_dir_all(&occupied).expect("occupied");
        fs::write(occupied.join("keep.txt"), b"keep").expect("occupied file");

        let summary = archive_once_at_timestamp(&root, 500).expect("archive after collision");
        assert_eq!(summary.created_at_ms, 501);
        assert_eq!(
            fs::read(occupied.join("keep.txt")).expect("kept file"),
            b"keep"
        );
        assert!(PathBuf::from(&summary.path).is_dir());
    }
}
