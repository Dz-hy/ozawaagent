import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import remarkBreaks from "remark-breaks";
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";

// ── 渲染安全回归门禁 ────────────────────────────────────────────────────────
// 钉住 Markdown / MCP / 工具输出渲染管线的消毒属性（威胁模型 TM-01，
// 票 01「渲染安全门禁」）。与 src/components/Markdown.tsx 共用同一条
// streamdown 插件链：remark → rehype-raw → rehype-sanitize（defaultSchema，
// src 额外放行 data: 以便内嵌图片）→ rehype-harden。
//
// 注意：SSR 采用 Streamdown 的 children+mode 上层 API（content 模式在服务端
// 不渲染内容，无法断言）。两种 API 共用同一 remark/rehype 消毒链；真实浏览器
// 的 DOM 级验证（含 mermaid 渲染）仍属打包后 E2E 范围，本门禁保证库升级时
// 消毒属性先于人工验证失效。见 docs/threat-model-2026-08-11.md。

function buildRehypePlugins() {
  // 镜像 Markdown.tsx 的 relativeUrlRehypePlugins（raw → sanitize(+data: src) → harden）
  const sanitize = defaultRehypePlugins.sanitize;
  if (!Array.isArray(sanitize)) {
    return [defaultRehypePlugins.raw, sanitize, defaultRehypePlugins.harden];
  }
  const schema = sanitize[1] ?? {};
  const srcProtocols = schema.protocols?.src;
  const protocols = {
    ...schema.protocols,
    src: Array.isArray(srcProtocols)
      ? [...new Set([...srcProtocols, "data"])]
      : ["http", "https", "data"],
  };
  return [
    defaultRehypePlugins.raw,
    [sanitize[0], { ...schema, protocols }],
    defaultRehypePlugins.harden,
  ];
}

function renderMarkdown(content) {
  return renderToStaticMarkup(
    React.createElement(Streamdown, {
      children: content,
      mode: "static",
      remarkPlugins: [...Object.values(defaultRemarkPlugins), remarkBreaks],
      rehypePlugins: buildRehypePlugins(),
    }),
  );
}

const SCRIPTABLE_PATTERNS = [
  { pattern: /<script/i, label: "script elements" },
  { pattern: /\son\w+\s*=/i, label: "inline event handlers" },
  { pattern: /javascript:/i, label: "javascript: URLs" },
  { pattern: /data:text\/html/i, label: "data:text/html URLs" },
  { pattern: /<iframe/i, label: "iframe elements" },
];

// 不可信输入 fixtures：聊天内容、工具/MCP 返回值、文件预览都可能携带这些形态。
const XSS_PAYLOADS = [
  "<script>alert(1)</script>",
  '<img src="x" onerror="alert(1)">',
  '<svg onload="alert(1)"></svg>',
  '<svg><script>alert(1)</script></svg>',
  '<a href="javascript:alert(1)">click</a>',
  "<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">click</a>",
  "[click me](javascript:alert(1))",
  "[click me](vbscript:msgbox(1))",
  "[click me](data:text/html,<script>alert(1)</script>)",
  "<iframe src=\"https://evil.example\"></iframe>",
  "<details open ontoggle=\"alert(1)\"><summary>x</summary></details>",
  "<video><source onerror=\"alert(1)\"></video>",
  '![img](data:text/html,<script>alert(1)</script>)',
  // 经典 mXSS 载荷：浏览器解析器重建后若未二次消毒可产生可执行 img
  '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
];

test("markdown/MCP/tool-output pipeline neutralizes scriptable payloads", () => {
  for (const payload of XSS_PAYLOADS) {
    const html = renderMarkdown(payload);
    for (const { pattern, label } of SCRIPTABLE_PATTERNS) {
      assert.doesNotMatch(
        html,
        pattern,
        `payload ${JSON.stringify(payload.slice(0, 60))} leaked ${label}:\n${html.slice(0, 240)}`,
      );
    }
  }
});

test("blocked URLs degrade to a visible placeholder instead of a link", () => {
  const html = renderMarkdown("[click me](javascript:alert(1))");
  assert.match(html, /Blocked URL/i, "javascript: links must render as a blocked placeholder");
  assert.doesNotMatch(html, /href=/i, "blocked URLs must never produce an anchor href");
});

test("benign markdown still renders through the same pipeline", () => {
  const html = renderMarkdown(
    [
      "# Title",
      "",
      "**bold** text and [safe link](https://example.com/docs).",
      "",
      "![inline png](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n"),
  );
  assert.match(html, /<h1/, "headings must render");
  assert.match(
    html,
    /data-streamdown="strong"/,
    "bold must render (streamdown renders strong as a data-streamdown span)",
  );
  assert.match(html, /data:image\/png;base64/, "data: image sources must render (app-intended)");
  assert.doesNotMatch(html, /<script/i, "benign content must not introduce scripts");
});