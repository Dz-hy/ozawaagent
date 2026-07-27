#!/usr/bin/env python3
"""Security and compatibility adapter for GenericAgent's official desktop bridge."""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import importlib.util
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from aiohttp import web

ADAPTER_VERSION = "1.2.1"
API_VERSION = "v1"
COMMAND_API_VERSION = "1"
MAX_COMMAND_ARGUMENT_CHARS = 32_768
MAX_AUTOMATION_PROMPT_CHARS = 32_768
AUTOMATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
AUTOMATION_SCHEDULE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
AUTOMATION_REPEAT = re.compile(r"^(?:daily|weekday|weekly|monthly|once|every_[1-9]\d*[mhd])$")
HOOK_EVENTS = ["agent_before", "turn_before", "llm_before", "llm_after",
               "tool_before", "tool_after", "turn_after", "agent_after"]
MANIFEST_PATH = Path(__file__).with_name("runtime_manifest.json")
DEFAULT_ORIGINS = ("http://tauri.localhost", "https://tauri.localhost", "tauri://localhost")
SENSITIVE_KEYS = re.compile(r"authorization|cookie|token|secret|password|passwd|api[_-]?key|private[_-]?key|mykey|credential", re.I)
PATH_KEYS = re.compile(r"(?:path|root|cwd|directory|filename|file)$", re.I)
WINDOWS_PATH = re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s\"']+")
UNIX_PATH = re.compile(r"(?<![A-Za-z0-9_])/(?:home|Users|root|mnt|private|var|tmp)/[^\s\"']+")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def envelope(event_type: str, payload: Any, *, request_id: str = "", session_id: str = "", turn_id: str = "", event_id: str = "") -> dict[str, Any]:
    return {"request_id": request_id or str(uuid.uuid4()), "session_id": session_id,
            "turn_id": turn_id, "event_id": event_id or str(uuid.uuid4()),
            "type": event_type, "timestamp": utc_now(), "payload": payload}


def redact(value: Any, key: str = "") -> Any:
    """Return a JSON-safe recursively redacted copy."""
    if SENSITIVE_KEYS.search(key):
        return "[REDACTED]"
    if PATH_KEYS.search(key) and isinstance(value, str):
        return "[REDACTED_PATH]"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, BaseException):
        value = f"{type(value).__name__}: {value}"
    if isinstance(value, str):
        return UNIX_PATH.sub("[REDACTED_PATH]", WINDOWS_PATH.sub("[REDACTED_PATH]", value))
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)


def _json(event_type: str, payload: Any, status: int, request_id: str, headers: dict[str, str] | None = None) -> web.Response:
    return web.json_response(envelope(event_type, redact(payload), request_id=request_id), status=status, headers=headers)


def parse_origins(raw: str | None) -> tuple[str, ...]:
    values = tuple(x.strip() for x in (raw or "").split(",") if x.strip())
    return values or DEFAULT_ORIGINS


def _bearer(request: web.Request) -> str:
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    return token if scheme.lower() == "bearer" else ""


def _credential(request: web.Request) -> str:
    bearer = _bearer(request)
    if bearer:
        return bearer
    if request.path == "/ws" and request.headers.get("Upgrade", "").lower() == "websocket":
        for protocol in request.headers.get("Sec-WebSocket-Protocol", "").split(","):
            protocol = protocol.strip()
            if protocol.startswith("ga-token."):
                return protocol.removeprefix("ga-token.")
    return ""


def _is_loopback(request: web.Request) -> bool:
    peer = request.transport.get_extra_info("peername") if request.transport else None
    host = peer[0].split("%", 1)[0] if isinstance(peer, (tuple, list)) and peer else ""
    return host in {"127.0.0.1", "::1"}


