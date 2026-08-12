import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tauriRoot = path.join(guiRoot, "src-tauri");
const distRoot = path.join(guiRoot, "dist");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(tauriRoot, relativePath), "utf8"));
}

function directiveSources(csp, name) {
  const value = csp?.[name];
  assert.ok(
    value !== undefined,
    `csp.${name} must be defined (see docs/threat-model-2026-08-11.md TM-01 and §7.3)`,
  );
  return Array.isArray(value) ? value : [value];
}

test("shipping CSP is enabled and covers the GA bridge plus Tauri IPC", () => {
  const config = readJson("tauri.conf.json");
  const csp = config.app?.security?.csp;
  assert.ok(csp && typeof csp === "object", "app.security.csp must be a non-null object");

  const connect = directiveSources(csp, "connect-src");
  for (const required of ["ipc:", "http://ipc.localhost", "http://127.0.0.1:*", "ws://127.0.0.1:*"]) {
    assert.ok(connect.includes(required), `connect-src must include ${required}`);
  }

  for (const [directive, required] of [
    ["img-src", ["data:", "blob:", "https:"]],
    ["frame-src", ["blob:"]],
    ["media-src", ["blob:"]],
    ["worker-src", ["'self'"]],
    ["object-src", ["'none'"]],
  ]) {
    const sources = directiveSources(csp, directive);
    for (const source of required) {
      assert.ok(sources.includes(source), `${directive} must include ${source}`);
    }
  }
});

test("shipping script-src stays strict: no unsafe-inline or unsafe-eval", () => {
  const config = readJson("tauri.conf.json");
  const script = directiveSources(config.app.security.csp, "script-src");
  for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'"]) {
    assert.ok(!script.includes(forbidden), `script-src must not contain ${forbidden}`);
  }
});

test("devCsp is defined and keeps dev-only allowances separate", () => {
  const config = readJson("tauri.conf.json");
  const devCsp = config.app?.security?.devCsp;
  assert.ok(devCsp && typeof devCsp === "object", "app.security.devCsp must be a non-null object");
  const connect = directiveSources(devCsp, "connect-src");
  assert.ok(connect.includes("ws://localhost:1420"), "devCsp connect-src must include Vite HMR");
  const script = directiveSources(devCsp, "script-src");
  assert.ok(
    script.includes("'unsafe-inline'"),
    "devCsp script-src must allow the react-refresh preamble inline script",
  );
});

test("platform and release config variants must not override security", () => {
  const variants = [
    "tauri.windows.conf.json",
    "tauri.macos.conf.json",
    "tauri.windows.release.conf.json",
    "tauri.macos.release.conf.json",
    "tauri.linux.release.conf.json",
  ];
  for (const variant of variants) {
    const parsed = readJson(variant);
    assert.ok(
      parsed.app?.security === undefined,
      `${variant} must not define app.security (would override the shipping CSP)`,
    );
  }
});

test("built frontend keeps a zero-inline profile so script-src 'self' suffices", () => {
  assert.ok(existsSync(distRoot), "dist/ is missing; run pnpm build first");
  const html = readFileSync(path.join(distRoot, "index.html"), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, "dist/index.html must not contain inline scripts");
  assert.doesNotMatch(html, /<style/i, "dist/index.html must not contain inline <style>");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "dist/index.html must not contain inline event handlers");
});
