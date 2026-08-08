//! 跨模块共享的路径/文件探测辅助（从重复定义中收敛，逐字迁移保持行为不变）。
//! 合并规则：仅当两个调用方的实现逐字节一致时才允许收拢到本模块；
//! 实现有差异的（如 canonicalize_workdir 的多份变体）必须留在原地。

use std::path::Path;

pub(crate) fn normalize_rel_path_input(input: &str) -> String {
    input.trim().replace('\\', "/")
}

pub(crate) fn rel_to_workdir_str(workdir: &Path, abs: &Path) -> String {
    abs.strip_prefix(workdir)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn is_windows_reserved_path_component(input: &str) -> bool {
    let stem = input
        .split('.')
        .next()
        .unwrap_or(input)
        .trim_matches(|ch| ch == ' ' || ch == '.')
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

pub(crate) fn looks_like_svg(bytes: &[u8]) -> bool {
    let prefix_len = bytes.len().min(1024);
    let prefix = String::from_utf8_lossy(&bytes[..prefix_len]);
    let trimmed = prefix.trim_start_matches('\u{feff}').trim_start();
    trimmed.starts_with("<svg") || trimmed.contains("<svg")
}
