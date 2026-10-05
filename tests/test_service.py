from pathlib import Path
import subprocess
import threading
import pytest

from registry import ProjectRecord, Registry
from repository_context import RepositoryContext
from service import ProjectService, ServiceError
from git_adapter import GitAdapter, GitAdapterError
from github_adapter import GitHubAdapterError


class FakeGit:
    def working_tree(self): return {"files": [{"path": "README.md", "status": "M"}]}
    def branches(self): return {"local": [{"name": "main", "current": True}], "remote": [], "remoteAlias": "origin", "repository": "https://github.com/example/repo.git"}
    def commits(self, ref): return [{"hash": "a" * 40, "shortHash": "a" * 7, "subject": "Initial", "author": "Test", "date": "2026-09-14T10:00:00+00:00", "merge": False}]
    def file_diff(self, path: str, *, untracked: bool = False) -> str: return "diff --git a/README.md b/README.md\n+change"


class FakeGithub:
    def pull_requests(self): return [{"number": 1, "title": "PR", "url": "https://github.com/example/repo/pull/1"}]
    def issues(self): return [{"number": 2, "title": "Issue", "url": "https://github.com/example/repo/issues/2"}]


def context(tmp_path: Path) -> RepositoryContext:
    return RepositoryContext("demo", "Demo", tmp_path, "origin", "main", "https://github.com/example/repo.git")


def test_snapshot_contains_local_and_github_capabilities(tmp_path: Path) -> None:
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: FakeGit(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    assert snapshot["project_id"] == "demo"
    assert snapshot["workingTree"]["files"][0]["path"] == "README.md"
    assert snapshot["github"]["pullRequests"][0]["number"] == 1
    assert snapshot["capabilities"]["workingTree"]["status"] == "ready"
    assert snapshot["capabilities"]["branchLogs"]["status"] == "ready"
    assert snapshot["capabilities"]["branchLogs"]["value"]["main"][0]["hash"] == "a" * 40
    assert snapshot["fileDiffs"]["README.md"].startswith("diff --git")
    assert snapshot["branchLogs"]["main"][0]["hash"] == "a" * 40

def test_snapshot_includes_a_diff_for_untracked_working_tree_files(tmp_path: Path) -> None:
    class UntrackedFile(FakeGit):
        def working_tree(self): return {"files": [{"path": "new.txt", "status": "??"}]}
        def file_diff(self, path: str, *, untracked: bool = False) -> str:
            return "diff --git a/new.txt b/new.txt\nnew file mode 100644\n@@ -0,0 +1 @@\n+new\n" if untracked else ""

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    service = ProjectService(Registry((tmp_path,), (record,)), lambda _ctx: UntrackedFile(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))

    assert snapshot["workingTree"] == {"files": [{"path": "new.txt", "status": "??"}]}
    assert snapshot["fileDiffs"] == {
        "new.txt": "diff --git a/new.txt b/new.txt\nnew file mode 100644\n@@ -0,0 +1 @@\n+new\n"
    }


def test_real_repository_snapshot_contains_untracked_file_diff(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args: str) -> str:
        result = subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)
        return result.stdout

    git("init", "-b", "main")
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.invalid")
    (repo / "tracked.txt").write_text("tracked\n", encoding="utf-8")
    git("add", "tracked.txt")
    git("commit", "-m", "initial")
    git("remote", "add", "origin", "https://github.com/example/repo.git")
    (repo / "new.txt").write_text("untracked snapshot content\n", encoding="utf-8")

    repo_context = RepositoryContext("demo", "Demo", repo, "origin", "main", "https://github.com/example/repo.git")
    record = ProjectRecord("demo", "Demo", repo, True, "origin", "main")
    service = ProjectService(Registry((tmp_path,), (record,)), lambda ctx: GitAdapter(ctx), lambda _ctx: FakeGithub())

    snapshot: dict = service.snapshot(repo_context)

    assert {"path": "new.txt", "status": "??"} in snapshot["workingTree"]["files"]
    assert "+untracked snapshot content" in snapshot["fileDiffs"]["new.txt"]



