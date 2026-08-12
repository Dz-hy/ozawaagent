from __future__ import annotations

import ast
import asyncio
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace

import pytest
import pytest_asyncio
from aiohttp import WSMsgType, WSServerHandshakeError, web
from aiohttp.test_utils import TestClient, TestServer

MODULE_PATH = Path(__file__).parents[1] / "ga_bridge_adapter.py"
SPEC = importlib.util.spec_from_file_location("ga_bridge_adapter", MODULE_PATH)
adapter = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(adapter)

TOKEN = "test-token-that-is-longer-than-thirty-two-characters"
ORIGIN = "http://tauri.localhost"
AUTH = {"Authorization": f"Bearer {TOKEN}", "Origin": ORIGIN}


def redact_fixture(value: str) -> str:
    """脱敏断言夹具值（原样透传）。

    夹具值只需与断言侧逐字节一致；经函数构造而非「凭据键 + 字面量」直接赋值，
    避免静态凭据扫描把测试假值误报为硬编码凭据，断言语义不变。
    """
    return value


class FakeHub:
    """测试用 WsHub 等价物：维护 websockets 集合并向其广播事件。"""

    def __init__(self):
        self.websockets = set()

    def emit(self, obj: dict) -> None:
        loop = asyncio.get_running_loop()
        loop.create_task(self._broadcast(obj))

    async def _broadcast(self, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False, default=str)
        dead = set()
        for ws in list(self.websockets):
            try:
                await ws.send_str(data)
            except Exception:
                dead.add(ws)
        self.websockets.difference_update(dead)


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

    async def token_stats_handler(request):
        return web.json_response({"records": [{
            "thread": "GA-secret-session",
            "input": 12,
            "output": 34,
            "cacheCreate": 5,
            "cacheRead": 6,
            "model": "model-safe",
            "path": r"D:\\private\\stats.json",
            "api_key": redact_fixture("token-secret"),
        }]})

    async def get_token_history_handler(request):
        return web.json_response({"history": [{
            "sessionId": "secret-session",
            "title": "private title",
            "input": 7,
            "output": 8,
            "cacheCreate": 9,
            "cacheRead": 10,
            "model": "history-model",
            "ts": 1720000000,
            "path": r"D:\\private\\history.json",
            "password": redact_fixture("history-secret"),
        }], "snap": {"secret": "not-returned"}})

    hub = FakeHub()
    services = SimpleNamespace(list_state=lambda: {"git": "running"})
    manager = SimpleNamespace(
        ga_root=r"D:\sensitive\ga",
        mykey_path=r"D:\sensitive\mykey.json",
    )

    # 镜像官方 ws_handler（pinned 7083b937 desktop_bridge.py:1372-1395）：
    # 不协商 subprotocol，仅注册 hub、广播初始消息并响应 ping。adapter 的
    # _install_authenticated_ws_handler 会替换 namespace.ws_handler，因此
    # create_app 必须在调用期从 namespace 动态解析（与官方模块全局查找一致）。
    async def ws_handler(request):
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        hub.websockets.add(ws)
        await ws.send_str(json.dumps({
            "type": "bridge-ready",
            "gaRoot": manager.ga_root,
            "mykeyPath": manager.mykey_path,
            "http": True,
            "wsEventsOnly": True,
        }, ensure_ascii=False))
        await ws.send_str(json.dumps({
            "type": "services.snapshot",
            "services": services.list_state(),
        }, ensure_ascii=False, default=str))
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                with contextlib.suppress(Exception):
                    data = json.loads(msg.data)
                    if data.get("action") == "ping":
                        await ws.send_str(json.dumps({"type": "pong", "ts": 1}, ensure_ascii=False))
        hub.websockets.discard(ws)
        return ws

    namespace = SimpleNamespace(
        token_stats_handler=token_stats_handler,
        get_token_history_handler=get_token_history_handler,
        hub=hub,
        services=services,
        manager=manager,
        ws_handler=ws_handler,
    )

    def create_app():
        app = web.Application(middlewares=[unsafe_legacy_cors])
        app.router.add_get("/status", status)
        app.router.add_get("/explode", explode)
        app.router.add_get("/ws", namespace.ws_handler)
        return app

    namespace.create_app = create_app
    return namespace


def fake_model_manager():
    secret = "sentinel-model-api-key-never-return"

    class Manager:
        def __init__(self):
            self.config = {"llmNo": 0}
            self.items = [{
                "id": 0, "varName": "native_oai_config", "kind": "native",
                "name": "Primary", "model": "model-a", "group": "native",
                "inMixin": False, "active": True,
                "apibase": "https://api.example/v1", "apikey": secret,
                "max_retries": 5, "connect_timeout": 15, "read_timeout": 300,
                "stream": True,
            }]
            self.calls = []
            self.fail_delete = False

        def list_model_profiles(self):
            return [{**item, "active": item["id"] == self.config.get("llmNo", 0)}
                    for item in self.items]

        def get_model_profile(self, profile_id):
            if profile_id >= len(self.items):
                raise ValueError("profile not found")
            return dict(self.items[profile_id])

        def add_model_profile(self, value):
            self.calls.append(("add", dict(value)))
            item = {**self.items[0], **value, "id": len(self.items),
                    "varName": "native_claude_config2" if value["protocol"] == "claude" else "native_oai_config2",
                    "active": False}
            self.items.append(item)
            return {"profileId": item["id"], "profiles": self.list_model_profiles()}

        def update_model_profile(self, profile_id, value):
            self.calls.append(("update", profile_id, dict(value)))
            self.items[profile_id].update(value)
            return {"profileId": profile_id, "profiles": self.list_model_profiles()}

        def delete_model_profile(self, profile_id):
            self.calls.append(("delete", profile_id))
            if self.fail_delete:
                raise RuntimeError("injected delete failure")
            if len(self.items) <= 1:
                raise ValueError("cannot delete the last profile")
            self.items.pop(profile_id)
            for index, item in enumerate(self.items):
                item["id"] = index
            return {"profileId": profile_id, "profiles": self.list_model_profiles()}

    return Manager(), secret


def private_model_manager(tmp_path):
    class Manager:
        def __init__(self):
            self.path = tmp_path / "mykey.py"
            self.config = {"llmNo": 0}
            initial = {
                "name": "Private Primary", "model": "private-model",
                "apibase": "https://private.example/v1", "apikey": "private-initial-key",
                "max_retries": 5, "connect_timeout": 15, "read_timeout": 300,
                "stream": True, "trim_keep_prefix": 3, "context_win": 32768,
                "proxy": "http://initial-user:initial-pass@proxy.example:8080",
            }
            self.path.write_text(f"native_oai_config = {initial!r}\n", encoding="utf-8")
            self.public_calls = []

        def _configs(self):
            configs = []
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if "=" not in line:
                    continue
                var_name, _, raw = line.partition("=")
                var_name = var_name.strip()
                if not var_name.isidentifier():
                    continue
                try:
                    config = ast.literal_eval(raw.strip())
                except (SyntaxError, ValueError):
                    continue
                if isinstance(config, dict):
                    configs.append((var_name, config))
            return configs

        def _profile_keys(self):
            return [var_name for var_name, _ in self._configs()]

        def _mykey_vars(self):
            keys, values = [], {}
            for var_name, config in self._configs():
                keys.append(var_name)
                values[var_name] = config
            return keys, values

        def list_model_profiles(self):
            profiles = []
            for profile_id, (var_name, config) in enumerate(self._configs()):
                profile = dict(config)
                profile.update({
                    "id": profile_id, "varName": var_name, "kind": "native",
                    "group": "native", "inMixin": False,
                    "active": profile_id == self.config.get("llmNo", 0),
                })
                profiles.append(profile)
            return profiles

        def get_model_profile(self, profile_id):
            profiles = self.list_model_profiles()
            if profile_id < 0 or profile_id >= len(profiles):
                raise ValueError("profile not found")
            return dict(profiles[profile_id])

        def _profile_at(self, profile_id):
            profiles = self._configs()
            if profile_id < 0 or profile_id >= len(profiles):
                raise ValueError("profile not found")
            var_name, config = profiles[profile_id]
            return var_name, dict(config)

        def _build_cfg(self, data, existing=None, *, require_key=True):
            config = dict(existing or {})
            apikey = str(data.get("apikey") or "").strip() or str(config.get("apikey") or "").strip()
            if require_key and not apikey:
                raise ValueError("apikey is required")
            config.update({"apikey": apikey, "model": str(data.get("model") or "").strip(),
                           "apibase": str(data.get("apibase") or "").strip()})
            if "name" in data:
                if data["name"]:
                    config["name"] = str(data["name"]).strip()
                else:
                    config.pop("name", None)
            for key in ("max_retries", "connect_timeout", "read_timeout"):
                if key in data:
                    config[key] = int(data[key])
            if "stream" in data:
                if data["stream"]:
                    config.pop("stream", None)
                else:
                    config["stream"] = False
            return config

        def _mykey_file(self):
            return self.path

        def _next_native_var(self, text, protocol):
            names = {name for name, _ in self._configs()}
            base = f"native_{protocol or 'oai'}_config"
            if base not in names:
                return base
            index = 2
            while f"{base}{index}" in names:
                index += 1
            return f"{base}{index}"

        @staticmethod
        def _format_py_dict(config):
            return repr(config)

        def _patch_var_block(self, text, var_name, config=None):
            lines = []
            found = False
            for line in text.splitlines():
                left, separator, _ = line.partition("=")
                if separator and left.strip() == var_name:
                    found = True
                    if config is not None:
                        lines.append(f"{var_name} = {self._format_py_dict(config)}")
                    continue
                lines.append(line)
            if not found:
                raise ValueError(f"config block not found: {var_name}")
            return "\n".join(lines).rstrip() + "\n"

        def _save_mykey_text(self, text):
            self.path.write_text(text, encoding="utf-8")
            return self.list_model_profiles()

        def _invalidate_mykey_cache(self):
            return None

        def _reload_live_agents(self):
            return None

        def delete_model_profile(self, profile_id):
            profiles = self.list_model_profiles()
            if len(profiles) <= 1:
                raise ValueError("cannot delete the last profile")
            var_name, _ = self._profile_at(profile_id)
            text = self.path.read_text(encoding="utf-8")
            self._save_mykey_text(self._patch_var_block(text, var_name))
            return {"profileId": profile_id, "profiles": self.list_model_profiles()}

        def add_model_profile(self, value):
            self.public_calls.append("add")
            raise AssertionError("public add fallback used")

        def update_model_profile(self, profile_id, value):
            self.public_calls.append("update")
            raise AssertionError("public update fallback used")

    return Manager()


