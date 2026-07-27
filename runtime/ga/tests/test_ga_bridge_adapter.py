from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

MODULE_PATH = Path(__file__).parents[1] / "ga_bridge_adapter.py"
SPEC = importlib.util.spec_from_file_location("ga_bridge_adapter", MODULE_PATH)
adapter = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(adapter)

TOKEN = "test-token-that-is-longer-than-thirty-two-characters"
ORIGIN = "http://tauri.localhost"
AUTH = {"Authorization": f"Bearer {TOKEN}", "Origin": ORIGIN}


def fake_official_module():
    @web.middleware
    async def unsafe_legacy_cors(request, handler):
        response = await handler(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    async def status(request):
        return web.json_response({"ok": True, "gaRoot": r"D:\\sensitive\\ga", "token": "never-return"})

    async def explode(request):
        raise RuntimeError(r"failed at D:\\private\\secret.txt using token=hidden")

    def create_app():
        app = web.Application(middlewares=[unsafe_legacy_cors])
        app.router.add_get("/status", status)
        app.router.add_get("/explode", explode)
        return app

    return SimpleNamespace(create_app=create_app)


@pytest_asyncio.fixture
async def client():
    manifest = adapter.load_manifest()
    app = adapter.create_app(official_module=fake_official_module(), token=TOKEN,
                             allowed_origins=(ORIGIN,), manifest=manifest)
    async with TestClient(TestServer(app)) as test_client:
        yield test_client


@pytest.mark.asyncio
async def test_v1_envelope_version_capabilities_and_health(client):
    for path, expected_type in (("/api/v1/version", "bridge.version"),
                                ("/api/v1/capabilities", "bridge.capabilities"),
                                ("/api/v1/health", "bridge.health")):
        response = await client.get(path, headers={**AUTH, "X-Request-Id": "request-1"})
        assert response.status == 200
        body = await response.json()
        assert set(body) == {"request_id", "session_id", "turn_id", "event_id", "type", "timestamp", "payload"}
        assert body["request_id"] == "request-1"
        assert body["type"] == expected_type
        assert body["event_id"]
    capabilities = (await (await client.get("/api/v1/capabilities", headers=AUTH)).json())["payload"]
    assert capabilities["unknown_events_preserved"] is True
    assert "ask_user.requested" in capabilities["events"]


@pytest.mark.asyncio
async def test_auth_origin_and_legacy_cors_are_enforced(client):
    missing = await client.get("/status", headers={"Origin": ORIGIN})
    assert missing.status == 401
    assert (await missing.json())["payload"]["code"] == "unauthorized"

    denied = await client.get("/status", headers={"Authorization": f"Bearer {TOKEN}", "Origin": "https://evil.invalid"})
    assert denied.status == 403
    assert "Access-Control-Allow-Origin" not in denied.headers

    allowed = await client.get("/status", headers=AUTH)
    assert allowed.status == 200
    assert allowed.headers["Access-Control-Allow-Origin"] == ORIGIN
    assert allowed.headers["Access-Control-Allow-Origin"] != "*"
    safe_body = await allowed.json()
    assert safe_body["gaRoot"] == "[REDACTED_PATH]"
    assert safe_body["token"] == "[REDACTED]"
    assert "sensitive" not in json.dumps(safe_body)


@pytest.mark.asyncio
async def test_preflight_is_origin_restricted_and_contains_no_body(client):
    response = await client.options("/api/v1/health", headers={"Origin": ORIGIN,
        "Access-Control-Request-Method": "GET", "Authorization": f"Bearer {TOKEN}"})
    assert response.status == 204
    assert response.headers["Access-Control-Allow-Origin"] == ORIGIN
    assert await response.read() == b""


@pytest.mark.asyncio
async def test_internal_error_is_enveloped_and_redacted(client):
    response = await client.get("/explode", headers=AUTH)
    assert response.status == 500
    raw = await response.text()
    body = json.loads(raw)
    assert body["type"] == "error"
    assert body["payload"]["code"] == "internal_error"
    assert "D:\\private" not in raw
    assert "secret.txt" not in raw
    assert "traceback" not in raw.lower()


def test_recursive_redaction_and_unknown_payload_preservation():
    unknown = {"vendor_item": {"kind": "future.event", "opaque": [1, {"x": True}]}}
    wrapped = adapter.envelope("ga.unknown", adapter.redact(unknown))
    assert wrapped["payload"] == unknown
    cleaned = adapter.redact({"api_key": "x", "workspacePath": r"C:\\Users\\me\\repo", "nested": [{"password": "x"}]})
    assert cleaned == {"api_key": "[REDACTED]", "workspacePath": "[REDACTED_PATH]", "nested": [{"password": "[REDACTED]"}]}


def test_token_strength_origin_defaults_and_websocket_credential():
    manifest = adapter.load_manifest()
    with pytest.raises(ValueError, match="32"):
        adapter.create_app(official_module=fake_official_module(), token="short", allowed_origins=(ORIGIN,), manifest=manifest)
    assert "http://tauri.localhost" in adapter.parse_origins(None)
    ws = SimpleNamespace(headers={"Upgrade": "websocket", "Sec-WebSocket-Protocol": f"ga-token.{TOKEN}"}, path="/ws")
    http = SimpleNamespace(headers={"Sec-WebSocket-Protocol": f"ga-token.{TOKEN}"}, path="/status")
    bearer = SimpleNamespace(headers={"Authorization": "Bearer preferred", "Upgrade": "websocket",
                                      "Sec-WebSocket-Protocol": f"ga-token.{TOKEN}"}, path="/ws")
    assert adapter._credential(ws) == TOKEN
    assert adapter._credential(http) == ""
    assert adapter._credential(bearer) == "preferred"


def test_pinned_official_bridge_contract_without_importing_user_runtime():
    manifest = adapter.load_manifest()
    ga_root = Path(r"D:\GenericAgent")
    adapter.verify_official_bridge(ga_root, manifest)
    source = (ga_root / manifest["official_bridge"]["path"]).read_text(encoding="utf-8")
    tree = ast.parse(source)
    functions = {node.name: node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert "create_app" in functions
    routes = set()
    for node in ast.walk(functions["create_app"]):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr.startswith("add_") and node.args:
            if isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                routes.add((node.func.attr, node.args[0].value))
    required = {("add_get", "/ws"), ("add_get", "/status"), ("add_get", "/sessions"),
                ("add_post", "/session/new"), ("add_post", "/session/{sid}/prompt"),
                ("add_get", "/session/{sid}/messages"), ("add_post", "/session/{sid}/cancel")}
    assert required <= routes
