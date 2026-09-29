import subprocess
from pathlib import Path

import pytest

from git_adapter import GitAdapter, GitAdapterError
from git_runner import GitRunner, GitRunnerError
from repository_context import RepositoryContext


def make_repo(tmp_path: Path) -> tuple[RepositoryContext, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    run = lambda *args: subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)
    run("init", "-q", "-b", "main")
    run("config", "user.email", "test@example.com")
    run("config", "user.name", "Test User")
    (repo / "README.md").write_text("hello\n")
    run("add", "README.md")
    run("commit", "-q", "-m", "initial commit")
    run("branch", "feature/ui")
    run("remote", "add", "origin", "https://github.com/example/repo.git")
    run("update-ref", "refs/remotes/origin/main", "HEAD")
    (repo / "README.md").write_text("hello\nchanged\n")
    (repo / "new.txt").write_text("new\n")
    context = RepositoryContext("demo", "Demo", repo, "origin", "main", "https://github.com/example/repo.git")
    return context, str(repo)


def test_reads_working_tree_as_bounded_entries(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    snapshot = GitAdapter(context).working_tree()
    assert {item["path"] for item in snapshot["files"]} == {"README.md", "new.txt"}
    assert snapshot["files"][0]["status"] in {"M", "??"}


def test_reads_local_and_remote_branches(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    result = adapter.branches()
    assert any(item["name"] == "main" and item["current"] for item in result["local"])
    assert any(item["name"] == "origin/main" for item in result["remote"])
    feature = next(item for item in result["local"]  # type: ignore[index]
                    if item["name"] == "feature/ui")  # type: ignore[index]
    assert feature["relation"] == "no-upstream"
    assert feature["repository"] is None
    markers = adapter.local_fingerprints()
    assert {"HEAD", "status", "refs/remotes", "refs/heads", "currentBranch"} <= markers.keys()
    assert markers["currentBranch"] == "main"


@pytest.mark.parametrize("head", ["not-a-hash", "a" * 39, "a" * 41, "g" * 40])
def test_rejects_malformed_head_fingerprint(tmp_path: Path, head: str) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    adapter._run = lambda operation, _args: head if operation == "fingerprint-head" else ""  # type: ignore[method-assign]
    with pytest.raises(GitAdapterError, match="GIT_MALFORMED_OUTPUT"):
        adapter.local_fingerprints()


@pytest.mark.parametrize("operation, malformed", [
    ("fingerprint-remotes", "origin/main\tdeadbeef\n"),
    ("fingerprint-branches", "main\tdeadbeef\t*\t\t\n"),
])
def test_rejects_malformed_remote_and_head_fingerprint_object_ids(
    tmp_path: Path, operation: str, malformed: str
) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)

    def fake_run(current_operation, _args):
        if current_operation == "fingerprint-head":
            return "a" * 40 + "\n"
        if current_operation == operation:
            return malformed
        if current_operation == "fingerprint-current-branch":
            return "main\n"
        return ""

    adapter._run = fake_run  # type: ignore[method-assign]
    with pytest.raises(GitAdapterError, match="GIT_MALFORMED_OUTPUT"):
        adapter.local_fingerprints()


@pytest.mark.parametrize("ref", ["release.lock/candidate", "release/.candidate", "release/candidate.lock"])
def test_git_log_allowlist_rejects_invalid_intermediate_ref(ref: str) -> None:
    assert not GitRunner._args_allowed("log", [
        "log", "--max-count=501", "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%P",
        "--date=iso-strict", ref,
    ])




def test_branch_listing_keeps_501st_ref_for_service_truncation(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    local = "".join(f"branch-{index:03d}\t \t\t\n" for index in range(501))
    adapter._run = lambda operation, _args: local if operation == "branches" else ""  # type: ignore[method-assign]
    result = adapter.branches()
    assert len(result["local"]) == 501



def test_branch_listing_accepts_exactly_500_refs(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    local = "".join(f"branch-{index:03d}\t \t\t\n" for index in range(500))
    adapter._run = lambda operation, _args: local if operation == "branches" else ""  # type: ignore[method-assign]
    assert len(adapter.branches()["local"]) == 500


def test_commit_history_keeps_500_entries_instead_of_failing_at_501(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    rows = []
    for index in range(501):
        commit_hash = f"{index + 1:040x}"
        rows.append("\0".join([commit_hash, commit_hash[:7], f"commit {index}", "Test", "2026-09-14T10:00:00+00:00", "", ""]))
    raw = "\n".join(rows) + "\n"
    adapter._run = lambda operation, _args: raw if operation == "log" else ""  # type: ignore[method-assign]
    assert len(adapter.commits("main")) == 500


def test_reads_commit_timeline_and_detail(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    commits = adapter.commits("main")
    assert commits[0]["subject"] == "initial commit"
    detail = adapter.commit_detail(commits[0]["hash"])
    assert detail["hash"] == commits[0]["hash"]
    assert "README.md" in {item["path"] for item in detail["files"]}
    assert "diff --git" in detail["diff"]


def test_commit_history_accepts_utc_z_timestamp(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    commit_hash = "a" * 40
    raw = "\0".join([
        commit_hash, commit_hash[:7], "UTC commit", "dependabot[bot]",
        "2026-09-28T12:34:56Z", "", "",
    ]) + "\n"
    adapter._run = lambda operation, _args: raw if operation == "log" else ""  # type: ignore[method-assign]

    commits = adapter.commits("main")

    assert commits[0]["date"] == "2026-09-28T12:34:56Z"
    assert commits[0]["author"] == "dependabot[bot]"


def test_commit_detail_accepts_utc_z_timestamp(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    commit_hash = "a" * 40
    raw = chr(0).join([
        commit_hash, "UTC commit", "dependabot[bot]", "2026-09-28T12:34:56Z",
    ]) + "\n\n1\t0\tREADME.md\n"
    adapter._run = lambda operation, _args: raw if operation == "show" else "diff --git a/README.md b/README.md\n"  # type: ignore[method-assign]

    detail = adapter.commit_detail(commit_hash)

    assert detail["hash"] == commit_hash
    assert detail["author"] == "dependabot[bot]"


def test_reads_file_diff_without_mutating_repository(tmp_path: Path) -> None:
    context, repo = make_repo(tmp_path)
    before = subprocess.check_output(["git", "-C", repo, "status", "--porcelain"], text=True)
    diff = GitAdapter(context).file_diff("README.md")
    after = subprocess.check_output(["git", "-C", repo, "status", "--porcelain"], text=True)
    assert "+changed" in diff
    assert before == after


def test_runner_rejects_mutating_operation(tmp_path: Path) -> None:
    with pytest.raises(GitRunnerError, match="reset"):
        GitRunner(tmp_path).run("reset", ["reset", "--hard"])


@pytest.mark.parametrize("ref", ["main..HEAD", "main//bad", "main..bad", "main.lock", "feature.lock/child", "feature/child.lock"])
def test_rejects_revision_expressions(tmp_path: Path, ref: str) -> None:
    context, _ = make_repo(tmp_path)
    with pytest.raises(GitAdapterError, match="INVALID_REF"):
        GitAdapter(context).commits(ref)


def test_rejects_pathspec_magic(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    with pytest.raises(GitAdapterError, match="INVALID_PATH"):
        GitAdapter(context).file_diff(":(top,glob)**")


def test_reads_rename_as_one_working_tree_entry(tmp_path: Path) -> None:
    context, repo = make_repo(tmp_path)
    subprocess.run(["git", "-C", repo, "mv", "README.md", "RENAMED.md"], check=True)
    entries = GitAdapter(context).working_tree()["files"]
    assert {item["path"] for item in entries} == {"RENAMED.md", "new.txt"}
    assert sum(item["path"] == "RENAMED.md" for item in entries) == 1


def test_accepts_unmerged_conflict_status(tmp_path: Path) -> None:
    context, repo = make_repo(tmp_path)
    subprocess.run(["git", "-C", repo, "checkout", "-q", "feature/ui"], check=True)
    (context.path / "README.md").write_text("feature conflict\n")
    subprocess.run(["git", "-C", repo, "add", "README.md", "new.txt"], check=True)
    subprocess.run(["git", "-C", repo, "commit", "-q", "-m", "feature changes"], check=True)
    subprocess.run(["git", "-C", repo, "checkout", "-q", "main"], check=True)
    (context.path / "README.md").write_text("main conflict\n")
    subprocess.run(["git", "-C", repo, "add", "README.md"], check=True)
    subprocess.run(["git", "-C", repo, "commit", "-q", "-m", "main changes"], check=True)
    subprocess.run(["git", "-C", repo, "merge", "feature/ui", "--no-commit"], check=False)
    entries = GitAdapter(context).working_tree()["files"]
    assert any(item["status"] == "U" for item in entries)


def test_reads_unicode_and_space_paths(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    (context.path / "spaced é.txt").write_text("unicode\n")
    entries = GitAdapter(context).working_tree()["files"]
    assert any(item["path"] == "spaced é.txt" for item in entries)


def test_rejects_malformed_branch_output(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    adapter._run = lambda _operation, _args: "broken\n"  # type: ignore[method-assign]
    with pytest.raises(GitAdapterError, match="GIT_MALFORMED_OUTPUT"):
        adapter.branches()


def test_rejects_malformed_commit_detail_output(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    adapter._run = lambda _operation, _args: "broken\n"  # type: ignore[method-assign]
    with pytest.raises(GitAdapterError, match="GIT_MALFORMED_OUTPUT"):
        adapter.commit_detail("0123456789abcdef0123456789abcdef01234567")


def test_accepts_staged_and_unstaged_modification_status(tmp_path: Path) -> None:
    context, repo = make_repo(tmp_path)
    (Path(repo) / "README.md").write_text("staged\n")
    subprocess.run(["git", "-C", repo, "add", "README.md"], check=True)
    (Path(repo) / "README.md").write_text("staged and unstaged\n")
    entries = GitAdapter(context).working_tree()["files"]
    assert entries[0]["status"] == "M"


def test_working_tree_rejects_path_deeper_than_32_components(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    deep_path = "/".join([f"d{i}" for i in range(33)]) + "/file.txt"
    adapter._run = lambda _operation, _args: f"?? {deep_path}\0"  # type: ignore[method-assign]
    with pytest.raises(GitAdapterError, match="OUTPUT_LIMIT"):
        adapter.working_tree()


def test_working_tree_accepts_path_at_depth_32(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    path = "/".join([f"d{i}" for i in range(31)]) + "/file.txt"
    adapter._run = lambda _operation, _args: f"?? {path}\0"  # type: ignore[method-assign]
    assert adapter.working_tree()["files"][0]["path"] == path


def test_reads_commit_detail_with_binary_file_from_real_repository(tmp_path: Path) -> None:
    """Regression (issue #12): `--numstat` emits `-\\t-\\t<path>` for binary files."""
    context, repo = make_repo(tmp_path)
    binary = context.path / "bin.dat"
    binary.write_bytes(bytes(range(256)) * 4)
    subprocess.run(["git", "-C", repo, "add", "bin.dat"], check=True)
    (context.path / "README.md").write_text("hello\nchanged\ntext\n")
    subprocess.run(["git", "-C", repo, "add", "README.md"], check=True)
    run = lambda *args: subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True)
    run("commit", "-q", "-m", "add binary")
    binary.write_bytes(bytes(range(256)) * 8)
    run("commit", "-q", "-am", "change binary")
    (context.path / "README.md").write_text("hello\nchanged\ntext\nmore\n")
    run("commit", "-q", "-am", "change text")

    adapter = GitAdapter(context)
    commits = [str(item["hash"]) for item in adapter.commits("main")]
    assert [item["subject"] for item in adapter.commits("main")] == [
        "change text", "change binary", "add binary", "initial commit"]

    text_only = adapter.commit_detail(commits[0])["files"]
    assert text_only == [{"path": "README.md", "additions": 1, "deletions": 0, "binary": False}]

    binary_only = adapter.commit_detail(commits[1])["files"]
    assert binary_only == [{"path": "bin.dat", "additions": 0, "deletions": 0, "binary": True}]

    combined = {item["path"]: item for item in adapter.commit_detail(commits[2])["files"]}
    assert set(combined) == {"README.md", "bin.dat"}
    assert combined["bin.dat"] == {"path": "bin.dat", "additions": 0, "deletions": 0, "binary": True}
    assert combined["README.md"] == {"path": "README.md", "additions": 2, "deletions": 0, "binary": False}

    assert adapter.commit_detail(commits[3])["files"] == [
        {"path": "README.md", "additions": 1, "deletions": 0, "binary": False}]


def test_rejects_numstat_counts_that_are_not_numeric_or_dash(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    adapter._run = lambda operation, _args: (
        "0" * 40 + "\x00subject\x00author\x002026-09-14T10:00:00+00:00\n\nx\t1\tfile.txt\n"
        if operation == "show" else "diff\n")  # type: ignore[method-assign]
    with pytest.raises(GitAdapterError, match="GIT_MALFORMED_OUTPUT"):
        adapter.commit_detail("0" * 40)


def test_rejects_empty_path_on_binary_numstat_line(tmp_path: Path) -> None:
    context, _ = make_repo(tmp_path)
    adapter = GitAdapter(context)
    adapter._run = lambda operation, _args: (
        "0" * 40 + "\x00subject\x00author\x002026-09-14T10:00:00+00:00\n\n-\t-\t\n"
        if operation == "show" else "diff\n")  # type: ignore[method-assign]
    with pytest.raises(GitAdapterError, match="GIT_MALFORMED_OUTPUT"):
        adapter.commit_detail("0" * 40)
