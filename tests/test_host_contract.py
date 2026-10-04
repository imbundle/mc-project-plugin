from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_SOURCE = ROOT / "tests" / "fixtures" / "host-plugin"


def _host_root() -> Path:
    value = os.environ.get("MC_PROJECT_HOST_ROOT")
    if not value:
        pytest.skip("set MC_PROJECT_HOST_ROOT to run tests against a real Mission Control checkout")
    host_root = Path(value).expanduser()
    if not host_root.is_dir():
        pytest.fail(f"MC_PROJECT_HOST_ROOT is not a directory: {host_root}")
    return host_root

EXPECTED_ENDPOINTS = [
    {"method": "GET", "path": "/mc-project-plugin/projects/catalog", "handler": "listProjects", "authRequired": True},
    {"method": "GET", "path": "/mc-project-plugin/projects/snapshot", "handler": "getSnapshot", "authRequired": True},
    {"method": "GET", "path": "/mc-project-plugin/projects/commit", "handler": "getCommitDetail", "authRequired": True},
    {"method": "GET", "path": "/mc-project-plugin/projects/pull-request", "handler": "getPullRequestDetail", "authRequired": True},
    {"method": "POST", "path": "/mc-project-plugin/projects/branch/switch", "handler": "switchBranch", "authRequired": True},
    {"method": "POST", "path": "/mc-project-plugin/projects/branch/create", "handler": "createBranch", "authRequired": True},
    {"method": "GET", "path": "/mc-project-plugin/projects/tree", "handler": "listTree", "authRequired": True},
    {"method": "GET", "path": "/mc-project-plugin/projects/file", "handler": "readFile", "authRequired": True},
    {"method": "GET", "path": "/mc-project-plugin/projects/file/raw", "handler": "readFileRaw", "authRequired": True},
    {"method": "GET", "path": "/mc-project-plugin/projects/plans/tree", "handler": "listPlansTree", "authRequired": True},
    {"method": "GET", "path": "/mc-project-plugin/projects/plans/file", "handler": "readPlanFile", "authRequired": True},
]


def _make_fixture(tmp_path: Path) -> Path:
    fixture_target = tmp_path / "host-fixture"
    if fixture_target.exists() or fixture_target.is_symlink():
        shutil.rmtree(fixture_target)
    shutil.copytree(FIXTURE_SOURCE, fixture_target, symlinks=True)
    return fixture_target


def _run_loader(fixture: Path, host_root: Path) -> dict[str, object]:
    script = """
import json
import sys
from pathlib import Path
from plugins.loader import PluginLoader

fixture = Path(sys.argv[1])
external = fixture / "installed"
external.mkdir()
link = external / "mc-project-plugin"
link.symlink_to(fixture, target_is_directory=True)
loader = PluginLoader(internal_dir=fixture / "empty-internal", external_dir=external)
assert loader.load_plugin("mc-project-plugin")
manifest = loader.get_manifest("mc-project-plugin")
module = loader.get_module("mc-project-plugin")
paths = [
    (ep["method"], ep["path"])
    for ep in manifest["endpoints"]
]
responses = []
for method, path in paths:
    handler = loader.resolve(method, path)
    response = handler.handler_fn({}, {}, None)
    responses.append({"handled": handler is not None, "status": 200, "ok": response["ok"]})
print(json.dumps({
    "plugin_dir": str(loader.get_plugin_dir("mc-project-plugin")),
    "resolved_dir": str(loader.get_plugin_dir("mc-project-plugin").resolve()),
    "manifest": manifest,
    "handlers": sorted(name for name in ("listProjects", "getSnapshot", "getCommitDetail", "getPullRequestDetail", "switchBranch", "createBranch", "listTree", "readFile", "readFileRaw", "listPlansTree", "readPlanFile") if hasattr(module, name)),
    "responses": responses,
}))
"""
    env = os.environ.copy()
    env["PYTHONPATH"] = str(host_root / "server")
    result = subprocess.run(
        [sys.executable, "-c", script, str(fixture)],
        cwd=host_root,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_manifest_declares_exact_host_contract() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["id"] == "mc-project-plugin"
    assert manifest["name"] == "Projects"
    assert manifest["routePath"] == "/mc-project-plugin"
    assert manifest["endpoints"] == EXPECTED_ENDPOINTS


def test_real_host_loader_loads_isolated_fixture_and_dispatches_all_handlers(tmp_path: Path) -> None:
    host_root = _host_root()
    fixture = _make_fixture(tmp_path)
    try:
        result = _run_loader(fixture, host_root)
        assert result["manifest"]["id"] == "mc-project-plugin"
        assert result["manifest"]["routePath"] == "/mc-project-plugin"
        assert result["handlers"] == sorted(ep["handler"] for ep in EXPECTED_ENDPOINTS)
        assert result["resolved_dir"] == str(fixture)
        assert all(item == {"handled": True, "status": 200, "ok": True} for item in result["responses"])
    finally:
        if fixture.exists() or fixture.is_symlink():
            shutil.rmtree(fixture)


def test_plugin_endpoint_exports_are_exactly_manifest_handlers() -> None:
    spec = importlib.util.spec_from_file_location("plugin_endpoints", ROOT / "endpoints.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    exported = {
        name for name, value in vars(module).items()
        if callable(value) and getattr(value, "__module__", None) == module.__name__ and not name.startswith("_")
    }
    assert exported == {ep["handler"] for ep in EXPECTED_ENDPOINTS}
