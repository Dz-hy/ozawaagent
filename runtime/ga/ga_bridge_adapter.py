#!/usr/bin/env python3
"""Security and compatibility adapter for GenericAgent's official desktop bridge."""
from __future__ import annotations

import argparse
import asyncio
from collections import deque
from contextvars import ContextVar
import hashlib
import importlib.util
import json
import math
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

from aiohttp import ClientSession, ClientTimeout, web

ADAPTER_VERSION = "1.5.0"
API_VERSION = "v1"
COMMAND_API_VERSION = "1"
MAX_COMMAND_ARGUMENT_CHARS = 32_768
MAX_AUTOMATION_PROMPT_CHARS = 32_768
MAX_TOKEN_RECORDS = 1_000
MAX_TOKEN_COUNT = 10**15
MAX_TOKEN_MODEL_CHARS = 512
MAX_TOKEN_TIMESTAMP = 10**12
MAX_CONDUCTOR_ITEMS = 100
MAX_CONDUCTOR_CHAT_ITEMS = 50
MAX_CONDUCTOR_TEXT_CHARS = 2_000
MAX_CONDUCTOR_RESPONSE_BYTES = 256 * 1024
CONDUCTOR_TIMEOUT_SECONDS = 1.0
CONDUCTOR_BASE_URL = "http://127.0.0.1:8900"
AUTOMATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
AUTOMATION_SCHEDULE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
AUTOMATION_REPEAT = re.compile(r"^(?:daily|weekday|weekly|monthly|once|every_[1-9]\d*[mhd])$")
MODEL_PROFILE_FIELDS = {
    "protocol", "name", "model", "apibase", "api_key",
    "max_retries", "connect_timeout", "read_timeout", "stream",
}
MODEL_PROFILE_LIMITS = {"name": 256, "model": 512, "apibase": 2048, "api_key": 16_384}
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
        return value if isinstance(value, bool) else "[REDACTED]"
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


def model_protocol(var_name: Any) -> tuple[str, str]:
    value = str(var_name or "").lower()
    if "claude" in value:
        return "claude", "var_name_heuristic"
    return "unknown", "unknown"


def safe_model_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid model profile")
    profile_id = value.get("id")
    if not isinstance(profile_id, int) or isinstance(profile_id, bool) or profile_id < 0:
        raise ValueError("invalid model profile id")
    var_name = safe_hook_label(value.get("varName"))
    kind = "mixin" if value.get("kind") == "mixin" else "native"
    result: dict[str, Any] = {
        "id": profile_id, "kind": kind, "var_name": var_name,
        "name": str(value.get("name") or "")[:256],
        "model": str(value.get("model") or "")[:512],
        "active": value.get("active") is True,
    }
    if kind == "mixin":
        members = value.get("members")
        result["members"] = [str(item)[:256] for item in members[:100]] if isinstance(members, list) else []
    else:
        protocol, protocol_source = model_protocol(var_name)
        result.update({"protocol": protocol, "protocol_source": protocol_source,
                       "group": "native" if value.get("group") == "native" else "std",
                       "in_mixin": value.get("inMixin") is True})
    return result


def normalize_model_profile_input(value: Any, *, creating: bool) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - MODEL_PROFILE_FIELDS:
        raise ValueError("invalid model profile")
    required = {"protocol", "model", "apibase"} if creating else set()
    if not required <= set(value) or (not creating and not value):
        raise ValueError("missing model profile fields")
    result: dict[str, Any] = {}
    for key in ("name", "model", "apibase"):
        if key in value:
            item = value[key]
            if not isinstance(item, str) or len(item) > MODEL_PROFILE_LIMITS[key]:
                raise ValueError("invalid model profile field")
            result[key] = item.strip()
    if ("model" in value and not result.get("model")) or ("apibase" in value and not result.get("apibase")):
        raise ValueError("model and API base cannot be empty")
    if "protocol" in value:
        protocol = value["protocol"]
        if not creating or protocol not in ("oai", "claude"):
            raise ValueError("invalid model protocol")
        result["protocol"] = protocol
    if "api_key" in value:
        api_key = value["api_key"]
        if not isinstance(api_key, str) or len(api_key) > MODEL_PROFILE_LIMITS["api_key"]:
            raise ValueError("invalid API key")
        api_key = api_key.strip()
        if api_key:
            result["apikey"] = api_key
    for key, low, high in (("max_retries", 0, 100), ("connect_timeout", 1, 3600),
                           ("read_timeout", 1, 86400)):
        if key in value:
            item = value[key]
            if not isinstance(item, int) or isinstance(item, bool) or not low <= item <= high:
                raise ValueError("invalid model profile limit")
            result[key] = item
    if "stream" in value:
        if not isinstance(value["stream"], bool):
            raise ValueError("invalid stream setting")
        result["stream"] = value["stream"]
    return result


