# Phase 0 Baseline Evidence

## Scope

This document records the unmodified LiveAgent import baseline used for the GenericAgent integration. It intentionally contains no credentials, environment values, or user data.

- Baseline commit: `b426e5f1f4193c26577fedde9440904083cf249e`
- Commit subject: `chore: import liveagent baseline`
- Branch: `main`
- Remote: none
- Baseline commit trailer: `Co-Authored-By: GenericAgent <bot@gaagent.ai>`
- Tracked baseline: 1,259 files, 25,542,696 bytes
- SHA-256 manifest: `docs/phase0/tracked-files.sha256.csv`
- Manifest SHA-256 at generation: `ab18703a0b4ca759a9c25cc87b010cc29788b82b4847e703cc94007aeade2571`
- Sorted baseline content root: `be62e2924afd118417b6cfb4ce3d387f4328cf0c26b9db3230bdade5b36be7b9`

The manifest hashes the files tracked by the import commit. It does not hash `.git`, generated output, dependency directories, or this Phase 0 documentation commit.

## Ignore and secret-safety audit

`.gitignore` was inspected before relying on the baseline. Physical `git check-ignore -v --no-index` probes confirmed exclusion of:

- `.env` and `.env.*` (except documented templates)
- `*.key`, `*.pem`, `*.p12`, `*.pfx`, and `cert/`
- `node_modules`, `target`, `dist`, `.pnpm-store`
- `.codex`, `.claude`, `.liveagent`, and runtime `workspace`

A tracked-name audit found no tracked credential material. `scripts/release/bootstrap-github-secrets.sh` is a script name, not a secret file. No secret-file contents were read.

## Toolchain observed on Windows x64

| Tool | Observed | Project pin / note |
|---|---:|---|
| Git | 2.54.0.windows.1 | baseline repository |
| Node.js | 22.21.1 portable for gates | `mise.toml` pins 22.19.0 |
| pnpm | 10.32.1 | exact project/CI pin |
| Cargo | 1.96.0 | current local stable |
| rustc | 1.96.0 | current local stable |
| Go | 1.26.3 | `mise.toml` pins 1.25.12 |
| Python | 3.12.10 | evidence scripts only |
| protoc / buf | unavailable locally | proto gates not executed |

The ambient pnpm shim resolved to 11.5.2 and was not used. Gates used `npx --yes pnpm@10.32.1` with `CI=true` so lockfile installs were non-interactive and reproducible.

## Baseline gates

| Area | Gate | Result |
|---|---|---|
| GUI | `pnpm install --frozen-lockfile` | PASS |
| GUI | `pnpm build` | PASS, only existing bundle/externalization warnings |
| GUI | `pnpm lint` | PASS with advisory diagnostics |
| GUI | `pnpm test:release` | PASS, 9/9 |
| GUI | `pnpm test` | PARTIAL, 1 Node wrapper failed because nested Cargo had 2 Windows/WSL-specific Hook failures; 1,190/1,191 Node assertions passed |
| Gateway WebUI | install/build/lint/test | PASS, tests 403/403 |
| Tauri | `cargo check --tests` | PASS with 5 existing warnings |
| Tauri | `cargo test ... chat_history --lib` | PASS |
| Gateway Go | `go test ./...` | PARTIAL on Windows: all other packages passed; `TestDBFilePermissionsAndNoPlaintext` expected Unix mode 0600 but Windows reported 0666 |
| Proto | lint/breaking/generated check | NOT RUN: `protoc` and `buf` unavailable; no remote exists for the breaking baseline |
| Docker | image smoke | NOT RUN: not required for the Windows-only first release and the Gateway is scheduled for removal after MVP |

### Known pre-existing platform failures

1. `commands::automation_commands::hook::tests::{run_hook_script_sync_executes_and_injects_context, run_hook_script_sync_rejects_failed_script}` invoke `bash`; this machine's selected WSL distribution references a missing Fedora43 VHDX. Cargo summary: 540 passed, 2 failed.
2. `internal/auth/agenttoken.TestDBFilePermissionsAndNoPlaintext` asserts Unix permission bits on Windows (`0666`, expected `0600`). This is a platform assertion mismatch; no product source was changed in Phase 0.

Raw command logs are retained in the project-private evidence directory `projects/GA-aee18f3a/phase0_logs/`, not committed to the product repository.

## Reproduction

```powershell
# From repository root; use the exact project pnpm version.
$env:CI='true'
npx --yes pnpm@10.32.1 --dir crates/agent-gui install --frozen-lockfile
npx --yes pnpm@10.32.1 --dir crates/agent-gui build
npx --yes pnpm@10.32.1 --dir crates/agent-gui lint
npx --yes pnpm@10.32.1 --dir crates/agent-gui test
npx --yes pnpm@10.32.1 --dir crates/agent-gui test:release

npx --yes pnpm@10.32.1 --dir crates/agent-gateway/web install --frozen-lockfile
npx --yes pnpm@10.32.1 --dir crates/agent-gateway/web build
npx --yes pnpm@10.32.1 --dir crates/agent-gateway/web lint
npx --yes pnpm@10.32.1 --dir crates/agent-gateway/web test

cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests
cargo test --manifest-path crates/agent-gui/src-tauri/Cargo.toml chat_history --lib
$env:GOPROXY='https://goproxy.cn,direct'
go test ./... # cwd: crates/agent-gateway
```

To verify the manifest, hash the committed blob bytes from `b426e5f` (for example, `git show b426e5f:<path>`) and compare them with the CSV. Do not hash a Windows checkout directly: `core.autocrlf` may convert LF to CRLF even though the checkout is clean. A detached worktree plus Git-object verification is the preferred non-destructive proof of recoverability.
