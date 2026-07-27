from __future__ import annotations

import ast
import importlib.util
import json
import os
from pathlib import Path
import threading
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


@pytest_asyncio.fixture
async def command_client(tmp_path):
    frontends = tmp_path / "frontends"
    frontends.mkdir()
    (frontends / "slash_cmds.py").write_text(
        "PALETTE_ENTRIES = [('/goal', '<objective>', 'Run a goal'), ('/scheduler', '', 'Local picker')]\n"
        "def prompt_for(cmd, args_text):\n"
        "    return f'GOAL:{args_text}' if cmd == '/goal' else None\n",
        encoding="utf-8",
    )
    manifest = adapter.load_manifest()
    app = adapter.create_app(
        official_module=fake_official_module(),
        token=TOKEN,
        allowed_origins=(ORIGIN,),
        manifest=manifest,
        ga_root=tmp_path,
    )
    async with TestClient(TestServer(app)) as test_client:
        yield test_client


@pytest.mark.asyncio
async def test_command_registry_requires_a_verified_ga_root(client):
    listed = await client.get("/api/v1/commands", headers=AUTH)
    assert listed.status == 503
    assert (await listed.json())["payload"]["code"] == "command_registry_unavailable"


@pytest.mark.asyncio
async def test_command_registry_discovers_ga_metadata_and_executes_prompt(command_client):
    listed = await command_client.get("/api/v1/commands", headers=AUTH)
    assert listed.status == 200
    commands = (await listed.json())["payload"]["commands"]
    assert [command["id"] for command in commands] == ["goal"]
    assert commands[0]["name"] == "/goal"
    assert commands[0]["arg_hint"] == "<objective>"
    assert commands[0]["argument_schema"]["properties"]["args_text"] == {
        "type": "string",
        "maxLength": adapter.MAX_COMMAND_ARGUMENT_CHARS,
    }
    assert commands[0]["plugin_version"]

    executed = await command_client.post(
        "/api/v1/commands/goal/execute", headers=AUTH, json={"args_text": "ship it"})
    assert executed.status == 200
    result = (await executed.json())["payload"]
    assert result == {"command_id": "goal", "result": {"type": "prompt", "prompt": "GOAL:ship it"}}

    missing = await command_client.post(
        "/api/v1/commands/not-there/execute", headers=AUTH, json={})
    assert missing.status == 404
    assert (await missing.json())["payload"]["code"] == "command_not_found"

    invalid = await command_client.post(
        "/api/v1/commands/goal/execute", headers=AUTH, json={"args_text": 7})
    assert invalid.status == 400
    assert (await invalid.json())["payload"]["code"] == "invalid_command_input"

    too_long = await command_client.post(
        "/api/v1/commands/goal/execute", headers=AUTH,
        json={"args_text": "x" * (adapter.MAX_COMMAND_ARGUMENT_CHARS + 1)})
    assert too_long.status == 400
    assert (await too_long.json())["payload"]["code"] == "invalid_command_input"


@pytest.mark.asyncio
async def test_command_registry_failures_are_isolated_and_redacted(monkeypatch, client):
    def fail_registry(_root):
        raise RuntimeError("sensitive-plugin-detail")

    monkeypatch.setattr(adapter, "load_command_registry", fail_registry)
    # The default test app has no root, so build an isolated app with any root
    # to exercise the plugin failure path rather than the missing-root path.
    manifest = adapter.load_manifest()
    app = adapter.create_app(
        official_module=fake_official_module(),
        token=TOKEN,
        allowed_origins=(ORIGIN,),
        manifest=manifest,
        ga_root=Path("."),
    )
    async with TestClient(TestServer(app)) as isolated:
        for method, path, kwargs in (
            (isolated.get, "/api/v1/commands", {}),
            (isolated.post, "/api/v1/commands/goal/execute", {"json": {}}),
        ):
            response = await method(path, headers=AUTH, **kwargs)
            assert response.status == 503
            body = await response.json()
            assert body["payload"]["code"] == "command_registry_unavailable"
            assert "sensitive-plugin-detail" not in json.dumps(body)


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
    assert "command_registry" in capabilities["capabilities"]
    assert "automation_registry" in capabilities["capabilities"]
    assert "hooks_observability" in capabilities["capabilities"]
    assert "ask_user.requested" in capabilities["events"]
    assert not any(event.startswith("command.") for event in capabilities["events"])


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
    configured_root = os.environ.get("GA_TEST_ROOT", "").strip()
    if not configured_root:
        pytest.skip("set GA_TEST_ROOT to a checkout matching runtime_manifest.json")
    manifest = adapter.load_manifest()
    ga_root = Path(configured_root).expanduser().resolve()
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
    required = {
        ("add_get", "/ws"), ("add_get", "/status"), ("add_get", "/sessions"),
        ("add_post", "/session/new"), ("add_post", "/session/{sid}/prompt"),
        ("add_get", "/session/{sid}/messages"), ("add_post", "/session/{sid}/cancel"),
    }
    assert required <= routes