def safe_editable_model_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid model profile")
    result = safe_model_profile({**value, "kind": "native"})
    result.update({
        "apibase": str(value.get("apibase") or "")[:2048],
        "api_key_configured": bool(value.get("apikey")),
        "max_retries": int(value.get("max_retries", 5)),
        "connect_timeout": int(value.get("connect_timeout", 15)),
        "read_timeout": int(value.get("read_timeout", 300)),
        "stream": value.get("stream") is not False,
    })
    return result


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


def knowledge_catalog(root: Path | None) -> dict[str, Any]:
    """Return GA-owned skill and memory metadata without secret-bearing content."""
    layers = [
        {"id": "L1", "name": "Insight index", "purpose": "Minimal high-frequency index into verified knowledge"},
        {"id": "L2", "name": "Verified facts", "purpose": "Stable environment facts and project references"},
        {"id": "L3", "name": "SOPs and tools", "purpose": "Reusable procedures and task-specific implementations"},
        {"id": "L4", "name": "Raw sessions", "purpose": "Auditable source material retained outside active context"},
    ]
    snapshot: dict[str, Any] = {
        "schema": "ga.knowledge_catalog.v1",
        "read_only": True,
        "registry_state": "unavailable",
        "skills": [],
        "memory": {"layers": layers},
        "morphling": {
            "kind": "workflow",
            "summary": "Absorb a target capability by extracting goals and tests, then call, rewrite, or discard each component.",
            "completion": "Successful results solidify into a registered tool, SOP, or tested repository rather than a second store.",
            "skill_ids": [],
        },
    }
    if root is None:
        return snapshot
    registry_path = root / "GA-local" / "skills" / "skill_registry.json"
    try:
        if registry_path.is_symlink() or not registry_path.is_file():
            return snapshot
        document = json.loads(registry_path.read_text(encoding="utf-8"))
        if document.get("schema") != "ga.skill_registry.v1" or not isinstance(document.get("skills"), dict):
            return snapshot
        skills = []
        for skill_id, raw in sorted(document["skills"].items()):
            if not isinstance(skill_id, str) or not skill_id.startswith("skill:") or not isinstance(raw, dict):
                continue
            triggers = raw.get("triggers", [])
            skills.append({
                "id": skill_id,
                "kind": raw.get("kind") if isinstance(raw.get("kind"), str) else "unknown",
                "triggers": [value for value in triggers if isinstance(value, str)] if isinstance(triggers, list) else [],
                "verified": raw.get("verified") is True,
            })
        snapshot["registry_state"] = "loaded"
        snapshot["skills"] = skills
        snapshot["morphling"]["skill_ids"] = [
            item["id"] for item in skills
            if "morphling" in item["id"].lower() or any("morphling" in value.lower() for value in item["triggers"])
        ]
    except (OSError, UnicodeError, json.JSONDecodeError):
        return snapshot
    return snapshot


def safe_token_count(value: Any) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_TOKEN_COUNT:
        return value
    return 0


def safe_token_model(value: Any) -> str:
    return value[:MAX_TOKEN_MODEL_CHARS] if isinstance(value, str) else ""


