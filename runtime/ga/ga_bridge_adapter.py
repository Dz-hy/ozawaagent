#!/usr/bin/env python3
"""Security and compatibility adapter for GenericAgent's official desktop bridge."""
from __future__ import annotations

import argparse
import asyncio
from collections import deque
from contextvars import ContextVar
import copy
import hashlib
import importlib.util
import inspect
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
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
    # Advanced options intentionally mirror the supported GenericAgent session
    # config keys; arbitrary mykey.py keys must never cross this API boundary.
    "api_mode", "fake_cc_system_prompt", "user_agent", "codex_client",
    "originator", "codex_client_metadata", "reasoning_effort", "service_tier",
    "thinking_type", "thinking_budget_tokens", "temperature", "max_tokens",
    "context_win", "trim_keep_prefix", "proxy", "verify", "omit_thinking",
}
MODEL_PROFILE_ADVANCED_FIELDS = {
    "api_mode", "fake_cc_system_prompt", "user_agent", "codex_client",
    "originator", "codex_client_metadata", "reasoning_effort", "service_tier",
    "thinking_type", "thinking_budget_tokens", "temperature", "max_tokens",
    "context_win", "trim_keep_prefix", "proxy", "verify", "omit_thinking",
}
MODEL_PROFILE_LIMITS = {
    "name": 256, "model": 512, "apibase": 2048, "api_key": 16_384,
    "user_agent": 512, "originator": 256, "proxy": 2048,
}
MODEL_PROFILE_ENUMS = {
    "api_mode": {"chat_completions", "responses"},
    "reasoning_effort": {"none", "minimal", "low", "medium", "high", "xhigh", "max"},
    "service_tier": {"auto", "default", "priority", "flex"},
    "thinking_type": {"adaptive", "enabled", "disabled"},
}
MODEL_PROFILE_DEFAULTS = {
    "max_retries": 5, "connect_timeout": 15, "read_timeout": 300,
    "stream": True, "api_mode": "chat_completions", "temperature": 1,
    "trim_keep_prefix": 0, "verify": True, "codex_client_metadata": True, "omit_thinking": False,
}
SESSION_RUNTIME_EFFORTS = frozenset({"minimal", "low", "medium", "high", "xhigh", "max"})
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
            # Browser CORS preflights intentionally do not carry Authorization.
            # Complete them only after loopback and Origin allowlist checks; all
            # actual requests (and origin-less OPTIONS) still require the token.
            if request.method == "OPTIONS" and origin and origin in allowed:
                return web.Response(status=204, headers=headers)
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


