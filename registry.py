"""Validated local project registry for the Mission Control project plugin."""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
import threading
from typing import Any
from ref_validation import is_valid_ref_name

PROJECT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
REMOTE_ALIAS_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")
BRANCH_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")


class RegistryError(ValueError):
    pass


@dataclass(frozen=True)
class ProjectRecord:
    project_id: str
    name: str
    path: Path
    enabled: bool
    remote: str
    default_branch: str
    plans_category: str = "project"
    plans_slug: str | None = None


@dataclass(frozen=True)
class Registry:
    approved_roots: tuple[Path, ...]
    projects: tuple[ProjectRecord, ...]
    epoch: int = 1

    def get(self, project_id: str) -> ProjectRecord | None:
        return next((item for item in self.projects if item.project_id == project_id), None)


_EPOCH_LOCK = threading.Lock()
_EPOCH_STATE: dict[str, tuple[tuple[object, ...], int]] = {}


def _identity(registry: Registry) -> tuple[object, ...]:
    """Return a stable, content-based identity for one validated registry."""
    return (
        tuple(str(root) for root in registry.approved_roots),
        tuple((item.project_id, item.name, str(item.path.expanduser().resolve(strict=False)), item.enabled,
               item.remote, item.default_branch, item.plans_category, item.plans_slug)
              for item in registry.projects),
    )


def _with_process_epoch(config_path: Path, registry: Registry) -> Registry:
    key = str(config_path.expanduser().resolve(strict=False))
    identity = _identity(registry)
    with _EPOCH_LOCK:
        previous = _EPOCH_STATE.get(key)
        epoch = 1 if previous is None else previous[1] + (previous[0] != identity)
        _EPOCH_STATE[key] = (identity, epoch)
    return Registry(registry.approved_roots, registry.projects, epoch)


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise RegistryError(f"INVALID_{field.upper()}")
    return value


def load_registry(config_path: Path) -> Registry:
    try:
        text = config_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return _with_process_epoch(config_path, Registry((), ()))
    except OSError as exc:
        raise RegistryError("INVALID_CONFIG") from exc
    if not text.strip():
        return _with_process_epoch(config_path, Registry((), ()))
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RegistryError("INVALID_CONFIG") from exc
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise RegistryError("INVALID_CONFIG_VERSION")
    roots_raw = raw.get("approvedRoots")
    projects_raw = raw.get("projects")
    if not isinstance(roots_raw, list) or not isinstance(projects_raw, list):
        if raw == {}:
            return _with_process_epoch(config_path, Registry((), ()))
        raise RegistryError("INVALID_CONFIG")
    if len(projects_raw) > 50:
        raise RegistryError("PROJECT_LIMIT")
    roots: list[Path] = []
    for value in roots_raw:
        try:
            root = Path(_required_string(value, "approved_root")).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise RegistryError("INVALID_APPROVED_ROOT") from exc
        if not root.is_dir():
            raise RegistryError("INVALID_APPROVED_ROOT")
        roots.append(root)
    projects: list[ProjectRecord] = []
    seen: set[str] = set()
    seen_plans_mappings: set[tuple[str, str]] = set()
    for item in projects_raw:
        if not isinstance(item, dict):
            raise RegistryError("INVALID_PROJECT")
        project_id = _required_string(item.get("project_id"), "project_id")
        if not PROJECT_ID_RE.fullmatch(project_id):
            raise RegistryError("INVALID_PROJECT_ID")
        if project_id in seen:
            raise RegistryError("DUPLICATE_PROJECT_ID")
        seen.add(project_id)
        try:
            path = Path(_required_string(item.get("path"), "path")).expanduser()
        except (OSError, RuntimeError) as exc:
            raise RegistryError("INVALID_PATH") from exc
        if not path.is_absolute():
            raise RegistryError("INVALID_PATH")
        enabled = item.get("enabled")
        if not isinstance(enabled, bool):
            raise RegistryError("INVALID_ENABLED")
        remote = _required_string(item.get("remote"), "remote")
        default_branch = _required_string(item.get("default_branch"), "default_branch")
        if not REMOTE_ALIAS_RE.fullmatch(remote):
            raise RegistryError("INVALID_REMOTE_ALIAS")
        if not is_valid_ref_name(default_branch):
            raise RegistryError("INVALID_DEFAULT_BRANCH")
        plans_category = item.get("plans_category", "project")
        if not isinstance(plans_category, str) or plans_category not in {"project", "thirdparty"}:
            raise RegistryError("INVALID_PLANS_CATEGORY")
        plans_slug = item.get("plans_slug", project_id)
        if not isinstance(plans_slug, str) or not PROJECT_ID_RE.fullmatch(plans_slug):
            raise RegistryError("INVALID_PLANS_SLUG")
        plans_mapping = (plans_category, plans_slug)
        if plans_mapping in seen_plans_mappings:
            raise RegistryError("DUPLICATE_PLANS_MAPPING")
        seen_plans_mappings.add(plans_mapping)
        projects.append(ProjectRecord(
            project_id=project_id,
            name=_required_string(item.get("name"), "name"),
            path=path,
            enabled=enabled,
            remote=remote,
            default_branch=default_branch,
            plans_category=plans_category,
            plans_slug=plans_slug,
        ))
    return _with_process_epoch(config_path, Registry(tuple(roots), tuple(projects)))