def test_snapshot_does_not_expose_filesystem_remote_paths(tmp_path: Path) -> None:
    class LocalRemote(FakeGit):
        def branches(self):
            return {"local": [{"name": "main", "current": True, "repository": str(tmp_path / "remote.git")}], "remote": [], "remoteAlias": "origin", "repository": str(tmp_path / "remote.git")}

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    service = ProjectService(Registry((tmp_path,), (record,)), lambda _ctx: LocalRemote(), lambda _ctx: FakeGithub())
    local_context = RepositoryContext("demo", "Demo", tmp_path, "origin", "main", str(tmp_path / "remote.git"))
    snapshot = service.snapshot(local_context)
    assert snapshot["project"]["repository"] is None
    assert snapshot["branches"]["repository"] is None
    assert snapshot["branches"]["local"][0]["repository"] is None


def test_branch_log_limit_truncates_deterministically_without_output_limit(tmp_path: Path) -> None:
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))

    class ManyBranches(FakeGit):
        def branches(self):
            return {"local": [{"name": f"branch-{index:03d}"} for index in range(501)], "remote": [], "remoteAlias": "origin", "repository": "https://github.com/example/repo.git"}

    service = ProjectService(registry, lambda _ctx: ManyBranches(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))

    assert len(snapshot["branchLogs"]) == 500
    assert len(snapshot["branches"]["local"]) == 500
    assert len(snapshot["capabilities"]["branches"]["value"]["local"]) == 500
    assert snapshot["capabilities"]["branchLogs"]["status"] == "ready"
    assert "BRANCH_LOGS_TRUNCATED" in snapshot["warnings"]
    assert "OUTPUT_LIMIT" not in snapshot["warnings"]