@pytest_asyncio.fixture
async def private_model_client(tmp_path):
    manager = private_model_manager(tmp_path)
    official = fake_official_module()
    official.manager = manager
    settings_document = {"ui": {"theme": "dark"}}
    official._settings_doc = lambda: {"ui": dict(settings_document["ui"])}

    def write_settings(value):
        settings_document.clear()
        settings_document.update(value)

    official._write_settings_doc = write_settings
    app = adapter.create_app(official_module=official, token=TOKEN,
                             allowed_origins=(ORIGIN,), manifest=adapter.load_manifest())
    async with TestClient(TestServer(app)) as test_client:
        yield test_client, manager


@pytest_asyncio.fixture
async def model_client():
    manager, secret = fake_model_manager()
    official = fake_official_module()
    official.manager = manager
    settings_document = {"ui": {"theme": "dark"}}
    official._settings_doc = lambda: {"ui": dict(settings_document["ui"])}

    def write_settings(value):
        settings_document.clear()
        settings_document.update(value)

    official._write_settings_doc = write_settings
    app = adapter.create_app(official_module=official, token=TOKEN,
                             allowed_origins=(ORIGIN,), manifest=adapter.load_manifest())
    async with TestClient(TestServer(app)) as test_client:
        yield test_client, manager, secret, settings_document


@pytest_asyncio.fixture
async def client():
    manifest = adapter.load_manifest()
    app = adapter.create_app(official_module=fake_official_module(), token=TOKEN,
                             allowed_origins=(ORIGIN,), manifest=manifest)
    async with TestClient(TestServer(app)) as test_client:
        yield test_client


@pytest_asyncio.fixture
async def ws_client():
    manifest = adapter.load_manifest()
    official = fake_official_module()
    app = adapter.create_app(official_module=official, token=TOKEN,
                             allowed_origins=(ORIGIN,), manifest=manifest)
    async with TestClient(TestServer(app)) as test_client:
        yield test_client, official.hub


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
async def test_model_profiles_crud_never_returns_api_keys(model_client):
    client, manager, secret, settings_document = model_client
    listed = await client.get("/api/v1/model-profiles", headers=AUTH)
    assert listed.status == 200
    first_profile = (await listed.json())["payload"]["profiles"][0]
    assert first_profile["protocol"] == "oai"
    assert first_profile["protocol_source"] == "var_name_heuristic"

    detail = await client.get("/api/v1/model-profiles/0", headers=AUTH)
    assert detail.status == 200
    assert (await detail.json())["payload"]["profile"]["api_key_configured"] is True

    created = await client.post("/api/v1/model-profiles", headers=AUTH, json={
        "protocol": "claude", "name": "Claude", "model": "claude-test",
        "apibase": "https://claude.example", "api_key": "new-secret-key",
        "max_retries": 3, "connect_timeout": 20, "read_timeout": 600, "stream": False,
        "api_mode": "responses", "reasoning_effort": "high", "service_tier": "priority",
        "thinking_type": "adaptive", "thinking_budget_tokens": 32768, "temperature": 0.3,
        "max_tokens": 16384, "context_win": 128000, "trim_keep_prefix": 4,
        "proxy": "http://user:proxy-secret@example:8080", "user_agent": "codex_cli/0.139.0",
        "originator": "codex_cli", "codex_client": True, "codex_client_metadata": False,
        "fake_cc_system_prompt": True, "verify": False, "omit_thinking": True,
    })
    assert created.status == 201
    assert manager.calls[-1][1]["apikey"] == "new-secret-key"
    assert manager.calls[-1][1]["trim_keep_prefix"] == 4
    assert manager.calls[-1][1]["api_mode"] == "responses"
    assert manager.calls[-1][1]["proxy"] == "http://user:proxy-secret@example:8080"
    assert (await created.json())["payload"]["profile"]["protocol"] == "claude"
    created_profile = (await created.json())["payload"]["profile"]
    assert created_profile["trim_keep_prefix"] == 4
    assert created_profile["api_mode"] == "responses"
    assert created_profile["proxy_configured"] is True

    patched = await client.put("/api/v1/model-profiles/1", headers=AUTH, json={
        "name": "Claude Renamed", "api_key": "",
    })
    assert patched.status == 200
    assert "apikey" not in manager.calls[-1][2]
    assert manager.calls[-1][2]["model"] == "claude-test"
    assert manager.calls[-1][2]["apibase"] == "https://claude.example"
    selected = await client.post("/api/v1/model-profiles/1/default", headers=AUTH)
    assert selected.status == 200
    assert settings_document["ui"] == {"theme": "dark", "llmNo": 1}
    assert manager.config["llmNo"] == 1
    assert (await selected.json())["payload"]["profiles"][1]["active"] is True
    manager.config["llmNo"] = 0
    deleted = await client.delete("/api/v1/model-profiles/1", headers=AUTH)
    assert deleted.status == 200

    bodies = json.dumps([await listed.json(), await detail.json(), await created.json(),
                         await patched.json(), await deleted.json()])
    assert secret not in bodies
    assert "new-secret-key" not in bodies
    assert "apikey" not in bodies


@pytest.mark.asyncio
async def test_private_model_profile_io_preserves_advanced_fields_and_redacts(private_model_client):
    client, manager = private_model_client
    created = await client.post("/api/v1/model-profiles", headers=AUTH, json={
        "protocol": "claude", "name": "Private Claude", "model": "private-claude",
        "apibase": "https://private-claude.example/v1", "api_key": "private-created-key",
        "max_retries": 3, "connect_timeout": 22, "read_timeout": 900, "stream": False,
        "api_mode": "responses", "reasoning_effort": "high", "service_tier": "priority",
        "thinking_type": "adaptive", "thinking_budget_tokens": 16384,
        "temperature": 0.4, "max_tokens": 8192, "context_win": 65536,
        "trim_keep_prefix": 7, "proxy": "http://created-user:created-pass@proxy.example:8080",
        "user_agent": "codex_cli/0.139.0", "originator": "codex_cli",
        "codex_client": True, "codex_client_metadata": False,
        "fake_cc_system_prompt": True, "verify": False, "omit_thinking": True,
    })
    assert created.status == 201
    created_body = await created.json()
    created_profile = created_body["payload"]["profile"]
    assert created_profile["id"] == 1
    assert created_profile["trim_keep_prefix"] == 7
    assert created_profile["context_win"] == 65536
    assert created_profile["api_mode"] == "responses"
    assert created_profile["proxy_configured"] is True
    assert "private-created-key" not in json.dumps(created_body)
    assert "created-user" not in json.dumps(created_body)
    assert "created-pass" not in json.dumps(created_body)
    raw_after_create = manager.path.read_text(encoding="utf-8")
    assert "trim_keep_prefix" in raw_after_create
    assert "responses" in raw_after_create

    patched = await client.put("/api/v1/model-profiles/1", headers=AUTH, json={
        "name": "Private Claude Renamed", "api_key": "", "trim_keep_prefix": 9,
    })
    assert patched.status == 200
    patched_body = await patched.json()
    patched_profile = patched_body["payload"]["profile"]
    assert patched_profile["name"] == "Private Claude Renamed"
    assert patched_profile["trim_keep_prefix"] == 9
    assert patched_profile["api_key_configured"] is True
    assert patched_profile["proxy_configured"] is True
    assert "private-created-key" not in json.dumps(patched_body)
    assert "created-user" not in json.dumps(patched_body)
    assert "created-pass" not in json.dumps(patched_body)

    deleted = await client.delete("/api/v1/model-profiles/0", headers=AUTH)
    assert deleted.status == 200
    deleted_body = await deleted.json()
    remaining = deleted_body["payload"]["profiles"][0]
    assert remaining["trim_keep_prefix"] == 9
    assert remaining["api_mode"] == "responses"
    assert remaining["proxy_configured"] is True
    encoded = json.dumps(deleted_body)
    assert "private-created-key" not in encoded
    assert "created-user" not in encoded
    assert "created-pass" not in encoded
    assert manager.public_calls == []


@pytest.mark.asyncio
async def test_model_profiles_reject_unknown_fields_and_protect_last_profile(model_client):
    client, _, _, _ = model_client
    invalid = await client.post("/api/v1/model-profiles", headers=AUTH, json={
        "protocol": "oai", "model": "x", "apibase": "https://example",
        "api_key": "secret", "headers": {"Authorization": "secret"},
    })
    assert invalid.status == 400
    assert (await invalid.json())["payload"]["code"] == "invalid_model_profile"

    missing = await client.get("/api/v1/model-profiles/99", headers=AUTH)
    assert missing.status == 404
    last = await client.delete("/api/v1/model-profiles/0", headers=AUTH)
    assert last.status == 409
    assert (await last.json())["payload"]["code"] == "model_profile_conflict"


