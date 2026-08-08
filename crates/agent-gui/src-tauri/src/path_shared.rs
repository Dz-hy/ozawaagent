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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rel_path_input_unifies_separators_and_trims() {
        assert_eq!(normalize_rel_path_input("  a\\b\\c  "), "a/b/c");
        assert_eq!(normalize_rel_path_input(""), "");
        assert_eq!(
            normalize_rel_path_input("C:\\Users\\x\\f.txt"),
            "C:/Users/x/f.txt"
        );
        assert_eq!(normalize_rel_path_input("already/posix"), "already/posix");
        assert_eq!(
            normalize_rel_path_input("  spaced name\\tail "),
            "spaced name/tail"
        );
    }

    #[test]
    fn rel_to_workdir_str_strips_prefix_or_falls_back() {
        assert_eq!(
            rel_to_workdir_str(Path::new("/work/dir"), Path::new("/work/dir/sub/file.txt")),
            "sub/file.txt"
        );
        // 同级文件直接文件名
        assert_eq!(
            rel_to_workdir_str(Path::new("/work/dir"), Path::new("/work/dir/f.txt")),
            "f.txt"
        );
        // 前缀匹配但不完整（/work / dir 是部分匹配，strip 失败回落绝对路径）
        let partial = rel_to_workdir_str(Path::new("/work"), Path::new("/workx/y.txt"));
        assert_eq!(partial, "/workx/y.txt");
        // 反斜杠统一为 /
        let bs = rel_to_workdir_str(Path::new("C:/w"), Path::new("C:/w/sub"));
        assert_eq!(bs, "sub");
    }

    #[test]
    fn reserved_windows_components_are_detected_case_insensitively() {
        for name in [
            "CON", "con", "Con", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9", "com3",
        ] {
            assert!(
                is_windows_reserved_path_component(name),
                "{name} 应为保留名"
            );
        }
        // 扩展名不影响：保留后缀仍判保留
        assert!(is_windows_reserved_path_component("CON.txt"));
        assert!(is_windows_reserved_path_component("NUL.log"));
        // 尾部点/空格容忍
        assert!(is_windows_reserved_path_component("CON ."));
        // 非保留：COM0/LPT0（规则要求非零）、COM10+（长度>4）、普通名
        for name in [
            "COM0", "LPT0", "COM10", "LPT10", "CONSOLE", "PRINTER", "normal", "co n",
        ] {
            assert!(
                !is_windows_reserved_path_component(name),
                "{name} 不应判保留"
            );
        }
    }

    #[test]
    fn looks_like_svg_detects_svg_markers_in_prefix() {
        assert!(looks_like_svg(b"<svg width=\"10\"/>"));
        assert!(looks_like_svg(b"<svg>"));
        assert!(looks_like_svg(b"\xef\xbb\xbf<svg>"));
        // 头部空白的 <svg 会被 trim 后识别
        assert!(looks_like_svg(b"   <svg"));
        // 内容深处的 <svg（1024 字节前缀内）也命中
        let mut padded = vec![b'x'; 900];
        padded.extend_from_slice(b"<svg>tail");
        assert!(looks_like_svg(&padded));
        // 非 svg
        assert!(looks_like_svg(b"<html><svg-not-really/x>"));
        assert!(!looks_like_svg(b"<SVG>"));
        assert!(!looks_like_svg(b""));
        assert!(looks_like_svg(b"{\"k\":\"<svg>\"}"));
    }
}
