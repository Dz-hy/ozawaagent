# 🪐 OzawaAgent

<p align="center">
  <strong>Local-First AI Agent Desktop</strong><br/>
  GenericAgent kernel · multi-model · local tool execution · MCP & Skills ecosystem
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> | English
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blueviolet" />
  <img alt="Tauri" src="https://img.shields.io/badge/built%20with-Tauri%202-FFC131?logo=tauri&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-B7410E?logo=rust&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
</p>

---

## Why OzawaAgent?

OzawaAgent is a **local-first** AI Agent desktop client built around the
GenericAgent kernel. It combines large language model reasoning with deep
local system tooling — file access, precise editing, shell execution, and
scheduled automation — all running on your machine, with no remote relay.

- **An agent that actually acts** — beyond chat: read/write files, exact edits, Bash, managed long-running processes
- **Open ecosystem** — MCP protocol bridges any external tool; Skills packages load on demand
- **Local by design** — full loop runs locally, no dependency on remote servers

---

## Core capabilities

- **Multi-model routing** — Claude (Anthropic), Codex (OpenAI), Gemini protocols; custom Base URL for compatible third-party services
- **Rich rendering** — streaming Markdown with KaTeX math, Mermaid diagrams and Monaco code preview
- **Local tool execution** — Read/Write/Edit/Delete, Glob/Grep with regex, non-interactive Bash, ManagedProcess for dev servers
- **Sub-Agent delegation** — parallel sub-agents with worktree isolation and automatic merge
- **MCP & Skills** — native stdio/http MCP server bridging; progressive-disclosure Skills with install/create/package and ClawHub ecosystem
- **Memory** — Markdown + SQLite FTS full-text search, cross-session knowledge
- **Automation** — bash/http/prompt Cron jobs and hooks run in the background
- **History compaction** — Segment + Summary Checkpoint persistence for long conversations
- **i18n** — built-in multilingual framework

## Download & deploy

Release installers are built, signed and published by GitHub Actions — see
[**GitHub Releases**](https://github.com/Dz-hy/ozawaagent/releases/latest).

### System requirements

| Platform | Requirement |
|---|---|
| macOS | Intel (x64) and Apple Silicon (aarch64) |
| Windows | x64, WebView2 Runtime required |
| Linux | x86_64 (AppImage / deb / rpm) |

## Development

```bash
make dev        # Tauri dev environment
make build      # Build the desktop app
make test       # run all test gates
```

See [docs/operations/development.md](docs/operations/development.md) and
[docs/architecture/overview.md](docs/architecture/overview.md) for details.

## Docs

- [Architecture overview](docs/architecture/overview.md)
- [GUI architecture](docs/architecture/gui.md)
- [Feature docs](docs/features/chat-runtime.md)
- [Operations & deployment](docs/operations/deployment.md)
- [Source map](docs/reference/source-map.md)

## Contributing

Issues and PRs are welcome. Before submitting a PR, make sure the CI gates
pass for `crates/agent-gui`:

1. Type check and build: `pnpm build`
2. Lint: `pnpm lint`
3. Frontend tests: `pnpm test:frontend` (plus `pnpm test:release` when release scripts change)
4. Rust checks: `cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests`
5. Keep the diff clean: `git diff --check`

## License

MIT © 2026 Dz-hy (OzawaAgent). The repository contains upstream components
under their own MIT licenses (LiveAgent © Stack-Cairn, GenericAgent © lsdefine);
see [NOTICE](NOTICE) for details.