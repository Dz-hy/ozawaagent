# Architecture Decision Record: GenericAgent Integration Baseline

- Status: Accepted
- Date: 2026-07-27
- Scope: LiveAgent desktop second development
- Decision source: user-approved implementation plan

## Context

LiveAgent currently implements Agent execution in React/TypeScript and includes a separate Gateway/remote stack. GenericAgent is the sole target Agent core. The product must preserve the familiar desktop UI and local workspace capabilities without retaining two Agent truth sources.

## Accepted decisions

### ADR-01 — Preserve UI, replace runtime
Keep LiveAgent's visual design and major interactions. React state and calls may change, but GenericAgent owns the complete Agent core.

### ADR-02 — Development and release runtime topology
Development connects directly to `D:\GenericAgent`. Releases bundle an isolated Python plus pinned GA runtime and allow an explicit compatible external GA path override.

### ADR-03 — One Agent truth source
Models, sessions, Skills/SOP, Memory, subagents, scheduled/long-running work, and all other Agent semantics use GA as their only truth source. No dual database or dual kernel synchronization is permitted.

### ADR-04 — Remove remote capability
Remove LiveAgent Gateway, Go service, Browser WebUI, Proto, remote frontend entries, and their build/release chain after the MVP proves replacement paths. Build an exact dependency/deletion inventory first.

### ADR-05 — Windows-first scope
The first supported release target is Windows 10/11 x64, including both external development runtime and bundled installed runtime. macOS/Linux are deferred.

### ADR-06 — Page ownership governance
Keep existing navigation and reusable page appearance. Rebind mappable Agent pages to GA, preserve pure desktop pages, and remove pages/settings that cannot map without creating a second Agent truth source.

### ADR-07 — Official Bridge as anticorruption boundary
Reuse and extend GA's official `frontends/desktop_bridge.py`. Tauri owns sidecar lifecycle only; React uses typed HTTP/WebSocket adaptation. Agent logic must not move into TypeScript.

### ADR-08 — Project adapter ownership
Maintain `ga_bridge_adapter.py` in this product repository for product DTOs, routes, and version negotiation while importing/wrapping official GA. Upstream only generally reusable changes; do not create a private GA fork.

### ADR-09 — No legacy Agent-data migration
Do not migrate LiveAgent sessions, Providers, Skills, Memory, Cron, or MCP Agent data. On first launch create a read-only archive and expose its directory. Preserve only pure desktop configuration.

### ADR-10 — Local Bridge security
Bind only to `127.0.0.1`; use a high-entropy temporary token for HTTP and WebSocket, strict Origin/CORS checks, dynamic/free-port selection, redacted logs, token rotation on restart, and child-process cleanup.

### ADR-11 — Auditable version control baseline
Hash the unmodified tree, audit ignore rules, initialize local Git, and commit an import baseline before source transformation. Continue with small, buildable commits.

### ADR-12 — Vertical-slice MVP first
First deliver sidecar lifecycle, minimal model setup, session CRUD, streaming send/cancel/final states, restart recovery, tool traces, `ask_user`, uploads/path context, and Bridge/port failure recovery before broad page conversion.

### ADR-13 — Lossless event adaptation
Map known GA events to existing bubbles/cards. Preserve unknown events in a generic expandable card; never silently discard them. Raw development payload logs must be redacted.

### ADR-14 — Independent brand with attribution
Use a new product name and identity. Preserve LiveAgent (2026 Stack-Cairn) and GenericAgent (2025 lsdefine) MIT licenses, copyright, and source attribution in About/NOTICE and distributions.

### ADR-15 — Pinned GA upgrades
Each application release pins one tested GA commit and runtime manifest including adapter API, Python, and dependencies. GA never auto-updates at runtime; incompatible external paths produce an actionable warning.

### ADR-16 — Session-bound workspace
Bind each GA session immutably to one `workspace_path`/`project_dir`; file tree, Git, terminal, and Agent use the same directory. Switching workspace switches or creates a session, never mutates an active session's cwd invisibly.

### ADR-17 — GA-native authorization
Use GA's native security policy and `ask_user`. LiveAgent displays the decision UI and returns the user's actual choice; it adds no second allowlist/permission engine and never auto-approves.

### ADR-18 — Unified Commands and Skills panel
Use one `/` panel grouped into GA Commands and GA Skills. Exact line-leading commands take precedence; resolve naming conflicts explicitly with `/skill <name>` or selection from the Skills group. Skill chips inject context, not commands.

### ADR-19 — Discoverable Command extension model
Build a GA-side registry. Declarative Command Packs support prompt/skill additions; Python Command Plugins support stateful operations. UI-local commands may call only public APIs. React discovers `/commands` and does not hardcode business commands.

### ADR-20 — Hooks map to GA lifecycle
Retain the Hooks page appearance but manage GA Hook Registry entries executed in the real GA lifecycle. Python plugins may receive mutable context; declarative command/HTTP Hooks receive redacted snapshots by default. Never generate/overwrite Python source from the UI.

### ADR-21 — Automation uses one scheduler
Retain the Automation appearance but route data and execution through GA Automation/Scheduler Registry. The page and `/scheduler` share state. Support Agent Prompt, GA service, and controlled command/HTTP tasks; remove the Rust Cron truth source.

### ADR-22 — Extension delivery staging
MVP includes Command Registry, unified Commands/Skills panel, core commands, declarative/Python examples, Hook observability, and one minimal Agent Prompt automation. Defer Hive/Conductor visualization, full Scheduler/Hook editing, and Command Pack management. Disable `/update` in bundled releases.

## Consequences

- LiveAgent's legacy Agent Loop is a migration liability, not a fallback.
- The Bridge contract and runtime supervisor become release-critical security boundaries.
- UI preservation is measured by interaction and visual regression, while state ownership changes completely.
- Gateway removal remains blocked until the MVP and dependency gates prove local desktop capabilities are independent.
- Rollback uses Git stage commits rather than shipping both kernels.

## Enforcement

Every commit must be independently buildable, pass `git diff --check`, run its relevant minimal tests, and end its message with:

`Co-Authored-By: GenericAgent <bot@gaagent.ai>`

Any deletion of more than three files requires a fresh exact list and explicit user confirmation.
