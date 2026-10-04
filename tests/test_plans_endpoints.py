from pathlib import Path

import pytest

import endpoints
from errors import ServiceError
from registry import ProjectRecord, Registry


def _plans_registry(tmp_path: Path, *, enabled: bool = True) -> Registry:
    record = ProjectRecord(
        "demo", "Demo", tmp_path / "unused-repository", enabled, "origin", "main",
        plans_category="project", plans_slug="demo",
    )
    return Registry((), (record,), epoch=1)


def _configure_endpoint(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, enabled: bool = True):
    home = tmp_path / "home"
    root = home / "Developer" / "plans" / "project" / "demo"
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setattr(endpoints, "_runtime", lambda: (_plans_registry(tmp_path, enabled=enabled), object()))
    monkeypatch.setattr(
        endpoints, "resolve_context",
        lambda *_args: pytest.fail("Plans endpoints must not resolve a Git repository"),
    )
    return root


def _call_tree(path: str | None = None):
    params = {"project_id": ["demo"]}
    if path is not None:
        params["path"] = [path]
    return endpoints.listPlansTree({}, params, None)


def test_plans_tree_lists_only_visible_markdown_and_filters_each_lazy_level(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)
    (root / "docs").mkdir(parents=True)
    (root / "README.md").write_text("# Plans\n", encoding="utf-8")
    (root / "notes.txt").write_text("not Markdown", encoding="utf-8")
    (root / ".hidden.md").write_text("hidden", encoding="utf-8")
    (root / ".private").mkdir()
    (root / ".private" / "secret.md").write_text("hidden directory", encoding="utf-8")
    (root / "docs" / "guide.markdown").write_text("# Guide\n", encoding="utf-8")
    (root / "docs" / ".draft.md").write_text("hidden nested file", encoding="utf-8")

    top = _call_tree()
    nested = _call_tree("docs")

    assert top["ok"] is True
    assert top["data"]["path"] == "."
    assert [(entry["name"], entry["type"]) for entry in top["data"]["entries"]] == [
        ("docs", "dir"), ("README.md", "file"),
    ]
    assert nested["ok"] is True
    assert [(entry["name"], entry["type"]) for entry in nested["data"]["entries"]] == [
        ("guide.markdown", "file"),
    ]


@pytest.mark.parametrize("path", [".hidden.md", ".private", "docs/.draft.md"])
def test_plans_tree_rejects_direct_hidden_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, path: str,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)
    (root / "docs").mkdir(parents=True)

    with pytest.raises(ServiceError) as exc:
        _call_tree(path)

    assert (exc.value.code, exc.value.status_code) == ("NOT_ALLOWED", 403)


@pytest.mark.parametrize("path", ["../outside", "/etc/passwd", "docs\\guide.md"])
def test_plans_tree_rejects_invalid_paths_as_bad_requests(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, path: str,
) -> None:
    _configure_endpoint(tmp_path, monkeypatch)

    with pytest.raises(ServiceError) as exc:
        _call_tree(path)

    assert (exc.value.code, exc.value.status_code) == ("INVALID_REQUEST", 400)


def test_plans_tree_distinguishes_missing_root_from_empty_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)

    with pytest.raises(ServiceError) as exc:
        _call_tree()
    assert (exc.value.code, exc.value.status_code) == ("NOT_FOUND", 404)

    root.mkdir(parents=True)
    result = _call_tree()
    assert result["ok"] is True
    assert result["data"]["entries"] == []


def test_plans_tree_hides_disabled_projects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_endpoint(tmp_path, monkeypatch, enabled=False)

    with pytest.raises(ServiceError) as exc:
        _call_tree()

    assert (exc.value.code, exc.value.status_code) == ("UNKNOWN_PROJECT", 404)


def test_plans_tree_rejects_mapped_root_symlink_to_another_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)
    other_project = root.parent / "other-project"
    other_project.mkdir(parents=True)
    (other_project / "private.md").write_text("belongs to another project", encoding="utf-8")
    root.symlink_to(other_project, target_is_directory=True)

    with pytest.raises(ServiceError) as exc:
        _call_tree()

    assert (exc.value.code, exc.value.status_code) == ("NOT_ALLOWED", 403)


def test_plans_tree_requires_host_authentication() -> None:
    with pytest.raises(ServiceError) as exc:
        endpoints.listPlansTree({}, {"project_id": ["demo"]})

    assert (exc.value.code, exc.value.status_code) == ("UNAUTHENTICATED", 401)


