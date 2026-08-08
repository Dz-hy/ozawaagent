import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    "@streamdown/cjk": {
      cjk: {},
    },
    "@streamdown/code": {
      code: {},
    },
    "@streamdown/math": {
      math: {},
    },
    "@streamdown/mermaid": {
      mermaid: {},
    },
    streamdown: {
      Streamdown(props) {
        return { type: "Streamdown", props };
      },
      defaultRemarkPlugins: {},
      defaultRehypePlugins: {},
    },
    "@tauri-apps/plugin-opener": {
      openUrl() {
        throw new Error("openUrl mock was not expected to be called");
      },
    },
    "react-dom": {
      createPortal(children, container) {
        return { type: "portal", children, container };
      },
    },
    "./ui/button": {
      Button(props) {
        return { type: "Button", props };
      },
    },
    "../lib/shared/utils": {
      cn: (...parts) => parts.filter(Boolean).join(" "),
    },
    "../lib/shared/modalMotion": {
      useModalMotion(onClose) {
        return { modalState: "open", requestClose: onClose };
      },
    },
    "@earendil-works/pi-agent-core": {
      Agent: class Agent {},
    },
    "../providers/llm": {
      buildProviderRequestMetadata() {},
      createModelFromConfig() {},
      finalizeProviderStreamOptions() {},
      normalizeErrorMessage(message, fallback) {
        return message || fallback;
      },
      resolveProviderCacheRetention() {},
      toSimpleStreamReasoning(value) {
        return value;
      },
      streamSimpleByApi() {
        throw new Error("streamSimpleByApi mock was not expected to be called");
      },
      buildDualAuthHeaders() {
        return {};
      },
      createStreamingTextReconciler() {
        return {};
      },
    },
    "../debug/agentDebug": {
      buildStreamRequestDebugPayload() {
        return {};
      },
    },
    "../system/powerActivity": {
      withPowerActivity(task) {
        return task;
      },
    },
    "../providers/proxy": {
      prepareProxyRequest() {
        return {};
      },
    },
    "./uiMessages": {
      summarizeToolCall() {
        return "";
      },
    },
    "../requestContextSanitizer": {
      sanitizeContextForModelRequest(context) {
        return context;
      },
    },
  },
});

const markdownModule = loader.loadModule("src/components/Markdown.tsx");

test("markdown image syntax falls back to alt text instead of rendering a real image", () => {
  const node = markdownModule.markdownComponents.img({
    alt: "东门老街",
    title: "深圳夜景",
  });

  assert.ok(node);
  assert.equal(node.type, "span");
  assert.equal(node.props["data-ozawaagent-markdown-image"], "text-fallback");
  assert.equal(node.props.title, "东门老街");
  assert.equal(node.props.children, "东门老街");

  const titleOnly = markdownModule.markdownComponents.img({ title: "南头古城" });
  assert.ok(titleOnly);
  assert.equal(titleOnly.props.children, "南头古城");

  const empty = markdownModule.markdownComponents.img({});
  assert.equal(empty, null);
});

test("external link safety modal renders through document body portal", () => {
  const previousDocument = globalThis.document;
  const body = { nodeType: 1 };
  globalThis.document = { body };

  try {
    const portal = markdownModule.ExternalLinkModal({
      isOpen: true,
      onClose() {},
      onConfirm() {},
      url: "https://example.com/dashboard",
    });

    assert.ok(portal);
    assert.equal(portal.type, "portal");
    assert.equal(portal.container, body);
    assert.equal(portal.children.type, "div");
    assert.match(portal.children.props.className, /\bfixed\b/);
    assert.match(portal.children.props.className, /\binset-0\b/);
  } finally {
    if (typeof previousDocument === "undefined") {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});