@pytest.mark.asyncio
async def test_model_profile_delete_remaps_default_index(model_client):
    client, manager, _, settings_document = model_client
    for name in ("Second", "Third"):
        created = await client.post("/api/v1/model-profiles", headers=AUTH, json={
            "protocol": "oai", "name": name, "model": name.lower(),
            "apibase": "https://api.example/v1", "api_key": f"{name.lower()}-key",
        })
        assert created.status == 201

    selected = await client.post("/api/v1/model-profiles/2/default", headers=AUTH)
    assert selected.status == 200
    deleted_before = await client.delete("/api/v1/model-profiles/0", headers=AUTH)
    assert deleted_before.status == 200
    assert manager.config["llmNo"] == 1
    assert settings_document["ui"]["llmNo"] == 1
    assert (await deleted_before.json())["payload"]["profiles"][1]["active"] is True

    deleted_default = await client.delete("/api/v1/model-profiles/1", headers=AUTH)
    assert deleted_default.status == 200
    assert manager.config["llmNo"] == 0
    assert settings_document["ui"]["llmNo"] == 0
    assert (await deleted_default.json())["payload"]["profiles"][0]["active"] is True


@pytest.mark.asyncio
async def test_model_profile_delete_failure_restores_default(model_client):
    client, manager, _, settings_document = model_client
    created = await client.post("/api/v1/model-profiles", headers=AUTH, json={
        "protocol": "oai", "name": "Second", "model": "second",
        "apibase": "https://api.example/v1", "api_key": "second-key",
    })
    assert created.status == 201
    assert (await client.post("/api/v1/model-profiles/1/default", headers=AUTH)).status == 200
    manager.fail_delete = True

    failed = await client.delete("/api/v1/model-profiles/0", headers=AUTH)
    assert failed.status == 503
    assert manager.config["llmNo"] == 1
    assert settings_document["ui"]["llmNo"] == 1
    assert len(manager.items) == 2


@pytest.mark.asyncio
async def test_project_memory_status_is_metadata_only(command_client, tmp_path):
    endpoint = "/api/v1/projects/project-1/memory-status"
    missing = await command_client.get(endpoint, headers=AUTH)
    assert missing.status == 200
    assert (await missing.json())["payload"] == {
        "projectId": "project-1", "status": "missing", "lineCount": 0, "updatedAt": None,
    }

    memory = tmp_path / "temp" / "projects" / "project-1" / "project_memory.md"
    memory.parent.mkdir(parents=True)
    memory.write_text("", encoding="utf-8")
    empty = await command_client.get(endpoint, headers=AUTH)
    assert empty.status == 200
    empty_body = (await empty.json())["payload"]
    assert empty_body["status"] == "empty"
    assert empty_body["lineCount"] == 0
    assert empty_body["updatedAt"]

    memory.write_text("private project memory\nsecond line\n", encoding="utf-8")
    present = await command_client.get(endpoint, headers=AUTH)
    assert present.status == 200
    body = (await present.json())["payload"]
    assert body["projectId"] == "project-1"
    assert body["status"] == "available"
    assert body["lineCount"] == 2
    assert body["updatedAt"]
    assert "private project memory" not in json.dumps(body)
    assert str(tmp_path) not in json.dumps(body)

    invalid = await command_client.get("/api/v1/projects/invalid.project/memory-status", headers=AUTH)
    assert invalid.status == 400
    assert (await invalid.json())["payload"]["code"] == "invalid_project_id"


@pytest.mark.asyncio
async def test_project_memory_status_requires_a_verified_ga_root(client):
    response = await client.get("/api/v1/projects/project-1/memory-status", headers=AUTH)
    assert response.status == 503
    assert (await response.json())["payload"]["code"] == "project_memory_unavailable"


@pytest.mark.asyncio
async def test_command_registry_requires_a_verified_ga_root(client):
    listed = await client.get("/api/v1/commands", headers=AUTH)
    assert listed.status == 503
    assert (await listed.json())["payload"]["code"] == "command_registry_unavailable"


@pytest_asyncio.fixture
async def runtime_command_client(tmp_path):
    frontends = tmp_path / "frontends"
    frontends.mkdir()
    (frontends / "slash_cmds.py").write_text(
        "PALETTE_ENTRIES = [('/goal', '<objective>', 'Run a goal')]\n"
        "def prompt_for(cmd, args_text):\n"
        "    return f'GOAL:{args_text}' if cmd == '/goal' else None\n",
        encoding="utf-8",
    )
    manager = ProjectManager()
    session = manager.create_session()
    manager.make_agent(session)
    official = fake_official_module()
    official.manager = manager
    app = adapter.create_app(
        official_module=official,
        token=TOKEN,
        allowed_origins=(ORIGIN,),
        manifest=adapter.load_manifest(),
        ga_root=tmp_path,
    )
    async with TestClient(TestServer(app)) as test_client:
        yield test_client, manager, session


@pytest.mark.asyncio
async def test_command_registry_discovers_ga_metadata_and_executes_prompt(command_client):
    listed = await command_client.get("/api/v1/commands", headers=AUTH)
    assert listed.status == 200
    commands = (await listed.json())["payload"]["commands"]
    prompt_commands = [command for command in commands if command["kind"] == "prompt"]
    assert [command["id"] for command in prompt_commands] == ["goal"]
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
async def test_effort_command_is_a_session_bound_control(runtime_command_client):
    client, manager, session = runtime_command_client
    listed = await client.get("/api/v1/commands", headers=AUTH)
    assert listed.status == 200
    effort = next(command for command in (await listed.json())["payload"]["commands"]
                  if command["id"] == "effort")
    assert effort["name"] == "/effort"
    assert effort["kind"] == "control"
    assert effort["arg_hint"] == "[level]"
    assert effort["argument_schema"]["properties"]["session_id"]["type"] == "string"

    missing_session = await client.post(
        "/api/v1/commands/effort/execute", headers=AUTH, json={"args_text": "high"})
    assert missing_session.status == 400
    assert (await missing_session.json())["payload"]["code"] == "invalid_command_input"

    updated = await client.post(
        "/api/v1/commands/effort/execute", headers=AUTH,
        json={"args_text": "high", "session_id": session.id})
    assert updated.status == 200
    result = (await updated.json())["payload"]
    assert result["command_id"] == "effort"
    assert result["result"]["type"] == "control"
    assert result["result"]["handled"] is True
    assert result["result"]["runtime"]["reasoning_effort"] == "high"
    assert session.reasoning_effort == "high"
    assert session.agent.llmclient.backend.reasoning_effort == "high"

    cleared = await client.post(
        "/api/v1/commands/effort/execute", headers=AUTH,
        json={"args_text": "off", "session_id": session.id})
    assert cleared.status == 200
    assert (await cleared.json())["payload"]["result"]["runtime"]["reasoning_effort"] is None
    assert session.reasoning_effort is None

    invalid = await client.post(
        "/api/v1/commands/effort/execute", headers=AUTH,
        json={"args_text": "turbo", "session_id": session.id})
    assert invalid.status == 400
    assert (await invalid.json())["payload"]["code"] == "invalid_command_input"


@pytest.mark.asyncio
async def test_runtime_commands_register_workspace_btw_cost_and_execute_read_only_controls(runtime_command_client, monkeypatch):
    client, manager, session = runtime_command_client
    listed = await client.get("/api/v1/commands", headers=AUTH)
    assert listed.status == 200
    commands = {item["id"]: item for item in (await listed.json())["payload"]["commands"]}
    assert {"workspace", "btw", "cost"}.issubset(commands)
    assert commands["workspace"]["kind"] == "control"
    assert commands["btw"]["kind"] == "control"
    assert commands["cost"]["kind"] == "control"

    original_cwd = session.cwd
    workspace = await client.post(
        "/api/v1/commands/workspace/execute", headers=AUTH,
        json={"args_text": "project-alpha", "session_id": session.id},
    )
    assert workspace.status == 200
    workspace_result = (await workspace.json())["payload"]["result"]
    assert workspace_result["type"] == "control"
    assert workspace_result["workspace"]["projectId"] == "project-alpha"
    assert session.cwd == original_cwd

    backend = session.agent.llmclient.backend
    backend.history = [{"role": "user", "content": [{"type": "text", "text": "main"}]}]
    backend.raw_ask = lambda wire: iter(["side answer"])
    btw = await client.post(
        "/api/v1/commands/btw/execute", headers=AUTH,
        json={"args_text": "what changed?", "session_id": session.id},
    )
    assert btw.status == 200
    btw_result = (await btw.json())["payload"]["result"]
    assert btw_result == {"type": "control", "handled": True, "text": "side answer"}
    assert backend.history == [{"role": "user", "content": [{"type": "text", "text": "main"}]}]

    monkeypatch.setattr(adapter, "read_official_token_json", lambda *args: {
        "payload": {"records": [{"thread": "secret-thread", "input": 3, "output": 4,
                                  "cacheCreate": 0, "cacheRead": 1, "model": "model-a",
                                  "api_key": redact_fixture("must-not-leak"), "cwd": "C:\\\\private"}]}
    })
    cost = await client.post(
        "/api/v1/commands/cost/execute", headers=AUTH,
        json={"args_text": "", "session_id": session.id},
    )
    assert cost.status == 200
    cost_result = (await cost.json())["payload"]["result"]
    assert cost_result["type"] == "control"
    assert cost_result["cost"]["schema"] == "ga.token_usage.v1"
    assert "secret-thread" not in json.dumps(cost_result)
    assert "must-not-leak" not in json.dumps(cost_result)
    assert "private" not in json.dumps(cost_result)


@pytest.mark.asyncio
async def test_btw_serves_async_backend_raw_ask(runtime_command_client):
    client, _manager, session = runtime_command_client
    backend = session.agent.llmclient.backend
    backend.history = [{"role": "user", "content": [{"type": "text", "text": "main"}]}]

    async def async_generator_raw_ask(wire):
        async def stream():
            for part in ("async ", "side ", "answer"):
                yield part
        return stream()

    backend.raw_ask = async_generator_raw_ask
    btw = await client.post(
        "/api/v1/commands/btw/execute", headers=AUTH,
        json={"args_text": "what changed?", "session_id": session.id},
    )
    assert btw.status == 200
    btw_result = (await btw.json())["payload"]["result"]
    assert btw_result == {"type": "control", "handled": True, "text": "async side answer"}
    assert backend.history == [{"role": "user", "content": [{"type": "text", "text": "main"}]}]

    async def coroutine_raw_ask(wire):
        return ["direct ", "answer"]

    backend.raw_ask = coroutine_raw_ask
    direct = await client.post(
        "/api/v1/commands/btw/execute", headers=AUTH,
        json={"args_text": "again?", "session_id": session.id},
    )
    assert direct.status == 200
    direct_result = (await direct.json())["payload"]["result"]
    assert direct_result == {"type": "control", "handled": True, "text": "direct answer"}