def test_branches_output_limit_fallback_keeps_contract_shape(tmp_path: Path) -> None:
    class HugeBranches(FakeGit):
        def branches(self):
            return {"local": [{"name": f"branch-{index:03d}", "padding": "x" * 6000} for index in range(500)], "remote": [], "remoteAlias": "origin", "repository": "https://github.com/example/repo.git"}

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: HugeBranches(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    assert snapshot["branches"] == {"local": [], "remote": [], "remoteAlias": "origin", "repository": "https://github.com/example/repo.git"}
    assert snapshot["capabilities"]["branches"]["status"] == "error"



def test_empty_branch_capability_reports_empty(tmp_path: Path) -> None:
    class EmptyBranches(FakeGit):
        def branches(self):
            return {"local": [], "remote": [], "remoteAlias": "origin", "repository": "https://github.com/example/repo.git"}

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: EmptyBranches(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    assert snapshot["capabilities"]["branches"]["status"] == "empty"




def test_file_diff_collection_stops_at_aggregate_budget(tmp_path: Path) -> None:
    class ManyDiffs(FakeGit):
        def __init__(self): self.calls = 0
        def working_tree(self): return {"files": [{"path": f"file-{index}.txt", "status": "M"} for index in range(30)]}
        def file_diff(self, path: str, *, untracked: bool = False) -> str:
            self.calls += 1
            return "x" * (1024 * 1024)

    git = ManyDiffs()
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    service = ProjectService(Registry((tmp_path,), (record,)), lambda _ctx: git, lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    assert git.calls <= 11
    assert "OUTPUT_LIMIT" in snapshot["warnings"]


def test_branch_log_collection_stops_at_aggregate_budget(tmp_path: Path) -> None:
    class ManyLogs(FakeGit):
        def __init__(self): self.calls = 0
        def branches(self): return {"local": [{"name": "main", "current": True}] + [{"name": f"branch-{index}"} for index in range(30)], "remote": [], "remoteAlias": "origin", "repository": "https://github.com/example/repo.git"}
        def commits(self, ref):
            self.calls += 1
            return [{"hash": "a" * 40, "shortHash": "a" * 7, "subject": "x" * (1024 * 1024 - 256), "author": "Test", "date": "2026-09-14T10:00:00+00:00", "merge": False, "parents": []}]

    git = ManyLogs()
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    service = ProjectService(Registry((tmp_path,), (record,)), lambda _ctx: git, lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    assert git.calls <= 12
    assert "BRANCH_LOGS_TRUNCATED" in snapshot["warnings"]


def test_single_file_diff_byte_limit_emits_output_warning(tmp_path: Path) -> None:
    class HugeDiff(FakeGit):
        def file_diff(self, path: str, *, untracked: bool = False) -> str:
            return "x" * (1024 * 1024 + 1)

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: HugeDiff(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    assert snapshot["fileDiffs"] == {}
    assert "OUTPUT_LIMIT" in snapshot["warnings"]



def test_service_accepts_exactly_500_branch_refs(tmp_path: Path) -> None:
    class ExactlyBranches(FakeGit):
        def branches(self):
            return {"local": [{"name": f"branch-{index:03d}"} for index in range(500)], "remote": [], "remoteAlias": "origin", "repository": "https://github.com/example/repo.git"}

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: ExactlyBranches(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    assert len(snapshot["branches"]["local"]) == 500
    assert "BRANCH_LOGS_TRUNCATED" not in snapshot["warnings"]


def test_branch_logs_truncate_each_ref_history_to_100_commits(tmp_path: Path) -> None:
    class ManyCommits(FakeGit):
        def commits(self, ref):
            return [{"hash": f"{index + 1:040x}", "shortHash": f"{index + 1:07x}", "subject": f"Commit {index}", "author": "Test", "date": "2026-09-14T10:00:00+00:00", "merge": False, "parents": []} for index in range(101)]

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: ManyCommits(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    assert len(snapshot["branchLogs"]["main"]) == 100


def test_branch_log_read_failure_isolated_as_error(tmp_path: Path) -> None:
    class BrokenBranchLog(FakeGit):
        def branches(self):
            return {"local": [{"name": "main", "current": True}, {"name": "feature/ui"}], "remote": [], "remoteAlias": "origin", "repository": "https://github.com/example/repo.git"}

        def commits(self, ref):
            if ref == "feature/ui":
                raise GitAdapterError("GIT_TIMEOUT")
            return super().commits(ref)

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: BrokenBranchLog(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    assert snapshot["capabilities"]["branchLogs"]["status"] == "error"
    assert snapshot["capabilities"]["branchLogs"]["errorCode"] == "GIT_TIMEOUT"
    assert "GIT_TIMEOUT" in snapshot["warnings"]



def test_commit_detail_accepts_commit_from_non_current_branch_log(tmp_path: Path) -> None:
    feature_hash = "b" * 40

    class BranchGit(FakeGit):
        def branches(self):
            return {"local": [{"name": "main", "current": True}, {"name": "feature/ui", "current": False}], "remote": [], "remoteAlias": "origin", "repository": "https://github.com/example/repo.git"}

        def commits(self, ref):
            if ref == "feature/ui":
                return [{"hash": feature_hash, "shortHash": "b" * 7, "subject": "Feature", "author": "Test", "date": "2026-09-14T10:00:00+00:00", "merge": False, "parents": []}]
            return super().commits(ref)

        def commit_detail(self, commit):
            return {"hash": commit, "subject": "Feature", "author": "Test", "date": "2026-09-14T10:00:00+00:00", "files": [], "diff": ""}

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: BranchGit(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(context(tmp_path))
    detail = service.commit_detail(context(tmp_path), feature_hash, generation=snapshot["localGeneration"], process_instance_id=snapshot["processInstanceId"], registry_epoch=snapshot["registryEpoch"], context_identity=snapshot["contextIdentity"], snapshot_id=snapshot["snapshotId"])
    assert detail["hash"] == feature_hash


def test_failed_local_refresh_preserves_branch_logs_and_stale_since(tmp_path: Path) -> None:
    available = {"value": True}

    def git_factory(_ctx):
        if not available["value"]:
            raise GitAdapterError("GIT_TIMEOUT")
        return FakeGit()

    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, git_factory, lambda _ctx: FakeGithub())
    first = service.snapshot(context(tmp_path))
    available["value"] = False
    second = service.snapshot(context(tmp_path))
    third = service.snapshot(context(tmp_path))
    assert second["branchLogs"] == first["branchLogs"]
    assert second["capabilities"]["branchLogs"]["status"] == "stale"
    assert second["capabilities"]["branchLogs"].get("staleSince") == third["capabilities"]["branchLogs"].get("staleSince")

def test_github_failure_isolated_from_local_snapshot(tmp_path: Path) -> None:
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: FakeGit(), lambda _ctx: (_ for _ in ()).throw(RuntimeError("offline")))
    snapshot = service.snapshot(context(tmp_path))
    assert snapshot["workingTree"]["files"]
    assert snapshot["github"]["status"] == "unavailable"


def test_unknown_context_is_rejected(tmp_path: Path) -> None:
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: FakeGit(), lambda _ctx: FakeGithub())
    bad = RepositoryContext("other", "Other", tmp_path, "origin", "main", "https://github.com/example/repo.git")
    try:
        service.snapshot(bad)
    except ServiceError as exc:
        assert str(exc) == "UNKNOWN_PROJECT"
    else:
        raise AssertionError("expected ServiceError")


def test_snapshot_has_process_registry_generation_and_fingerprints(tmp_path: Path) -> None:
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,), epoch=7)
    service = ProjectService(registry, lambda _ctx: FakeGit(), lambda _ctx: FakeGithub())
    snapshot = service.snapshot(RepositoryContext("demo", "Demo", tmp_path, "origin", "main", "https://github.com/example/repo.git", 7))
    assert snapshot["processInstanceId"] == service.process_instance_id
    assert snapshot["registryEpoch"] == 7
    assert isinstance(snapshot["localGeneration"], int)
    assert set(snapshot["fingerprints"]) >= {"workingTree", "branches", "commits", "local"}
    assert snapshot["fingerprints"]["local"]


def test_failed_github_refresh_preserves_last_known_good(tmp_path: Path) -> None:
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    available = {"value": True}

    def github(_ctx):
        if not available["value"]:
            raise GitHubAdapterError("GITHUB_TIMEOUT")
        return FakeGithub()

    service = ProjectService(registry, lambda _ctx: FakeGit(), github)
    first = service.snapshot(context(tmp_path))
    available["value"] = False
    second = service.snapshot(context(tmp_path))
    third = service.snapshot(context(tmp_path))
    assert second["workingTree"] == first["workingTree"]
    assert second["github"]["status"] == "stale"
    assert second["github"]["pullRequests"] == first["github"]["pullRequests"]
    assert second["capabilities"]["github"]["stale"] is True
    assert second["capabilities"]["github"]["staleSince"] == third["capabilities"]["github"]["staleSince"]


def test_context_binding_rejects_changed_identity(tmp_path: Path) -> None:
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    service = ProjectService(registry, lambda _ctx: FakeGit(), lambda _ctx: FakeGithub())
    bad = RepositoryContext("demo", "Changed", tmp_path, "origin", "main", "https://github.com/example/repo.git")
    with pytest.raises(ServiceError, match="CONTEXT_MISMATCH"):
        service.snapshot(bad)


def test_concurrent_refresh_returns_last_known_good_as_refreshing(tmp_path: Path) -> None:
    record = ProjectRecord("demo", "Demo", tmp_path, True, "origin", "main")
    registry = Registry((tmp_path,), (record,))
    entered = threading.Event()
    release = threading.Event()

    class BlockingGit(FakeGit):
        def working_tree(self):
            entered.set()
            release.wait(timeout=2)
            return super().working_tree()

    service = ProjectService(registry, lambda _ctx: BlockingGit(), lambda _ctx: FakeGithub())
    # Seed a last-known-good snapshot with a non-blocking read.
    service.git_factory = lambda _ctx: FakeGit()
    previous = service.snapshot(context(tmp_path))
    service.git_factory = lambda _ctx: BlockingGit()
    result = {}
    worker = threading.Thread(target=lambda: result.setdefault("value", service.snapshot(context(tmp_path))))
    worker.start()
    assert entered.wait(timeout=2)
    concurrent = service.snapshot(context(tmp_path))
    assert concurrent["refreshing"] is True
    assert concurrent["snapshotId"] == previous["snapshotId"]
    release.set()
    worker.join(timeout=2)
    assert not worker.is_alive()
