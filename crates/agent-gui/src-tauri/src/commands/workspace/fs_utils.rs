//! fs.rs 中无内部依赖的纯工具函数（从超大文件中拆分，逐字迁移保持行为不变）。
//! 拆分规则：仅提取零文件内引用或引用伙伴均在集合内的函数；对文件级
//! const/自定义类型有依赖的（如 DEFAULT_*、FsError）必须留在 fs.rs。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::path_shared::looks_like_svg;
use serde_json::Value;

pub(crate) fn levenshtein_at_most(a: &str, b: &str, max: usize) -> bool {
    let a: Vec<char> = a.chars().take(64).collect();
    let b: Vec<char> = b.chars().take(64).collect();
    if a.len().abs_diff(b.len()) > max {
        return false;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = Vec::with_capacity(b.len() + 1);
        cur.push(i + 1);
        let mut row_min = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            let value = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
            row_min = row_min.min(value);
            cur.push(value);
        }
        if row_min > max {
            return false;
        }
        prev = cur;
    }
    prev[b.len()] <= max
}
pub(crate) fn normalize_glob_pattern_input(input: &str) -> String {
    input.trim().replace('\\', "/")
}
pub(crate) fn hash_bytes(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
pub(crate) fn logical_rel_path(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}
pub(crate) fn split_text_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split_inclusive('\n').collect()
    }
}
pub(crate) fn infer_image_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("avif") => Some("image/avif"),
        Some("bmp") => Some("image/bmp"),
        Some("svg") => Some("image/svg+xml"),
        Some("ico") => Some("image/x-icon"),
        _ => None,
    }
}
pub(crate) fn infer_image_mime_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && bytes[8..].windows(4).any(|w| w == b"avif") {
        return Some("image/avif");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    if looks_like_svg(bytes) {
        return Some("image/svg+xml");
    }
    None
}
pub(crate) fn is_pdf_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("pdf")),
        Some(true)
    )
}
pub(crate) fn is_notebook_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("ipynb")),
        Some(true)
    )
}
pub(crate) fn file_name_lower(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}
pub(crate) fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}
pub(crate) fn path_to_file_url(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut encoded = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '/' | ':' | '.' | '-' | '_' | '~' => {
                encoded.push(ch);
            }
            _ => {
                let mut buf = [0u8; 4];
                for byte in ch.encode_utf8(&mut buf).as_bytes() {
                    encoded.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}
pub(crate) fn truncate_text_to_byte_limit(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }

    let mut end = 0usize;
    for (idx, ch) in text.char_indices() {
        let next = idx + ch.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    (text[..end].to_string(), true)
}
pub(crate) fn join_text_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}
pub(crate) fn truncate_block_preview(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let preview = trimmed.chars().take(max_chars).collect::<String>();
    format!("{preview}...")
}
pub(crate) fn decode_xml_entities(input: &str) -> String {
    // 办公文档 XML 由软件生成，正常都能解码；遇到非法实体时保留原文降级。
    match quick_xml::escape::unescape(input) {
        Ok(decoded) => decoded.into_owned(),
        Err(_) => input.to_string(),
    }
}
pub(crate) fn normalize_text_preview(input: &str) -> String {
    input
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
pub(crate) fn extract_xml_elements(xml: &str, tag_name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    let start_pattern = format!("<{tag_name}");
    let end_pattern = format!("</{tag_name}>");

    while let Some(start_rel) = xml[cursor..].find(&start_pattern) {
        let start = cursor + start_rel;
        let Some(start_end_rel) = xml[start..].find('>') else {
            break;
        };
        let body_start = start + start_end_rel + 1;
        let Some(end_rel) = xml[body_start..].find(&end_pattern) else {
            break;
        };
        let end = body_start + end_rel;
        out.push(xml[body_start..end].to_string());
        cursor = end + end_pattern.len();
    }

    out
}
pub(crate) fn extract_xml_tag_bodies(xml: &str, tag_name: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    let start_pattern = format!("<{tag_name}");
    let end_pattern = format!("</{tag_name}>");

    while let Some(start_rel) = xml[cursor..].find(&start_pattern) {
        let start = cursor + start_rel;
        let Some(start_end_rel) = xml[start..].find('>') else {
            break;
        };
        let start_end = start + start_end_rel;
        let body_start = start_end + 1;
        let Some(end_rel) = xml[body_start..].find(&end_pattern) else {
            break;
        };
        let end = body_start + end_rel;
        out.push((
            xml[start + 1..start_end].to_string(),
            xml[body_start..end].to_string(),
        ));
        cursor = end + end_pattern.len();
    }

    out
}
pub(crate) fn build_line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (idx, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(idx + 1);
        }
    }
    starts
}
pub(crate) fn byte_index_to_line(line_starts: &[usize], index: usize) -> usize {
    match line_starts.binary_search(&index) {
        Ok(pos) => pos + 1,
        Err(pos) => pos.max(1),
    }
}
pub(crate) fn split_lines_for_grep(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}
pub(crate) fn remove_symlink_path(target: &Path) -> Result<(), io::Error> {
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(file_err) => match fs::remove_dir(target) {
            Ok(()) => Ok(()),
            Err(_) => Err(file_err),
        },
    }
}