def _safe_runtime_path(value: Any) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value:
        raise RuntimeError("runtime manifest contains an unsafe relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise RuntimeError("runtime manifest contains an unsafe relative path")
    if any(part in {".git", "__pycache__", ".pytest_cache", "temp", "memory", "mykey.py", "mykey.json", "auth.json"}
               for part in path.parts):
        raise RuntimeError("runtime manifest contains a writable or sensitive path")
    return path


def _copy_runtime_file(source_root: Path, data_root: Path, relative: PurePosixPath) -> None:
    source = source_root.joinpath(*relative.parts)
    if source.is_symlink() or not source.is_file():
        raise RuntimeError(f"bundled runtime file is missing or symbolic: {relative}")
    destination = data_root.joinpath(*relative.parts)
    cursor = data_root
    for part in relative.parts[:-1]:
        cursor = cursor / part
        if cursor.is_symlink():
            raise RuntimeError(f"writable runtime path is symbolic: {relative}")
        cursor.mkdir(exist_ok=True)
    if destination.is_symlink():
        raise RuntimeError(f"writable runtime file is symbolic: {relative}")
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def prepare_data_root(source_root: Path, data_root: Path, manifest: dict[str, Any]) -> Path:
    source_root = source_root.resolve()
    data_root = data_root.expanduser().resolve()
    if data_root == source_root or data_root in source_root.parents or source_root in data_root.parents:
        raise RuntimeError("writable GA data root must be separate from the bundled source root")
    if data_root.exists() and data_root.is_symlink():
        raise RuntimeError("writable GA data root cannot be symbolic")
    data_root.mkdir(parents=True, exist_ok=True)
    staging = manifest.get("staging")
    files = staging.get("files") if isinstance(staging, dict) else None
    if not isinstance(files, list) or not files:
        raise RuntimeError("bundled runtime manifest has no staging file allowlist")
    relative_files = [_safe_runtime_path(item) for item in files]
    bridge_path = _safe_runtime_path(manifest["official_bridge"]["path"])
    if bridge_path not in relative_files:
        raise RuntimeError("staging allowlist does not contain the official bridge")
    for relative in (*relative_files, PurePosixPath("ga_bridge_adapter.py"), PurePosixPath("runtime_manifest.json")):
        _copy_runtime_file(source_root, data_root, relative)
    return data_root


def load_module_from_path(module_name: str, path: Path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load module: {path}")
    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get(module_name)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        if previous is None:
            sys.modules.pop(module_name, None)
        else:
            sys.modules[module_name] = previous
        raise
    return module


def load_official_module(root: Path, manifest: dict[str, Any]):
    path = root / manifest["official_bridge"]["path"]
    # The official bridge is normally executed as a script, where Python puts
    # its `frontends` directory on sys.path automatically.  The desktop
    # adapter loads it by filename instead, so absolute imports used by the
    # bridge (for example `import plan_state`) would otherwise fail.
    bridge_dir = path.parent
    if str(bridge_dir) not in sys.path:
        sys.path.insert(0, str(bridge_dir))
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    module = load_module_from_path("liveagent_official_ga_bridge", path)
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


def model_protocol(var_name: Any, value: Any = None) -> tuple[str, str]:
    if isinstance(value, dict):
        explicit = value.get("protocol")
        if explicit in ("oai", "claude"):
            return explicit, "official"
    name = str(var_name or "").lower()
    if any(token in name for token in ("claude", "anthropic")):
        return "claude", "var_name_heuristic"
    if any(token in name for token in ("oai", "openai", "codex", "gpt", "responses")):
        return "oai", "var_name_heuristic"
    return "unknown", "unknown"


def _safe_profile_string(value: Any, key: str) -> str:
    if not isinstance(value, str):
        return ""
    return value[:MODEL_PROFILE_LIMITS.get(key, 2048)]


def _safe_endpoint_shape(value: str) -> str:
    """Rebuild scheme://host[:port] only, dropping credentials, paths, queries
    and fragments. IPv6 hosts are re-bracketed so the display value is a
    parseable endpoint; an unparseable input yields an empty string instead of
    ever falling back to the original (possibly secret-bearing) value."""
    from urllib.parse import urlsplit
    try:
        parsed = urlsplit(value)
    except (ValueError, TypeError):
        return ""
    host = parsed.hostname or ""
    if not host:
        return ""
    scheme = (parsed.scheme or "http").lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    return f"{scheme}://{host}"


def _safe_profile_proxy(value: Any) -> tuple[str, bool]:
    if not isinstance(value, str):
        return "", False
    proxy = value[:MODEL_PROFILE_LIMITS["proxy"]].strip()
    if not proxy:
        return "", False
    # A proxy may contain credentials or sensitive path/query data. Expose only
    # its scheme://host:port endpoint shape; an update with an equal display
    # value (or the legacy [REDACTED] marker) preserves the stored value.
    return _safe_endpoint_shape(proxy), True


def _safe_profile_apibase(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    apibase = value[:MODEL_PROFILE_LIMITS["apibase"]].strip()
    if not apibase:
        return ""
    # API base URLs may embed credentials or per-deployment paths; expose only
    # the scheme://host:port endpoint shape for read-back and UI display.
    return _safe_endpoint_shape(apibase)


def _safe_profile_advanced(value: dict[str, Any], result: dict[str, Any], *, defaults: bool = False) -> None:
    for key in ("api_mode", "reasoning_effort", "service_tier", "thinking_type"):
        if key in value and isinstance(value[key], str) and value[key] in MODEL_PROFILE_ENUMS[key]:
            result[key] = value[key]
    for key in ("user_agent", "originator"):
        if key in value and isinstance(value[key], str):
            result[key] = _safe_profile_string(value[key], key)
    for key in ("fake_cc_system_prompt", "codex_client", "codex_client_metadata",
                "verify", "omit_thinking"):
        if key in value and isinstance(value[key], bool):
            result[key] = value[key]
    for key, low, high in (("thinking_budget_tokens", 1, 100_000_000),
                           ("max_tokens", 1, 100_000_000),
                           ("context_win", 1, 100_000_000),
                           ("trim_keep_prefix", 0, 100_000_000)):
        item = value.get(key)
        if isinstance(item, int) and not isinstance(item, bool) and low <= item <= high:
            result[key] = item
    temperature = value.get("temperature")
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool) and 0 <= temperature <= 2:
        result["temperature"] = temperature
    if "proxy" in value:
        proxy, configured = _safe_profile_proxy(value.get("proxy"))
        result["proxy"] = proxy
        result["proxy_configured"] = configured
    if defaults:
        for key, default in MODEL_PROFILE_DEFAULTS.items():
            result.setdefault(key, default)


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
        protocol, protocol_source = model_protocol(var_name, value)
        result.update({"protocol": protocol, "protocol_source": protocol_source,
                       "group": "native" if value.get("group") == "native" else "std",
                       "in_mixin": value.get("inMixin") is True,
                       "apibase": _safe_profile_apibase(value.get("apibase")),
                       "api_key_configured": bool(value.get("apikey")),
                       "max_retries": int(value.get("max_retries", 5)),
                       "connect_timeout": int(value.get("connect_timeout", value.get("timeout", 15))),
                       "read_timeout": int(value.get("read_timeout", 300)),
                       "stream": value.get("stream") is not False})
        _safe_profile_advanced(value, result)
    return result


def safe_editable_model_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid model profile")
    result = safe_model_profile({**value, "kind": "native"})
    result.update({
        "apibase": _safe_profile_apibase(value.get("apibase")),
        "api_key_configured": bool(value.get("apikey")),
        "max_retries": int(value.get("max_retries", 5)),
        "connect_timeout": int(value.get("connect_timeout", value.get("timeout", 15))),
        "read_timeout": int(value.get("read_timeout", 300)),
        "stream": value.get("stream") is not False,
    })
    _safe_profile_advanced(value, result, defaults=True)
    return result


def _normalize_optional_advanced(value: Any, key: str, *, creating: bool) -> Any:
    if value is None:
        return None if not creating else ...
    if key in MODEL_PROFILE_ENUMS:
        if not isinstance(value, str):
            raise ValueError("invalid advanced model profile field")
        normalized = value.strip().lower().replace("-", "_")
        if not normalized:
            return None if not creating else ...
        if normalized not in MODEL_PROFILE_ENUMS[key]:
            raise ValueError("invalid advanced model profile field")
        return normalized
    if key in ("user_agent", "originator", "proxy"):
        if not isinstance(value, str) or len(value) > MODEL_PROFILE_LIMITS[key]:
            raise ValueError("invalid advanced model profile field")
        normalized = value.strip()
        return (None if not normalized else normalized) if not creating else (normalized if normalized else ...)
    if key in ("fake_cc_system_prompt", "codex_client", "codex_client_metadata", "verify", "omit_thinking"):
        if not isinstance(value, bool):
            raise ValueError("invalid advanced model profile field")
        return value
    if key == "trim_keep_prefix":
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 100_000_000:
            raise ValueError("invalid advanced model profile field")
        return value
    if key in ("thinking_budget_tokens", "max_tokens", "context_win"):
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 100_000_000:
            raise ValueError("invalid advanced model profile field")
        return value
    if key == "temperature":
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 <= value <= 2:
            raise ValueError("invalid temperature")
        return value
    raise ValueError("invalid advanced model profile field")


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
        if creating and not api_key:
            raise ValueError("API key is required when creating a model profile")
        if api_key:
            result["apikey"] = api_key
    elif creating:
        raise ValueError("API key is required when creating a model profile")
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
    if "api_mode" in value:
        mode = value["api_mode"]
        if not isinstance(mode, str) or mode.strip().lower().replace("-", "_") not in MODEL_PROFILE_ENUMS["api_mode"]:
            raise ValueError("invalid advanced model profile field")
        result["api_mode"] = mode.strip().lower().replace("-", "_")
    for key in MODEL_PROFILE_ADVANCED_FIELDS - {"api_mode"}:
        if key not in value:
            continue
        normalized = _normalize_optional_advanced(value[key], key, creating=creating)
        if normalized is not ...:
            result[key] = normalized
    return result


def _raw_manager_profile(manager: Any, profile_id: int) -> dict[str, Any] | None:
    """Read the pinned GA manager's raw profile without returning it to callers."""
    getter = getattr(manager, "_profile_at", None)
    if not callable(getter):
        return None
    raw = getter(profile_id)
    if not isinstance(raw, (tuple, list)) or len(raw) != 2 or not isinstance(raw[1], dict):
        return None
    var_name, config = raw
    allowed = {
        "varName", "kind", "name", "model", "apibase", "apikey", "timeout",
        "connect_timeout", "max_retries", "read_timeout", "stream",
        *MODEL_PROFILE_ADVANCED_FIELDS,
    }
    result: dict[str, Any] = {"id": profile_id, "varName": var_name, "kind": "native"}
    result.update({key: value for key, value in config.items() if key in allowed})
    return result


def _merge_manager_profile(manager: Any, profile: Any) -> dict[str, Any]:
    if not isinstance(profile, dict):
        raise ValueError("invalid model profile")
    if profile.get("kind") == "mixin":
        return dict(profile)
    profile_id = profile.get("id")
    if not isinstance(profile_id, int) or isinstance(profile_id, bool):
        return dict(profile)
    raw = _raw_manager_profile(manager, profile_id)
    if raw is None:
        return dict(profile)
    merged = dict(profile)
    for key in set(raw) & ({"id", "varName", "kind", "name", "model", "apibase", "apikey",
                             "timeout", "connect_timeout", "max_retries", "read_timeout", "stream"}
                            | MODEL_PROFILE_ADVANCED_FIELDS):
        merged[key] = raw[key]
    return merged


def _safe_manager_profiles(manager: Any) -> list[dict[str, Any]]:
    return [safe_model_profile(_merge_manager_profile(manager, item))
            for item in manager.list_model_profiles()]


def _safe_session_model(value: Any, llm_no: int) -> dict[str, Any]:
    """Return only the official bridge's non-secret live-model snapshot."""
    raw = value.get("model") if isinstance(value, dict) else None
    raw = raw if isinstance(raw, dict) else {}
    current = raw.get("current")
    if not isinstance(current, str):
        current = None
    else:
        current = current[:MAX_TOKEN_MODEL_CHARS]
    live_no = raw.get("llmNo", llm_no)
    if not isinstance(live_no, int) or isinstance(live_no, bool) or live_no != llm_no:
        live_no = llm_no
    return {
        "current": current,
        "isMixin": raw.get("isMixin") is True,
        "llmNo": live_no,
    }


def _private_profile_io_available(manager: Any, *, creating: bool) -> bool:
    required = ["_build_cfg", "_mykey_file", "_patch_var_block", "_save_mykey_text"]
    required += ["_next_native_var", "_format_py_dict"] if creating else ["_profile_at"]
    return all(callable(getattr(manager, name, None)) for name in required)


def _private_profile_cfg(manager: Any, data: dict[str, Any], existing: dict[str, Any] | None,
                         *, require_key: bool = False) -> dict[str, Any]:
    builder = getattr(manager, "_build_cfg")
    cfg = builder(data, existing, require_key=require_key)
    if not isinstance(cfg, dict):
        raise RuntimeError("invalid GenericAgent profile configuration")
    cfg = dict(cfg)
    # A redacted read-back endpoint is a display token, never a replacement:
    # when the UI submits exactly the whitelisted display shape of an existing
    # value, keep the stored value (credentials/path/query included).
    if existing is not None:
        if isinstance(cfg.get("apibase"), str):
            submitted_apibase = cfg["apibase"].strip()
            if submitted_apibase and submitted_apibase == _safe_profile_apibase(existing.get("apibase")):
                cfg["apibase"] = existing["apibase"]
    # BaseSession consumes `timeout`; the official bridge's legacy helper writes
    # `connect_timeout`, so keep the latter for compatibility and also write the
    # effective runtime key when the UI explicitly supplies this value.
    if "connect_timeout" in data:
        cfg["timeout"] = data["connect_timeout"]
    for key in MODEL_PROFILE_ADVANCED_FIELDS:
        if key not in data:
            continue
        value = data[key]
        # A redacted read-back proxy is a display token, never a replacement.
        if key == "proxy" and isinstance(value, str) and "[REDACTED]" in value:
            continue
        if key == "proxy" and existing is not None and isinstance(value, str) and existing.get("proxy"):
            stripped_proxy = value.strip()
            if stripped_proxy and stripped_proxy == _safe_profile_proxy(existing["proxy"])[0]:
                cfg["proxy"] = existing["proxy"]
                continue
        if value is None:
            cfg.pop(key, None)
        else:
            cfg[key] = value
    return cfg


def _private_save_mykey_text_atomic(manager: Any, text: str) -> list:
    """Persist mykey.py atomically with syntax pre-flight and rollback.

    The official bridge's _save_mykey_text writes in place and can surface
    "200 but reverted after restart" when activation fails after the file has
    already changed. Here the new text is validated, written to a temp file,
    atomically swapped, and only then activated; any activation failure rolls
    the file back before re-raising.
    """
    try:
        import ast as _ast
        _ast.parse(text)
    except SyntaxError as exc:
        raise ValueError(f"invalid mykey configuration: {exc}") from exc
    model_file = manager._mykey_file()
    backup = model_file.read_text(encoding="utf-8")
    tmp = model_file.with_name(model_file.name + f".tmp.{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, model_file)
    try:
        manager._invalidate_mykey_cache()
        manager._reload_live_agents()
        profiles = manager.list_model_profiles()
    except Exception:
        rollback = model_file.with_name(model_file.name + f".rollback.{os.getpid()}")
        rollback.write_text(backup, encoding="utf-8")
        os.replace(rollback, model_file)
        try:
            manager._invalidate_mykey_cache()
            manager._reload_live_agents()
        except Exception:
            pass
        raise
    if not isinstance(profiles, list):
        profiles = manager.list_model_profiles()
    return profiles


def _private_profile_idempotent(manager: Any, data: dict[str, Any]) -> dict[str, Any] | None:
    """Return the existing profile that a create request would duplicate.

    A failed-but-retried create (e.g. timeout after persist) must not append a
    second entry; matching on model + apibase + name keeps retries idempotent
    while still allowing intentionally identical configs under a new name.
    """
    target = (str(data.get("model") or "").strip(), str(data.get("apibase") or "").strip(),
              str(data.get("name") or "").strip())
    if not any(target):
        return None
    keys_getter = getattr(manager, "_profile_keys", None)
    if not callable(keys_getter):
        return None
    try:
        keys = keys_getter()
    except Exception:
        return None
    for index in range(len(keys)):
        try:
            var_name, cfg = manager._profile_at(index)
        except Exception:
            continue
        if not isinstance(cfg, dict):
            continue
        if (str(cfg.get("model") or "").strip(), str(cfg.get("apibase") or "").strip(),
                str(cfg.get("name") or "").strip()) == target:
            return {"varName": var_name, "profileId": index}
    return None


def _private_clean_mixins(manager: Any, profile_id: int, name: str) -> None:
    """Remove references to a deleted profile from every mixin.

    The official bridge only cleans the first mixin channel and only by name;
    integer references or additional channels can otherwise leave dangling
    llm_nos entries that break mixin construction. This pass is idempotent and
    best-effort: a failure here must not undo the deletion itself.
    """
    try:
        text = manager._mykey_file().read_text(encoding="utf-8")
        keys, mk = manager._mykey_vars()
        changed = False
        for key in keys:
            if "mixin" not in key.lower():
                continue
            mcfg = mk.get(key)
            if not isinstance(mcfg, dict):
                continue
            llm_nos = [str(item) for item in (mcfg.get("llm_nos") or [])]
            cleaned = [
                item for item in llm_nos
                if not ((name and item == name) or (item.isdigit() and int(item) == profile_id))
            ]
            if len(cleaned) == len(llm_nos):
                continue
            patched = {**mcfg, "llm_nos": cleaned}
            if manager._find_var_block_span(text, key):
                text = manager._patch_var_block(text, key, patched)
                changed = True
        if changed:
            _private_save_mykey_text_atomic(manager, text)
    except Exception:
        pass


def _private_remap_session_llm_no(manager: Any, deleted_id: int, count_before: int) -> None:
    """Remap every persisted/live session's model index after a profile delete.

    The official bridge remaps only the global default; sessions that pointed
    at the deleted profile (or past it) keep an out-of-range llm_no until
    restart. Remap here and persist each changed session.
    """
    sessions = getattr(manager, "sessions", None)
    if not isinstance(sessions, dict):
        return
    fallback = min(deleted_id, count_before - 2)
    persist = getattr(manager, "_persist_session", None)
    for session in list(sessions.values()):
        old = getattr(session, "llm_no", None)
        if not isinstance(old, int) or isinstance(old, bool):
            continue
        if old < deleted_id:
            new = old
        elif old == deleted_id:
            new = fallback
        else:
            new = old - 1
        if new == old:
            continue
        session.llm_no = new
        agent = getattr(session, "agent", None)
        if agent is not None and isinstance(getattr(agent, "llm_no", None), int) \
                and not isinstance(agent.llm_no, bool):
            agent.llm_no = new
        if callable(persist):
            try:
                persist(session)
            except Exception:
                pass


def _private_persist_session_checked(manager: Any, session: Any) -> None:
    """Persist a session and verify the file actually matches memory.

    The official _persist_session swallows every exception and reports
    nothing, so a "successful" runtime update can silently revert on restart.
    This helper re-reads the written file and raises when the swap failed or
    the key fields did not land.
    """
    persist = getattr(manager, "_persist_session", None)
    if not callable(persist):
        raise RuntimeError("session persistence is unavailable")
    persist(session)
    session_file = getattr(manager, "_session_file", None)
    if not callable(session_file):
        raise RuntimeError("session persistence is unavailable")
    file_path = session_file(session.id)
    if not file_path.exists():
        raise RuntimeError("session persist failed: file missing")
    try:
        data = json.loads(file_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise RuntimeError("session persist failed: unreadable file") from exc
    expected = manager._session_dict(session)
    for key, value in expected.items():
        if key in ("messages", "msg_seq", "updated_at", "created_at", "plan_scan_baseline"):
            continue
        if data.get(key) != value:
            raise RuntimeError(f"session persist failed: {key} mismatch")


def _private_delete_model_profile(manager: Any, profile_id: int) -> dict[str, Any]:
    """Delete a profile atomically instead of the official in-place write."""
    if len(manager._profile_keys()) <= 1:
        raise ValueError("cannot delete the last profile")
    var_name, _cfg = manager._profile_at(profile_id)
    text = manager._mykey_file().read_text(encoding="utf-8")
    text = manager._patch_var_block(text, var_name).rstrip() + "\n"
    profiles = _private_save_mykey_text_atomic(manager, text)
    if not isinstance(profiles, list):
        profiles = manager.list_model_profiles()
    return {"profileId": profile_id, "profiles": profiles}


def _private_add_model_profile(manager: Any, data: dict[str, Any]) -> dict[str, Any]:
    existing = _private_profile_idempotent(manager, data)
    if existing is not None:
        # A retried create that already landed: return the stored entry
        # unchanged instead of appending a duplicate.
        profiles = manager.list_model_profiles()
        return {"varName": existing["varName"], "profileId": existing["profileId"],
                "profiles": profiles, "duplicate": True}
    cfg = _private_profile_cfg(manager, data, None, require_key=True)
    model_file = manager._mykey_file()
    text = model_file.read_text(encoding="utf-8")
    var_name = manager._next_native_var(text, data.get("protocol", ""))
    formatted = manager._format_py_dict(cfg)
    profiles = _private_save_mykey_text_atomic(manager, text.rstrip() + f"\n{var_name} = {formatted}\n")
    if not isinstance(profiles, list):
        profiles = manager.list_model_profiles()
    profile_id = next((item.get("id") for item in profiles
                       if isinstance(item, dict) and item.get("varName") == var_name),
                      len(profiles) - 1)
    return {"varName": var_name, "profileId": profile_id, "profiles": profiles}


def _private_update_model_profile(manager: Any, profile_id: int, data: dict[str, Any]) -> dict[str, Any]:
    var_name, existing = manager._profile_at(profile_id)
    if not isinstance(existing, dict):
        raise ValueError("invalid model profile")
    model_file = manager._mykey_file()
    text = model_file.read_text(encoding="utf-8")
    cfg = _private_profile_cfg(manager, data, existing)
    patched = manager._patch_var_block(text, var_name, cfg)
    profiles = _private_save_mykey_text_atomic(manager, patched)
    if not isinstance(profiles, list):
        profiles = manager.list_model_profiles()
    return {"varName": var_name, "profileId": profile_id, "profiles": profiles}


def _manager_profile(manager: Any, profile_id: int) -> dict[str, Any]:
    return _merge_manager_profile(manager, manager.get_model_profile(profile_id))


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


CORE_RUNTIME_COMMANDS: tuple[dict[str, Any], ...] = (
    {
        "id": "effort",
        "name": "/effort",
        "aliases": [],
        "title": "/effort",
        "description": "查看 / 设置 reasoning effort（off 清除）",
        "arg_hint": "[level]",
        "argument_schema": {
            "type": "object",
            "properties": {
                "args_text": {"type": "string", "maxLength": MAX_COMMAND_ARGUMENT_CHARS},
                "session_id": {"type": "string", "minLength": 1},
            },
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "owner": "ga",
        "kind": "control",
        "api_version": COMMAND_API_VERSION,
        "plugin_version": "runtime",
        "requires_capabilities": ["sessions"],
        "permissions": [],
    },
    {
        "id": "model",
        "name": "/model",
        "aliases": [],
        "title": "/model",
        "description": "切换当前会话使用的模型 profile",
        "arg_hint": "<profile id>",
        "argument_schema": {
            "type": "object",
            "properties": {
                "args_text": {"type": "string", "pattern": "^[0-9]+$", "maxLength": 32},
                "session_id": {"type": "string", "minLength": 1},
            },
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "owner": "ga",
        "kind": "control",
        "api_version": COMMAND_API_VERSION,
        "plugin_version": "runtime",
        "requires_capabilities": ["sessions", "model_profiles"],
        "permissions": [],
    },
    {
        "id": "workspace",
        "name": "/workspace",
        "aliases": [],
        "title": "/workspace",
        "description": "绑定项目工作区（切换 cwd 需创建新会话）",
        "arg_hint": "<project id>",
        "argument_schema": {
            "type": "object",
            "properties": {
                "args_text": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", "maxLength": 128},
                "session_id": {"type": "string", "minLength": 1},
            },
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "owner": "ga",
        "kind": "control",
        "api_version": COMMAND_API_VERSION,
        "plugin_version": "runtime",
        "requires_capabilities": ["sessions", "projects"],
        "permissions": [],
    },
    {
        "id": "btw",
        "name": "/btw",
        "aliases": [],
        "title": "/btw",
        "description": "旁路询问当前 Agent，不修改主会话历史",
        "arg_hint": "<question>",
        "argument_schema": {
            "type": "object",
            "properties": {
                "args_text": {"type": "string", "minLength": 1, "maxLength": MAX_COMMAND_ARGUMENT_CHARS},
                "session_id": {"type": "string", "minLength": 1},
            },
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "owner": "ga",
        "kind": "control",
        "api_version": COMMAND_API_VERSION,
        "plugin_version": "runtime",
        "requires_capabilities": ["sessions", "side_questions"],
        "permissions": [],
    },
    {
        "id": "cost",
        "name": "/cost",
        "aliases": [],
        "title": "/cost",
        "description": "查看当前 GenericAgent 令牌用量",
        "arg_hint": "",
        "argument_schema": {
            "type": "object",
            "properties": {
                "args_text": {"type": "string", "maxLength": 0},
                "session_id": {"type": "string", "minLength": 1},
            },
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "owner": "ga",
        "kind": "control",
        "api_version": COMMAND_API_VERSION,
        "plugin_version": "runtime",
        "requires_capabilities": ["sessions", "token_usage"],
        "permissions": [],
    },
)


COMMAND_PACK_SCHEMA = "ga.command_pack.v1"
COMMAND_PACK_DIR = "command_packs"
COMMAND_PLUGIN_DIR = "command_plugins"

# --- MCP Connector support (adapter-owned extension; GenericAgent core has no MCP surface) ---
CONNECTOR_SCHEMA = "ga.connector.v1"
CONNECTOR_DIR = "connectors"
CONNECTOR_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
MCP_PROTOCOL_VERSION = "2024-11-05"
MCP_MAX_TOOLS = 64
MCP_MAX_TOOL_NAME_CHARS = 256
MCP_MAX_ARGUMENT_CHARS = 32_768
MCP_MAX_BODY_BYTES = 64 * 1024
MCP_MAX_RESPONSE_BYTES = 512 * 1024
MCP_TOOLS_TIMEOUT_SECONDS = 10.0
MCP_CALL_TIMEOUT_SECONDS = 30.0


def _load_connectors(ga_root: Path) -> list[dict[str, Any]]:
    """Load MCP connector declarations from the adapter-owned connectors dir."""
    conn_dir = ga_root / CONNECTOR_DIR
    connectors: list[dict[str, Any]] = []
    if not conn_dir.is_dir():
        return connectors
    for path in sorted(conn_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            connectors.append({"name": path.stem[:64], "valid": False,
                               "error": "invalid JSON", "transport": ""})
            continue
        name = str(data.get("name") or path.stem)
        if not CONNECTOR_NAME.match(name):
            connectors.append({"name": name[:64], "valid": False,
                               "error": "invalid connector name", "transport": ""})
            continue
        transport = str(data.get("transport", "stdio"))
        if transport not in ("stdio", "http"):
            connectors.append({"name": name, "valid": False,
                               "error": f"unsupported transport '{transport}'",
                               "transport": transport})
            continue
        if transport == "stdio" and not isinstance(data.get("command"), str):
            connectors.append({"name": name, "valid": False,
                               "error": "stdio transport requires 'command' string",
                               "transport": transport})
            continue
        if transport == "http" and not isinstance(data.get("url"), str):
            connectors.append({"name": name, "valid": False,
                               "error": "http transport requires 'url' string",
                               "transport": transport})
            continue
        try:
            timeout = float(data.get("timeout", MCP_CALL_TIMEOUT_SECONDS))
            max_tools = int(data.get("max_tools", MCP_MAX_TOOLS))
        except (TypeError, ValueError):
            connectors.append({"name": name, "valid": False,
                               "error": "invalid timeout/max_tools", "transport": transport})
            continue
        connectors.append({
            "name": name, "valid": True, "transport": transport,
            "command": str(data.get("command", "")),
            "args": [str(a) for a in (data.get("args") or [])],
            "url": str(data.get("url", "")),
            "headers": {str(k): str(v) for k, v in (data.get("headers") or {}).items()},
            "env": {str(k): str(v) for k, v in (data.get("env") or {}).items()},
            "redact_keys": [str(k) for k in (data.get("redact_keys") or [])],
            "timeout": max(1.0, min(timeout, 300.0)),
            "max_tools": max(1, min(max_tools, MCP_MAX_TOOLS)),
        })
    return connectors


def _redact_extra(value: Any, extra_keys: list[str]) -> Any:
    """Recursively redact connector-specific keys in addition to the global policy."""
    if isinstance(value, dict):
        return {str(k): "[REDACTED]" if k in extra_keys else _redact_extra(v, extra_keys)
                for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_extra(v, extra_keys) for v in value]
    return value


async def _mcp_stdio(connector: dict[str, Any],
                     requests: list[tuple[str, dict[str, Any]]],
                     timeout: float) -> list[dict[str, Any]]:
    """Run JSON-RPC 2.0 requests over a stdio MCP subprocess (no shell)."""
    env = dict(os.environ)
    env.update(connector["env"])
    proc = await asyncio.create_subprocess_exec(
        connector["command"], *connector["args"],
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, env=env)
    try:
        proc.stdin.write((json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": MCP_PROTOCOL_VERSION,
                       "capabilities": {},
                       "clientInfo": {"name": "ga-desktop-adapter",
                                      "version": ADAPTER_VERSION}},
        }) + "\n").encode("utf-8"))
        await proc.stdin.drain()
        line = await asyncio.wait_for(proc.stdout.readline(), timeout)
        if not line:
            raise ValueError("MCP stdio server closed during initialize")
        init = json.loads(line.decode("utf-8", "replace"))
        if "error" in init:
            raise ValueError(f"MCP initialize failed: {init['error']}")
        proc.stdin.write((json.dumps(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n").encode("utf-8"))
        await proc.stdin.drain()
        results: list[dict[str, Any]] = []
        for idx, (method, params) in enumerate(requests, start=2):
            proc.stdin.write((json.dumps({
                "jsonrpc": "2.0", "id": idx, "method": method,
                "params": params}) + "\n").encode("utf-8"))
            await proc.stdin.drain()
            response = None
            while response is None:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout)
                if not line:
                    raise ValueError(f"MCP stdio server closed during {method}")
                candidate = json.loads(line.decode("utf-8", "replace"))
                if candidate.get("id") == idx:
                    response = candidate
            results.append(response)
        return results
    finally:
        proc.kill()
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            pass


async def _mcp_http(connector: dict[str, Any],
                    requests: list[tuple[str, dict[str, Any]]],
                    timeout: float) -> list[dict[str, Any]]:
    """Run JSON-RPC 2.0 requests over HTTP (streamable-http compatible)."""
    headers = dict(connector["headers"])
    headers.setdefault("Content-Type", "application/json")
    results: list[dict[str, Any]] = []
    async with ClientSession() as session:
        for idx, (method, params) in enumerate(requests, start=1):
            req = {"jsonrpc": "2.0", "id": idx, "method": method, "params": params}
            async with session.post(connector["url"], json=req, headers=headers,
                                    timeout=ClientTimeout(total=timeout)) as resp:
                if resp.status >= 400:
                    raise ValueError(f"MCP http endpoint returned {resp.status}")
                raw = await resp.read()
                content_type = resp.headers.get("Content-Type", "")
                if "text/event-stream" in content_type or raw[:1] == b":":
                    msg: dict[str, Any] | None = None
                    for text_line in raw.decode("utf-8", "replace").splitlines():
                        if text_line.startswith("data:"):
                            msg = json.loads(text_line[5:].strip())
                            break
                    if msg is None:
                        raise ValueError("MCP http endpoint returned no SSE data")
                    results.append(msg)
                else:
                    results.append(json.loads(raw.decode("utf-8", "replace")))
    return results


async def _mcp_rpc(connector: dict[str, Any],
                   requests: list[tuple[str, dict[str, Any]]],
                   timeout: float) -> list[dict[str, Any]]:
    if connector["transport"] == "stdio":
        return await _mcp_stdio(connector, requests, timeout)
    return await _mcp_http(connector, requests, timeout)


# --- Morphling absorption classifier (adapter-owned suggestion engine, never writes) ---
MORPHLING_SCHEMA = "ga.morphling.classify.v1"
MORPHLING_MAX_TEXT_CHARS = 64_000
_CREDENTIAL_PATTERN = re.compile(
    r"api[_-]?key|secret|password|passwd|bearer\s|authorization|private[_-]?key", re.I)
_INTERFACE_PATTERN = re.compile(
    r"\bcurl\b|https?://|endpoint|jsonrpc|\bmcp\b|\bapi\b|schema|socket", re.I)
_PROCEDURE_PATTERN = re.compile(r"\bstep\b|流程|步骤|when .+ then|if .+ do|规程", re.I)


def _morphling_classify(text: str, max_chars: int = MORPHLING_MAX_TEXT_CHARS) -> dict[str, Any]:
    """Return a rule-based absorption suggestion for a text fragment.

    Suggestion only: the caller decides whether and where to persist. Credential-
    like fragments are always classified as discard to protect secrets.
    """
    clipped = (text or "")[:max_chars]
    low = clipped.lower()
    reasons: list[str] = []
    if _CREDENTIAL_PATTERN.search(low):
        cls = "discard"
        reasons.append("contains credential-like material; never absorb")
    elif _INTERFACE_PATTERN.search(low):
        cls = "tool"
        reasons.append("describes an interface or call pattern (tool/connector candidate)")
    elif _PROCEDURE_PATTERN.search(low):
        cls = "memory_l3"
        reasons.append("procedural, SOP-like content")
    elif len(clipped) < 400:
        cls = "memory_l1"
        reasons.append("short index-sized fragment")
    else:
        cls = "memory_l2"
        reasons.append("verified-fact style content")
    return {"class": cls, "reasons": reasons, "analyzed_chars": len(clipped)}


COMMAND_ID_PATTERN = re.compile(r"[a-z][a-z0-9_-]*")
COMMAND_ARGS_PLACEHOLDER = "{args}"


def _extension_command_metadata(command_id: str, *, title: str, description: str,
                                arg_hint: str, owner: str, plugin_version: str,
                                requires_capabilities: tuple[str, ...] = ()) -> dict[str, Any]:
    """Serializable metadata for adapter-owned commands (same shape as core commands)."""
    return {
        "id": command_id,
        "name": "/" + command_id,
        "aliases": [],
        "title": title or ("/" + command_id),
        "description": description,
        "arg_hint": arg_hint,
        "argument_schema": {"type": "object", "properties": {
            "args_text": {"type": "string", "maxLength": MAX_COMMAND_ARGUMENT_CHARS}},
                            "additionalProperties": False},
        "owner": owner,
        "kind": "prompt",
        "api_version": COMMAND_API_VERSION,
        "plugin_version": plugin_version,
        "requires_capabilities": list(requires_capabilities),
        "permissions": [],
    }


def load_command_packs(root: Path) -> list[dict[str, Any]]:
    """Load declarative Command Packs from <root>/command_packs/*.json.

    A pack is a JSON document with schema ``ga.command_pack.v1``; each command
    carries a ``prompt_template`` that may contain exactly one ``{args}``
    placeholder.  Packs prove that new commands appear in the UI panel and
    execute without touching React.
    """
    pack_dir = root / COMMAND_PACK_DIR
    commands: list[dict[str, Any]] = []
    if not pack_dir.is_dir():
        return commands
    for path in sorted(pack_dir.glob("*.json")):
        if path.is_symlink():
            continue
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if document.get("schema") != COMMAND_PACK_SCHEMA or not isinstance(document.get("commands"), list):
            continue
        pack_id = document.get("pack_id")
        if not isinstance(pack_id, str) or not COMMAND_ID_PATTERN.fullmatch(pack_id):
            continue
        for raw in document["commands"]:
            if not isinstance(raw, dict):
                continue
            command_id = raw.get("id")
            template = raw.get("prompt_template")
            if not isinstance(command_id, str) or not COMMAND_ID_PATTERN.fullmatch(command_id):
                continue
            if not isinstance(template, str) or not template.strip():
                continue
            # Only the {args} placeholder is allowed; anything else may be a
            # format-string injection or a template that the adapter cannot honor.
            if COMMAND_ARGS_PLACEHOLDER in template and template.count("{") != 1:
                continue
            title = raw.get("title")
            description = raw.get("description")
            arg_hint = raw.get("arg_hint")
            capabilities = raw.get("requires_capabilities")
            command = _extension_command_metadata(
                command_id,
                title=title if isinstance(title, str) and title.strip() else "",
                description=description if isinstance(description, str) else "",
                arg_hint=arg_hint if isinstance(arg_hint, str) else "",
                owner=f"pack:{pack_id}",
                plugin_version=pack_id,
                requires_capabilities=(tuple(value for value in capabilities if isinstance(value, str))
                                       if isinstance(capabilities, list) else ()),
            )
            command["prompt_template"] = template
            commands.append(command)
    return commands


def load_command_plugins(root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Load Python Command Plugins from <root>/command_plugins/*.py.

    Each module must export a ``COMMANDS`` tuple of dicts; every command needs
    ``id`` (slash id without the leading slash) and a callable ``prompt_for``
    following the GenericAgent slash command contract:
    ``prompt_for(slash_name, args_text) -> str | None``.
    """
    plugin_dir = root / COMMAND_PLUGIN_DIR
    handlers: dict[str, Any] = {}
    commands: list[dict[str, Any]] = []
    if not plugin_dir.is_dir():
        return handlers, commands
    for path in sorted(plugin_dir.glob("*.py")):
        if path.is_symlink():
            continue
        module_name = "liveagent_command_plugin_" + hashlib.sha256(path.name.encode("utf-8")).hexdigest()[:12]
        try:
            module = load_module_from_path(module_name, path)
            entries = getattr(module, "COMMANDS", ())
        except Exception:
            continue
        if not isinstance(entries, (list, tuple)):
            continue
        for raw in entries:
            if not isinstance(raw, dict):
                continue
            command_id = raw.get("id")
            prompt_for = raw.get("prompt_for")
            if not isinstance(command_id, str) or not COMMAND_ID_PATTERN.fullmatch(command_id):
                continue
            if not callable(prompt_for):
                continue
            title = raw.get("title")
            description = raw.get("description")
            arg_hint = raw.get("arg_hint")
            capabilities = raw.get("requires_capabilities")
            command = _extension_command_metadata(
                command_id,
                title=title if isinstance(title, str) and title.strip() else "",
                description=description if isinstance(description, str) else "",
                arg_hint=arg_hint if isinstance(arg_hint, str) else "",
                owner=f"plugin:{path.stem}",
                plugin_version=path.stem,
                requires_capabilities=(tuple(value for value in capabilities if isinstance(value, str))
                                       if isinstance(capabilities, list) else ()),
            )
            command["plugin"] = f"{path.stem}:{command_id}"
            commands.append(command)
            handlers[command_id] = {"kind": "plugin", "prompt_for": prompt_for}
    return handlers, commands


def load_command_extensions(root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Discover pack and plugin commands; return (extension handlers, command list)."""
    pack_commands = load_command_packs(root)
    plugin_handlers, plugin_commands = load_command_plugins(root)
    extensions: dict[str, Any] = {}
    for command in pack_commands:
        extensions[command["id"]] = {
            "kind": "pack",
            "template": command["prompt_template"],
            "requires_args": COMMAND_ARGS_PLACEHOLDER in command["prompt_template"],
        }
    extensions.update(plugin_handlers)
    return extensions, pack_commands + plugin_commands


def load_command_registry(root: Path) -> tuple[Any, list[dict[str, Any]]]:
    """Reflect GA-owned slash metadata without copying command logic into the adapter."""
    path = root / "frontends" / "slash_cmds.py"
    module_name = f"liveagent_ga_slash_cmds_{manifest_safe_version(root)}"
    module = load_module_from_path(module_name, path)
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
    for runtime_command in CORE_RUNTIME_COMMANDS:
        if runtime_command["id"] not in seen:
            commands.append(dict(runtime_command))
            seen.add(runtime_command["id"])
    extensions, extension_commands = load_command_extensions(root)
    for command in extension_commands:
        if command["id"] not in seen:
            commands.append(command)
            seen.add(command["id"])
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


async def _side_question_text(session: Any, question: str) -> str:
    """Ask one bounded side question without mutating the live backend history.

    Synchronous backends stream ``raw_ask`` as an iterator; asynchronous
    backends may return an awaitable (a coroutine or an async generator).
    Both are awaited/collected here so a healthy async backend is served
    instead of failing with a misleading 503.
    """
    if not question.strip():
        raise ValueError("side question is required")
    agent = getattr(session, "agent", None)
    backend = getattr(getattr(agent, "llmclient", None), "backend", None)
    raw_ask = getattr(backend, "raw_ask", None)
    if backend is None or not callable(raw_ask):
        raise RuntimeError("side questions are unavailable")
    history = copy.deepcopy(list(getattr(backend, "history", []) or []))
    question_message = {
        "role": "user",
        "content": [{"type": "text", "text": question.strip()}],
    }
    messages = history + [question_message]
    make_messages = getattr(backend, "make_messages", None)
    wire = make_messages(messages) if callable(make_messages) else messages
    result = raw_ask(wire)
    if inspect.isawaitable(result):
        result = await result
    limit = MAX_COMMAND_ARGUMENT_CHARS * 4
    chunks: list[str] = []
    if hasattr(result, "__aiter__"):
        async for chunk in result:
            if isinstance(chunk, str):
                chunks.append(chunk)
            elif chunk is not None:
                chunks.append(str(chunk))
            if sum(len(value) for value in chunks) >= limit:
                break
    else:
        for chunk in result:
            if isinstance(chunk, str):
                chunks.append(chunk)
            elif chunk is not None:
                chunks.append(str(chunk))
            if sum(len(value) for value in chunks) >= limit:
                break
    return "".join(chunks)[:MAX_COMMAND_ARGUMENT_CHARS * 4].strip()


def _safe_token_usage_payload(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict) or not isinstance(document.get("records"), list):
        raise RuntimeError("official token usage response was invalid")
    raw_records = document["records"]
    records = [
        record
        for raw in raw_records[:MAX_TOKEN_RECORDS]
        if (record := safe_token_record(raw, include_timestamp=False)) is not None
    ]
    return {
        "schema": "ga.token_usage.v1",
        "records": records,
        "truncated": len(raw_records) > MAX_TOKEN_RECORDS,
    }


def _workspace_control(session: Any, project_id: str) -> dict[str, Any]:
    """Describe a requested binding; an active session's cwd is immutable."""
    return {
        "projectId": project_id,
        "currentProjectId": _normalize_project_id(getattr(session, "project_id", None)),
        "cwd": getattr(session, "cwd", None),
        "cwdImmutable": True,
        "requiresNewSession": project_id != getattr(session, "project_id", None),
    }


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


SESSION_RUNTIME_ENUMS = {
    "reasoning_effort": SESSION_RUNTIME_EFFORTS | {"none"},
    "service_tier": frozenset({"auto", "default", "priority", "flex"}),
    "thinking_type": frozenset({"adaptive", "enabled", "disabled"}),
}
SESSION_RUNTIME_FIELDS = tuple(SESSION_RUNTIME_ENUMS)


def _runtime_value(value: Any, field: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or value not in SESSION_RUNTIME_ENUMS[field]:
        raise ValueError(f"invalid {field}")
    return value


def _session_runtime(session: Any) -> dict[str, str | None]:
    return {field: getattr(session, field, None) for field in SESSION_RUNTIME_FIELDS}


def _apply_session_runtime(session: Any, agent: Any = None) -> None:
    agent = agent if agent is not None else getattr(session, "agent", None)
    if agent is None:
        return
    llmclient = getattr(agent, "llmclient", None)
    backend = getattr(llmclient, "backend", None)
    if backend is None:
        return
    for field, value in _session_runtime(session).items():
        setattr(backend, field, value)


def _session_for_runtime(manager: Any, sid: str) -> Any:
    getter = getattr(manager, "get_session", None)
    if callable(getter):
        try:
            return getter(sid)
        except Exception as exc:
            if type(exc).__name__ not in {"HTTPNotFound", "KeyError"}:
                raise
    sessions = getattr(manager, "sessions", None)
    session = sessions.get(sid) if isinstance(sessions, dict) else None
    if session is None:
        raise KeyError(sid)
    return session


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
        for field in SESSION_RUNTIME_FIELDS:
            if not hasattr(session, field):
                setattr(session, field, None)
        try:
            _private_persist_session_checked(manager, session)
        except Exception:
            sessions = getattr(manager, "sessions", None)
            if isinstance(sessions, dict):
                sessions.pop(session.id, None)
            raise
        return session

    def snapshot(session: Any, include_messages: bool = True) -> dict[str, Any]:
        result = original_snapshot(session, include_messages=include_messages)
        project_id = getattr(session, "project_id", None)
        if project_id:
            result["projectId"] = project_id
        result["runtime"] = _session_runtime(session)
        return result

    def session_dict(session: Any) -> dict[str, Any]:
        result = original_session_dict(session)
        project_id = getattr(session, "project_id", None)
        if project_id:
            result["project_id"] = project_id
        result.update(_session_runtime(session))
        return result

    def session_from_item(item: dict[str, Any]):
        session = original_session_from_item(item)
        try:
            session.project_id = _normalize_project_id(item.get("project_id"))
        except ValueError:
            session.project_id = None
        for field in SESSION_RUNTIME_FIELDS:
            try:
                setattr(session, field, _runtime_value(item.get(field), field))
            except ValueError:
                setattr(session, field, None)
        return session

    def make_agent(session: Any):
        agent = original_make_agent(session)
        session.agent = agent
        _apply_session_runtime(session, agent)
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

    def runtime_error(request: web.Request, code: str, message: str, status: int) -> web.Response:
        return _json("error", {"code": code, "message": message}, status,
                     request.headers.get("X-Request-Id", ""))

    async def session_runtime_handler(request: web.Request) -> web.Response:
        manager = getattr(official_module, "manager", None)
        if manager is None:
            return runtime_error(request, "session_runtime_unavailable", "Session runtime is unavailable", 503)
        try:
            session = _session_for_runtime(manager, request.match_info["sid"])
        except (KeyError, LookupError):
            return runtime_error(request, "session_not_found", "Session not found", 404)
        if request.method == "GET":
            return _json("session.runtime", _session_runtime(session), 200,
                         request.headers.get("X-Request-Id", ""),)
        try:
            payload = await request.json()
        except (json.JSONDecodeError, ValueError):
            return runtime_error(request, "invalid_runtime", "Runtime payload must be an object", 400)
        if not isinstance(payload, dict) or set(payload) - set(SESSION_RUNTIME_FIELDS):
            return runtime_error(request, "invalid_runtime", "Unknown session runtime field", 400)
        try:
            values = {field: _runtime_value(payload.get(field), field)
                      for field in SESSION_RUNTIME_FIELDS if field in payload}
        except ValueError as exc:
            return runtime_error(request, "invalid_runtime", str(exc), 400)
        previous = {field: getattr(session, field, None) for field in values}
        for field, value in values.items():
            setattr(session, field, value)
        try:
            _private_persist_session_checked(manager, session)
        except Exception as exc:
            for field, old_value in previous.items():
                setattr(session, field, old_value)
            return runtime_error(request, "session_runtime_unavailable",
                                 f"Session runtime persist failed: {exc}", 503)
        try:
            _apply_session_runtime(session)
        except Exception as exc:
            for field, old_value in previous.items():
                setattr(session, field, old_value)
            try:
                _private_persist_session_checked(manager, session)
            except Exception:
                pass
            return runtime_error(request, "session_runtime_unavailable",
                                 f"Session runtime apply failed: {exc}", 503)
        return _json("session.runtime.updated", _session_runtime(session), 200,
                     request.headers.get("X-Request-Id", ""))

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
        memory_path = ga_root / "temp" / "projects" / project_id / "project_memory.md"
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
            profiles = _safe_manager_profiles(manager)
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
                profile = safe_editable_model_profile(_manager_profile(manager, profile_id))
                return _json("model_profile.get", {"profile": profile}, 200,
                             request.headers.get("X-Request-Id", ""))
            if request.method == "PATCH":
                body = normalize_model_profile_input(await request.json(), creating=False)
                existing = safe_editable_model_profile(_manager_profile(manager, profile_id))
                body.setdefault("model", existing["model"])
                body.setdefault("apibase", existing["apibase"])
                if _private_profile_io_available(manager, creating=False):
                    _private_update_model_profile(manager, profile_id, body)
                else:
                    manager.update_model_profile(profile_id, body)
                profile = safe_editable_model_profile(_manager_profile(manager, profile_id))
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
            deleted_name = ""
            try:
                if _private_profile_io_available(manager, creating=False):
                    try:
                        _, deleted_cfg = manager._profile_at(profile_id)
                        if isinstance(deleted_cfg, dict):
                            deleted_name = str(deleted_cfg.get("name")
                                               or deleted_cfg.get("model") or "").strip()
                    except Exception:
                        deleted_name = ""
                    _private_delete_model_profile(manager, profile_id)
                else:
                    manager.delete_model_profile(profile_id)
            except Exception:
                if default_changed:
                    persist_default_model(manager, old_default)
                raise
            if _private_profile_io_available(manager, creating=False):
                _private_clean_mixins(manager, profile_id, deleted_name)
                _private_remap_session_llm_no(manager, profile_id, len(profiles_before))
            profiles = _safe_manager_profiles(manager)
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
            safe_profiles = _safe_manager_profiles(manager)
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
            if _private_profile_io_available(manager, creating=True):
                result = _private_add_model_profile(manager, body)
            else:
                result = manager.add_model_profile(body)
            profile_id = result.get("profileId")
            profile = safe_editable_model_profile(_manager_profile(manager, profile_id))
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

    def mcp_connector_error(request: web.Request, message: str, status: int = 400) -> web.Response:
        return _json("error", {"code": "mcp_connector_error", "message": message}, status,
                     request.headers.get("X-Request-Id", ""))

    def connectors_handler(request: web.Request) -> web.Response:
        """Read-only MCP connector inventory (adapter-owned extensions)."""
        if ga_root is None:
            return mcp_connector_error(request, "adapter is unavailable", 503)
        try:
            connectors = _load_connectors(ga_root)
        except Exception as exc:
            return mcp_connector_error(request, f"cannot read connectors: {exc}", 503)
        return _json("connectors", {"schema": CONNECTOR_SCHEMA, "connectors": [
            {"name": c["name"], "valid": c["valid"], "transport": c.get("transport", ""),
             "error": c.get("error")}
            for c in connectors
        ]}, 200, request.headers.get("X-Request-Id", ""))

    async def mcp_tools_handler(request: web.Request) -> web.Response:
        """List tools exposed by one MCP connector (live protocol call)."""
        request_id = request.headers.get("X-Request-Id", "")
        if ga_root is None:
            return mcp_connector_error(request, "adapter is unavailable", 503)
        name = request.match_info["name"]
        connector = next((c for c in _load_connectors(ga_root)
                          if c["valid"] and c["name"] == name), None)
        if connector is None:
            return mcp_connector_error(request, f"unknown or invalid connector '{name}'", 404)
        try:
            results = await _mcp_rpc(connector, [("tools/list", {})],
                                     MCP_TOOLS_TIMEOUT_SECONDS)
        except (asyncio.TimeoutError, ValueError, OSError) as exc:
            return mcp_connector_error(request, f"tools/list failed: {exc}")
        reply = results[-1]
        if "error" in reply:
            return mcp_connector_error(request, f"tools/list failed: {reply['error']}")
        tools = reply.get("result", {}).get("tools", [])
        if not isinstance(tools, list):
            tools = []
        safe_tools = []
        for tool in tools[:connector["max_tools"]]:
            if not isinstance(tool, dict):
                continue
            safe_tools.append({
                "name": str(tool.get("name", ""))[:MCP_MAX_TOOL_NAME_CHARS],
                "description": str(tool.get("description", ""))[:1024],
                "inputSchema": redact(tool.get("inputSchema", {})),
            })
        return _json("mcp.tools", {"connector": name, "protocol": "mcp",
                                   "tools": safe_tools}, 200, request_id)

    async def mcp_call_handler(request: web.Request) -> web.Response:
        """Invoke one MCP tool with size limits, timeouts and response redaction."""
        request_id = request.headers.get("X-Request-Id", "")
        if ga_root is None:
            return mcp_connector_error(request, "adapter is unavailable", 503)
        name = request.match_info["name"]
        connector = next((c for c in _load_connectors(ga_root)
                          if c["valid"] and c["name"] == name), None)
        if connector is None:
            return mcp_connector_error(request, f"unknown or invalid connector '{name}'", 404)
        raw = await request.read()
        if len(raw) > MCP_MAX_BODY_BYTES:
            return mcp_connector_error(request, "request body too large")
        try:
            body = json.loads(raw.decode("utf-8"))
            tool = str(body.get("tool", ""))
            arguments = body.get("arguments") or {}
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            return mcp_connector_error(request, "invalid JSON body")
        if not tool or len(tool) > MCP_MAX_TOOL_NAME_CHARS:
            return mcp_connector_error(request, "invalid tool name")
        try:
            arguments_json = json.dumps(arguments)
        except (TypeError, ValueError):
            return mcp_connector_error(request, "invalid arguments")
        if len(arguments_json) > MCP_MAX_ARGUMENT_CHARS:
            return mcp_connector_error(request, "arguments exceed size limit")
        try:
            results = await _mcp_rpc(connector, [("tools/call", {
                "name": tool, "arguments": arguments})], connector["timeout"])
        except (asyncio.TimeoutError, ValueError, OSError) as exc:
            return mcp_connector_error(request, f"tools/call failed: {exc}")
        reply = results[-1]
        if "error" in reply:
            return mcp_connector_error(request, f"tools/call failed: {reply['error']}")
        content = reply.get("result", {}).get("content", [])
        truncated = False
        if len(json.dumps(content).encode("utf-8")) > MCP_MAX_RESPONSE_BYTES:
            content = content[:4]
            truncated = True
        content = _redact_extra(content, connector["redact_keys"])
        return _json("mcp.call", {"connector": name, "tool": tool,
                                  "content": content, "truncated": truncated},
                     200, request_id)

    async def morphling_classify_handler(request: web.Request) -> web.Response:
        """Suggest an absorption target for a text fragment (never writes)."""
        request_id = request.headers.get("X-Request-Id", "")
        raw = await request.read()
        if len(raw) > MCP_MAX_BODY_BYTES:
            return mcp_connector_error(request, "request body too large")
        try:
            body = json.loads(raw.decode("utf-8"))
            text = body.get("text", "")
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            return mcp_connector_error(request, "invalid JSON body")
        if not isinstance(text, str) or not text.strip():
            return mcp_connector_error(request, "field 'text' must be a non-empty string")
        return _json("morphling.classify", {
            "schema": MORPHLING_SCHEMA,
            "suggestion": _morphling_classify(text),
        }, 200, request_id)

    async def command_packs_handler(request: web.Request) -> web.Response:
        """Declarative Command Pack / Python Plugin inventory with conflict diagnostics.

        Read-only: mirrors what load_command_registry already merges into
        ``/api/v1/commands`` (GA core wins on duplicate ids) and reports the
        per-source origin of every command plus id collisions across sources.
        """
        if ga_root is None:
            return command_registry_error(request)
        try:
            _, commands = load_command_registry(ga_root)
        except Exception:
            return command_registry_error(request)

        pack_dir = ga_root / COMMAND_PACK_DIR
        packs: list[dict[str, Any]] = []
        if pack_dir.is_dir():
            for path in sorted(pack_dir.glob("*.json")):
                pack_id = path.stem
                try:
                    doc = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    packs.append({"pack_id": pack_id, "file": path.name,
                                  "valid": False, "command_ids": []})
                    continue
                raw_commands = doc.get("commands")
                command_ids = ([entry.get("id") for entry in raw_commands
                                if isinstance(entry, dict) and isinstance(entry.get("id"), str)]
                               if isinstance(raw_commands, list) else [])
                packs.append({
                    "pack_id": doc.get("pack_id", pack_id),
                    "file": path.name,
                    "valid": doc.get("schema") == COMMAND_PACK_SCHEMA and isinstance(raw_commands, list),
                    "command_ids": command_ids,
                })

        plugin_dir = ga_root / COMMAND_PLUGIN_DIR
        plugins: list[dict[str, Any]] = []
        if plugin_dir.is_dir():
            for path in sorted(plugin_dir.glob("*.py")):
                module_name = ("liveagent_command_plugin_"
                               + hashlib.sha256(path.name.encode("utf-8")).hexdigest()[:12])
                try:
                    module = load_module_from_path(module_name, path)
                    entries = getattr(module, "COMMANDS", ())
                    loaded = True
                except Exception:
                    entries, loaded = (), False
                command_ids = [entry.get("id") for entry in entries
                               if isinstance(entry, dict) and isinstance(entry.get("id"), str)]
                plugins.append({"file": path.name, "module": module_name,
                                "loaded": loaded, "command_ids": command_ids})

        claims: dict[str, set[str]] = {}
        for command in commands:
            owner = command.get("owner")
            if not isinstance(owner, str) or not owner:
                continue
            group = "ga" if owner == "ga" else owner
            claims.setdefault(group, set()).add(command["id"])
        # load_command_registry deduplicates (GA wins), so shadowed pack/plugin
        # ids never reach ``commands``; re-add their raw declarations so that
        # collisions are still reported as diagnostics.
        for pack in packs:
            claims.setdefault(f"pack:{pack['pack_id']}", set()).update(pack["command_ids"])
        for plugin in plugins:
            claims.setdefault(f"plugin:{plugin['module']}", set()).update(plugin["command_ids"])

        conflicts: list[dict[str, Any]] = []
        all_ids = sorted({cid for ids in claims.values() for cid in ids})
        for command_id in all_ids:
            sources = sorted(group for group, ids in claims.items()
                             if command_id in ids)
            if len(sources) > 1:
                conflicts.append({"command_id": command_id, "sources": sources})

        return _json("command_packs.list", {
            "packs": packs,
            "plugins": plugins,
            "conflicts": conflicts,
            "loaded_command_count": len(commands),
        }, 200, request.headers.get("X-Request-Id", ""))

    async def execute_command_handler(request: web.Request) -> web.Response:
        if ga_root is None:
            return command_registry_error(request)
        command_id = request.match_info["command_id"]
        try:
            module, commands = load_command_registry(ga_root)
            command_extensions, _ = load_command_extensions(ga_root)
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
        if command["kind"] == "control":
            session_id = body.get("session_id")
            if not isinstance(session_id, str) or not session_id.strip():
                return _json("error", {"code": "invalid_command_input",
                                        "message": "session_id is required for control commands"}, 400,
                             request.headers.get("X-Request-Id", ""))
            manager = getattr(official_module, "manager", None)
            if manager is None:
                return _json("error", {"code": "command_execution_failed",
                                        "message": "Session runtime is unavailable"}, 503,
                             request.headers.get("X-Request-Id", ""))
            try:
                session = _session_for_runtime(manager, session_id.strip())
            except (KeyError, LookupError):
                return _json("error", {"code": "session_not_found", "message": "Session not found"}, 404,
                             request.headers.get("X-Request-Id", ""))
            if command_id == "workspace":
                project_id = args_text.strip()
                try:
                    project_id = _normalize_project_id(project_id)
                except ValueError:
                    project_id = None
                if project_id is None:
                    return _json("error", {"code": "invalid_command_input",
                                            "message": "project id is required and must be a safe identifier"}, 400,
                                 request.headers.get("X-Request-Id", ""))
                return _json("command.completed", {
                    "command_id": command_id,
                    "result": {"type": "control", "handled": True,
                                "workspace": _workspace_control(session, project_id)},
                }, 200, request.headers.get("X-Request-Id", ""))
            if command_id == "btw":
                try:
                    text = await _side_question_text(session, args_text)
                except ValueError as error:
                    return _json("error", {"code": "invalid_command_input", "message": str(error)}, 400,
                                 request.headers.get("X-Request-Id", ""))
                except Exception:
                    return _json("error", {"code": "side_question_unavailable",
                                            "message": "GenericAgent side question is unavailable; "
                                                       "ensure GenericAgent is running and the bridge process is healthy"}, 503,
                                 request.headers.get("X-Request-Id", ""))
                return _json("command.completed", {
                    "command_id": command_id,
                    "result": {"type": "control", "handled": True, "text": text},
                }, 200, request.headers.get("X-Request-Id", ""))
            if command_id == "cost":
                if args_text.strip():
                    return _json("error", {"code": "invalid_command_input",
                                            "message": "cost does not accept arguments"}, 400,
                                 request.headers.get("X-Request-Id", ""))
                try:
                    document = read_official_token_json(official_module, "token_stats_handler", request)
                    if inspect.isawaitable(document):
                        document = await document
                    if isinstance(document, dict) and isinstance(document.get("payload"), dict) and "records" not in document:
                        document = document["payload"]
                    cost = _safe_token_usage_payload(document)
                except Exception:
                    return _json("error", {"code": "token_usage_unavailable",
                                            "message": "GenericAgent token usage is unavailable"}, 503,
                                 request.headers.get("X-Request-Id", ""))
                return _json("command.completed", {
                    "command_id": command_id,
                    "result": {"type": "control", "handled": True, "cost": cost},
                }, 200, request.headers.get("X-Request-Id", ""))
            if command_id == "model":
                argument = args_text.strip()
                if not re.fullmatch(r"[0-9]+", argument):
                    return _json("error", {"code": "invalid_command_input",
                                            "message": "Model profile id must be a non-negative decimal integer"}, 400,
                                 request.headers.get("X-Request-Id", ""))
                try:
                    llm_no = int(argument, 10)
                    profiles = _safe_manager_profiles(manager)
                except (ValueError, TypeError, AttributeError, OverflowError):
                    return _json("error", {"code": "model_profiles_unavailable",
                                            "message": "GenericAgent model profiles are unavailable"}, 503,
                                 request.headers.get("X-Request-Id", ""))
                if not any(profile.get("id") == llm_no for profile in profiles):
                    return _json("error", {"code": "model_profile_not_found",
                                            "message": "Model profile not found"}, 404,
                                 request.headers.get("X-Request-Id", ""))
                switch_model = getattr(manager, "set_session_model", None)
                if not callable(switch_model):
                    return _json("error", {"code": "model_profiles_unavailable",
                                            "message": "GenericAgent model profiles are unavailable"}, 503,
                                 request.headers.get("X-Request-Id", ""))
                try:
                    switched = switch_model(session_id.strip(), llm_no)
                except (KeyError, LookupError):
                    return _json("error", {"code": "session_not_found", "message": "Session not found"}, 404,
                                 request.headers.get("X-Request-Id", ""))
                except (ValueError, TypeError):
                    return _json("error", {"code": "model_profile_not_found",
                                            "message": "Model profile not found"}, 404,
                                 request.headers.get("X-Request-Id", ""))
                except Exception:
                    return _json("error", {"code": "model_profiles_unavailable",
                                            "message": "GenericAgent model profiles are unavailable"}, 503,
                                 request.headers.get("X-Request-Id", ""))
                return _json("command.completed", {
                    "command_id": command_id,
                    "result": {
                        "type": "control",
                        "handled": True,
                        "model": _safe_session_model(switched, llm_no),
                        "runtime": _session_runtime(session),
                    },
                }, 200, request.headers.get("X-Request-Id", ""))
            if command_id != "effort":
                return _json("error", {"code": "command_execution_failed",
                                        "message": "Unsupported control command"}, 500,
                             request.headers.get("X-Request-Id", ""))
            effort = args_text.strip().lower()
            if effort in {"", "off", "clear", "unset"}:
                effort = None
            try:
                value = _runtime_value(effort, "reasoning_effort")
            except ValueError:
                return _json("error", {"code": "invalid_command_input",
                                        "message": "Invalid reasoning effort"}, 400,
                             request.headers.get("X-Request-Id", ""))
            setattr(session, "reasoning_effort", value)
            _apply_session_runtime(session)
            persist = getattr(manager, "_persist_session", None)
            if callable(persist):
                persist(session)
            return _json("command.completed", {
                "command_id": command_id,
                "result": {"type": "control", "handled": True, "runtime": _session_runtime(session)},
            }, 200, request.headers.get("X-Request-Id", ""))
        try:
            template = command.get("prompt_template")
            plugin_ref = command.get("plugin")
            if isinstance(template, str):
                if COMMAND_ARGS_PLACEHOLDER in template:
                    prompt = template.replace(COMMAND_ARGS_PLACEHOLDER, args_text)
                elif args_text:
                    return _json("error", {"code": "invalid_command_input",
                                           "message": "Command does not accept arguments"}, 400,
                                 request.headers.get("X-Request-Id", ""))
                else:
                    prompt = template
            elif isinstance(plugin_ref, str):
                extension = command_extensions.get(command_id)
                prompt_for = extension.get("prompt_for") if isinstance(extension, dict) else None
                prompt = prompt_for(command["name"], args_text) if callable(prompt_for) else None
            else:
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
    app.router.add_get("/api/v1/sessions/{sid}/runtime", session_runtime_handler)
    app.router.add_patch("/api/v1/sessions/{sid}/runtime", session_runtime_handler)
    app.router.add_get("/api/v1/knowledge", knowledge_handler)
    app.router.add_get("/api/v1/projects/{project_id}/memory-status", project_memory_handler)
    app.router.add_get("/api/v1/token-stats", token_stats_handler)
    app.router.add_get("/api/v1/token-history", token_history_handler)
    app.router.add_get("/api/v1/model-profiles", model_profiles_handler)
    app.router.add_post("/api/v1/model-profiles", create_model_profile_handler)
    app.router.add_get("/api/v1/model-profiles/{profile_id}", model_profile_handler)
    app.router.add_put("/api/v1/model-profiles/{profile_id}", model_profile_handler)
    app.router.add_delete("/api/v1/model-profiles/{profile_id}", model_profile_handler)
    app.router.add_post("/api/v1/model-profiles/{profile_id}/default", set_default_model_profile_handler)
    app.router.add_get("/api/v1/commands", commands_handler)
    app.router.add_get("/api/v1/command-packs", command_packs_handler)
    app.router.add_post("/api/v1/commands/{command_id}/execute", execute_command_handler)
    app.router.add_get("/api/v1/hooks", hooks_handler)
    app.router.add_get("/api/v1/conductor", conductor_snapshot_handler)
    app.router.add_get("/api/v1/automations", automations_handler)
    app.router.add_post("/api/v1/automations", create_automation_handler)
    app.router.add_patch("/api/v1/automations/{automation_id}", patch_automation_handler)
    app.router.add_delete("/api/v1/automations/{automation_id}", delete_automation_handler)
    app.router.add_get("/api/v1/automations/{automation_id}/runs", automation_runs_handler)
    app.router.add_get("/api/v1/connectors", connectors_handler)
    app.router.add_post("/api/v1/connectors/{name}/tools/list", mcp_tools_handler)
    app.router.add_post("/api/v1/connectors/{name}/tools/call", mcp_call_handler)
    app.router.add_post("/api/v1/morphling/classify", morphling_classify_handler)
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ga-root")
    parser.add_argument("--data-root", help="Writable per-user root for bundled GenericAgent files")
    parser.add_argument("--host", default=os.environ.get("BRIDGE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BRIDGE_PORT", "14168")))
    parser.add_argument("--check", action="store_true", help="Verify the pinned runtime without importing or starting it")
    args = parser.parse_args(argv)
    if args.host != "127.0.0.1":
        parser.error("--host must be 127.0.0.1")
    source_root = resolve_ga_root(args.ga_root)
    source_manifest = load_manifest(source_root / "runtime_manifest.json")
    verify_official_bridge(source_root, source_manifest)
    root = prepare_data_root(source_root, Path(args.data_root), source_manifest) if args.data_root else source_root
    runtime_manifest = load_manifest(root / "runtime_manifest.json")
    verify_official_bridge(root, runtime_manifest)
    if args.check:
        print(json.dumps({"status": "compatible", "ga_commit": runtime_manifest["ga_commit"], "ga_root": str(root)}))
        return 0
    token = os.environ.get("GA_BRIDGE_TOKEN", "")
    if len(token) < 32:
        parser.error("GA_BRIDGE_TOKEN must contain at least 32 characters")
    module = load_official_module(root, runtime_manifest)
    app = create_app(official_module=module, token=token,
                     allowed_origins=parse_origins(os.environ.get("GA_BRIDGE_ALLOWED_ORIGINS")), manifest=runtime_manifest,
                     ga_root=root)
    web.run_app(app, host="127.0.0.1", port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