def safe_token_timestamp(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    numeric = float(value)
    if not math.isfinite(numeric) or not 0 <= numeric <= MAX_TOKEN_TIMESTAMP:
        return None
    return value


def safe_token_record(value: Any, *, include_timestamp: bool) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    record: dict[str, Any] = {
        "input": safe_token_count(value.get("input")),
        "output": safe_token_count(value.get("output")),
        "cacheCreate": safe_token_count(value.get("cacheCreate")),
        "cacheRead": safe_token_count(value.get("cacheRead")),
        "model": safe_token_model(value.get("model")),
    }
    if include_timestamp:
        timestamp = safe_token_timestamp(value.get("ts"))
        if timestamp is not None:
            record["timestamp"] = timestamp
    return record


async def read_official_token_json(official_module: Any, handler_name: str, request: web.Request) -> dict[str, Any]:
    handler = getattr(official_module, handler_name, None)
    if not callable(handler):
        raise RuntimeError("official token usage contract unavailable")
    response = await handler(request)
    if not isinstance(response, web.Response) or response.status >= 400:
        raise RuntimeError("official token usage request failed")
    try:
        body = json.loads(response.body.decode(response.charset or "utf-8"))
    except (AttributeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("official token usage response was invalid") from error
    if not isinstance(body, dict):
        raise RuntimeError("official token usage response was invalid")
    return body


def token_usage_error(request: web.Request) -> web.Response:
    return _json("error", {
        "code": "token_usage_unavailable",
        "message": "GenericAgent token usage is unavailable",
    }, 503, request.headers.get("X-Request-Id", ""))


_CONDUCTOR_SECRET_TEXT = re.compile(
    r"(?i)(?:api[_ -]?key|access[_ -]?token|bearer|password|passwd|secret|credential)"
    r"\s*[:=]\s*[^\s,;]+"
)


def safe_conductor_text(value: Any, *, limit: int = MAX_CONDUCTOR_TEXT_CHARS) -> str:
    """Keep Conductor previews bounded and remove paths/obvious inline secrets."""
    if not isinstance(value, str):
        return ""
    text = redact(value)
    text = _CONDUCTOR_SECRET_TEXT.sub(lambda match: f"{match.group(0).split(':', 1)[0].split('=', 1)[0]}=[REDACTED]", text)
    text = "".join(char for char in text if char in "\n\r\t" or ord(char) >= 32)
    return text[:limit]


def safe_conductor_id(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value[:128]


def safe_conductor_time(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    numeric = float(value)
    if not math.isfinite(numeric) or not 0 <= numeric <= MAX_TOKEN_TIMESTAMP:
        return None
    return value


def safe_conductor_subagent(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    item: dict[str, Any] = {
        "id": safe_conductor_id(value.get("id")),
        "status": value.get("status") if value.get("status") in {"running", "stopped"} else "unknown",
        "prompt": safe_conductor_text(value.get("prompt")),
        "reply": safe_conductor_text(value.get("reply")),
    }
    if not item["id"]:
        return None
    for source, target in (("created_at", "createdAt"), ("updated_at", "updatedAt")):
        timestamp = safe_conductor_time(value.get(source))
        if timestamp is not None:
            item[target] = timestamp
    return item


def safe_conductor_chat(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    item = {
        "id": safe_conductor_id(value.get("id")),
        "role": value.get("role") if value.get("role") in {"conductor", "system", "user"} else "unknown",
        "message": safe_conductor_text(value.get("msg")),
    }
    if not item["id"]:
        return None
    timestamp = safe_conductor_time(value.get("ts"))
    if timestamp is not None:
        item["timestamp"] = timestamp
    return item


def _conductor_items(document: Any, key: str, limit: int) -> list[Any]:
    if not isinstance(document, dict) or not isinstance(document.get(key), list):
        raise RuntimeError("Conductor response was invalid")
    return document[key][:limit]


async def _read_conductor_json(session: ClientSession, path: str) -> dict[str, Any]:
    async with session.get(
        f"{CONDUCTOR_BASE_URL}{path}",
        allow_redirects=False,
        headers={"Accept": "application/json"},
    ) as response:
        if response.status != 200:
            raise RuntimeError("Conductor request failed")
        body = await response.content.read(MAX_CONDUCTOR_RESPONSE_BYTES + 1)
        if len(body) > MAX_CONDUCTOR_RESPONSE_BYTES:
            raise RuntimeError("Conductor response was too large")
        document = json.loads(body.decode(response.charset or "utf-8"))
        if not isinstance(document, dict):
            raise RuntimeError("Conductor response was invalid")
        return document


async def conductor_snapshot_handler(request: web.Request) -> web.Response:
    try:
        timeout = ClientTimeout(total=CONDUCTOR_TIMEOUT_SECONDS)
        async with ClientSession(timeout=timeout) as session:
            subagents_doc, chat_doc = await asyncio.gather(
                _read_conductor_json(session, "/subagent"),
                _read_conductor_json(session, "/chat?last=50"),
            )
        subagents = [
            item for raw in _conductor_items(subagents_doc, "items", MAX_CONDUCTOR_ITEMS)
            if (item := safe_conductor_subagent(raw)) is not None
        ]
        chat = [
            item for raw in _conductor_items(chat_doc, "items", MAX_CONDUCTOR_CHAT_ITEMS)
            if (item := safe_conductor_chat(raw)) is not None
        ]
        payload = {
            "schema": "ga.conductor.v1",
            "read_only": True,
            "available": True,
            "subagents": subagents,
            "chat": chat,
            "counts": {
                "running": sum(item["status"] == "running" for item in subagents),
                "stopped": sum(item["status"] == "stopped" for item in subagents),
            },
        }
    except Exception:
        return _json("error", {
            "code": "conductor_unavailable",
            "message": "GenericAgent Conductor is unavailable",
        }, 503, request.headers.get("X-Request-Id", ""))
    return _json("conductor.snapshot", payload, 200, request.headers.get("X-Request-Id", ""))


PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_CURRENT_PROJECT_ID: ContextVar[str | None] = ContextVar("ga_current_project_id", default=None)


def _normalize_project_id(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not PROJECT_ID.fullmatch(value):
        raise ValueError("projectId must contain only letters, numbers, underscores, and hyphens")
    return value


def _install_project_session_support(official_module: Any) -> None:
    manager = getattr(official_module, "manager", None)
    if manager is None or getattr(manager, "_ga_project_session_support", False):
        return
    required = ("create_session", "snapshot", "_session_dict", "_session_from_item", "make_agent", "_persist_session")
    if not all(callable(getattr(manager, name, None)) for name in required):
        return

    original_create_session = manager.create_session
    original_snapshot = manager.snapshot
    original_session_dict = manager._session_dict
    original_session_from_item = manager._session_from_item
    original_make_agent = manager.make_agent

    def create_session(cwd: str | None = None):
        session = original_create_session(cwd)
        session.project_id = _CURRENT_PROJECT_ID.get()
        manager._persist_session(session)
        return session

    def snapshot(session: Any, include_messages: bool = True) -> dict[str, Any]:
        result = original_snapshot(session, include_messages=include_messages)
        project_id = getattr(session, "project_id", None)
        if project_id:
            result["projectId"] = project_id
        return result

    def session_dict(session: Any) -> dict[str, Any]:
        result = original_session_dict(session)
        project_id = getattr(session, "project_id", None)
        if project_id:
            result["project_id"] = project_id
        return result

    def session_from_item(item: dict[str, Any]):
        session = original_session_from_item(item)
        try:
            session.project_id = _normalize_project_id(item.get("project_id"))
        except ValueError:
            session.project_id = None
        return session

    def make_agent(session: Any):
        agent = original_make_agent(session)
        project_id = getattr(session, "project_id", None)
        enter_project_mode = getattr(getattr(agent, "handler", None), "enter_project_mode", None)
        if project_id and callable(enter_project_mode):
            enter_project_mode(project_id)
        return agent

    manager.create_session = create_session
    manager.snapshot = snapshot
    manager._session_dict = session_dict
    manager._session_from_item = session_from_item
    manager.make_agent = make_agent
    manager._ga_project_session_support = True


def project_session_middleware():
    @web.middleware
    async def middleware(request: web.Request, handler):
        if request.method != "POST" or request.path != "/session/new":
            return await handler(request)
        try:
            payload = await request.json()
            project_id = _normalize_project_id(payload.get("projectId") if isinstance(payload, dict) else None)
        except (ValueError, json.JSONDecodeError):
            return _json("error", {"code": "invalid_project_id", "message": "Invalid projectId"}, 400,
                         request.headers.get("X-Request-Id", ""))
        context_token = _CURRENT_PROJECT_ID.set(project_id)
        try:
            return await handler(request)
        finally:
            _CURRENT_PROJECT_ID.reset(context_token)

    return middleware


def create_app(*, official_module: Any, token: str, allowed_origins: Iterable[str], manifest: dict[str, Any],
               ga_root: Path | None = None) -> web.Application:
    if len(token) < 32:
        raise ValueError("Bridge token must contain at least 32 characters")
    _install_project_session_support(official_module)
    app = official_module.create_app()
    app.middlewares.insert(0, project_session_middleware())
    app.middlewares.insert(0, security_middleware(token, allowed_origins))

    async def version_handler(request: web.Request) -> web.Response:
        payload = {"adapter_version": ADAPTER_VERSION, "api_version": API_VERSION, "ga_commit": manifest["ga_commit"]}
        return _json("bridge.version", payload, 200, request.headers.get("X-Request-Id", ""))

    async def capabilities_handler(request: web.Request) -> web.Response:
        payload = {"capabilities": manifest["capabilities"], "events": manifest["events"], "unknown_events_preserved": True}
        return _json("bridge.capabilities", payload, 200, request.headers.get("X-Request-Id", ""))

    async def health_handler(request: web.Request) -> web.Response:
        return _json("bridge.health", {"status": "ready", "official_bridge": "compatible"}, 200, request.headers.get("X-Request-Id", ""))

    async def knowledge_handler(request: web.Request) -> web.Response:
        return _json("knowledge.catalog", knowledge_catalog(ga_root), 200,
                     request.headers.get("X-Request-Id", ""))

    async def project_memory_handler(request: web.Request) -> web.Response:
        try:
            project_id = _normalize_project_id(request.match_info.get("project_id"))
        except ValueError:
            project_id = None
        if project_id is None:
            return _json("error", {"code": "invalid_project_id", "message": "Invalid projectId"}, 400,
                         request.headers.get("X-Request-Id", ""))
        if ga_root is None:
            return _json("error", {"code": "project_memory_unavailable",
                                   "message": "GenericAgent project memory is unavailable"}, 503,
                         request.headers.get("X-Request-Id", ""))
        memory_path = ga_root / "private" / "projects" / project_id / "project_memory.md"
        exists = memory_path.is_file() and not memory_path.is_symlink()
        payload: dict[str, Any] = {"projectId": project_id, "status": "missing",
                                   "lineCount": 0, "updatedAt": None}
        if exists:
            content = memory_path.read_text(encoding="utf-8")
            stat = memory_path.stat()
            payload["lineCount"] = len(content.splitlines())
            payload["status"] = "available" if content.strip() else "empty"
            payload["updatedAt"] = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
        return _json("project.memory-status", payload, 200, request.headers.get("X-Request-Id", ""))

    async def token_stats_handler(request: web.Request) -> web.Response:
        try:
            document = await read_official_token_json(official_module, "token_stats_handler", request)
            raw_records = document.get("records")
            if not isinstance(raw_records, list):
                raise RuntimeError("official token usage response was invalid")
            records = [
                record
                for raw in raw_records[:MAX_TOKEN_RECORDS]
                if (record := safe_token_record(raw, include_timestamp=False)) is not None
            ]
            payload = {
                "schema": "ga.token_usage.v1",
                "records": records,
                "truncated": len(raw_records) > MAX_TOKEN_RECORDS,
            }
        except Exception:
            return token_usage_error(request)
        return _json("token-usage.stats", payload, 200, request.headers.get("X-Request-Id", ""))

    async def token_history_handler(request: web.Request) -> web.Response:
        try:
            document = await read_official_token_json(official_module, "get_token_history_handler", request)
            raw_history = document.get("history")
            if not isinstance(raw_history, list):
                raise RuntimeError("official token usage response was invalid")
            history = [
                record
                for raw in raw_history[:MAX_TOKEN_RECORDS]
                if (record := safe_token_record(raw, include_timestamp=True)) is not None
            ]
            payload = {
                "schema": "ga.token_usage.v1",
                "history": history,
                "truncated": len(raw_history) > MAX_TOKEN_RECORDS,
            }
        except Exception:
            return token_usage_error(request)
        return _json("token-usage.history", payload, 200, request.headers.get("X-Request-Id", ""))

    def model_profiles_error(request: web.Request, code: str, status: int) -> web.Response:
        messages = {
            "model_profiles_unavailable": "GenericAgent model profiles are unavailable",
            "invalid_model_profile": "Invalid model profile",
            "model_profile_not_found": "Model profile not found",
            "model_profile_conflict": "Model profile operation is not allowed",
        }
        return _json("error", {"code": code, "message": messages[code]}, status,
                     request.headers.get("X-Request-Id", ""))

    def model_manager() -> Any:
        manager = getattr(official_module, "manager", None)
        methods = ("list_model_profiles", "get_model_profile", "add_model_profile",
                   "update_model_profile", "delete_model_profile")
        if manager is None or not all(callable(getattr(manager, method, None)) for method in methods):
            raise RuntimeError("model manager unavailable")
        return manager

    async def model_profiles_handler(request: web.Request) -> web.Response:
        try:
            manager = model_manager()
            profiles = [safe_model_profile(item) for item in manager.list_model_profiles()]
        except Exception:
            return model_profiles_error(request, "model_profiles_unavailable", 503)
        return _json("model_profiles.list", {"profiles": profiles}, 200,
                     request.headers.get("X-Request-Id", ""))

    def persist_default_model(manager: Any, profile_id: int) -> None:
        read_settings = getattr(official_module, "_settings_doc", None)
        write_settings = getattr(official_module, "_write_settings_doc", None)
        if not callable(read_settings) or not callable(write_settings):
            raise RuntimeError("settings persistence unavailable")
        document = read_settings()
        if not isinstance(document, dict):
            raise RuntimeError("settings persistence unavailable")
        old_profile_id = manager.config.get("llmNo", 0)
        updated = dict(document)
        updated["ui"] = dict(document.get("ui") if isinstance(document.get("ui"), dict) else {})
        updated["ui"]["llmNo"] = profile_id
        write_settings(updated)
        try:
            manager.config["llmNo"] = profile_id
        except Exception:
            try:
                write_settings(document)
                manager.config["llmNo"] = old_profile_id
            finally:
                raise

    async def model_profile_handler(request: web.Request) -> web.Response:
        try:
            profile_id = int(request.match_info["profile_id"])
            if profile_id < 0:
                raise ValueError("invalid id")
            manager = model_manager()
            if request.method == "GET":
                profile = safe_editable_model_profile(manager.get_model_profile(profile_id))
                return _json("model_profile.get", {"profile": profile}, 200,
                             request.headers.get("X-Request-Id", ""))
            if request.method == "PATCH":
                body = normalize_model_profile_input(await request.json(), creating=False)
                existing = safe_editable_model_profile(manager.get_model_profile(profile_id))
                body.setdefault("model", existing["model"])
                body.setdefault("apibase", existing["apibase"])
                manager.update_model_profile(profile_id, body)
                profile = safe_editable_model_profile(manager.get_model_profile(profile_id))
                return _json("model_profile.updated", {"profile": profile}, 200,
                             request.headers.get("X-Request-Id", ""))
            profiles_before = manager.list_model_profiles()
            if not any(item.get("id") == profile_id for item in profiles_before):
                raise ValueError("profile not found")
            old_default = manager.config.get("llmNo", 0)
            if not isinstance(old_default, int) or isinstance(old_default, bool):
                old_default = 0
            last_index_after_delete = len(profiles_before) - 2
            if profile_id < old_default:
                new_default = old_default - 1
            elif profile_id == old_default:
                new_default = min(profile_id, last_index_after_delete)
            else:
                new_default = old_default
            new_default = max(0, min(new_default, last_index_after_delete))
            default_changed = new_default != old_default
            if default_changed:
                persist_default_model(manager, new_default)
            try:
                manager.delete_model_profile(profile_id)
            except Exception:
                if default_changed:
                    persist_default_model(manager, old_default)
                raise
            profiles = [safe_model_profile(item) for item in manager.list_model_profiles()]
            return _json("model_profile.deleted", {"id": profile_id, "profiles": profiles}, 200,
                         request.headers.get("X-Request-Id", ""))
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
            return model_profiles_error(request, "invalid_model_profile", 400)
        except ValueError as error:
            message = str(error).lower()
            if "not found" in message:
                return model_profiles_error(request, "model_profile_not_found", 404)
            if "last profile" in message or "mixin" in message:
                return model_profiles_error(request, "model_profile_conflict", 409)
            return model_profiles_error(request, "invalid_model_profile", 400)
        except Exception:
            return model_profiles_error(request, "model_profiles_unavailable", 503)

    async def set_default_model_profile_handler(request: web.Request) -> web.Response:
        try:
            profile_id = int(request.match_info["profile_id"])
            manager = model_manager()
            profiles = manager.list_model_profiles()
            if profile_id < 0 or not any(item.get("id") == profile_id for item in profiles):
                raise ValueError("profile not found")
            persist_default_model(manager, profile_id)
            safe_profiles = [safe_model_profile(item) for item in manager.list_model_profiles()]
        except (TypeError, ValueError) as error:
            if "profile not found" in str(error).lower():
                return model_profiles_error(request, "model_profile_not_found", 404)
            return model_profiles_error(request, "invalid_model_profile", 400)
        except Exception:
            return model_profiles_error(request, "model_profiles_unavailable", 503)
        return _json("model_profile.default_updated", {"profiles": safe_profiles}, 200,
                     request.headers.get("X-Request-Id", ""))

    async def create_model_profile_handler(request: web.Request) -> web.Response:
        try:
            manager = model_manager()
            body = normalize_model_profile_input(await request.json(), creating=True)
            result = manager.add_model_profile(body)
            profile_id = result.get("profileId")
            profile = safe_editable_model_profile(manager.get_model_profile(profile_id))
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError, TypeError):
            return model_profiles_error(request, "invalid_model_profile", 400)
        except Exception:
            return model_profiles_error(request, "model_profiles_unavailable", 503)
        return _json("model_profile.created", {"profile": profile}, 201,
                     request.headers.get("X-Request-Id", ""))

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
    app.router.add_get("/api/v1/knowledge", knowledge_handler)
    app.router.add_get("/api/v1/projects/{project_id}/memory-status", project_memory_handler)
    app.router.add_get("/api/v1/token-stats", token_stats_handler)
    app.router.add_get("/api/v1/token-history", token_history_handler)
    app.router.add_get("/api/v1/model-profiles", model_profiles_handler)
    app.router.add_post("/api/v1/model-profiles", create_model_profile_handler)
    app.router.add_get("/api/v1/model-profiles/{profile_id}", model_profile_handler)
    app.router.add_patch("/api/v1/model-profiles/{profile_id}", model_profile_handler)
    app.router.add_delete("/api/v1/model-profiles/{profile_id}", model_profile_handler)
    app.router.add_post("/api/v1/model-profiles/{profile_id}/default", set_default_model_profile_handler)
    app.router.add_get("/api/v1/commands", commands_handler)
    app.router.add_post("/api/v1/commands/{command_id}/execute", execute_command_handler)
    app.router.add_get("/api/v1/hooks", hooks_handler)
    app.router.add_get("/api/v1/conductor", conductor_snapshot_handler)
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