@pytest.mark.asyncio
async def test_adapter_exposes_hooks_and_automation_routes(automation_client):
    client, _ = automation_client
    routes = {(route.method, route.resource.canonical) for route in client.app.router.routes()}
    required = {
        ("GET", "/api/v1/hooks"), ("GET", "/api/v1/automations"),
        ("POST", "/api/v1/automations"),
        ("PATCH", "/api/v1/automations/{automation_id}"),
        ("DELETE", "/api/v1/automations/{automation_id}"),
        ("GET", "/api/v1/automations/{automation_id}/runs"),
    }
    assert required <= routes


@pytest_asyncio.fixture
async def automation_client(tmp_path):
    (tmp_path / "sche_tasks").mkdir()
    manifest = adapter.load_manifest()
    app = adapter.create_app(
        official_module=fake_official_module(), token=TOKEN,
        allowed_origins=(ORIGIN,), manifest=manifest, ga_root=tmp_path,
    )
    async with TestClient(TestServer(app)) as test_client:
        yield test_client, tmp_path


@pytest.mark.asyncio
async def test_hooks_snapshot_reads_only_an_already_loaded_registry(monkeypatch, client):
    adapter.HOOK_OBSERVATIONS.clear()
    monkeypatch.delitem(adapter.sys.modules, "plugins.hooks", raising=False)
    unloaded = await client.get("/api/v1/hooks", headers=AUTH)
    assert unloaded.status == 200
    assert (await unloaded.json())["payload"] == {
        "registry_state": "not_loaded",
        "events": adapter.HOOK_EVENTS,
        "registrations": [],
        "observations": [],
    }

    def callback(_ctx):
        return None

    callback.__module__ = "plugins.safe_plugin"
    callback.__qualname__ = "observe"
    fake_hooks = SimpleNamespace(_registry={"agent_before": [callback], "vendor.event": [callback]})
    monkeypatch.setitem(adapter.sys.modules, "plugins.hooks", fake_hooks)
    loaded = await client.get("/api/v1/hooks", headers=AUTH)
    payload = (await loaded.json())["payload"]
    assert payload["registry_state"] == "loaded"
    assert payload["registrations"] == [
        {"event": "agent_before", "module": "plugins.safe_plugin", "handler": "observe"},
        {"event": "vendor.event", "module": "plugins.safe_plugin", "handler": "observe"},
    ]
    observer = next(item for item in fake_hooks._registry["agent_before"]
                    if getattr(item, "__ga_desktop_observer__", False))
    observer({"token": "sensitive-context-must-not-escape"})
    again = (await (await client.get("/api/v1/hooks", headers=AUTH)).json())["payload"]
    assert len([item for item in fake_hooks._registry["agent_before"]
                if getattr(item, "__ga_desktop_observer__", False)]) == 1
    assert set(again["observations"][0]) == {"id", "event", "timestamp"}
    assert again["observations"][0]["event"] == "agent_before"
    assert "sensitive-context" not in json.dumps(again)

    threads = [threading.Thread(target=adapter.install_hook_observers, args=(fake_hooks._registry,))
               for _ in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    for event in adapter.HOOK_EVENTS:
        assert len([item for item in fake_hooks._registry[event]
                    if getattr(item, "__ga_desktop_observer__", False)]) == 1


@pytest.mark.asyncio
async def test_agent_prompt_automation_crud_is_strict_and_atomic(automation_client):
    client, root = automation_client
    created = await client.post("/api/v1/automations", headers=AUTH, json={
        "id": "daily-report", "schedule": "08:30", "repeat": "daily",
        "enabled": True, "prompt": "Prepare the daily report", "max_delay_hours": 4,
    })
    assert created.status == 201
    expected = {"id": "daily-report", "schedule": "08:30", "repeat": "daily",
                "enabled": True, "prompt": "Prepare the daily report", "max_delay_hours": 4}
    assert (await created.json())["payload"]["automation"] == expected
    assert json.loads((root / "sche_tasks" / "daily-report.json").read_text(encoding="utf-8")) == {
        key: value for key, value in expected.items() if key != "id"
    }
    assert not list((root / "sche_tasks").glob("*.tmp"))

    listed = await client.get("/api/v1/automations", headers=AUTH)
    assert (await listed.json())["payload"] == {"automations": [expected], "diagnostics": []}

    patched = await client.patch("/api/v1/automations/daily-report", headers=AUTH,
                                 json={"enabled": False, "repeat": "every_15m"})
    assert patched.status == 200
    assert (await patched.json())["payload"]["automation"]["enabled"] is False
    assert (await patched.json())["payload"]["automation"]["repeat"] == "every_15m"

    deleted = await client.delete("/api/v1/automations/daily-report", headers=AUTH)
    assert deleted.status == 200
    assert not (root / "sche_tasks" / "daily-report.json").exists()


@pytest.mark.asyncio
async def test_automation_rejects_traversal_unknown_fields_and_invalid_schedule(automation_client):
    client, root = automation_client
    valid = {"id": "safe", "schedule": "09:00", "repeat": "weekday",
             "enabled": True, "prompt": "Do work", "max_delay_hours": 6}
    cases = [
        ({**valid, "id": "../escape"}, "invalid_automation"),
        ({**valid, "schedule": "25:00"}, "invalid_automation"),
        ({**valid, "repeat": "sometimes"}, "invalid_automation"),
        ({**valid, "bash": "danger"}, "invalid_automation"),
        ({**valid, "prompt": ""}, "invalid_automation"),
    ]
    for body, code in cases:
        response = await client.post("/api/v1/automations", headers=AUTH, json=body)
        assert response.status == 400
        assert (await response.json())["payload"]["code"] == code
    assert not (root.parent / "escape.json").exists()


@pytest.mark.asyncio
async def test_automation_listing_isolates_invalid_files_and_run_metadata(automation_client):
    client, root = automation_client
    tasks = root / "sche_tasks"
    (tasks / "broken.json").write_text("{bad", encoding="utf-8")
    (tasks / "valid.json").write_text(json.dumps({
        "schedule": "10:00", "repeat": "once", "enabled": True,
        "prompt": "One shot", "max_delay_hours": 2,
    }), encoding="utf-8")
    done = tasks / "done"
    done.mkdir()
    (done / "2026-07-28_1030_valid.md").write_text("secret report body", encoding="utf-8")
    (done / "not-a-run.txt").write_text("ignored", encoding="utf-8")

    listed = (await (await client.get("/api/v1/automations", headers=AUTH)).json())["payload"]
    assert [item["id"] for item in listed["automations"]] == ["valid"]
    assert listed["diagnostics"] == [{"id": "broken", "code": "invalid_definition"}]
    runs = (await (await client.get("/api/v1/automations/valid/runs", headers=AUTH)).json())["payload"]
    assert runs["runs"] == [{"id": "2026-07-28_1030_valid", "timestamp": "2026-07-28T10:30:00", "size": 18}]
    assert "secret report body" not in json.dumps(runs)


@pytest.mark.asyncio
async def test_automation_registry_rejects_symlink_escape(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "ga"
    root.mkdir()
    try:
        (root / "sche_tasks").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symbolic links are unavailable")
    app = adapter.create_app(
        official_module=fake_official_module(), token=TOKEN,
        allowed_origins=(ORIGIN,), manifest=adapter.load_manifest(), ga_root=root,
    )
    async with TestClient(TestServer(app)) as client:
        response = await client.get("/api/v1/automations", headers=AUTH)
        assert response.status == 503
        created = await client.post("/api/v1/automations", headers=AUTH, json={
            "id": "escape", "schedule": "08:00", "repeat": "daily",
            "enabled": True, "prompt": "must not escape", "max_delay_hours": 6,
        })
        assert created.status == 400
    assert not (outside / "escape.json").exists()
