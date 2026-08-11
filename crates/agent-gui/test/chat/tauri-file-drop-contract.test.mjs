import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync(
  new URL("../../src/pages/chat/hooks/useTauriFileDrop.ts", import.meta.url),
  "utf8",
);

test("file-drop listener skips Tauri webview access in a normal browser", () => {
  assert.match(hook, /function isTauriRuntime\(\)/);
  assert.match(
    hook,
    /runtimeWindow\.__TAURI__ !== undefined \|\| runtimeWindow\.__TAURI_INTERNALS__ !== undefined/,
  );

  const guard = hook.indexOf("if (!isTauriRuntime()) return;");
  const webviewSubscription = hook.indexOf("getCurrentWebview()\n      .onDragDropEvent");
  assert.ok(guard >= 0, "the browser-runtime guard is present");
  assert.ok(webviewSubscription > guard, "the guard runs before the webview subscription");
});
