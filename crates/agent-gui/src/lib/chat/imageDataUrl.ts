const IMAGE_MIME_PREFIX = "image/";

/**
 * data: URL 的 MIME 白名单：仅允许 image/*（含 image/svg+xml——浏览器在
 * `<img>` 上下文中把 SVG 视为 inert 图片，不执行脚本）。模型/工具/引擎返回的
 * 非图片 MIME（text/html、application/xhtml+xml 等）一律不构造 data: URL。
 * 见 docs/threat-model-2026-08-11.md §9.3。
 */
export function isImageDataMimeType(mimeType: string) {
  return mimeType.split(";")[0].trim().toLowerCase().startsWith(IMAGE_MIME_PREFIX);
}

export function buildSafeImageDataUrl(mimeType: string, data: string) {
  // 用规范化后的 MIME 构造（丢弃参数与前导/尾随空白），避免把不可信原始
  // 串拼进 data: URL。
  const normalized = mimeType.split(";")[0].trim();
  if (!normalized.toLowerCase().startsWith(IMAGE_MIME_PREFIX)) return null;
  return `data:${normalized};base64,${data}`;
}
