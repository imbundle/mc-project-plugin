import json
import subprocess
from pathlib import Path

import pytest

from registry import RegistryError, load_registry
from repository_context import RepositoryContextError, resolve_context


def write_config(tmp_path: Path, projects: list[dict], roots: list[str] | None = None) -> Path:
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"version": 1, "approvedRoots": roots or [str(tmp_path)], "projects": projects}))
    return path


def git_repo(path: Path) -> None:
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "remote", "add", "origin", "https://github.com/example/demo.git"], check=True)


def project(path: Path, **extra: object) -> dict:
    value = {"project_id": "demo", "name": "Demo", "path": str(path), "enabled": True,
             "remote": "origin", "default_branch": "main"}
    value.update(extra)
    return value


def test_loads_enabled_project_and_resolves_context(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    config = write_config(tmp_path, [project(repo)])

    registry = load_registry(config)
    context = resolve_context(registry, "demo")

    assert context.project_id == "demo"
    assert context.path == repo.resolve()
    assert context.remote == "origin"
    assert context.default_branch == "main"


def test_missing_project_id_is_rejected(tmp_path: Path) -> None:
    registry = load_registry(write_config(tmp_path, [project(tmp_path / "repo")]))
    with pytest.raises(RepositoryContextError, match="UNKNOWN_PROJECT"):
        resolve_context(registry, "missing")


def test_non_git_directory_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "not-git"
    path.mkdir()
    registry = load_registry(write_config(tmp_path, [project(path)]))
    with pytest.raises(RepositoryContextError, match="NOT_GIT"):
        resolve_context(registry, "demo")


def test_duplicate_project_ids_are_rejected(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    with pytest.raises(RegistryError, match="DUPLICATE_PROJECT_ID"):
        load_registry(write_config(tmp_path, [project(repo), project(repo)]))


def test_symlink_outside_approved_root_is_rejected(tmp_path: Path) -> None:
    outside = tmp_path.parent / "mc-project-plugin-outside-fixture"
    outside.mkdir(exist_ok=True)
    git_repo(outside / "repo")
    link = tmp_path / "linked-repo"
    link.symlink_to(outside / "repo", target_is_directory=True)
    registry = load_registry(write_config(tmp_path, [project(link)]))
    with pytest.raises(RepositoryContextError, match="PATH_OUTSIDE_APPROVED_ROOT"):
        resolve_context(registry, "demo")


def test_remote_alias_must_be_declared(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    registry = load_registry(write_config(tmp_path, [project(repo, remote="upstream")]))
    with pytest.raises(RepositoryContextError, match="REMOTE_NOT_FOUND"):
        resolve_context(registry, "demo")


def test_enabled_must_be_boolean(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    with pytest.raises(RegistryError, match="INVALID_ENABLED"):
        load_registry(write_config(tmp_path, [project(repo, enabled="yes")]))


def test_missing_approved_root_is_controlled_error(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    config = write_config(tmp_path, [project(repo)], roots=[str(tmp_path / "missing-root")])
    with pytest.raises(RegistryError, match="INVALID_APPROVED_ROOT"):
        load_registry(config)


def test_invalid_repository_is_not_misclassified_by_error_text(tmp_path: Path) -> None:
    path = tmp_path / "remote-repo"
    path.mkdir()
    registry = load_registry(write_config(tmp_path, [project(path)]))
    with pytest.raises(RepositoryContextError, match="NOT_GIT"):
        resolve_context(registry, "demo")


def test_symlink_loop_is_controlled_error(tmp_path: Path) -> None:
    loop = tmp_path / "loop"
    loop.symlink_to(loop)
    registry = load_registry(write_config(tmp_path, [project(loop)]))
    with pytest.raises(RepositoryContextError, match="INVALID_PATH"):
        resolve_context(registry, "demo")


def test_option_like_remote_alias_is_rejected(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    with pytest.raises(RegistryError, match="INVALID_REMOTE_ALIAS"):
        load_registry(write_config(tmp_path, [project(repo, remote="--upload-pack")]))


def test_empty_config_is_empty_registry(tmp_path: Path) -> None:
    config = tmp_path / "empty.json"
    config.write_text("")
    assert load_registry(config).projects == ()


def test_more_than_fifty_projects_is_rejected(tmp_path: Path) -> None:
    projects = [project(tmp_path / f"repo-{index}", project_id=f"project-{index}") for index in range(51)]
    with pytest.raises(RegistryError, match="PROJECT_LIMIT"):
        load_registry(write_config(tmp_path, projects))



def test_github_ssh_remote_with_fixed_git_user_is_accepted(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    subprocess.run(["git", "-C", str(repo), "remote", "set-url", "origin", "ssh://git@github.com/example/repo.git"], check=True)
    registry = load_registry(write_config(tmp_path, [project(repo)]))
    assert resolve_context(registry, "demo").remote_url == "ssh://git@github.com/example/repo.git"


def test_remote_url_with_credentials_is_rejected(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    subprocess.run(["git", "-C", str(repo), "remote", "set-url", "origin", "https://user:secret@example.com/repo.git"], check=True)
    registry = load_registry(write_config(tmp_path, [project(repo)]))
    with pytest.raises(RepositoryContextError, match="INVALID_REMOTE_URL"):
        resolve_context(registry, "demo")


@pytest.mark.parametrize("remote", [
    "https://example.com:bad/repo.git",
    "https://example.com:99999/repo.git",
    "https://[broken/repo.git",
    "git@:repo.git",
    "/tmp/local-repository.git",
])
def test_malformed_remote_url_is_rejected(tmp_path: Path, remote: str) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    subprocess.run(["git", "-C", str(repo), "remote", "set-url", "origin", remote], check=True)
    registry = load_registry(write_config(tmp_path, [project(repo)]))
    with pytest.raises(RepositoryContextError, match="INVALID_REMOTE_URL"):
        resolve_context(registry, "demo")


def test_unknown_user_project_path_is_controlled_error(tmp_path: Path) -> None:
    item = project(tmp_path / "repo")
    item["path"] = "~definitely-no-such-user-x/repo"
    with pytest.raises(RegistryError, match="INVALID_PATH"):
        load_registry(write_config(tmp_path, [item]))


def test_registry_epoch_advances_only_when_content_identity_changes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    config = write_config(tmp_path, [project(repo)])
    first = load_registry(config)
    same = load_registry(config)
    assert same.epoch == first.epoch
    config.write_text(json.dumps({"version": 1, "approvedRoots": [str(tmp_path)],
                                  "projects": [project(repo, name="Changed")]}))
    changed = load_registry(config)
    assert changed.epoch == first.epoch + 1


@pytest.mark.parametrize("default_branch", ["release.lock/candidate", "release/.candidate", "release/candidate.lock"])
def test_complete_default_branch_ref_grammar_is_rejected(tmp_path: Path, default_branch: str) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    with pytest.raises(RegistryError, match="INVALID_DEFAULT_BRANCH"):
        load_registry(write_config(tmp_path, [project(repo, default_branch=default_branch)]))


def test_plans_mapping_defaults_to_project_category_and_project_id(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)

    record = load_registry(write_config(tmp_path, [project(repo)])).get("demo")

    assert record is not None
    assert record.plans_category == "project"
    assert record.plans_slug == "demo"


def test_plans_mapping_accepts_explicit_thirdparty_category_and_slug(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)

    record = load_registry(write_config(
        tmp_path, [project(repo, plans_category="thirdparty", plans_slug="external-plugin")]
    )).get("demo")

    assert record is not None
    assert record.plans_category == "thirdparty"
    assert record.plans_slug == "external-plugin"


@pytest.mark.parametrize("category", [None, "", "PROJECT", "client", 1])
def test_invalid_plans_category_is_rejected(tmp_path: Path, category: object) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)

    with pytest.raises(RegistryError, match="INVALID_PLANS_CATEGORY"):
        load_registry(write_config(tmp_path, [project(repo, plans_category=category)]))


@pytest.mark.parametrize("slug", [None, "", "Upper", "../outside", "folder/name", "x" * 65])
def test_invalid_plans_slug_is_rejected(tmp_path: Path, slug: object) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)

    with pytest.raises(RegistryError, match="INVALID_PLANS_SLUG"):
        load_registry(write_config(tmp_path, [project(repo, plans_slug=slug)]))


def test_duplicate_plans_mapping_is_rejected_even_when_one_project_is_disabled(tmp_path: Path) -> None:
    projects = [
        project(tmp_path / "repo-one", project_id="one", plans_slug="shared-plans"),
        project(tmp_path / "repo-two", project_id="two", enabled=False, plans_slug="shared-plans"),
    ]

    with pytest.raises(RegistryError, match="DUPLICATE_PLANS_MAPPING"):
        load_registry(write_config(tmp_path, projects))


def test_registry_epoch_advances_when_plans_mapping_changes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_repo(repo)
    config = write_config(tmp_path, [project(repo)])
    first = load_registry(config)
    same = load_registry(config)
    assert same.epoch == first.epoch

    config.write_text(json.dumps({
        "version": 1,
        "approvedRoots": [str(tmp_path)],
        "projects": [project(repo, plans_category="thirdparty", plans_slug="shared")],
    }))
    changed = load_registry(config)

    assert changed.epoch == first.epoch + 1
