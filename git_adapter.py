"""Read-only local Git adapter used by the project service."""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import PurePosixPath
from git_runner import GitRunner, GitRunnerError
from ref_validation import is_valid_ref_name
from repository_context import RepositoryContext


class GitAdapterError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


_SAFE_PATH = re.compile(r"^[^\x00]+$")
_SAFE_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
_OBJECT_ID = re.compile(r"^[0-9a-fA-F]{40}$")
_STATUS = {"M", "A", "D", "R", "C", "U", "T", "??"}
MAX_PATH_DEPTH = 32


def _ref(value: object) -> str:
    if not is_valid_ref_name(value):
        raise GitAdapterError("INVALID_REF")
    assert isinstance(value, str)
    return value


def _path(value: str) -> str:
    if not isinstance(value, str) or not value or value.startswith("/") or not _SAFE_PATH.fullmatch(value) or any(ord(char) < 32 for char in value) or any(char in value for char in "*?[]:"):
        raise GitAdapterError("INVALID_PATH")
    parts = PurePosixPath(value).parts
    if ".." in parts:
        raise GitAdapterError("INVALID_PATH")
    if len(parts) > MAX_PATH_DEPTH:
        raise GitAdapterError("OUTPUT_LIMIT")
    return value


def _parsed_ref(value: str) -> str:
    return _ref(value)


def _object_id(value: object) -> str:
    if not isinstance(value, str) or not _OBJECT_ID.fullmatch(value):
        raise GitAdapterError("GIT_MALFORMED_OUTPUT")
    return value


def _validate_fingerprint_status(raw: object) -> str:
    if not isinstance(raw, str):
        raise GitAdapterError("GIT_MALFORMED_OUTPUT")
    records = raw.split("\0")
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if len(record) < 4 or record[2] != " ":
            raise GitAdapterError("GIT_MALFORMED_OUTPUT")
        status = record[:2]
        if status == "??":
            pass
        elif any(char not in " MADRCUT?!" for char in status) or status == "  ":
            raise GitAdapterError("GIT_MALFORMED_OUTPUT")
        try:
            _path(record[3:])
            if status[0] in {"R", "C"}:
                if index >= len(records) or not records[index]:
                    raise GitAdapterError("GIT_MALFORMED_OUTPUT")
                _path(records[index])
                index += 1
        except GitAdapterError as exc:
            raise GitAdapterError("GIT_MALFORMED_OUTPUT") from exc
    return raw


def _validate_fingerprint_refs(raw: object, field_count: int) -> str:
    """Validate each for-each-ref row while preserving the raw fingerprint."""
    if not isinstance(raw, str):
        raise GitAdapterError("GIT_MALFORMED_OUTPUT")
    for row in raw.splitlines():
        fields = row.split("\t")
        if len(fields) != field_count:
            raise GitAdapterError("GIT_MALFORMED_OUTPUT")
        try:
            _parsed_ref(fields[0])
        except GitAdapterError as exc:
            raise GitAdapterError("GIT_MALFORMED_OUTPUT") from exc
        _object_id(fields[1])
        if field_count == 5:
            if fields[2] not in {"*", " "}:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            if fields[3]:
                try:
                    _parsed_ref(fields[3])
                except GitAdapterError as exc:
                    raise GitAdapterError("GIT_MALFORMED_OUTPUT") from exc
            if not re.fullmatch(r"|\[(?:ahead \d+(?:, behind \d+)?|behind \d+(?:, ahead \d+)?|gone)\]", fields[4]):
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
    return raw