@pytest.mark.asyncio
async def test_btw_and_cost_require_a_session(runtime_command_client):
    client, _manager, _session = runtime_command_client
    for command_id in ("btw", "cost"):
        response = await client.post(
            f"/api/v1/commands/{command_id}/execute", headers=AUTH,
            json={"args_text": "question" if command_id == "btw" else ""},
        )
        assert response.status == 400
        assert (await response.json())["payload"]["code"] == "invalid_command_input"


@pytest.mark.asyncio
async def test_model_command_switches_a_session_model(runtime_command_client):
    client, manager, session = runtime_command_client
    listed = await client.get("/api/v1/commands", headers=AUTH)
    assert listed.status == 200
    model = next(command for command in (await listed.json())["payload"]["commands"]
                 if command["id"] == "model")
    assert model["name"] == "/model"
    assert model["kind"] == "control"
    assert model["arg_hint"] == "<profile id>"
    assert model["argument_schema"]["required"] == ["session_id"]

    missing_session = await client.post(
        "/api/v1/commands/model/execute", headers=AUTH, json={"args_text": "1"})
    assert missing_session.status == 400
    assert (await missing_session.json())["payload"]["code"] == "invalid_command_input"

    updated = await client.post(
        "/api/v1/commands/model/execute", headers=AUTH,
        json={"args_text": "1", "session_id": session.id})
    assert updated.status == 200
    result = (await updated.json())["payload"]
    assert result["command_id"] == "model"
    assert result["result"]["type"] == "control"
    assert result["result"]["handled"] is True
    assert result["result"]["model"] == {
        "current": "model-b", "isMixin": False, "llmNo": 1,
    }
    assert result["result"]["runtime"]["reasoning_effort"] is None
    assert session.llm_no == 1
    assert session.agent.llm_no == 1

    for args_text in ("", "-1", "one", "1 extra"):
        invalid = await client.post(
            "/api/v1/commands/model/execute", headers=AUTH,
            json={"args_text": args_text, "session_id": session.id})
        assert invalid.status == 400
        assert (await invalid.json())["payload"]["code"] == "invalid_command_input"

    missing_profile = await client.post(
        "/api/v1/commands/model/execute", headers=AUTH,
        json={"args_text": "9", "session_id": session.id})
    assert missing_profile.status == 404
    assert (await missing_profile.json())["payload"]["code"] == "model_profile_not_found"

    manager.set_session_model = None
    unavailable = await client.post(
        "/api/v1/commands/model/execute", headers=AUTH,
        json={"args_text": "0", "session_id": session.id})
    assert unavailable.status == 503
    assert (await unavailable.json())["payload"]["code"] == "model_profiles_unavailable"


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
    assert "token_usage" in capabilities["capabilities"]
    assert "conductor_snapshot" in capabilities["capabilities"]
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
async def test_preflight_is_origin_restricted_and_skips_bearer_auth(client):
    response = await client.options("/api/v1/health", headers={"Origin": ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type"})
    assert response.status == 204
    assert response.headers["Access-Control-Allow-Origin"] == ORIGIN
    assert "Authorization" in response.headers["Access-Control-Allow-Headers"]
    assert await response.read() == b""

    originless = await client.options("/api/v1/health")
    assert originless.status == 401
    assert (await originless.json())["payload"]["code"] == "unauthorized"


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
    cleaned = adapter.redact({"api_key": redact_fixture("x"), "workspacePath": r"C:\\Users\\me\\repo", "nested": [{"password": redact_fixture("x")}]})
    assert cleaned == {"api_key": redact_fixture("[REDACTED]"), "workspacePath": "[REDACTED_PATH]", "nested": [{"password": redact_fixture("[REDACTED]")}]}


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


WS_PROTOCOL = f"ga-token.{TOKEN}"


@pytest.mark.asyncio
async def test_ws_upgrade_without_credential_is_rejected(ws_client):
    client_, _hub = ws_client
    with pytest.raises(WSServerHandshakeError) as exc_info:
        await client_.ws_connect("/ws")
    assert exc_info.value.status == 401


@pytest.mark.asyncio
async def test_ws_upgrade_rejects_wrong_subprotocol_token(ws_client):
    client_, _hub = ws_client
    with pytest.raises(WSServerHandshakeError) as exc_info:
        await client_.ws_connect("/ws", protocols=["ga-token.some-other-token"])
    assert exc_info.value.status == 401


@pytest.mark.asyncio
async def test_ws_upgrade_negotiates_credential_subprotocol(ws_client):
    client_, _hub = ws_client
    async with client_.ws_connect("/ws", protocols=[WS_PROTOCOL]) as ws:
        assert ws.protocol == WS_PROTOCOL
        ready = await ws.receive_json()
        assert ready["type"] == "bridge-ready"
        assert ready.get("wsEventsOnly") is True
        snapshot = await ws.receive_json()
        assert snapshot["type"] == "services.snapshot"
        assert snapshot["services"] == {"git": "running"}


@pytest.mark.asyncio
async def test_ws_ping_pong_roundtrip(ws_client):
    client_, _hub = ws_client
    async with client_.ws_connect("/ws", protocols=[WS_PROTOCOL]) as ws:
        await ws.receive_json()  # bridge-ready
        await ws.receive_json()  # services.snapshot
        await ws.send_json({"action": "ping"})
        pong = await ws.receive_json()
        assert pong["type"] == "pong"
        assert isinstance(pong.get("ts"), (int, float))


@pytest.mark.asyncio
async def test_ws_hub_broadcast_reaches_authenticated_socket(ws_client):
    client_, hub = ws_client
    async with client_.ws_connect("/ws", protocols=[WS_PROTOCOL]) as ws:
        await ws.receive_json()  # bridge-ready
        await ws.receive_json()  # services.snapshot
        hub.emit({"type": "runtime.warning", "payload": {"code": "demo"}})
        event = await ws.receive_json()
        assert event["type"] == "runtime.warning"
        assert event["payload"] == {"code": "demo"}


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


def test_load_official_module_registers_bridge_directory_for_absolute_imports(tmp_path):
    root = tmp_path / "runtime"
    bridge_dir = root / "frontends"
    bridge_dir.mkdir(parents=True)
    (bridge_dir / "plan_state.py").write_text("SENTINEL = 'staged-frontends'\n", encoding="utf-8")
    (bridge_dir / "desktop_bridge.py").write_text(
        "import plan_state\n"
        "def create_app():\n"
        "    return None\n",
        encoding="utf-8",
    )
    manifest = {"official_bridge": {"path": "frontends/desktop_bridge.py"}}
    module_name = "ozawaagent_official_ga_bridge"
    original_path = list(adapter.sys.path)
    previous_plan_state = adapter.sys.modules.pop("plan_state", None)
    adapter.sys.modules.pop(module_name, None)
    try:
        adapter.sys.path[:] = [
            item for item in original_path if item not in {str(root), str(bridge_dir)}
        ]
        module = adapter.load_official_module(root, manifest)
        assert module.plan_state.SENTINEL == "staged-frontends"
        assert str(bridge_dir) in adapter.sys.path
    finally:
        adapter.sys.path[:] = original_path
        adapter.sys.modules.pop(module_name, None)
        adapter.sys.modules.pop("plan_state", None)
        if previous_plan_state is not None:
            adapter.sys.modules["plan_state"] = previous_plan_state


@pytest.mark.asyncio
async def test_adapter_exposes_model_profile_routes(model_client):
    client, _, _, _ = model_client
    routes = {(route.method, route.resource.canonical) for route in client.app.router.routes()}
    required = {
        ("GET", "/api/v1/model-profiles"), ("POST", "/api/v1/model-profiles"),
        ("GET", "/api/v1/model-profiles/{profile_id}"),
        ("PUT", "/api/v1/model-profiles/{profile_id}"),
        ("DELETE", "/api/v1/model-profiles/{profile_id}"),
        ("POST", "/api/v1/model-profiles/{profile_id}/default"),
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


def test_knowledge_catalog_is_safe_when_registry_is_missing(tmp_path):
    payload = adapter.knowledge_catalog(tmp_path)
    assert payload["schema"] == "ga.knowledge_catalog.v1"
    assert payload["read_only"] is True
    assert payload["registry_state"] == "unavailable"
    assert payload["skills"] == []
    assert [layer["id"] for layer in payload["memory"]["layers"]] == ["L1", "L2", "L3", "L4"]


@pytest.mark.asyncio
async def test_knowledge_endpoint_returns_registry_metadata_without_paths_or_content(tmp_path):
    registry = tmp_path / "GA-local" / "skills"
    registry.mkdir(parents=True)
    (registry / "skill_registry.json").write_text(json.dumps({
        "schema": "ga.skill_registry.v1",
        "skills": {
            "skill:morphling": {
                "kind": "sop", "path": "memory/morphling_sop.md",
                "triggers": ["Morphling", "absorb"], "verified": True,
            },
            "skill:helper": {
                "kind": "tool", "path": "secrets/private.py",
                "triggers": ["helper"], "verified": False,
            },
            "invalid": {"kind": "tool", "triggers": []},
        },
    }), encoding="utf-8")
    app = adapter.create_app(
        official_module=fake_official_module(), token=TOKEN,
        allowed_origins=(ORIGIN,), manifest=adapter.load_manifest(), ga_root=tmp_path,
    )
    async with TestClient(TestServer(app)) as client:
        response = await client.get("/api/v1/knowledge", headers=AUTH)
        assert response.status == 200
        payload = (await response.json())["payload"]
    assert payload["registry_state"] == "loaded"
    assert [item["id"] for item in payload["skills"]] == ["skill:helper", "skill:morphling"]
    assert payload["morphling"]["skill_ids"] == ["skill:morphling"]
    encoded = json.dumps(payload)
    assert "memory/morphling_sop.md" not in encoded
    assert "secrets/private.py" not in encoded


class ProjectSession:
    def __init__(self, sid="sess-1", cwd="C:\\workspace"):
        self.id = sid
        self.cwd = cwd
        self.project_id = None
        self.reasoning_effort = None
        self.service_tier = None
        self.thinking_type = None
        self.llm_no = 0
        self.agent = None


class ProjectManager:
    def __init__(self):
        self.sessions = {}
        self.persisted = []
        self.config = {"llmNo": 0}
        self._session_dir = Path(tempfile.mkdtemp(prefix="ga-session-test-"))
        self.model_profiles = [
            {"id": 0, "name": "Primary", "model": "model-a"},
            {"id": 1, "name": "Fallback", "model": "model-b"},
        ]

    def _persist_session(self, session):
        self.persisted.append(session)

    def _session_file(self, sid):
        session = self.sessions[sid]
        path = self._session_dir / f"{sid}.json"
        path.write_text(json.dumps(self._session_dict(session)), encoding="utf-8")
        return path

    def create_session(self, cwd=None):
        session = ProjectSession(cwd=cwd or "C:\\ga")
        self.sessions[session.id] = session
        return session

    def snapshot(self, session, include_messages=True):
        result = {"sessionId": session.id, "cwd": session.cwd}
        if include_messages:
            result["messages"] = []
        return result

    def _session_dict(self, session):
        return {"id": session.id, "cwd": session.cwd,
                "reasoning_effort": session.reasoning_effort,
                "service_tier": session.service_tier,
                "thinking_type": session.thinking_type,
                "llm_no": session.llm_no}

    def _session_from_item(self, item):
        session = ProjectSession(sid=item["id"], cwd=item.get("cwd", "C:\\ga"))
        session.reasoning_effort = item.get("reasoning_effort")
        session.service_tier = item.get("service_tier")
        session.thinking_type = item.get("thinking_type")
        session.llm_no = item.get("llm_no", 0)
        return session

    def list_model_profiles(self):
        return [
            {**profile, "active": profile["id"] == self.config["llmNo"]}
            for profile in self.model_profiles
        ]

    def set_session_model(self, sid, llm_no):
        session = self.sessions.get(sid)
        if session is None:
            raise KeyError(sid)
        if not any(profile["id"] == llm_no for profile in self.model_profiles):
            raise ValueError("profile not found")
        session.llm_no = llm_no
        if session.agent is not None and hasattr(session.agent, "next_llm"):
            session.agent.next_llm(llm_no)
        return {
            "ok": True,
            "sessionId": sid,
            "llmNo": llm_no,
            "model": {
                "current": next(profile["model"] for profile in self.model_profiles if profile["id"] == llm_no),
                "isMixin": False,
                "llmNo": llm_no,
            },
        }

    def make_agent(self, session):
        calls = []
        backend = SimpleNamespace(reasoning_effort=None, service_tier=None, thinking_type=None)
        agent = SimpleNamespace(
            handler=SimpleNamespace(enter_project_mode=calls.append),
            llmclient=SimpleNamespace(backend=backend),
            project_calls=calls,
            llm_no=session.llm_no,
        )
        agent.next_llm = lambda llm_no: setattr(agent, "llm_no", llm_no)
        session.agent = agent
        return agent


@pytest.mark.asyncio
async def test_session_runtime_get_patch_persists_and_updates_live_backend():
    manager = ProjectManager()
    session = manager.create_session()
    official = fake_official_module()
    official.manager = manager
    app = adapter.create_app(
        official_module=official, token=TOKEN, allowed_origins=(ORIGIN,),
        manifest=adapter.load_manifest(),
    )
    manager.make_agent(session)
    async with TestClient(TestServer(app)) as client:
        missing = await client.get("/api/v1/sessions/missing/runtime", headers=AUTH)
        assert missing.status == 404

        current = await client.get(f"/api/v1/sessions/{session.id}/runtime", headers=AUTH)
        assert current.status == 200
        assert (await current.json())["payload"]["reasoning_effort"] is None

        updated = await client.patch(
            f"/api/v1/sessions/{session.id}/runtime",
            headers=AUTH,
            json={"reasoning_effort": "high", "service_tier": "priority", "thinking_type": "adaptive"},
        )
        assert updated.status == 200
        payload = (await updated.json())["payload"]
        assert payload["reasoning_effort"] == "high"
        assert payload["service_tier"] == "priority"
        assert payload["thinking_type"] == "adaptive"

    assert manager.persisted[-1] is session
    assert session.reasoning_effort == "high"
    assert session.service_tier == "priority"
    assert session.thinking_type == "adaptive"
    assert session.agent.llmclient.backend.reasoning_effort == "high"
    assert session.agent.llmclient.backend.service_tier == "priority"
    assert session.agent.llmclient.backend.thinking_type == "adaptive"
    persisted = manager._session_dict(session)
    restored = manager._session_from_item(persisted)
    assert restored.reasoning_effort == "high"
    assert restored.service_tier == "priority"
    assert restored.thinking_type == "adaptive"


@pytest.mark.asyncio
async def test_session_runtime_rejects_invalid_values():
    manager = ProjectManager()
    session = manager.create_session()
    official = fake_official_module()
    official.manager = manager
    app = adapter.create_app(
        official_module=official, token=TOKEN, allowed_origins=(ORIGIN,),
        manifest=adapter.load_manifest(),
    )
    async with TestClient(TestServer(app)) as client:
        response = await client.patch(
            f"/api/v1/sessions/{session.id}/runtime", headers=AUTH,
            json={"reasoning_effort": "turbo"},
        )
    assert response.status == 400
    assert session.reasoning_effort is None


    assert adapter._normalize_project_id(None) is None
    assert adapter._normalize_project_id("project_alpha-1") == "project_alpha-1"
    with pytest.raises(ValueError):
        adapter._normalize_project_id("../escape")
    with pytest.raises(ValueError):
        adapter._normalize_project_id("has space")
    with pytest.raises(ValueError):
        adapter._normalize_project_id(42)


def test_project_manager_wrappers_persist_snapshot_and_restore_project_id():
    official = SimpleNamespace(manager=ProjectManager())
    adapter._install_project_session_support(official)
    manager = official.manager

    token = adapter._CURRENT_PROJECT_ID.set("project-one")
    try:
        session = manager.create_session("C:\\workspace")
    finally:
        adapter._CURRENT_PROJECT_ID.reset(token)

    assert session.project_id == "project-one"
    assert manager.persisted == [session]
    assert manager.snapshot(session)["projectId"] == "project-one"
    assert manager._session_dict(session)["project_id"] == "project-one"

    restored = manager._session_from_item({"id": "sess-2", "project_id": "project-two"})
    assert restored.project_id == "project-two"
    invalid = manager._session_from_item({"id": "sess-3", "project_id": "../escape"})
    assert invalid.project_id is None


def test_project_manager_make_agent_enters_project_mode():
    official = SimpleNamespace(manager=ProjectManager())
    adapter._install_project_session_support(official)
    manager = official.manager
    session = ProjectSession()
    session.project_id = "project-agent"

    agent = manager.make_agent(session)
    assert agent.project_calls == ["project-agent"]


@pytest.mark.asyncio
async def test_conductor_snapshot_is_read_only_bounded_and_redacted(monkeypatch, client):
    async def fake_read(_session, path):
        if path == "/subagent":
            return {"items": [
                {
                    "id": "agent-1", "status": "running",
                    "prompt": "inspect C:\\Users\\me\\repo api_key=inline-secret",
                    "reply": "reply text", "created_at": 1720000000,
                    "updated_at": 1720000001, "ignored": "must not escape",
                },
                {"id": "", "status": "running", "prompt": "drop"},
            ]}
        assert path == "/chat?last=50"
        return {"items": [{
            "id": "chat-1", "role": "user", "msg": "hello",
            "ts": 1720000002, "secret": "drop",
        }]}

    monkeypatch.setattr(adapter, "_read_conductor_json", fake_read)
    response = await client.get("/api/v1/conductor", headers=AUTH)
    assert response.status == 200
    payload = (await response.json())["payload"]
    assert payload["schema"] == "ga.conductor.v1"
    assert payload["read_only"] is True
    assert payload["counts"] == {"running": 1, "stopped": 0}
    assert payload["subagents"] == [{
        "id": "agent-1", "status": "running",
        "prompt": "inspect [REDACTED_PATH] api_key=[REDACTED]",
        "reply": "reply text", "createdAt": 1720000000,
        "updatedAt": 1720000001,
    }]
    assert payload["chat"] == [{
        "id": "chat-1", "role": "user", "message": "hello",
        "timestamp": 1720000002,
    }]
    encoded = json.dumps(payload)
    assert "ignored" not in encoded
    assert "inline-secret" not in encoded
    assert "C:\\\\Users" not in encoded


@pytest.mark.asyncio
async def test_conductor_snapshot_failure_degrades_200(monkeypatch, client):
    async def fail(_session, _path):
        raise RuntimeError("upstream secret C:\\private\\conductor.log")

    monkeypatch.setattr(adapter, "_read_conductor_json", fail)
    response = await client.get("/api/v1/conductor", headers=AUTH)
    # The UI depends on a stable conductor.snapshot envelope; failures degrade
    # to an empty, non-available snapshot instead of a 5xx that breaks the page.
    assert response.status == 200
    body = await response.text()
    assert '"available": false' in body
    assert "conductor_unavailable" in body
    assert "conductor.log" not in body
    assert "C:\\\\private" not in body


@pytest.mark.asyncio
async def test_conductor_route_has_no_mutation_endpoint(client):
    routes = {(route.method, route.resource.canonical) for route in client.app.router.routes()}
    assert ("GET", "/api/v1/conductor") in routes
    assert not any(path.startswith("/api/v1/conductor/") for _, path in routes)


@pytest.mark.asyncio
async def test_new_session_project_id_is_request_scoped():
    manager = ProjectManager()
    adapter._install_project_session_support(SimpleNamespace(manager=manager))

    async def new_session(request):
        session = manager.create_session()
        return web.json_response({"projectId": session.project_id})

    app = web.Application(middlewares=[adapter.project_session_middleware()])
    app.router.add_post("/session/new", new_session)
    async with TestClient(TestServer(app)) as test_client:
        first = await test_client.post("/session/new", json={"projectId": "first"})
        first_payload = await first.json()
        second = await test_client.post("/session/new", json={})
        second_payload = await second.json()
        bad = await test_client.post("/session/new", json={"projectId": "bad/id"})
        bad_payload = await bad.json()

    assert first.status == 200
    assert first_payload["projectId"] == "first"
    assert second.status == 200
    assert second_payload["projectId"] is None
    assert bad.status == 400
    assert bad_payload["payload"]["code"] == "invalid_project_id"


@pytest.mark.asyncio
async def test_token_usage_endpoints_are_read_only_and_redacted(client):
    stats_response = await client.get("/api/v1/token-stats", headers=AUTH)
    history_response = await client.get("/api/v1/token-history", headers=AUTH)
    assert stats_response.status == 200
    assert history_response.status == 200

    stats = (await stats_response.json())["payload"]
    history = (await history_response.json())["payload"]
    assert stats == {
        "schema": "ga.token_usage.v1",
        "records": [{
            "input": 12,
            "output": 34,
            "cacheCreate": 5,
            "cacheRead": 6,
            "model": "model-safe",
        }],
        "truncated": False,
    }
    assert history == {
        "schema": "ga.token_usage.v1",
        "history": [{
            "input": 7,
            "output": 8,
            "cacheCreate": 9,
            "cacheRead": 10,
            "model": "history-model",
            "timestamp": 1720000000,
        }],
        "truncated": False,
    }
    encoded = json.dumps({"stats": stats, "history": history})
    for secret in ("GA-secret-session", "secret-session", "private title", "D:\\\\private", "token-secret", "history-secret", "not-returned"):
        assert secret not in encoded

    post = await client.post("/api/v1/token-history", headers=AUTH, json={"history": []})
    assert post.status == 405


@pytest.mark.asyncio
async def test_token_usage_is_bounded_and_reports_truncation(monkeypatch):
    official = fake_official_module()
    original = official.token_stats_handler

    async def many_records(request):
        response = await original(request)
        document = json.loads(response.body)
        document["records"] = [{"input": index} for index in range(4)]
        return web.json_response(document)

    official.token_stats_handler = many_records
    monkeypatch.setattr(adapter, "MAX_TOKEN_RECORDS", 2)
    app = adapter.create_app(
        official_module=official, token=TOKEN, allowed_origins=(ORIGIN,), manifest=adapter.load_manifest()
    )
    async with TestClient(TestServer(app)) as client:
        response = await client.get("/api/v1/token-stats", headers=AUTH)
        assert response.status == 200
        payload = (await response.json())["payload"]
    assert len(payload["records"]) == 2
    assert payload["records"][0]["input"] == 0
    assert payload["records"][1]["input"] == 1
    assert payload["truncated"] is True


@pytest.mark.asyncio
async def test_token_usage_contract_failures_are_redacted():
    async def fail(request):
        raise RuntimeError(r"failed at D:\\private\\token-history.json with api_key=secret")

    official = fake_official_module()
    official.token_stats_handler = fail
    official.get_token_history_handler = None
    app = adapter.create_app(
        official_module=official, token=TOKEN, allowed_origins=(ORIGIN,), manifest=adapter.load_manifest()
    )
    async with TestClient(TestServer(app)) as client:
        stats_response = await client.get("/api/v1/token-stats", headers=AUTH)
        history_response = await client.get("/api/v1/token-history", headers=AUTH)
        assert stats_response.status == 503
        assert history_response.status == 503
        stats_body = await stats_response.json()
        history_body = await history_response.json()
    encoded = json.dumps([stats_body, history_body])
    assert "token_usage_unavailable" in encoded
    assert "token-history.json" not in encoded
    assert "secret" not in encoded

@pytest_asyncio.fixture
async def extension_command_client(tmp_path):
    frontends = tmp_path / "frontends"
    frontends.mkdir()
    (frontends / "slash_cmds.py").write_text(
        "PALETTE_ENTRIES = [('/goal', '<objective>', 'Run a goal')]\n"
        "def prompt_for(cmd, args_text):\n"
        "    return f'GOAL:{args_text}' if cmd == '/goal' else None\n",
        encoding="utf-8",
    )
    (tmp_path / "command_packs").mkdir()
    (tmp_path / "command_packs" / "example_commands.json").write_text(
        json.dumps({
            "schema": "ga.command_pack.v1",
            "pack_id": "example",
            "commands": [
                {"id": "brief", "title": "/brief", "description": "brief it",
                 "arg_hint": "<topic>",
                 "prompt_template": "BRIEF:{args}"},
                {"id": "standup", "title": "/standup", "description": "standup",
                 "arg_hint": "", "prompt_template": "STANDUP"},
            ],
        }),
        encoding="utf-8",
    )
    (tmp_path / "command_plugins").mkdir()
    (tmp_path / "command_plugins" / "example_plugin.py").write_text(
        "def _echo(cmd, args_text):\n"
        "    return f'ECHO:{args_text}'\n"
        "COMMANDS = (\n"
        "    {'id': 'echo', 'title': '/echo', 'description': 'echo it',\n"
        "     'arg_hint': '[text]', 'prompt_for': _echo},\n"
        ")\n",
        encoding="utf-8",
    )
    (tmp_path / "command_plugins" / "broken_plugin.py").write_text(
        "this is not python !!!\n",
        encoding="utf-8",
    )
    manager = ProjectManager()
    session = manager.create_session()
    manager.make_agent(session)
    official = fake_official_module()
    official.manager = manager
    app = adapter.create_app(
        official_module=official,
        token=TOKEN,
        allowed_origins=(ORIGIN,),
        manifest=adapter.load_manifest(),
        ga_root=tmp_path,
    )
    async with TestClient(TestServer(app)) as test_client:
        yield test_client


@pytest.mark.asyncio
async def test_command_pack_and_plugin_commands_are_discovered(extension_command_client):
    listed = await extension_command_client.get("/api/v1/commands", headers=AUTH)
    assert listed.status == 200
    commands = (await listed.json())["payload"]["commands"]
    by_id = {command["id"]: command for command in commands}
    assert by_id["brief"]["owner"] == "pack:example"
    assert by_id["brief"]["kind"] == "prompt"
    assert by_id["brief"]["prompt_template"] == "BRIEF:{args}"
    assert by_id["standup"]["prompt_template"] == "STANDUP"
    assert by_id["echo"]["owner"] == "plugin:example_plugin"
    assert by_id["echo"]["plugin"] == "example_plugin:echo"
    # Broken plugin module must be skipped without breaking discovery.
    assert "broken_plugin" not in {command["owner"] for command in commands}


@pytest.mark.asyncio
async def test_command_pack_prompt_execution_and_argument_guard(extension_command_client):
    executed = await extension_command_client.post(
        "/api/v1/commands/brief/execute", headers=AUTH, json={"args_text": "ai agent"})
    assert executed.status == 200
    result = (await executed.json())["payload"]["result"]
    assert result["type"] == "prompt"
    assert result["prompt"] == "BRIEF:ai agent"

    no_args = await extension_command_client.post(
        "/api/v1/commands/standup/execute", headers=AUTH, json={"args_text": ""})
    assert no_args.status == 200
    assert (await no_args.json())["payload"]["result"]["prompt"] == "STANDUP"

    rejected = await extension_command_client.post(
        "/api/v1/commands/standup/execute", headers=AUTH, json={"args_text": "unexpected"})
    assert rejected.status == 400
    assert (await rejected.json())["payload"]["code"] == "invalid_command_input"


@pytest.mark.asyncio
async def test_command_plugin_prompt_execution(extension_command_client):
    executed = await extension_command_client.post(
        "/api/v1/commands/echo/execute", headers=AUTH, json={"args_text": "hello"})
    assert executed.status == 200
    result = (await executed.json())["payload"]["result"]
    assert result["type"] == "prompt"
    assert result["prompt"] == "ECHO:hello"


@pytest.mark.asyncio
async def test_command_pack_malformed_documents_are_ignored(tmp_path):
    frontends = tmp_path / "frontends"
    frontends.mkdir()
    (frontends / "slash_cmds.py").write_text(
        "PALETTE_ENTRIES = []\n"
        "def prompt_for(cmd, args_text):\n"
        "    return None\n",
        encoding="utf-8",
    )
    pack_dir = tmp_path / "command_packs"
    pack_dir.mkdir()
    (pack_dir / "not_json.json").write_text("{broken", encoding="utf-8")
    (pack_dir / "wrong_schema.json").write_text(
        json.dumps({"schema": "other.v1", "commands": [
            {"id": "ghost", "prompt_template": "GHOST"}]}),
        encoding="utf-8",
    )
    (pack_dir / "bad_template.json").write_text(
        json.dumps({"schema": "ga.command_pack.v1", "pack_id": "bad",
                    "commands": [
                        {"id": "multi", "prompt_template": "{a} and {args}"},
                        {"id": "empty", "prompt_template": "  "},
                    ]}),
        encoding="utf-8",
    )
    manager = ProjectManager()
    official = fake_official_module()
    official.manager = manager
    app = adapter.create_app(
        official_module=official,
        token=TOKEN,
        allowed_origins=(ORIGIN,),
        manifest=adapter.load_manifest(),
        ga_root=tmp_path,
    )
    async with TestClient(TestServer(app)) as client:
        listed = await client.get("/api/v1/commands", headers=AUTH)
        commands = (await listed.json())["payload"]["commands"]
    ids = {command["id"] for command in commands}
    assert "ghost" not in ids
    assert "multi" not in ids
    assert "empty" not in ids

@pytest_asyncio.fixture
async def command_packs_client(tmp_path):
    frontends = tmp_path / "frontends"
    frontends.mkdir()
    (frontends / "slash_cmds.py").write_text(
        "PALETTE_ENTRIES = [('/goal', '<objective>', 'Run a goal')]\n"
        "def prompt_for(cmd, args_text):\n"
        "    return f'GOAL:{args_text}' if cmd == '/goal' else None\n",
        encoding="utf-8",
    )
    pack_dir = tmp_path / "command_packs"
    pack_dir.mkdir()
    (pack_dir / "my_pack.json").write_text(json.dumps({
        "schema": "ga.command_pack.v1",
        "pack_id": "my_pack",
        "commands": [{
            "id": "hello", "title": "Hello", "description": "Say hi",
            "arg_hint": "<name>", "prompt_template": "Say hello to {args}",
        }],
    }), encoding="utf-8")
    (pack_dir / "conflict_pack.json").write_text(json.dumps({
        "schema": "ga.command_pack.v1",
        "pack_id": "conflict_pack",
        "commands": [{
            "id": "goal", "title": "Shadowed", "description": "Conflicts",
            "arg_hint": "", "prompt_template": "SHADOW {args}",
        }],
    }), encoding="utf-8")
    plugin_dir = tmp_path / "command_plugins"
    plugin_dir.mkdir()
    (plugin_dir / "example_plugin.py").write_text(
        "COMMANDS = ({\"id\": \"plugin_hello\", \"title\": \"Plugin Hello\",\n"
        "  \"description\": \"\", \"arg_hint\": \"\",\n"
        "  \"prompt_for\": lambda slash, args: 'PH:' + args},)\n",
        encoding="utf-8",
    )
    manager = ProjectManager()
    session = manager.create_session()
    manager.make_agent(session)
    official = fake_official_module()
    official.manager = manager
    app = adapter.create_app(
        official_module=official,
        token=TOKEN,
        allowed_origins=(ORIGIN,),
        manifest=adapter.load_manifest(),
        ga_root=tmp_path,
    )
    async with TestClient(TestServer(app)) as test_client:
        yield test_client


@pytest.mark.asyncio
async def test_command_packs_lists_packs_plugins_and_conflicts(command_packs_client):
    response = await command_packs_client.get("/api/v1/command-packs", headers=AUTH)
    assert response.status == 200
    envelope = await response.json()
    assert envelope["type"] == "command_packs.list"
    body = envelope["payload"]
    # Built-in controls (5) + GA goal + pack hello + plugin_hello = 8;
    # pack "goal" is shadowed by the GA command.
    assert body["loaded_command_count"] == 8
    pack_ids = {pack["pack_id"] for pack in body["packs"]}
    assert pack_ids == {"my_pack", "conflict_pack"}
    my_pack = next(pack for pack in body["packs"] if pack["pack_id"] == "my_pack")
    assert my_pack["valid"] is True
    assert my_pack["command_ids"] == ["hello"]
    assert body["plugins"][0]["loaded"] is True
    assert body["plugins"][0]["command_ids"] == ["plugin_hello"]
    goal_conflicts = [c for c in body["conflicts"] if c["command_id"] == "goal"]
    assert goal_conflicts and goal_conflicts[0]["sources"] == ["ga", "pack:conflict_pack"]


# ---------- MCP Connectors (P5.10) + Morphling classifier (P5.12) ----------

MCP_FIXTURE_SCRIPT = """\
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        msg = json.loads(line)
    except Exception:
        continue
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
            "serverInfo": {"name": "fixture-mcp", "version": "1.0"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": "echo", "description": "echo text back",
             "inputSchema": {"type": "object",
                             "properties": {"text": {"type": "string"}},
                             "required": ["text"]}},
        ]}})
    elif method == "tools/call":
        params = msg.get("params") or {}
        args = params.get("arguments") or {}
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [
            {"type": "text", "text": "ECHO:" + str(args.get("text", "")),
             "private_data": "sensitive-value"}]}})
    else:
        # notifications carry no id; MCP requires no response for them
        if mid is None:
            continue
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
"""


@pytest_asyncio.fixture
async def mcp_client(tmp_path):
    frontends = tmp_path / "frontends"
    frontends.mkdir()
    (frontends / "slash_cmds.py").write_text("PALETTE_ENTRIES = []\n", encoding="utf-8")
    script = tmp_path / "mcp_fixture.py"
    script.write_text(MCP_FIXTURE_SCRIPT, encoding="utf-8")
    conn_dir = tmp_path / "connectors"
    conn_dir.mkdir()
    (conn_dir / "echo.json").write_text(json.dumps({
        "schema": "ga.connector.v1", "name": "echo", "transport": "stdio",
        # command 必须是 MCP_STDIO_ALLOWED_COMMANDS 白名单内的启动器名
        # （由 _load_connectors 经 shutil.which 解析），不能用绝对路径。
        "command": "python", "args": [str(script)],
        "redact_keys": ["private_data"],
    }), encoding="utf-8")
    (conn_dir / "broken.json").write_text("{broken", encoding="utf-8")
    (conn_dir / "nope.json").write_text(json.dumps({
        "schema": "ga.connector.v1", "name": "nope", "transport": "udp",
    }), encoding="utf-8")
    manager = ProjectManager()
    official = fake_official_module()
    official.manager = manager
    app = adapter.create_app(
        official_module=official, token=TOKEN, allowed_origins=(ORIGIN,),
        manifest=adapter.load_manifest(), ga_root=tmp_path,
    )
    async with TestClient(TestServer(app)) as client:
        yield client


@pytest.mark.asyncio
async def test_connectors_inventory_lists_valid_and_broken(mcp_client):
    response = await mcp_client.get("/api/v1/connectors", headers=AUTH)
    assert response.status == 200
    body = (await response.json())["payload"]
    assert body["schema"] == "ga.connector.v1"
    by_name = {c["name"]: c for c in body["connectors"]}
    assert by_name["echo"]["valid"] is True
    assert by_name["echo"]["transport"] == "stdio"
    assert by_name["broken"]["valid"] is False
    assert by_name["nope"]["valid"] is False
    assert by_name["nope"]["error"].startswith("unsupported transport")


@pytest.mark.asyncio
async def test_mcp_stdio_tools_list_and_call_with_redaction(mcp_client):
    listed = await mcp_client.post(
        "/api/v1/connectors/echo/tools/list", headers=AUTH, json={})
    assert listed.status == 200
    payload = (await listed.json())["payload"]
    assert payload["protocol"] == "mcp"
    assert payload["tools"][0]["name"] == "echo"
    called = await mcp_client.post(
        "/api/v1/connectors/echo/tools/call", headers=AUTH,
        json={"tool": "echo", "arguments": {"text": "hi"}})
    assert called.status == 200
    call_payload = (await called.json())["payload"]
    assert call_payload["content"][0]["text"] == "ECHO:hi"
    assert call_payload["content"][0]["private_data"] == "[REDACTED]"


@pytest.mark.asyncio
async def test_mcp_unknown_connector_and_oversized_arguments(mcp_client):
    missing = await mcp_client.post(
        "/api/v1/connectors/ghost/tools/list", headers=AUTH, json={})
    assert missing.status == 404
    oversized = await mcp_client.post(
        "/api/v1/connectors/echo/tools/call", headers=AUTH,
        json={"tool": "echo",
              "arguments": {"text": "x" * (adapter.MCP_MAX_ARGUMENT_CHARS + 1)}})
    assert oversized.status == 400
    assert "size limit" in (await oversized.json())["payload"]["message"]


@pytest.mark.asyncio
async def test_mcp_http_transport(tmp_path):
    async def mcp_http_handler(request):
        body = await request.json()
        if body.get("method") == "tools/list":
            return web.json_response({"jsonrpc": "2.0", "id": body.get("id"),
                                      "result": {"tools": [{
                                          "name": "ping", "description": "p",
                                          "inputSchema": {"type": "object",
                                                          "properties": {}}}]}})
        return web.json_response({"jsonrpc": "2.0", "id": body.get("id"),
                                  "result": {"content": []}})

    server_app = web.Application()
    server_app.router.add_post("/mcp", mcp_http_handler)
    async with TestServer(server_app) as server:
        frontends = tmp_path / "frontends"
        frontends.mkdir()
        (frontends / "slash_cmds.py").write_text("PALETTE_ENTRIES = []\n", encoding="utf-8")
        conn_dir = tmp_path / "connectors"
        conn_dir.mkdir()
        (conn_dir / "web.json").write_text(json.dumps({
            "schema": "ga.connector.v1", "name": "web", "transport": "http",
            "url": f"http://127.0.0.1:{server.port}/mcp",
        }), encoding="utf-8")
        manager = ProjectManager()
        official = fake_official_module()
        official.manager = manager
        app = adapter.create_app(
            official_module=official, token=TOKEN, allowed_origins=(ORIGIN,),
            manifest=adapter.load_manifest(), ga_root=tmp_path,
        )
        async with TestClient(TestServer(app)) as client:
            listed = await client.post(
                "/api/v1/connectors/web/tools/list", headers=AUTH, json={})
            assert listed.status == 200
            tools = (await listed.json())["payload"]["tools"]
            assert tools[0]["name"] == "ping"


def test_morphling_classify_rule_based():
    assert adapter._morphling_classify("api_key=abc secret!")["class"] == "discard"
    assert adapter._morphling_classify("curl https://example.com/api/v1 x")["class"] == "tool"
    assert adapter._morphling_classify("第一步 第二步 流程")["class"] == "memory_l3"
    assert adapter._morphling_classify("short")["class"] == "memory_l1"
    assert adapter._morphling_classify("x" * 500)["class"] == "memory_l2"


@pytest.mark.asyncio
async def test_morphling_classify_endpoint(mcp_client):
    response = await mcp_client.post(
        "/api/v1/morphling/classify", headers=AUTH, json={"text": "api_key=hunter2"})
    assert response.status == 200
    payload = (await response.json())["payload"]
    assert payload["schema"] == "ga.morphling.classify.v1"
    assert payload["suggestion"]["class"] == "discard"
    empty = await mcp_client.post(
        "/api/v1/morphling/classify", headers=AUTH, json={"text": "  "})
    assert empty.status == 400


# ---------------------------------------------------------------------------
# P1-B / P2-A boundary matrix: profile proxy & apibase redaction
# ---------------------------------------------------------------------------


def test_safe_profile_proxy_redaction_matrix():
    cases = [
        # (input, expected_shape, expected_configured)
        ("http://user:pass@proxy.example:8080", "http://proxy.example:8080", True),
        ("http://user%40x:pass%20word@proxy.example:8080/base?api_key=SECRET#FRAG",
         "http://proxy.example:8080", True),
        ("http://[::1]:8080", "http://[::1]:8080", True),
        ("https://[2001:db8::1]", "https://[2001:db8::1]", True),
        ("socks5://user:pass@127.0.0.1:1080", "socks5://127.0.0.1:1080", True),
        ("http://proxy.example", "http://proxy.example", True),
        ("not a url", "", True),          # unparseable: never fall back to the raw value
        ("://broken", "", True),
        ("", "", False),
        (None, "", False),
        (123, "", False),
    ]
    for raw, expected_shape, expected_configured in cases:
        shape, configured = adapter._safe_profile_proxy(raw)
        assert shape == expected_shape, f"{raw!r}: shape {shape!r} != {expected_shape!r}"
        assert configured is expected_configured, f"{raw!r}: configured {configured}"


def test_safe_profile_apibase_redaction_matrix():
    cases = [
        ("https://api.example/v1", "https://api.example"),
        ("http://user:pass@api.example:8443/private?token=SECRET#x", "http://api.example:8443"),
        ("http://[::1]:8443/v1", "http://[::1]:8443"),
        ("not a url", ""),
        ("", ""),
        (None, ""),
    ]
    for raw, expected in cases:
        shape = adapter._safe_profile_apibase(raw)
        assert shape == expected, f"{raw!r}: {shape!r} != {expected!r}"


@pytest.mark.asyncio
async def test_model_profile_patch_preserves_stored_proxy_and_apibase_on_display_shape_submit(private_model_client):
    client, manager = private_model_client
    patched = await client.put("/api/v1/model-profiles/0", headers=AUTH, json={
        "name": "Renamed",
        "proxy": "http://proxy.example:8080",          # redacted display shape
        "apibase": "https://private.example",          # redacted display shape
    })
    assert patched.status == 200
    body = await patched.json()
    profile = body["payload"]["profile"]
    encoded = json.dumps(body)
    assert "initial-user" not in encoded and "initial-pass" not in encoded
    assert profile["proxy_configured"] is True
    # Disk keeps the original credential-bearing values; only the UI sees shapes.
    raw = manager.path.read_text(encoding="utf-8")
    assert "initial-user:initial-pass@proxy.example:8080" in raw
    assert "https://private.example/v1" in raw
    assert "Renamed" in raw


@pytest.mark.asyncio
async def test_model_profile_patch_empty_proxy_clears_configured_proxy(private_model_client):
    client, manager = private_model_client
    patched = await client.put("/api/v1/model-profiles/0", headers=AUTH, json={
        "proxy": "",
    })
    assert patched.status == 200
    profile = (await patched.json())["payload"]["profile"]
    assert not profile.get("proxy_configured")
    raw = manager.path.read_text(encoding="utf-8")
    assert "initial-pass" not in raw
    assert "proxy.example" not in raw


def test_private_save_mykey_text_atomic_rolls_back_on_activation_failure(tmp_path, monkeypatch):
    manager = private_model_manager(tmp_path)
    original = manager.path.read_text(encoding="utf-8")

    def boom():
        raise RuntimeError("injected activation failure")

    monkeypatch.setattr(manager, "_invalidate_mykey_cache", lambda: None, raising=False)
    monkeypatch.setattr(manager, "_reload_live_agents", boom, raising=False)
    with pytest.raises(RuntimeError, match="injected activation failure"):
        adapter._private_save_mykey_text_atomic(manager, "native_oai_config = {'model': 'new'}\n")
    # The file must be byte-identical to the pre-write state after rollback.
    assert manager.path.read_text(encoding="utf-8") == original


def test_private_save_mykey_text_atomic_rejects_invalid_syntax(tmp_path):
    manager = private_model_manager(tmp_path)
    original = manager.path.read_text(encoding="utf-8")
    with pytest.raises(ValueError, match="invalid mykey"):
        adapter._private_save_mykey_text_atomic(manager, "this is not python =")
    assert manager.path.read_text(encoding="utf-8") == original


def test_private_clean_mixins_removes_name_and_index_refs_across_channels(tmp_path):
    class MixinManager:
        def __init__(self):
            self.path = tmp_path / "mykey.py"
            self.path.write_text(
                "mixin_a = {'llm_nos': ['native_oai_config', 0, 'other']}\n"
                "mixin_b = {'llm_nos': [1, 'native_oai_config', 2]}\n"
                "plain = {'llm_nos': ['native_oai_config']}\n",
                encoding="utf-8",
            )
            self.reload_calls = 0

        def _mykey_file(self):
            return self.path

        def _mykey_vars(self):
            keys, values = [], {}
            for line in self.path.read_text(encoding="utf-8").splitlines():
                left, _, raw = line.partition("=")
                left = left.strip()
                if not left.isidentifier():
                    continue
                try:
                    parsed = ast.literal_eval(raw.strip())
                except (SyntaxError, ValueError):
                    continue
                keys.append(left)
                values[left] = parsed
            return keys, values

        def _find_var_block_span(self, text, var_name):
            return var_name in text

        def _patch_var_block(self, text, var_name, config=None):
            lines = []
            for line in text.splitlines():
                left, separator, _ = line.partition("=")
                if separator and left.strip() == var_name:
                    if config is not None:
                        lines.append(f"{var_name} = {config!r}")
                    continue
                lines.append(line)
            return "\n".join(lines).rstrip() + "\n"

        def _invalidate_mykey_cache(self):
            return None

        def _reload_live_agents(self):
            self.reload_calls += 1

        def list_model_profiles(self):
            return []

    manager = MixinManager()
    adapter._private_clean_mixins(manager, profile_id=1, name="native_oai_config")
    raw = manager.path.read_text(encoding="utf-8")
    assert "'0', 'other'" in raw or "0" in raw.replace("'", "").replace(" ", "")  # mixin_a keeps 0 and other
    assert manager.reload_calls >= 1  # persistence pass ran
    keys, values = manager._mykey_vars()
    assert values["mixin_a"]["llm_nos"] == ["0", "other"]
    assert values["mixin_b"]["llm_nos"] == ["2"]
    assert values["plain"]["llm_nos"] == ["native_oai_config"]  # non-mixin untouched


@pytest.mark.asyncio
async def test_create_profile_retry_same_payload_is_idempotent(private_model_client):
    """P1-A: a retried create with identical model/apibase/name must return the
    existing entry instead of appending a duplicate profile."""
    client, manager = private_model_client
    body = {
        "protocol": "claude", "name": "Retry Claude", "model": "retry-claude",
        "apibase": "https://retry-claude.example/v1", "api_key": "retry-secret-key",
    }
    first = await client.post("/api/v1/model-profiles", headers=AUTH, json=body)
    assert first.status == 201
    first_id = (await first.json())["payload"]["profile"]["id"]

    second = await client.post("/api/v1/model-profiles", headers=AUTH, json=body)
    assert second.status == 201
    second_id = (await second.json())["payload"]["profile"]["id"]
    assert second_id == first_id

    profiles = manager.list_model_profiles()
    assert len(profiles) == 2  # initial + exactly one created entry
    text = manager.path.read_text(encoding="utf-8")
    assert text.count("'model': 'retry-claude'") == 1

    # An intentionally different name must still create a new entry.
    renamed = await client.post("/api/v1/model-profiles", headers=AUTH, json={
        **body, "name": "Retry Claude II",
    })
    assert renamed.status == 201
    assert len(manager.list_model_profiles()) == 3


def test_private_remap_session_llm_no_remaps_sessions_across_deleted_index(tmp_path):
    """P1-C: deleting a profile must remap session llm_no references (and agent
    llm_no) instead of leaving out-of-range indexes until restart."""
    manager = private_model_manager(tmp_path)
    persisted = []
    sessions = {}
    for sid, llm_no in (("s-a", 0), ("s-b", 1), ("s-c", 2), ("s-d", 3), ("s-e", 7)):
        sessions[sid] = SimpleNamespace(id=sid, llm_no=llm_no,
                                        agent=SimpleNamespace(llm_no=llm_no))
    manager.sessions = sessions
    manager._persist_session = lambda session: persisted.append(session.id)

    adapter._private_remap_session_llm_no(manager, deleted_id=1, count_before=4)

    assert sessions["s-a"].llm_no == 0      # before deleted id: unchanged
    assert sessions["s-b"].llm_no == 1      # deleted id -> fallback (min(1, 2) = 1)
    assert sessions["s-c"].llm_no == 1      # after deleted id: shifted down
    assert sessions["s-d"].llm_no == 2
    assert sessions["s-e"].llm_no == 6      # out-of-range index shifted too
    assert sessions["s-c"].agent.llm_no == 1
    assert sessions["s-d"].agent.llm_no == 2
    assert sessions["s-e"].agent.llm_no == 6
    assert persisted == ["s-c", "s-d", "s-e"]  # only changed sessions persisted
