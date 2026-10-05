"""Bounded, read-only Git command runner."""
from __future__ import annotations

import os
import errno
from pathlib import Path
import selectors
import signal
import subprocess
import time
import re
from ref_validation import is_valid_ref_name


class GitRunnerError(RuntimeError):
    def __init__(self, code: str, operation: str) -> None:
        super().__init__(operation)
        self.code = code
        self.operation = operation


class GitRunner:
    ALLOWED_OPERATIONS = {"status", "branches", "remote-branches", "remote", "rev-parse", "log", "show", "show-diff", "diff", "diff-untracked", "fingerprint-head", "fingerprint-status", "fingerprint-remotes", "fingerprint-branches", "fingerprint-current-branch"}
    ALLOWED_COMMANDS = {"status": "status", "branches": "for-each-ref", "remote-branches": "for-each-ref",
                       "remote": "remote", "rev-parse": "rev-parse", "log": "log", "show": "show", "show-diff": "show", "diff": "diff", "diff-untracked": "diff",
                       "fingerprint-head": "rev-parse", "fingerprint-status": "status", "fingerprint-remotes": "for-each-ref",
                       "fingerprint-branches": "for-each-ref", "fingerprint-current-branch": "symbolic-ref"}
    FORBIDDEN_ARGS = {"--git-dir", "--work-tree", "--exec-path", "--upload-pack", "--receive-pack", "-c"}

    @classmethod
    def _args_allowed(cls, operation: str, args: list[str]) -> bool:
        if not args or args[0] != cls.ALLOWED_COMMANDS.get(operation):
            return False
        if any(arg in cls.FORBIDDEN_ARGS or arg.startswith(("--output", "--config", "--exec-path")) for arg in args):
            return False
        if operation == "status":
            return args[1:] == ["--porcelain=v1", "-z", "--untracked-files=all"]
        if operation == "branches":
            return len(args) == 3 and args[1] == "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)" and args[2] == "refs/heads"
        if operation == "remote-branches":
            return args[1:] == ["--format=%(refname:short)", "refs/remotes"]
        if operation == "remote":
            return len(args) == 3 and args[1] == "get-url" and bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]{0,63}", args[2]))
        if operation == "rev-parse":
            return args[1:] == ["--show-toplevel"]
        if operation == "log":
            return ((len(args) == 5 and args[1] == "--max-count=501" and args[2] == "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%P" and args[3] == "--date=iso-strict")
                    or (len(args) == 6 and args[1] == "--max-count=501" and args[2] == "--decorate=short" and args[3] == "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%P%x00%D" and args[4] == "--date=iso-strict")) and is_valid_ref_name(args[-1])
        if operation == "show":
            return len(args) == 6 and args[1:3] == ["--no-renames", "--format=%H%x00%s%x00%an%x00%aI"] and args[3:5] == ["--numstat", "--no-ext-diff"] and bool(re.fullmatch(r"[0-9a-fA-F]{7,64}", args[5]))
        if operation == "show-diff":
            return len(args) == 4 and args[1:3] == ["--no-ext-diff", "--format="] and bool(re.fullmatch(r"[0-9a-fA-F]{7,64}", args[3]))
        if operation == "diff":
            return len(args) == 6 and args[1:5] == ["--no-ext-diff", "--no-renames", "HEAD", "--"] and bool(args[5]) and not args[5].startswith("/") and ".." not in args[5] and not any(char in args[5] for char in "\x00\n\r*?[]:")
        if operation == "diff-untracked":
            path = args[7] if len(args) == 8 else ""
            return (len(args) == 8 and args[1:7] == ["--no-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--", "/dev/null"]
                    and bool(path) and not path.startswith("/") and ".." not in path.split("/")
                    and not any(ord(char) < 32 for char in path) and not any(char in path for char in "*?[]:"))
        if operation == "fingerprint-head":
            return args[1:] == ["HEAD"]
        if operation == "fingerprint-status":
            return args[1:] == ["--porcelain=v1", "-z", "--untracked-files=all"]
        if operation == "fingerprint-remotes":
            return args[1:] == ["--format=%(refname:short)\t%(objectname)", "refs/remotes"]
        if operation == "fingerprint-branches":
            return args[1:] == ["--format=%(refname:short)\t%(objectname)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)", "refs/heads"]
        if operation == "fingerprint-current-branch":
            return args[1:] == ["--short", "HEAD"]
        return False

    def __init__(self, cwd: Path, timeout: float = 10.0, output_limit: int = 1024 * 1024) -> None:
        self.cwd = cwd
        self.timeout = min(max(timeout, 0.1), 10.0)
        self.output_limit = min(max(output_limit, 1024), 1024 * 1024)

    @staticmethod
    def _stop(process: subprocess.Popen[bytes], pgid: int | None = None) -> None:
        stable_pgid = pgid if pgid is not None else getattr(process, "_mc_pgid", None)
        if type(stable_pgid) is int and stable_pgid > 0:
            try:
                os.killpg(stable_pgid, signal.SIGTERM)
            except OSError as exc:
                if exc.errno != errno.ESRCH:
                    pass
            try:
                process.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                pass
            except OSError:
                pass
            try:
                os.killpg(stable_pgid, signal.SIGKILL)
            except OSError as exc:
                if exc.errno != errno.ESRCH:
                    pass
        try:
            process.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def run(self, operation: str, args: list[str]) -> str:
        if not isinstance(operation, str) or not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
            raise GitRunnerError("GIT_ARGUMENTS_NOT_ALLOWED", "invalid")
        if operation not in self.ALLOWED_OPERATIONS:
            raise GitRunnerError("GIT_OPERATION_NOT_ALLOWED", operation)
        if not self._args_allowed(operation, args):
            raise GitRunnerError("GIT_ARGUMENTS_NOT_ALLOWED", operation)
        argv = ["git", "-C", str(self.cwd), *args]
        try:
            process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       shell=False, start_new_session=True)
        except OSError as exc:
            raise GitRunnerError("GIT_UNAVAILABLE", operation) from exc
        pgid = process.pid
        if type(pgid) is not int or pgid <= 0:
            self._stop(process)
            raise GitRunnerError("GIT_IO_ERROR", operation)
        stdout, stderr = process.stdout, process.stderr
        selector = selectors.DefaultSelector()
        output = {"stdout": bytearray(), "stderr": bytearray()}
        try:
            if stdout is None or stderr is None:
                raise GitRunnerError("GIT_IO_ERROR", operation)
            selector.register(stdout, selectors.EVENT_READ, "stdout")
            selector.register(stderr, selectors.EVENT_READ, "stderr")
            deadline = time.monotonic() + self.timeout
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._stop(process, pgid)
                    raise GitRunnerError("GIT_TIMEOUT", operation)
                for key, _ in selector.select(remaining):
                    stream = key.fileobj
                    fd = stream if isinstance(stream, int) else stream.fileno()
                    chunk = os.read(fd, 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    output[key.data].extend(chunk)
                    if sum(len(value) for value in output.values()) > self.output_limit:
                        self._stop(process, pgid)
                        raise GitRunnerError("GIT_OUTPUT_LIMIT", operation)
            try:
                returncode = process.wait(timeout=max(deadline - time.monotonic(), 0.1))
            except subprocess.TimeoutExpired as exc:
                self._stop(process, pgid)
                raise GitRunnerError("GIT_TIMEOUT", operation) from exc
            if returncode != 0:
                expected_untracked_diff = (
                    operation == "diff-untracked"
                    and returncode == 1
                    and not output["stderr"]
                    and bytes(output["stdout"]).startswith(b"diff --git ")
                )
                if not expected_untracked_diff:
                    raise GitRunnerError("GIT_COMMAND_FAILED", operation)
            try:
                return output["stdout"].decode("utf-8")
            except UnicodeDecodeError as exc:
                raise GitRunnerError("GIT_INVALID_ENCODING", operation) from exc
        except GitRunnerError:
            raise
        except (OSError, ValueError) as exc:
            self._stop(process, pgid)
            raise GitRunnerError("GIT_IO_ERROR", operation) from exc
        finally:
            self._stop(process, pgid)
            selector.close()
            for stream in (stdout, stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