class GitAdapter:
    def __init__(self, context: RepositoryContext) -> None:
        self.context = context
        self.runner = GitRunner(context.path)

    def _run(self, operation: str, args: list[str]) -> str:
        try:
            return self.runner.run(operation, args)
        except GitRunnerError as exc:
            raise GitAdapterError(exc.code) from exc

    def local_fingerprints(self) -> dict[str, str]:
        raw_head = self._run("fingerprint-head", ["rev-parse", "HEAD"])
        head = raw_head.strip() if isinstance(raw_head, str) else raw_head
        remotes = _validate_fingerprint_refs(self._run("fingerprint-remotes", ["for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/remotes"]), 2)
        heads = _validate_fingerprint_refs(self._run("fingerprint-branches", ["for-each-ref", "--format=%(refname:short)\t%(objectname)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)", "refs/heads"]), 5)
        status = _validate_fingerprint_status(self._run("fingerprint-status", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
        current = self._run("fingerprint-current-branch", ["symbolic-ref", "--short", "HEAD"]).strip()
        try:
            current = _ref(current)
        except GitAdapterError as exc:
            raise GitAdapterError("GIT_MALFORMED_OUTPUT") from exc
        return {
            "HEAD": _object_id(head),
            "status": status,
            "refs/remotes": remotes,
            "refs/heads": heads,
            "currentBranch": current,
        }

    def working_tree(self) -> dict[str, list[dict[str, str]]]:
        raw = self._run("status", ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        entries: list[dict[str, str]] = []
        records = raw.split("\0")
        index = 0
        while index < len(records):
            record = records[index]
            if not record:
                index += 1
                continue
            if len(record) < 4:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            status, path = record[:2], record[3:]
            if not path:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            if status == "??":
                normalized = "??"
            elif status[0] in {"M", "A", "D", "R", "C", "U", "T"}:
                normalized = status[0]
            elif status[1] in {"M", "A", "D", "R", "C", "U", "T"}:
                normalized = status[1]
            else:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            if path.startswith("/") or ".." in PurePosixPath(path).parts:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            _path(path)
            entries.append({"path": path, "status": normalized})
            if status[0] in {"R", "C"}:
                index += 1
                if index >= len(records) or not records[index]:
                    raise GitAdapterError("GIT_MALFORMED_OUTPUT")
                _path(records[index])
            index += 1
        if len(entries) > 2000:
            raise GitAdapterError("GIT_OUTPUT_LIMIT")
        entries.sort(key=lambda item: item["path"])
        return {"files": entries[:2000]}

    def branches(self) -> dict[str, object]:
        fmt = "%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)"
        local_raw = self._run("branches", ["for-each-ref", f"--format={fmt}", "refs/heads"])
        local: list[dict[str, object]] = []
        for row in local_raw.split("\n"):
            if not row:
                continue
            fields = row.split("\t")
            if len(fields) != 4 or not fields[0]:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            track = fields[3]
            if fields[1] not in {"*", " "} or not re.fullmatch(r"|\[(?:ahead \d+(?:, behind \d+)?|behind \d+(?:, ahead \d+)?|gone)\]", track):
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            try:
                _parsed_ref(fields[0])
                if fields[2]:
                    _parsed_ref(fields[2])
            except GitAdapterError as exc:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT") from exc
            ahead_match = re.search(r"ahead (\d+)", track)
            behind_match = re.search(r"behind (\d+)", track)
            relation = "no-upstream" if not fields[2] else "diverged" if ahead_match and behind_match else "ahead" if ahead_match else "behind" if behind_match else "up-to-date"
            tracking_alias = fields[2].split("/", 1)[0] if fields[2] else None
            local.append({"name": fields[0], "current": fields[1] == "*", "tracking": fields[2] or None,
                          "ahead": int(ahead_match.group(1)) if ahead_match else 0,
                          "behind": int(behind_match.group(1)) if behind_match else 0, "relation": relation,
                          "remoteAlias": tracking_alias, "repository": self.context.remote_url if tracking_alias == self.context.remote else None})
        remote_raw = self._run("remote-branches", ["for-each-ref", "--format=%(refname:short)", "refs/remotes"])
        remote: list[dict[str, object]] = []
        aliases = {name.split("/", 1)[0] for name in remote_raw.splitlines() if name.strip() and not name.strip().endswith("/HEAD")}
        remote_urls = {alias: self._run("remote", ["remote", "get-url", alias]).strip() for alias in aliases}
        for row in remote_raw.splitlines():
            name = row.strip()
            if not name:
                continue
            if name.endswith("/HEAD"):
                continue
            if not _SAFE_REF.fullmatch(name):
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            try:
                _parsed_ref(name)
            except GitAdapterError as exc:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT") from exc
            alias = name.split("/", 1)[0]
            remote.append({"name": name, "remoteAlias": alias, "repository": self.context.remote_url if alias == self.context.remote else None})
        return {"local": local, "remote": remote, "remoteAlias": self.context.remote, "repository": self.context.remote_url}

    def commits(self, ref: str) -> list[dict[str, object]]:
        ref = _ref(ref)
        fmt = "%H%x00%h%x00%s%x00%an%x00%aI%x00%P%x00%D"
        raw = self._run("log", ["log", "--max-count=501", "--decorate=short", f"--format={fmt}", "--date=iso-strict", ref])
        commits = []
        for row in raw.splitlines():
            fields = row.split("\0")
            if len(fields) == 6:
                fields.append("")
            if len(fields) != 7:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            if not re.fullmatch(r"[0-9a-fA-F]{40}", fields[0]) or not re.fullmatch(r"[0-9a-fA-F]{7,40}", fields[1]) or not fields[0].lower().startswith(fields[1].lower()) or not fields[2] or not fields[3] or not fields[4]:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)", fields[4]):
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            try:
                # git's `--date=iso-strict` renders UTC commit timestamps with a
                # trailing "Z" (strict ISO 8601) instead of "+00:00" — this
                # happens for any author whose local git config resolves to UTC
                # (e.g. dependabot[bot]). `datetime.fromisoformat` pre-3.11 does
                # not accept the "Z" suffix, so normalize it before parsing.
                datetime.fromisoformat(fields[4].replace("Z", "+00:00"))
            except ValueError as exc:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT") from exc
            parents = fields[5].split()
            if len(parents) > 32 or (fields[5] and any(not re.fullmatch(r"[0-9a-fA-F]{40}", parent) for parent in parents)):
                raise GitAdapterError("GIT_OUTPUT_LIMIT" if len(parents) > 32 else "GIT_MALFORMED_OUTPUT")
            commits.append({"hash": fields[0], "shortHash": fields[1], "subject": fields[2], "author": fields[3],
                            "date": fields[4], "merge": len(parents) > 1,
                            "parents": parents, "refs": [item.strip() for item in fields[6].split(",") if item.strip()]})
        return commits[:500]

    def commit_detail(self, commit: str) -> dict[str, object]:
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-fA-F]{7,64}", commit):
            raise GitAdapterError("INVALID_COMMIT")
        raw = self._run("show", ["show", "--no-renames", "--format=%H%x00%s%x00%an%x00%aI", "--numstat", "--no-ext-diff", commit])
        lines = raw.splitlines()
        header = lines[0].split("\0") if lines else []
        if len(header) != 4 or not re.fullmatch(r"[0-9a-fA-F]{40}", header[0]) or not re.fullmatch(r"[0-9a-fA-F]{7,40}", commit) or not header[0].lower().startswith(commit.lower()) or not header[1] or not header[2] or not header[3]:
            raise GitAdapterError("GIT_MALFORMED_OUTPUT")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)", header[3]):
            raise GitAdapterError("GIT_MALFORMED_OUTPUT")
        try:
            # See commits(): git renders UTC author dates with a trailing "Z"
            # for --date=iso-strict (e.g. bot authors like dependabot[bot]).
            datetime.fromisoformat(header[3].replace("Z", "+00:00"))
        except ValueError as exc:
            raise GitAdapterError("GIT_MALFORMED_OUTPUT") from exc
        files = []
        for line in lines[1:]:
            fields = line.split("\t")
            if len(fields) == 3 and fields[2]:
                additions, deletions = fields[0], fields[1]
                if additions == "-" and deletions == "-":
                    # `--numstat` emits `-\t-\t<path>` for binary files: no line counts exist.
                    # Represent them as 0/0 and flag `binary` so a truly empty textual diff stays distinguishable.
                    _path(fields[2])
                    files.append({"path": fields[2], "additions": 0, "deletions": 0, "binary": True})
                elif additions.isdigit() and deletions.isdigit():
                    _path(fields[2])
                    files.append({"path": fields[2], "additions": int(additions),
                                  "deletions": int(deletions), "binary": False})
                else:
                    raise GitAdapterError("GIT_MALFORMED_OUTPUT")
            elif line:
                raise GitAdapterError("GIT_MALFORMED_OUTPUT")
        if len(files) > 500:
            raise GitAdapterError("GIT_OUTPUT_LIMIT")
        diff = self._run("show-diff", ["show", "--no-ext-diff", "--format=", commit])
        if len(diff.encode("utf-8")) > 1024 * 1024:
            raise GitAdapterError("OUTPUT_LIMIT")
        return {"hash": header[0] if header else commit, "subject": header[1] if len(header) > 1 else "",
                "author": header[2] if len(header) > 2 else "", "date": header[3] if len(header) > 3 else "",
                "files": files[:500], "diff": diff}

    def file_diff(self, file_path: str) -> str:
        safe = _path(file_path)
        diff = self._run("diff", ["diff", "--no-ext-diff", "--no-renames", "HEAD", "--", safe])
        if len(diff.encode("utf-8")) > 1024 * 1024:
            raise GitAdapterError("OUTPUT_LIMIT")
        return diff
