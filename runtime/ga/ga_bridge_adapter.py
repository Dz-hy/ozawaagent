#!/usr/bin/env python3
"""Security and compatibility adapter for GenericAgent's official desktop bridge."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import secrets
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from aiohttp import web

ADAPTER_VERSION = "1.0.0"
API_VERSION = "v1"
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


def create_app(*, official_module: Any, token: str, allowed_origins: Iterable[str], manifest: dict[str, Any]) -> web.Application:
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

    app.router.add_get("/api/v1/version", version_handler)
    app.router.add_get("/api/v1/capabilities", capabilities_handler)
    app.router.add_get("/api/v1/health", health_handler)
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
                     allowed_origins=parse_origins(os.environ.get("GA_BRIDGE_ALLOWED_ORIGINS")), manifest=manifest)
    web.run_app(app, host="127.0.0.1", port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
