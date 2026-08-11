import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tauriRoot = path.join(guiRoot, "src-tauri");

function source(relativePath) {
  return readFileSync(path.join(tauriRoot, relativePath), "utf8");
}

test("shipping desktop configuration excludes the unauthenticated MCP bridge", () => {
  const cargoManifest = source("Cargo.toml");
  const appBuilder = source("src/lib.rs");
  const mainCapability = source("capabilities/default.json");
  const shippingConfig = `${cargoManifest}\n${appBuilder}\n${mainCapability}`;

  assert.doesNotMatch(shippingConfig, /tauri-plugin-mcp-bridge/);
  assert.doesNotMatch(shippingConfig, /tauri_plugin_mcp_bridge/);
  assert.doesNotMatch(shippingConfig, /mcp-bridge:/);
  assert.doesNotMatch(shippingConfig, /0\.0\.0\.0:9223/);
});
