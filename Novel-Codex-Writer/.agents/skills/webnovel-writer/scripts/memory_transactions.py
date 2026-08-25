"""Atomic writes, per-project locking, and crash-safe memory transactions."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any


class MemorySystemError(RuntimeError):
    """A user-facing validation error."""


_HELD_PROJECT_LOCKS: dict[tuple[str, int], int] = {}
_HELD_PROJECT_LOCK_OWNERS: dict[tuple[str, int], str] = {}
_HELD_PROJECT_LOCK_LOST: dict[tuple[str, int], threading.Event] = {}
_HELD_PROJECT_LOCKS_GUARD = threading.Lock()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _host_identity(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _pid_value_valid(value: Any) -> bool:
    return type(value) is int and 0 < value <= 4_294_967_295


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig") if path.exists() else ""


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(content, encoding="utf-8", newline="")
    os.replace(temporary, path)


def atomic_write_json(path: Path, data: Any) -> None:
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_text(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _lock_payload(lock_file: Path) -> dict[str, Any] | None:
    try:
        if lock_file.is_symlink() or getattr(lock_file, "is_junction", lambda: False)() or not lock_file.is_file():
            return None
        value = json.loads(read_text(lock_file))
    except (json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def _lock_owner(lock_file: Path) -> str | None:
    value = _lock_payload(lock_file)
    owner = value.get("owner") if value else None
    return owner if isinstance(owner, str) else None


def _pid_is_alive(pid: int) -> bool:
    if not _pid_value_valid(pid):
        return True
    if os.name == "nt":
        # Python's os.kill(pid, 0) can report an already-exited Windows process
        # as alive. Query the process handle and its signalled state instead.
        import ctypes

        synchronize = 0x00100000
        wait_object_0 = 0x00000000
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        handle = kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            # Access denied means the process exists but is protected. Unknown
            # failures remain fail-closed.
            return ctypes.get_last_error() not in {87, 1168}
        try:
            wait_result = kernel32.WaitForSingleObject(ctypes.c_void_p(handle), 0)
            if wait_result == wait_object_0:
                return False
            # WAIT_TIMEOUT and unknown/failed results remain fail-closed instead
            # of authorizing reclaim.
            return True
        finally:
            kernel32.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True


def _cleanup_dead_acquire_files(lock_file: Path, local_host: str) -> None:
    prefix = f"{lock_file.name}.acquire."
    local_host_key = _host_identity(local_host)
    for acquire_file in lock_file.parent.glob(f"{prefix}*"):
        if acquire_file.is_symlink() or getattr(acquire_file, "is_junction", lambda: False)():
            continue
        payload = _lock_payload(acquire_file)
        suffix = acquire_file.name.removeprefix(prefix)
        file_host_key, separator, owner_from_name = suffix.partition(".")
        pid_text = owner_from_name.split("-", 1)[0] if separator else ""
        name_pid = int(pid_text) if pid_text.isascii() and pid_text.isdigit() and len(pid_text) <= 10 else None
        if isinstance(payload, dict) and payload.get("host") not in {None, local_host}:
            continue
        payload_pid = payload.get("pid") if isinstance(payload, dict) and payload.get("host") == local_host else None
        pid = payload_pid if _pid_value_valid(payload_pid) else name_pid if file_host_key == local_host_key else None
        if _pid_value_valid(pid) and not _pid_is_alive(pid):
            try:
                acquire_file.unlink()
            except OSError:
                pass


def _assert_project_lock_owned(project_root: Path) -> None:
    thread_key = (str(project_root.resolve()), threading.get_ident())
    with _HELD_PROJECT_LOCKS_GUARD:
        owner = _HELD_PROJECT_LOCK_OWNERS.get(thread_key)
        lost = _HELD_PROJECT_LOCK_LOST.get(thread_key)
    if (
        not owner
        or (lost is not None and lost.is_set())
        or _lock_owner(project_root / ".locks" / "project-write.lock") != owner
    ):
        raise MemorySystemError("项目写入锁已丢失，已停止事务提交。")


def _transaction_target(project_root: Path, candidate: Path, label: str = "事务目标") -> Path:
    root = project_root.resolve()
    target = Path(os.path.abspath(candidate if candidate.is_absolute() else root / candidate))
    try:
        relative = target.relative_to(root)
    except ValueError as exc:
        raise MemorySystemError(f"{label}越出小说目录：{target}") from exc
    if not relative.parts:
        raise MemorySystemError(f"{label}不能是小说目录本身：{target}")
    current = root
    for index, part in enumerate(relative.parts):
        current /= part
        if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
            raise MemorySystemError(f"{label}不能经过符号链接或 junction：{target}")
        if current.exists():
            is_leaf = index == len(relative.parts) - 1
            if is_leaf and not current.is_file():
                raise MemorySystemError(f"{label}不是普通文件：{target}")
            if not is_leaf and not current.is_dir():
                raise MemorySystemError(f"{label}父路径不是目录：{current}")
    return target


def _transaction_target_hash(project_root: Path, candidate: Path) -> str | None:
    target = _transaction_target(project_root, candidate)
    if not target.exists():
        return None
    try:
        return sha256_file(target)
    except OSError as exc:
        raise MemorySystemError(f"无法读取事务目标：{target}") from exc


def validate_transaction_targets(project_root: Path, changes: dict[Path, str | None]) -> None:
    """Read-only preflight used by dry-run commands before reporting success."""
    root = project_root.resolve()
    for candidate in changes:
        _transaction_target(root, candidate)


def _reclaim_lock(lock_file: Path, stale_seconds: float) -> bool:
    reclaim_owner = f"{os.getpid()}-{uuid.uuid4()}"
    local_host = socket.gethostname()
    local_host_key = _host_identity(local_host)
    reclaim_file = Path(f"{lock_file}.reclaim.{local_host_key}.{reclaim_owner}")
    candidate_created = False
    try:
        if lock_file.is_symlink() or getattr(lock_file, "is_junction", lambda: False)() or not lock_file.is_file():
            return False
        initial_contents = lock_file.read_text(encoding="utf-8-sig")
        try:
            payload = json.loads(initial_contents)
        except json.JSONDecodeError:
            payload = None
        first_stat = lock_file.stat()
        age = time.time() - first_stat.st_mtime
        released = isinstance(payload, dict) and payload.get("released") is True
        owner_host = payload.get("host") if isinstance(payload, dict) else None
        owner_pid = payload.get("pid") if isinstance(payload, dict) else None
        owner_id = payload.get("owner") if isinstance(payload, dict) else None
        if not isinstance(owner_id, str) or not _pid_value_valid(owner_pid) or owner_host != local_host:
            return False
        if released:
            # A released marker is only recoverable after the publishing
            # process has exited. This stays fail-closed if PID ownership is
            # uncertain or reused by another live process.
            if age <= 2.0 or _pid_is_alive(owner_pid):
                return False
        elif age <= stale_seconds or _pid_is_alive(owner_pid):
            return False

        descriptor = os.open(reclaim_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            json.dump({
                "owner": reclaim_owner,
                "pid": os.getpid(),
                "host": local_host,
                "createdMonotonicNs": str(time.monotonic_ns()),
            }, handle)
        candidate_created = True

        time.sleep(0.01)
        candidates: list[tuple[int, str]] = []
        for candidate_file in lock_file.parent.glob(f"{lock_file.name}.reclaim.*"):
            if candidate_file.is_symlink() or getattr(candidate_file, "is_junction", lambda: False)():
                return False
            try:
                candidate_file.stat()
                candidate = _lock_payload(candidate_file)
            except OSError:
                return False
            if (
                not isinstance(candidate, dict)
                or not isinstance(candidate.get("owner"), str)
                or not _pid_value_valid(candidate.get("pid"))
                or not isinstance(candidate.get("host"), str)
                or not isinstance(candidate.get("createdMonotonicNs"), str)
                or not candidate["createdMonotonicNs"].isascii()
                or not candidate["createdMonotonicNs"].isdigit()
                or len(candidate["createdMonotonicNs"]) > 32
            ):
                suffix = candidate_file.name.removeprefix(f"{lock_file.name}.reclaim.")
                file_host_key, separator, name_owner = suffix.partition(".")
                pid_text = name_owner.split("-", 1)[0]
                candidate_pid = int(pid_text) if separator and pid_text.isascii() and pid_text.isdigit() and len(pid_text) <= 10 else None
                if file_host_key == local_host_key and _pid_value_valid(candidate_pid) and not _pid_is_alive(candidate_pid):
                    try:
                        candidate_file.unlink()
                    except OSError:
                        pass
                else:
                    return False
                continue
            if candidate["host"] != local_host:
                return False
            if not _pid_is_alive(candidate["pid"]):
                if candidate["owner"] != reclaim_owner:
                    try:
                        candidate_file.unlink()
                    except OSError:
                        pass
                continue
            candidates.append((int(candidate["createdMonotonicNs"]), candidate["owner"]))
        candidates.sort()
        if not candidates or candidates[0][1] != reclaim_owner:
            return False

        confirmed_contents = lock_file.read_text(encoding="utf-8-sig")
        confirmed_stat = lock_file.stat()
        if (
            confirmed_contents != initial_contents
            or confirmed_stat.st_mtime_ns != first_stat.st_mtime_ns
            or confirmed_stat.st_size != first_stat.st_size
            or time.time() - confirmed_stat.st_mtime <= (2.0 if released else stale_seconds)
        ):
            return False
        if _lock_owner(reclaim_file) != reclaim_owner:
            return False
        stale_file = lock_file.with_name(f"{lock_file.name}.stale.{uuid.uuid4().hex}")
        lock_file.rename(stale_file)
        stale_file.unlink(missing_ok=True)
        return True
    except (FileExistsError, FileNotFoundError, PermissionError, OSError):
        return False
    finally:
        if candidate_created and _lock_owner(reclaim_file) == reclaim_owner:
            try:
                reclaim_file.unlink()
            except OSError:
                pass


@contextmanager
def project_write_lock(project_root: Path, *, timeout_seconds: float = 10.0, stale_seconds: float = 30.0):
    """Serialize Python and Node writers through the same project lock file."""
    project_root = project_root.resolve()
    if not project_root.is_dir():
        raise MemorySystemError("小说项目目录不存在，已拒绝重新创建锁目录。")
    thread_key = (str(project_root), threading.get_ident())
    with _HELD_PROJECT_LOCKS_GUARD:
        held_count = _HELD_PROJECT_LOCKS.get(thread_key, 0)
        if held_count:
            _HELD_PROJECT_LOCKS[thread_key] = held_count + 1
    if held_count:
        try:
            yield
            _assert_project_lock_owned(project_root)
        finally:
            with _HELD_PROJECT_LOCKS_GUARD:
                remaining = _HELD_PROJECT_LOCKS[thread_key] - 1
                if remaining:
                    _HELD_PROJECT_LOCKS[thread_key] = remaining
                else:
                    _HELD_PROJECT_LOCKS.pop(thread_key, None)
                    _HELD_PROJECT_LOCK_OWNERS.pop(thread_key, None)
                    _HELD_PROJECT_LOCK_LOST.pop(thread_key, None)
        return

    lock_root = project_root / ".locks"
    try:
        lock_root.mkdir(exist_ok=True)
    except OSError as exc:
        raise MemorySystemError("小说项目目录在加锁前发生变化，已停止写入。") from exc
    if lock_root.is_symlink() or getattr(lock_root, "is_junction", lambda: False)():
        raise MemorySystemError("事务锁目录不能是符号链接或 junction。")
    if project_root not in lock_root.resolve().parents:
        raise MemorySystemError("事务锁目录越出小说项目。")
    lock_file = lock_root / "project-write.lock"
    inherited_owner = os.environ.get("NOVEL_PARENT_PROJECT_LOCK_OWNER", "").strip()
    inherited_pid = os.environ.get("NOVEL_PARENT_PROJECT_LOCK_PID", "").strip()
    inherited_payload = _lock_payload(lock_file) if inherited_owner else None
    if (
        inherited_owner
        and inherited_payload
        and inherited_payload.get("owner") == inherited_owner
        and inherited_pid.isdigit()
        and inherited_payload.get("pid") == int(inherited_pid)
        and os.getppid() == int(inherited_pid)
        and inherited_payload.get("host") == socket.gethostname()
    ):
        # The direct child becomes a co-holder of the parent's lease for the
        # duration of its work. This keeps the lock fresh even if the Node
        # parent crashes, so another writer cannot reclaim it while Python is
        # still committing. The child never removes the parent's lock.
        inherited_lock_lost = threading.Event()
        stop_inherited_heartbeat = threading.Event()

        def inherited_heartbeat() -> None:
            interval = max(0.01, min(1.0, stale_seconds / 3))
            while not stop_inherited_heartbeat.wait(interval):
                if _lock_owner(lock_file) != inherited_owner:
                    inherited_lock_lost.set()
                    return
                try:
                    os.utime(lock_file, None)
                except OSError:
                    inherited_lock_lost.set()
                    return

        inherited_heartbeat_thread = threading.Thread(
            target=inherited_heartbeat,
            name="webnovel-memory-inherited-lock",
            daemon=True,
        )
        inherited_heartbeat_thread.start()
        with _HELD_PROJECT_LOCKS_GUARD:
            _HELD_PROJECT_LOCKS[thread_key] = 1
            _HELD_PROJECT_LOCK_OWNERS[thread_key] = inherited_owner
            _HELD_PROJECT_LOCK_LOST[thread_key] = inherited_lock_lost
        try:
            yield
            _assert_project_lock_owned(project_root)
        finally:
            stop_inherited_heartbeat.set()
            inherited_heartbeat_thread.join(timeout=1.0)
            with _HELD_PROJECT_LOCKS_GUARD:
                _HELD_PROJECT_LOCKS.pop(thread_key, None)
                _HELD_PROJECT_LOCK_OWNERS.pop(thread_key, None)
                _HELD_PROJECT_LOCK_LOST.pop(thread_key, None)
        return
    deadline = time.monotonic() + timeout_seconds
    owner = f"{os.getpid()}-{uuid.uuid4()}"
    local_host = socket.gethostname()
    _cleanup_dead_acquire_files(lock_file, local_host)
    acquire_file = lock_file.with_name(f"{lock_file.name}.acquire.{_host_identity(local_host)}.{owner}")
    try:
        descriptor = os.open(acquire_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            json.dump({
                "owner": owner,
                "pid": os.getpid(),
                "host": local_host,
                "createdAt": now_iso(),
            }, handle, ensure_ascii=False)
    except OSError as exc:
        raise MemorySystemError("无法准备项目写入锁。") from exc
    try:
        while True:
            try:
                # Hard-link publication is no-overwrite and exposes only a
                # complete payload to Node/Python contenders.
                os.link(acquire_file, lock_file)
                deleting_marker = project_root / ".deleting"
                try:
                    deleting_marker.unlink(missing_ok=True)
                except OSError as exc:
                    if _lock_owner(lock_file) == owner:
                        lock_file.unlink(missing_ok=True)
                    raise MemorySystemError("检测到未完成的项目删除，且无法清理删除标记。") from exc
                break
            except FileExistsError:
                if _reclaim_lock(lock_file, stale_seconds):
                    continue
                if time.monotonic() >= deadline:
                    raise MemorySystemError("另一个记忆写入任务仍在运行，请稍后重试。")
                time.sleep(0.05)
            except PermissionError:
                if time.monotonic() >= deadline:
                    raise MemorySystemError("写入锁正在被另一个本机进程切换，请稍后重试。")
                time.sleep(0.05)
            except FileNotFoundError as exc:
                raise MemorySystemError("小说项目目录在等待写入锁期间已被移走。") from exc
    finally:
        try:
            acquire_file.unlink()
        except OSError:
            pass
    stop_heartbeat = threading.Event()
    lock_lost = threading.Event()

    def heartbeat() -> None:
        interval = max(0.01, min(1.0, stale_seconds / 3))
        while not stop_heartbeat.wait(interval):
            if _lock_owner(lock_file) != owner:
                lock_lost.set()
                return
            try:
                os.utime(lock_file, None)
            except OSError:
                lock_lost.set()
                return

    heartbeat_thread = threading.Thread(target=heartbeat, name="webnovel-memory-lock", daemon=True)
    heartbeat_thread.start()
    with _HELD_PROJECT_LOCKS_GUARD:
        _HELD_PROJECT_LOCKS[thread_key] = 1
        _HELD_PROJECT_LOCK_OWNERS[thread_key] = owner
        _HELD_PROJECT_LOCK_LOST[thread_key] = lock_lost
    try:
        yield
        _assert_project_lock_owned(project_root)
    finally:
        with _HELD_PROJECT_LOCKS_GUARD:
            _HELD_PROJECT_LOCKS.pop(thread_key, None)
            _HELD_PROJECT_LOCK_OWNERS.pop(thread_key, None)
            _HELD_PROJECT_LOCK_LOST.pop(thread_key, None)
        stop_heartbeat.set()
        heartbeat_thread.join(timeout=1.0)
        if _lock_owner(lock_file) == owner:
            for retry_delay in (0.0, 0.01, 0.025, 0.05):
                if retry_delay:
                    time.sleep(retry_delay)
                if _lock_owner(lock_file) != owner:
                    break
                try:
                    lock_file.unlink()
                    break
                except FileNotFoundError:
                    break
                except OSError:
                    continue


def inspect_transactions(project_root: Path) -> list[dict[str, Any]]:
    transaction_root = _transaction_root(project_root, create=False)
    if not transaction_root.exists():
        return []
    pending: list[dict[str, Any]] = []
    for raw_directory in sorted(transaction_root.iterdir()):
        if raw_directory.is_symlink() or getattr(raw_directory, "is_junction", lambda: False)():
            raise MemorySystemError(f"事务目录不能是符号链接或 junction：{raw_directory}")
        if not raw_directory.is_dir():
            continue
        directory = _checked_child_path(transaction_root, raw_directory.name, "事务目录")
        manifest_path = _checked_child_path(directory, "manifest.json", "事务 manifest")
        if manifest_path.is_symlink() or getattr(manifest_path, "is_junction", lambda: False)():
            raise MemorySystemError(f"事务 manifest 不能是符号链接或 junction：{manifest_path}")
        if not manifest_path.exists():
            pending.append({"id": directory.name, "status": "missing_manifest", "legacy": True, "files": []})
            continue
        try:
            manifest = json.loads(read_text(manifest_path))
        except json.JSONDecodeError as exc:
            raise MemorySystemError(f"事务恢复清单损坏，请人工检查：{manifest_path}") from exc
        if not isinstance(manifest, dict):
            raise MemorySystemError(f"事务恢复清单顶层必须是对象：{manifest_path}")
        if manifest.get("status") == "complete":
            continue
        files = manifest.get("files", []) if isinstance(manifest.get("files"), list) else []
        pending.append({
            "id": directory.name,
            "status": str(manifest.get("status", "unknown")),
            "legacy": any("before_hash" not in item or "staged_hash" not in item for item in files if isinstance(item, dict)),
            "files": [str(item.get("target", "")) for item in files if isinstance(item, dict)],
        })
    return pending


def _checked_project_path(project_root: Path, value: str, label: str) -> Path:
    target = (project_root / value).resolve()
    if target != project_root and project_root not in target.parents:
        raise MemorySystemError(f"{label}越出小说项目：{target}")
    return target


def _checked_child_path(root: Path, value: str, label: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise MemorySystemError(f"{label}包含非法路径：{value}")
    canonical_root = root.resolve()
    target = (canonical_root / candidate).resolve()
    if target != canonical_root and canonical_root not in target.parents:
        raise MemorySystemError(f"{label}越出允许目录：{target}")
    return target


def _transaction_root(project_root: Path, *, create: bool) -> Path:
    project_root = project_root.resolve()
    raw_memory_root = project_root / "记忆库"
    if raw_memory_root.is_symlink() or getattr(raw_memory_root, "is_junction", lambda: False)():
        raise MemorySystemError("记忆库目录不能是符号链接或 junction。")
    memory_root = _checked_project_path(project_root, "记忆库", "记忆库路径")
    if create and not memory_root.is_dir():
        raise MemorySystemError("记忆库目录不存在，已拒绝创建项目外事务目录。")
    raw_root = project_root / "记忆库" / ".transactions"
    if raw_root.is_symlink() or getattr(raw_root, "is_junction", lambda: False)():
        raise MemorySystemError("事务目录不能是符号链接或 junction。")
    if raw_root.exists() and not raw_root.is_dir():
        raise MemorySystemError("事务目录路径已被普通文件占用。")
    transaction_root = _checked_project_path(project_root, "记忆库/.transactions", "事务目录")
    if create:
        transaction_root.mkdir(exist_ok=True)
        transaction_root = _checked_project_path(project_root, "记忆库/.transactions", "事务目录")
    return transaction_root


def _remove_transaction_directory(directory: Path) -> None:
    try:
        shutil.rmtree(directory)
    except OSError as exc:
        raise MemorySystemError(f"事务目录清理失败，请人工检查：{directory}") from exc
    if directory.exists():
        raise MemorySystemError(f"事务目录清理后仍然存在，请人工检查：{directory}")


def _copy_replace(source: Path, target: Path) -> None:
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.restore")
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _validated_recovery_item(
    project_root: Path,
    directory: Path,
    manifest_path: Path,
    item: Any,
    *,
    legacy: bool,
) -> tuple[dict[str, Any], Path, Path]:
    if not isinstance(item, dict):
        raise MemorySystemError(f"事务文件记录格式不正确：{manifest_path}")
    target_value = item.get("target")
    backup_value = item.get("backup")
    if not isinstance(target_value, str) or not target_value.strip():
        raise MemorySystemError(f"事务文件记录缺少有效 target：{manifest_path}")
    if not isinstance(backup_value, str) or not backup_value.strip():
        raise MemorySystemError(f"事务文件记录缺少有效 backup：{manifest_path}")
    if type(item.get("had_original")) is not bool:
        raise MemorySystemError(f"事务文件记录缺少有效 had_original：{manifest_path}")
    target = _transaction_target(project_root, Path(target_value), "事务恢复目标")
    backup = _checked_child_path(directory, backup_value, "事务备份")
    if backup == directory or (backup.exists() and not backup.is_file()):
        raise MemorySystemError(f"事务备份必须是事务目录内的文件：{backup}")
    if not legacy:
        for field in ("before_hash", "staged_hash"):
            value = item.get(field)
            if value is not None and (
                not isinstance(value, str)
                or len(value) != 64
                or any(character not in "0123456789abcdef" for character in value.lower())
            ):
                raise MemorySystemError(f"事务文件记录 {field} 无效：{manifest_path}")
    return item, target, backup


def _recover_transactions_unlocked(project_root: Path, *, force_legacy: bool = False) -> list[str]:
    _assert_project_lock_owned(project_root)
    transaction_root = _transaction_root(project_root, create=False)
    recovered: list[str] = []
    if not transaction_root.exists():
        return recovered
    for raw_directory in sorted(transaction_root.iterdir()):
        if raw_directory.is_symlink() or getattr(raw_directory, "is_junction", lambda: False)():
            raise MemorySystemError(f"事务目录不能是符号链接或 junction：{raw_directory}")
        if not raw_directory.is_dir():
            continue
        directory = _checked_child_path(transaction_root, raw_directory.name, "事务目录")
        manifest_path = _checked_child_path(directory, "manifest.json", "事务 manifest")
        if manifest_path.is_symlink() or getattr(manifest_path, "is_junction", lambda: False)():
            raise MemorySystemError(f"事务 manifest 不能是符号链接或 junction：{manifest_path}")
        if not manifest_path.exists():
            raise MemorySystemError(f"事务目录缺少 manifest.json，请人工检查：{directory}")
        try:
            manifest = json.loads(read_text(manifest_path))
        except json.JSONDecodeError as exc:
            raise MemorySystemError(f"事务恢复清单损坏，请人工检查：{manifest_path}") from exc
        if not isinstance(manifest, dict):
            raise MemorySystemError(f"事务恢复清单顶层必须是对象：{manifest_path}")
        if manifest.get("status") == "complete":
            _assert_project_lock_owned(project_root)
            _remove_transaction_directory(directory)
            continue
        files = manifest.get("files", [])
        if not isinstance(files, list):
            raise MemorySystemError(f"事务恢复清单 files 格式不正确：{manifest_path}")
        legacy = any(not isinstance(item, dict) or "before_hash" not in item or "staged_hash" not in item for item in files)
        if legacy and not force_legacy:
            raise MemorySystemError(
                f"旧事务缺少 hash，不能自动确认外部改动：{directory.name}。"
                "确认没有人工修改后再使用 --force-legacy-recovery。"
            )
        validated = [
            _validated_recovery_item(project_root, directory, manifest_path, item, legacy=legacy)
            for item in files
        ]
        for item, target, _backup in validated:
            if legacy:
                continue
            actual_hash = _transaction_target_hash(project_root, target)
            if actual_hash not in {item.get("before_hash"), item.get("staged_hash")}:
                raise MemorySystemError(f"事务恢复检测到外部修改，已停止：{target.relative_to(project_root).as_posix()}")
        for item, target, backup in reversed(validated):
            _assert_project_lock_owned(project_root)
            if backup.is_symlink() or getattr(backup, "is_junction", lambda: False)():
                raise MemorySystemError(f"事务备份不能是符号链接或 junction：{backup}")
            if item.get("had_original"):
                if not backup.exists():
                    raise MemorySystemError(f"事务备份缺失，请人工检查：{backup}")
                if not legacy and sha256_file(backup) != item.get("before_hash"):
                    raise MemorySystemError(f"事务备份 hash 不匹配，请人工检查：{backup}")
                target = _transaction_target(project_root, target, "事务恢复目标")
                target.parent.mkdir(parents=True, exist_ok=True)
                target = _transaction_target(project_root, target, "事务恢复目标")
                _assert_project_lock_owned(project_root)
                _copy_replace(backup, target)
            else:
                target = _transaction_target(project_root, target, "事务恢复目标")
                if target.exists():
                    _assert_project_lock_owned(project_root)
                    target.unlink()
        recovered.append(directory.name)
        _assert_project_lock_owned(project_root)
        _remove_transaction_directory(directory)
    return recovered


def recover_transactions(project_root: Path, *, force_legacy: bool = False) -> list[str]:
    with project_write_lock(project_root):
        return _recover_transactions_unlocked(project_root, force_legacy=force_legacy)


def _apply_transaction_unlocked(project_root: Path, changes: dict[Path, str | None]) -> None:
    if not changes:
        return
    project_root = project_root.resolve()
    _assert_project_lock_owned(project_root)
    transaction_root = _transaction_root(project_root, create=True)
    directory = transaction_root / f"txn-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
    files: list[dict[str, Any]] = []
    try:
        _assert_project_lock_owned(project_root)
        directory.mkdir()
        (directory / "backup").mkdir()
        (directory / "staged").mkdir()
        for position, (target_value, content) in enumerate(sorted(changes.items(), key=lambda item: str(item[0]))):
            _assert_project_lock_owned(project_root)
            target = _transaction_target(project_root, target_value)
            had_original = target.exists()
            before_hash = _transaction_target_hash(project_root, target)
            backup_name = f"backup/{position}.bak"
            staged_name = f"staged/{position}.new"
            if had_original:
                shutil.copy2(target, directory / backup_name)
                if sha256_file(directory / backup_name) != before_hash:
                    raise MemorySystemError(f"事务备份期间检测到目标变化：{target}")
            if content is not None:
                (directory / staged_name).write_text(content, encoding="utf-8", newline="")
            staged_hash = sha256_file(directory / staged_name) if content is not None else None
            files.append({
                "target": target.relative_to(project_root).as_posix(), "had_original": had_original,
                "backup": backup_name, "staged": staged_name if content is not None else None,
                "before_hash": before_hash, "staged_hash": staged_hash,
            })
        manifest = {"status": "writing", "created_at": now_iso(), "files": files}
        manifest_path = directory / "manifest.json"
        _assert_project_lock_owned(project_root)
        atomic_write_json(manifest_path, manifest)
    except Exception:
        if directory.exists():
            _remove_transaction_directory(directory)
        raise
    replaced: list[dict[str, Any]] = []
    try:
        _assert_project_lock_owned(project_root)
        conflicts = [item["target"] for item in files
                     if _transaction_target_hash(project_root, project_root / item["target"]) != item["before_hash"]]
        if conflicts:
            manifest.update({"status": "conflict", "conflicts": conflicts})
            atomic_write_json(manifest_path, manifest)
            raise MemorySystemError("事务提交前检测到外部修改，已停止：" + "、".join(conflicts))
        for item in files:
            _assert_project_lock_owned(project_root)
            target = _transaction_target(project_root, project_root / item["target"])
            target.parent.mkdir(parents=True, exist_ok=True)
            target = _transaction_target(project_root, target)
            _assert_project_lock_owned(project_root)
            if item["staged"] is None:
                if target.exists():
                    target.unlink()
            else:
                os.replace(directory / item["staged"], target)
            replaced.append(item)
        _assert_project_lock_owned(project_root)
        manifest["status"] = "complete"
        atomic_write_json(manifest_path, manifest)
    except Exception as exc:
        try:
            _assert_project_lock_owned(project_root)
        except MemorySystemError as lock_error:
            raise MemorySystemError(
                f"事务期间项目写入锁丢失；已保留事务目录等待显式恢复：{directory.name}"
            ) from lock_error
        rollback_conflicts: list[str] = []
        for item in reversed(replaced):
            _assert_project_lock_owned(project_root)
            target = _transaction_target(project_root, project_root / item["target"])
            actual_hash = _transaction_target_hash(project_root, target)
            if actual_hash != item["staged_hash"]:
                rollback_conflicts.append(item["target"])
                continue
            if item["had_original"]:
                target.parent.mkdir(parents=True, exist_ok=True)
                backup = _checked_child_path(directory, str(item["backup"]), "事务回滚备份")
                _assert_project_lock_owned(project_root)
                _copy_replace(backup, target)
            elif target.exists():
                _assert_project_lock_owned(project_root)
                target.unlink()
        if rollback_conflicts:
            manifest.update({"status": "rollback_conflict", "rollback_conflicts": rollback_conflicts})
        elif manifest.get("status") != "conflict":
            manifest["status"] = "rolled_back"
        _assert_project_lock_owned(project_root)
        atomic_write_json(manifest_path, manifest)
        if rollback_conflicts:
            raise MemorySystemError("事务失败且回滚检测到外部修改，请人工恢复：" + "、".join(rollback_conflicts)) from exc
        raise
    finally:
        if manifest.get("status") == "complete":
            _assert_project_lock_owned(project_root)
            _remove_transaction_directory(directory)


def apply_transaction(project_root: Path, changes: dict[Path, str | None]) -> None:
    with project_write_lock(project_root):
        _apply_transaction_unlocked(project_root, changes)