def security_middleware(token: str, allowed_origins: Iterable[str]):
    allowed = frozenset(allowed_origins)

    @web.middleware
    async def middleware(request: web.Request, handler):
        request_id = request.headers.get("X-Request-Id", "")[:128] or str(uuid.uuid4())
        origin = request.headers.get("Origin", "")
        headers = {"Vary": "Origin", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
        if origin and origin in allowed:
            headers.update({"Access-Control-Allow-Origin": origin,
                            "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
                            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                            "Access-Control-Max-Age": "600"})
        try:
            if not _is_loopback(request):
                return _json("error", {"code": "loopback_required", "message": "Loopback access required"}, 403, request_id, headers)
            if origin and origin not in allowed:
                return _json("error", {"code": "origin_denied", "message": "Origin is not allowed"}, 403, request_id, headers)
            if not secrets.compare_digest(_credential(request), token):
                return _json("error", {"code": "unauthorized", "message": "Bearer token required"}, 401, request_id, headers)
            if request.method == "OPTIONS":
                return web.Response(status=204, headers=headers)
            response = await handler(request)
        except web.HTTPException as exc:
            response = _json("error", {"code": f"http_{exc.status}", "message": exc.reason}, exc.status, request_id, headers)
        except Exception as exc:
            response = _json("error", {"code": "internal_error", "message": redact(exc)}, 500, request_id, headers)
        if response.content_type == "application/json" and response.body:
            try:
                safe_body = redact(json.loads(response.body.decode(response.charset or "utf-8")))
                response = web.json_response(safe_body, status=response.status,
                                             headers={k: v for k, v in response.headers.items()
                                                      if k.lower() not in {"content-type", "content-length"}})
            except (UnicodeDecodeError, json.JSONDecodeError):
                response = _json("error", {"code": "invalid_json_response",
                                            "message": "Upstream returned invalid JSON"}, 502, request_id, headers)
        for name in tuple(response.headers):
            if name.lower().startswith("access-control-"):
                del response.headers[name]
        response.headers.update(headers)
        return response

    return middleware


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_ga_root(value: str | None) -> Path:
    raw = value or os.environ.get("GA_ROOT", "")
    if not raw:
        raise RuntimeError("GA_ROOT is required")
    root = Path(raw).expanduser().resolve()
    if not (root / "agentmain.py").is_file() or not (root / "frontends" / "desktop_bridge.py").is_file():
        raise RuntimeError("GA_ROOT is not a GenericAgent runtime")
    return root


def verify_official_bridge(root: Path, manifest: dict[str, Any]) -> None:
    bridge = root / manifest["official_bridge"]["path"]
    actual = hashlib.sha256(bridge.read_bytes()).hexdigest()
    if not secrets.compare_digest(actual, manifest["official_bridge"]["sha256"]):
        raise RuntimeError("Official bridge hash does not match the pinned runtime manifest")
    if (root / ".git").exists():
        result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10)
        if result.returncode or result.stdout.strip() != manifest["ga_commit"]:
            raise RuntimeError("GenericAgent commit does not match the pinned runtime manifest")