def _call_file(path: str, project_id: str = "demo"):
    return endpoints.readPlanFile({}, {"project_id": [project_id], "path": [path]}, None)


def test_read_plan_file_returns_bounded_markdown_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)
    content = "# Plan\n\n| item | value |\n|---|---|\n| a | b |\n"
    root.mkdir(parents=True)
    (root / "README.md").write_text(content, encoding="utf-8")

    result = _call_file("README.md")

    assert result["ok"] is True
    assert result["data"] == {
        "path": "README.md", "size": len(content.encode()), "content": content,
        "truncated": False, "binary": False,
    }


def test_read_plan_file_rejects_direct_non_markdown_request_before_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_endpoint(tmp_path, monkeypatch)
    monkeypatch.setattr(
        endpoints.file_explorer, "read_file",
        lambda *_args: pytest.fail("Non-Markdown requests must be rejected before reading"),
    )

    with pytest.raises(ServiceError) as exc:
        _call_file("README.txt")

    assert (exc.value.code, exc.value.status_code) == ("NOT_ALLOWED", 403)


@pytest.mark.parametrize("path", [".hidden.md", ".private/secret.md"])
def test_read_plan_file_rejects_hidden_segments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, path: str,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)
    (root / ".private").mkdir(parents=True)
    (root / ".hidden.md").write_text("hidden", encoding="utf-8")
    (root / ".private" / "secret.md").write_text("hidden", encoding="utf-8")

    with pytest.raises(ServiceError) as exc:
        _call_file(path)

    assert (exc.value.code, exc.value.status_code) == ("NOT_ALLOWED", 403)


@pytest.mark.parametrize("path", ["../outside.md", "/etc/passwd", "docs\\guide.md"])
def test_read_plan_file_rejects_invalid_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, path: str,
) -> None:
    _configure_endpoint(tmp_path, monkeypatch)

    with pytest.raises(ServiceError) as exc:
        _call_file(path)

    assert (exc.value.code, exc.value.status_code) == ("INVALID_REQUEST", 400)


def test_read_plan_file_maps_missing_project_and_file_to_not_found(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)
    root.mkdir(parents=True)

    with pytest.raises(ServiceError) as exc:
        _call_file("missing.md")
    assert (exc.value.code, exc.value.status_code) == ("NOT_FOUND", 404)

    with pytest.raises(ServiceError) as exc:
        _call_file("missing.md", project_id="unknown")
    assert (exc.value.code, exc.value.status_code) == ("UNKNOWN_PROJECT", 404)


def test_read_plan_file_hides_disabled_projects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_endpoint(tmp_path, monkeypatch, enabled=False)

    with pytest.raises(ServiceError) as exc:
        _call_file("README.md")

    assert (exc.value.code, exc.value.status_code) == ("UNKNOWN_PROJECT", 404)


def test_read_plan_file_maps_binary_and_oversize_flags_without_partial_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)
    root.mkdir(parents=True)
    (root / "binary.md").write_bytes(b"binary" + bytes([0]) + b"content")
    (root / "large.md").write_bytes(b"x" * (262_144 + 1))

    with pytest.raises(ServiceError) as exc:
        _call_file("binary.md")
    assert (exc.value.code, exc.value.status_code) == ("NOT_ALLOWED", 403)

    with pytest.raises(ServiceError) as exc:
        _call_file("large.md")
    assert (exc.value.code, exc.value.status_code) == ("PAYLOAD_TOO_LARGE", 413)


def test_read_plan_file_preserves_utf8_replacement_behavior(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)
    root.mkdir(parents=True)
    (root / "invalid-utf8.md").write_bytes(bytes([0xFF]))

    result = _call_file("invalid-utf8.md")

    assert result["data"]["content"] == chr(0xFFFD)


def test_read_plan_file_rejects_symlink_escape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _configure_endpoint(tmp_path, monkeypatch)
    root.mkdir(parents=True)
    outside = tmp_path / "outside.md"
    outside.write_text("outside", encoding="utf-8")
    (root / "escape.md").symlink_to(outside)

    with pytest.raises(ServiceError) as exc:
        _call_file("escape.md")

    assert (exc.value.code, exc.value.status_code) == ("NOT_ALLOWED", 403)