def load_official_module(root: Path, manifest: dict[str, Any]):
    path = root / manifest["official_bridge"]["path"]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    spec = importlib.util.spec_from_file_location("liveagent_official_ga_bridge", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load official GenericAgent bridge")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "create_app", None)):
        raise RuntimeError("Official GenericAgent bridge has no create_app contract")
    return module


HOOK_OBSERVATIONS: deque[dict[str, str]] = deque(maxlen=100)
HOOK_OBSERVATIONS_LOCK = threading.Lock()
HOOK_INSTALL_LOCK = threading.Lock()


def hook_observations_snapshot() -> list[dict[str, str]]:
    with HOOK_OBSERVATIONS_LOCK:
        return list(HOOK_OBSERVATIONS)


def safe_hook_label(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 256:
        return "unknown"
    return value if re.fullmatch(r"[A-Za-z0-9_.<>-]+", value) else "unknown"


def install_hook_observers(registry: dict[str, Any]) -> None:
    with HOOK_INSTALL_LOCK:
        for event in HOOK_EVENTS:
            callbacks = registry.setdefault(event, [])
            if not isinstance(callbacks, list):
                continue
            if any(getattr(callback, "__ga_desktop_observer__", False) for callback in callbacks):
                continue

            def observe(_ctx: Any, *, observed_event: str = event) -> None:
                observation = {
                    "id": uuid.uuid4().hex,
                    "event": observed_event,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                with HOOK_OBSERVATIONS_LOCK:
                    HOOK_OBSERVATIONS.append(observation)

            observe.__ga_desktop_observer__ = True  # type: ignore[attr-defined]
            callbacks.append(observe)


def hook_snapshot() -> dict[str, Any]:
    module = sys.modules.get("plugins.hooks")
    registry = getattr(module, "_registry", None) if module is not None else None
    if not isinstance(registry, dict):
        return {"registry_state": "not_loaded", "events": HOOK_EVENTS,
                "registrations": [], "observations": hook_observations_snapshot()}
    install_hook_observers(registry)
    registrations = []
    for event in sorted(registry):
        callbacks = registry[event]
        if not isinstance(event, str) or not isinstance(callbacks, (list, tuple)):
            continue
        for callback in callbacks:
            if getattr(callback, "__ga_desktop_observer__", False):
                continue
            registrations.append({
                "event": safe_hook_label(event),
                "module": safe_hook_label(getattr(callback, "__module__", None)),
                "handler": safe_hook_label(
                    getattr(callback, "__qualname__", getattr(callback, "__name__", None)),
                ),
            })
    return {"registry_state": "loaded", "events": HOOK_EVENTS,
            "registrations": registrations, "observations": hook_observations_snapshot()}


def normalize_automation(value: Any, *, automation_id: str | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("definition must be an object")
    allowed = {"schedule", "repeat", "enabled", "prompt", "max_delay_hours"}
    if automation_id is None:
        allowed.add("id")
        automation_id = value.get("id")
    if set(value) - allowed or not isinstance(automation_id, str) or not AUTOMATION_ID.fullmatch(automation_id):
        raise ValueError("invalid id or fields")
    schedule, repeat, enabled, prompt = (value.get(key) for key in ("schedule", "repeat", "enabled", "prompt"))
    delay = value.get("max_delay_hours", 6)
    if not isinstance(schedule, str) or not AUTOMATION_SCHEDULE.fullmatch(schedule):
        raise ValueError("invalid schedule")
    if not isinstance(repeat, str) or not AUTOMATION_REPEAT.fullmatch(repeat):
        raise ValueError("invalid repeat")
    if not isinstance(enabled, bool) or not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_AUTOMATION_PROMPT_CHARS:
        raise ValueError("invalid task values")
    if isinstance(delay, bool) or not isinstance(delay, (int, float)) or not 0 <= delay <= 168:
        raise ValueError("invalid max delay")
    return {"id": automation_id, "schedule": schedule, "repeat": repeat, "enabled": enabled,
            "prompt": prompt.strip(), "max_delay_hours": delay}


def automation_directory(root: Path) -> Path:
    resolved_root = root.resolve()
    candidate = root / "sche_tasks"
    if candidate.is_symlink():
        raise ValueError("automation directory cannot be a symbolic link")
    directory = candidate.resolve()
    if directory.parent != resolved_root:
        raise ValueError("automation directory is outside GenericAgent root")
    return directory


def automation_path(root: Path, automation_id: str) -> Path:
    if not AUTOMATION_ID.fullmatch(automation_id):
        raise ValueError("invalid automation id")
    directory = automation_directory(root)
    path = directory / f"{automation_id}.json"
    if path.is_symlink() or path.resolve().parent != directory:
        raise ValueError("invalid automation path")
    return path


def atomic_write_automation(path: Path, automation: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    payload = {key: value for key, value in automation.items() if key != "id"}
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def load_command_registry(root: Path) -> tuple[Any, list[dict[str, Any]]]:
    """Reflect GA-owned slash metadata without copying command logic into the adapter."""
    path = root / "frontends" / "slash_cmds.py"
    spec = importlib.util.spec_from_file_location(
        f"liveagent_ga_slash_cmds_{manifest_safe_version(root)}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load GenericAgent command registry")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    entries = getattr(module, "PALETTE_ENTRIES", ())
    prompt_for = getattr(module, "prompt_for", None)
    if not callable(prompt_for) or not isinstance(entries, (list, tuple)):
        raise RuntimeError("GenericAgent command registry contract is unavailable")
    commands: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in entries:
        if not isinstance(raw, (list, tuple)) or len(raw) != 3:
            continue
        slash_name, arg_hint, description = (str(value).strip() for value in raw)
        command_id = slash_name.removeprefix("/")
        if not command_id or command_id in seen or not re.fullmatch(r"[a-z][a-z0-9_-]*", command_id):
            continue
        # Only prompt commands are executable through this first registry slice.
        # TUI-local pickers such as scheduler remain undiscoverable until they have
        # a real GA plugin rather than silently acquiring different semantics.
        if prompt_for(slash_name, "") is None:
            continue
        seen.add(command_id)
        commands.append({
            "id": command_id,
            "name": slash_name,
            "aliases": [],
            "title": slash_name,
            "description": description,
            "arg_hint": arg_hint,
            "argument_schema": {"type": "object", "properties": {
                "args_text": {"type": "string", "maxLength": MAX_COMMAND_ARGUMENT_CHARS}},
                                "additionalProperties": False},
            "owner": "ga",
            "kind": "prompt",
            "api_version": COMMAND_API_VERSION,
            "plugin_version": manifest_safe_version(root),
            "requires_capabilities": [],
            "permissions": [],
        })
    return module, commands


def manifest_safe_version(root: Path) -> str:
    """Stable non-secret plugin version for a pinned GA checkout."""
    return hashlib.sha256((root / "frontends" / "slash_cmds.py").read_bytes()).hexdigest()[:12]


def create_app(*, official_module: Any, token: str, allowed_origins: Iterable[str], manifest: dict[str, Any],
               ga_root: Path | None = None) -> web.Application:
    if len(token) < 32:
        raise ValueError("Bridge token must contain at least 32 characters")
    app = official_module.create_app()
    app.middlewares.insert(0, security_middleware(token, allowed_origins))

    async def version_handler(request: web.Request) -> web.Response:
        payload = {"adapter_version": ADAPTER_VERSION, "api_version": API_VERSION, "ga_commit": manifest["ga_commit"]}
        return _json("bridge.version", payload, 200, request.headers.get("X-Request-Id", ""))

    async def capabilities_handler(request: web.Request) -> web.Response:
        payload = {"capabilities": manifest["capabilities"], "events": manifest["events"], "unknown_events_preserved": True}
        return _json("bridge.capabilities", payload, 200, request.headers.get("X-Request-Id", ""))

    async def health_handler(request: web.Request) -> web.Response:
        return _json("bridge.health", {"status": "ready", "official_bridge": "compatible"}, 200, request.headers.get("X-Request-Id", ""))

    def command_registry_error(request: web.Request) -> web.Response:
        return _json("error", {"code": "command_registry_unavailable",
                               "message": "GenericAgent command registry is unavailable"}, 503,
                     request.headers.get("X-Request-Id", ""))

    async def commands_handler(request: web.Request) -> web.Response:
        if ga_root is None:
            return command_registry_error(request)
        try:
            _, commands = load_command_registry(ga_root)
        except Exception:
            return command_registry_error(request)
        return _json("commands.list", {"commands": commands}, 200,
                     request.headers.get("X-Request-Id", ""))

    async def execute_command_handler(request: web.Request) -> web.Response:
        if ga_root is None:
            return command_registry_error(request)
        command_id = request.match_info["command_id"]
        try:
            module, commands = load_command_registry(ga_root)
        except Exception:
            return command_registry_error(request)
        command = next((item for item in commands if item["id"] == command_id), None)
        if command is None:
            return _json("error", {"code": "command_not_found", "message": "Command not found"}, 404,
                         request.headers.get("X-Request-Id", ""))
        try:
            body = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = None
        if not isinstance(body, dict):
            return _json("error", {"code": "invalid_command_input", "message": "JSON object required"}, 400,
                         request.headers.get("X-Request-Id", ""))
        args_text = body.get("args_text", "")
        if not isinstance(args_text, str) or len(args_text) > MAX_COMMAND_ARGUMENT_CHARS:
            return _json("error", {"code": "invalid_command_input",
                                    "message": f"args_text must be a string of at most {MAX_COMMAND_ARGUMENT_CHARS} characters"}, 400,
                         request.headers.get("X-Request-Id", ""))
        try:
            prompt = module.prompt_for(command["name"], args_text)
        except Exception:
            prompt = None
        if not isinstance(prompt, str) or not prompt.strip():
            return _json("error", {"code": "command_execution_failed",
                                    "message": "Command did not produce a prompt"}, 500,
                         request.headers.get("X-Request-Id", ""))
        return _json("command.completed", {"command_id": command_id, "result": {"type": "prompt", "prompt": prompt}},
                     200, request.headers.get("X-Request-Id", ""))

    def automation_error(request: web.Request, code: str, message: str, status: int) -> web.Response:
        return _json("error", {"code": code, "message": message}, status,
                     request.headers.get("X-Request-Id", ""))

    async def hooks_handler(request: web.Request) -> web.Response:
        return _json("hooks.snapshot", hook_snapshot(), 200,
                     request.headers.get("X-Request-Id", ""))

    async def automations_handler(request: web.Request) -> web.Response:
        if ga_root is None:
            return automation_error(request, "automation_registry_unavailable",
                                    "GenericAgent automation registry is unavailable", 503)
        automations, diagnostics = [], []
        try:
            directory = automation_directory(ga_root)
        except ValueError:
            return automation_error(request, "automation_registry_unavailable",
                                    "GenericAgent automation registry is unavailable", 503)
        for path in sorted(directory.glob("*.json")) if directory.is_dir() else []:
            try:
                if path.is_symlink():
                    raise ValueError("symbolic link definitions are forbidden")
                raw = json.loads(path.read_text(encoding="utf-8"))
                automations.append(normalize_automation(raw, automation_id=path.stem))
            except Exception:
                diagnostics.append({"id": path.stem, "code": "invalid_definition"})
        return _json("automations.list", {"automations": automations, "diagnostics": diagnostics}, 200,
                     request.headers.get("X-Request-Id", ""))

    async def create_automation_handler(request: web.Request) -> web.Response:
        if ga_root is None:
            return automation_error(request, "automation_registry_unavailable",
                                    "GenericAgent automation registry is unavailable", 503)
        try:
            automation = normalize_automation(await request.json())
            path = automation_path(ga_root, automation["id"])
            if path.exists():
                return automation_error(request, "automation_exists", "Automation already exists", 409)
            atomic_write_automation(path, automation)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError, TypeError):
            return automation_error(request, "invalid_automation", "Invalid Agent Prompt automation", 400)
        return _json("automation.created", {"automation": automation}, 201,
                     request.headers.get("X-Request-Id", ""))

    async def patch_automation_handler(request: web.Request) -> web.Response:
        if ga_root is None:
            return automation_error(request, "automation_registry_unavailable",
                                    "GenericAgent automation registry is unavailable", 503)
        try:
            automation_id = request.match_info["automation_id"]
            changes = await request.json()
            if not isinstance(changes, dict) or "id" in changes:
                raise ValueError("invalid patch")
            path = automation_path(ga_root, automation_id)
            if not path.is_file():
                return automation_error(request, "automation_not_found", "Automation not found", 404)
            current = json.loads(path.read_text(encoding="utf-8"))
            automation = normalize_automation({**current, **changes}, automation_id=automation_id)
            atomic_write_automation(path, automation)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError, TypeError):
            return automation_error(request, "invalid_automation", "Invalid Agent Prompt automation", 400)
        return _json("automation.updated", {"automation": automation}, 200,
                     request.headers.get("X-Request-Id", ""))

    async def delete_automation_handler(request: web.Request) -> web.Response:
        if ga_root is None:
            return automation_error(request, "automation_registry_unavailable",
                                    "GenericAgent automation registry is unavailable", 503)
        try:
            path = automation_path(ga_root, request.match_info["automation_id"])
        except ValueError:
            return automation_error(request, "invalid_automation", "Invalid automation id", 400)
        if not path.is_file():
            return automation_error(request, "automation_not_found", "Automation not found", 404)
        path.unlink()
        return _json("automation.deleted", {"id": request.match_info["automation_id"]}, 200,
                     request.headers.get("X-Request-Id", ""))

    async def automation_runs_handler(request: web.Request) -> web.Response:
        if ga_root is None:
            return automation_error(request, "automation_registry_unavailable",
                                    "GenericAgent automation registry is unavailable", 503)
        automation_id = request.match_info["automation_id"]
        try:
            definition = automation_path(ga_root, automation_id)
        except ValueError:
            return automation_error(request, "invalid_automation", "Invalid automation id", 400)
        if not definition.is_file():
            return automation_error(request, "automation_not_found", "Automation not found", 404)
        pattern = re.compile(rf"^(\d{{4}}-\d{{2}}-\d{{2}})_(\d{{2}})(\d{{2}})_{re.escape(automation_id)}\.md$")
        runs = []
        try:
            done = automation_directory(ga_root) / "done"
            if done.is_symlink():
                raise ValueError("run directory cannot be a symbolic link")
        except ValueError:
            return automation_error(request, "automation_registry_unavailable",
                                    "GenericAgent automation registry is unavailable", 503)
        for path in sorted(done.glob("*.md"), reverse=True) if done.is_dir() else []:
            match = pattern.fullmatch(path.name)
            if match and not path.is_symlink():
                runs.append({"id": path.stem,
                             "timestamp": f"{match.group(1)}T{match.group(2)}:{match.group(3)}:00",
                             "size": path.stat().st_size})
        return _json("automation.runs", {"id": automation_id, "runs": runs}, 200,
                     request.headers.get("X-Request-Id", ""))

    app.router.add_get("/api/v1/version", version_handler)
    app.router.add_get("/api/v1/capabilities", capabilities_handler)
    app.router.add_get("/api/v1/health", health_handler)
    app.router.add_get("/api/v1/commands", commands_handler)
    app.router.add_post("/api/v1/commands/{command_id}/execute", execute_command_handler)
    app.router.add_get("/api/v1/hooks", hooks_handler)
    app.router.add_get("/api/v1/automations", automations_handler)
    app.router.add_post("/api/v1/automations", create_automation_handler)
    app.router.add_patch("/api/v1/automations/{automation_id}", patch_automation_handler)
    app.router.add_delete("/api/v1/automations/{automation_id}", delete_automation_handler)
    app.router.add_get("/api/v1/automations/{automation_id}/runs", automation_runs_handler)
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ga-root")
    parser.add_argument("--host", default=os.environ.get("BRIDGE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BRIDGE_PORT", "14168")))
    parser.add_argument("--check", action="store_true", help="Verify the pinned runtime without importing or starting it")
    args = parser.parse_args(argv)
    if args.host != "127.0.0.1":
        parser.error("--host must be 127.0.0.1")
    manifest = load_manifest()
    root = resolve_ga_root(args.ga_root)
    verify_official_bridge(root, manifest)
    if args.check:
        print(json.dumps({"status": "compatible", "ga_commit": manifest["ga_commit"]}))
        return 0
    token = os.environ.get("GA_BRIDGE_TOKEN", "")
    if len(token) < 32:
        parser.error("GA_BRIDGE_TOKEN must contain at least 32 characters")
    module = load_official_module(root, manifest)
    app = create_app(official_module=module, token=token,
                     allowed_origins=parse_origins(os.environ.get("GA_BRIDGE_ALLOWED_ORIGINS")), manifest=manifest,
                     ga_root=root)
    web.run_app(app, host="127.0.0.1", port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
