"""Authorized, complete structure reads for the Hermes Mol* Desktop plugin.

Mounted by Hermes under ``/api/plugins/hermes-molstar/``. The endpoint accepts
only gateway-workspace relative paths. Browser-local files never come here.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
import errno
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Iterable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


MAX_STRUCTURE_BYTES = 16 * 1024 * 1024
MAX_VIEWER_DOCUMENT_BYTES = 3 * 1024 * 1024
PLUGIN_ID = "hermes-molstar"
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_PDB_ATOM_RE = re.compile(r"^(?:ATOM  |HETATM)", re.MULTILINE)
_MMCIF_DATA_RE = re.compile(r"^data_\S*", re.MULTILINE)
_MMCIF_ATOM_RE = re.compile(r"^_atom_site\.", re.MULTILINE)
_WINDOWS_RESERVED_RE = re.compile(
    r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.IGNORECASE
)


class StructureAccessError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _fail(status_code: int, detail: str) -> None:
    raise StructureAccessError(status_code, detail)


def _format_for_path(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdb":
        return "pdb"
    if suffix in {".cif", ".mmcif"}:
        return "mmcif"
    _fail(415, "only .pdb, .cif, and .mmcif files are supported")
    raise AssertionError("unreachable")


def _resolved_directory(raw: str | os.PathLike[str], *, label: str) -> Path:
    try:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            _fail(400, f"{label} must be an absolute path")
        resolved = path.resolve(strict=True)
    except StructureAccessError:
        raise
    except (OSError, RuntimeError, ValueError) as exc:
        _fail(400, f"{label} is unavailable: {exc}")
    if not resolved.is_dir():
        _fail(400, f"{label} is not a directory")
    return resolved


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _path_key(path: Path) -> str:
    """Return the platform comparison key for an already absolute path."""
    return os.path.normcase(os.path.normpath(str(path)))


def _same_path(left: Path, right: Path) -> bool:
    return _path_key(left) == _path_key(right)


def _safe_relative_path(raw: str) -> PurePosixPath:
    if not isinstance(raw, str):
        _fail(400, "path must be a string")
    if not raw or len(raw) > 1024 or _CONTROL_RE.search(raw):
        _fail(400, "path is empty, too long, or contains control characters")
    if raw != raw.strip():
        _fail(400, "path must not have leading or trailing whitespace")
    value = raw
    if "\\" in value:
        _fail(400, "gateway paths must use forward slashes")
    segments = value.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        _fail(400, "path contains unsafe segments")
    if any(
        ":" in segment
        or segment.endswith((" ", "."))
        or _WINDOWS_RESERVED_RE.match(segment)
        for segment in segments
    ):
        _fail(400, "path contains a Windows-reserved or ambiguous segment")
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if posix.is_absolute() or windows.is_absolute() or windows.drive:
        _fail(400, "path must be relative to the authorized workspace")
    return posix


def _file_open_flags() -> int:
    flags = os.O_RDONLY
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOINHERIT"):
        flags |= os.O_NOINHERIT
    return flags


def _candidate_open_flags() -> int:
    flags = _file_open_flags()
    if os.name == "posix":
        nonblocking = getattr(os, "O_NONBLOCK", None)
        if nonblocking is None:
            _fail(503, "secure non-blocking candidate opens are unsupported on this platform")
        flags |= nonblocking
    return flags


def _windows_final_path_for_handle(handle: int) -> Path:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_final_path = kernel32.GetFinalPathNameByHandleW
    get_final_path.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    get_final_path.restype = wintypes.DWORD

    size = 1024
    while size <= 32768:
        buffer = ctypes.create_unicode_buffer(size)
        length = get_final_path(wintypes.HANDLE(handle), buffer, size, 0)
        if length == 0:
            raise ctypes.WinError(ctypes.get_last_error())
        if length < size:
            value = buffer.value
            if value.startswith("\\\\?\\UNC\\"):
                value = "\\\\" + value[8:]
            elif value.startswith("\\\\?\\"):
                value = value[4:]
            final_path = Path(value)
            if not final_path.is_absolute():
                raise OSError("the opened object has no absolute final path")
            return final_path
        size = length + 1
    raise OSError("the opened object final path is too long")


def _windows_final_path_for_fd(fd: int) -> Path:
    import msvcrt
    handle = msvcrt.get_osfhandle(fd)
    if handle == -1:
        raise OSError("could not obtain the native file handle")
    return _windows_final_path_for_handle(handle)


def _windows_identity_for_handle(handle: int) -> tuple[int, int]:
    import ctypes
    from ctypes import wintypes

    class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("dwFileAttributes", wintypes.DWORD),
            ("ftCreationTime", wintypes.FILETIME),
            ("ftLastAccessTime", wintypes.FILETIME),
            ("ftLastWriteTime", wintypes.FILETIME),
            ("dwVolumeSerialNumber", wintypes.DWORD),
            ("nFileSizeHigh", wintypes.DWORD),
            ("nFileSizeLow", wintypes.DWORD),
            ("nNumberOfLinks", wintypes.DWORD),
            ("nFileIndexHigh", wintypes.DWORD),
            ("nFileIndexLow", wintypes.DWORD),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_information = kernel32.GetFileInformationByHandle
    get_information.argtypes = [wintypes.HANDLE, ctypes.POINTER(BY_HANDLE_FILE_INFORMATION)]
    get_information.restype = wintypes.BOOL
    information = BY_HANDLE_FILE_INFORMATION()
    if not get_information(wintypes.HANDLE(handle), ctypes.byref(information)):
        raise ctypes.WinError(ctypes.get_last_error())
    file_index = (int(information.nFileIndexHigh) << 32) | int(information.nFileIndexLow)
    return int(information.dwVolumeSerialNumber), file_index


def _posix_final_path_for_fd(fd: int) -> Path:
    if sys.platform.startswith("linux"):
        value = os.readlink(f"/proc/self/fd/{fd}")
        if value.endswith(" (deleted)"):
            raise OSError("the opened file was deleted during authorization")
    elif sys.platform == "darwin":
        import ctypes

        buffer = ctypes.create_string_buffer(4096)
        libc = ctypes.CDLL(None, use_errno=True)
        # macOS fcntl(2) F_GETPATH returns the path bound to an open descriptor.
        if libc.fcntl(fd, 50, buffer) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        value = os.fsdecode(buffer.value)
    else:
        _fail(503, "secure final-path-by-handle checks are unsupported on this platform")
        raise AssertionError("unreachable")
    final_path = Path(value)
    if not final_path.is_absolute():
        raise OSError("the opened file has no absolute final path")
    return final_path


def _final_path_for_fd(fd: int) -> Path:
    if os.name == "nt":
        return _windows_final_path_for_fd(fd)
    if os.name == "posix":
        return _posix_final_path_for_fd(fd)
    _fail(503, "secure final-path-by-handle checks are unsupported on this platform")
    raise AssertionError("unreachable")


class _OpenedDirectory:
    def __init__(self, resource: int, *, windows_handle: bool) -> None:
        self.resource = resource
        self.windows_handle = windows_handle
        self.approved_path: Path | None = None
        self.approved_identity: tuple[int, int] | None = None

    def final_path(self) -> Path:
        return (_windows_final_path_for_handle(self.resource)
                if self.windows_handle else _final_path_for_fd(self.resource))

    def identity(self) -> tuple[int, int]:
        if self.resource is None:
            raise OSError("directory handle is closed")
        if self.windows_handle:
            return _windows_identity_for_handle(self.resource)
        opened_stat = os.fstat(self.resource)
        return int(opened_stat.st_dev), int(opened_stat.st_ino)

    def close(self) -> None:
        if self.resource is None:
            return
        resource = self.resource
        self.resource = None
        if self.windows_handle:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            close_handle = kernel32.CloseHandle
            close_handle.argtypes = [wintypes.HANDLE]
            close_handle.restype = wintypes.BOOL
            close_handle(wintypes.HANDLE(resource))
        else:
            os.close(resource)


def _bind_directory_anchor(opened: _OpenedDirectory, approved_path: Path) -> _OpenedDirectory:
    """Bind a real directory object to the canonical path approved before open."""
    try:
        final_path = opened.final_path()
        if not _same_path(final_path, approved_path):
            _fail(403, "authorized directory changed while it was opened")
        opened.approved_path = approved_path
        opened.approved_identity = opened.identity()
        return opened
    except Exception:
        opened.close()
        raise


def _verify_directory_anchor(opened: _OpenedDirectory, approved_path: Path) -> None:
    """Verify the held object, and on Windows its final name, before the read."""
    if (opened.approved_path is None
            or not _same_path(opened.approved_path, approved_path)
            or opened.approved_identity is None
            or opened.identity() != opened.approved_identity):
        _fail(403, "authorized directory identity changed during the read")
    # POSIX descriptor-relative traversal remains bound to the original inode
    # across a safe rename. Windows path opens need the canonical name pinned
    # too, because a junction/ancestor replacement can redirect CreateFileW.
    if os.name == "nt" and not _same_path(opened.final_path(), approved_path):
        _fail(403, "authorized directory path changed during the read")


def _open_directory_object(path: Path) -> _OpenedDirectory:
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create_file = kernel32.CreateFileW
        create_file.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        create_file.restype = wintypes.HANDLE
        handle = create_file(
            str(path),
            0x0080,  # FILE_READ_ATTRIBUTES
            0x00000001 | 0x00000002 | 0x00000004,  # share read/write/delete
            None,
            3,  # OPEN_EXISTING
            0x02000000,  # FILE_FLAG_BACKUP_SEMANTICS (open directories)
            None,
        )
        invalid = ctypes.c_void_p(-1).value
        if handle == invalid:
            raise ctypes.WinError(ctypes.get_last_error())
        return _bind_directory_anchor(
            _OpenedDirectory(int(handle), windows_handle=True), path
        )
    if os.name == "posix":
        nofollow = getattr(os, "O_NOFOLLOW", None)
        directory = getattr(os, "O_DIRECTORY", None)
        if nofollow is None or directory is None or os.open not in os.supports_dir_fd:
            _fail(503, "secure directory-relative opens are unsupported on this platform")
        flags = os.O_RDONLY | nofollow | directory
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        return _bind_directory_anchor(
            _OpenedDirectory(os.open(path, flags), windows_handle=False), path
        )
    _fail(503, "secure directory handles are unsupported on this platform")
    raise AssertionError("unreachable")


def _open_candidate_fd(
    path: Path,
    workspace: _OpenedDirectory | None = None,
    relative: PurePosixPath | None = None,
) -> int:
    """Open the candidate and bind POSIX traversal to a held workspace directory object."""
    flags = _candidate_open_flags()
    if os.name != "posix" or workspace is None or relative is None:
        if os.name == "posix":
            nofollow = getattr(os, "O_NOFOLLOW", None)
            if nofollow is None:
                _fail(503, "secure no-follow file opens are unsupported on this platform")
            flags |= nofollow
        return os.open(path, flags)

    nofollow = getattr(os, "O_NOFOLLOW", None)
    directory = getattr(os, "O_DIRECTORY", None)
    if nofollow is None or directory is None or os.open not in os.supports_dir_fd:
        _fail(503, "secure directory-relative opens are unsupported on this platform")
    directory_flags = os.O_RDONLY | nofollow | directory
    if hasattr(os, "O_CLOEXEC"):
        directory_flags |= os.O_CLOEXEC
    current = os.dup(workspace.resource)
    try:
        for segment in relative.parts[:-1]:
            next_fd = os.open(segment, directory_flags, dir_fd=current)
            os.close(current)
            current = next_fd
        try:
            return os.open(relative.parts[-1], flags | nofollow, dir_fd=current)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                _fail(403, "structure path contains a symbolic link")
            raise
    finally:
        os.close(current)


def _validate_structure_text(content: str, format_name: str) -> None:
    if not content.strip() or "\x00" in content:
        _fail(422, "structure is empty or contains binary data")
    if format_name == "pdb" and not _PDB_ATOM_RE.search(content):
        _fail(422, "PDB has no ATOM or HETATM records")
    if format_name == "mmcif" and not (_MMCIF_DATA_RE.search(content) and _MMCIF_ATOM_RE.search(content)):
        _fail(422, "mmCIF has no data block or atom_site category")


def read_authorized_structure(
    *,
    source: str,
    relative_path: str,
    workspace_root: str,
    allowed_roots: Iterable[str | os.PathLike[str]],
    max_bytes: int = MAX_STRUCTURE_BYTES,
) -> dict[str, Any]:
    """Read one complete structure after root, path, type, and size checks."""
    if source != "gateway-workspace":
        _fail(400, "backend reads require source='gateway-workspace'")
    relative = _safe_relative_path(relative_path)
    workspace = _resolved_directory(workspace_root, label="workspace_root")
    roots = [_resolved_directory(root, label="allowed root") for root in allowed_roots]
    if not roots:
        _fail(503, "no allowed_roots are configured for hermes-molstar")
    if not any(_within(workspace, root) for root in roots):
        _fail(403, "workspace_root is outside the configured allowed_roots")
    unresolved = workspace.joinpath(*relative.parts)
    requested_format = _format_for_path(unresolved)
    limit = min(MAX_STRUCTURE_BYTES, max(1, int(max_bytes)))
    fd: int | None = None
    workspace_object: _OpenedDirectory | None = None
    root_objects: list[_OpenedDirectory] = []
    try:
        for root in roots:
            root_object = _open_directory_object(root)
            _verify_directory_anchor(root_object, root)
            root_objects.append(root_object)
        workspace_object = _open_directory_object(workspace)
        _verify_directory_anchor(workspace_object, workspace)
        fd = _open_candidate_fd(unresolved, workspace_object, relative)
    except FileNotFoundError:
        if workspace_object is not None:
            workspace_object.close()
        for root_object in root_objects:
            root_object.close()
        _fail(404, "structure file was not found")
    except StructureAccessError:
        if workspace_object is not None:
            workspace_object.close()
        for root_object in root_objects:
            root_object.close()
        raise
    except (OSError, RuntimeError, ValueError) as exc:
        if workspace_object is not None:
            workspace_object.close()
        for root_object in root_objects:
            root_object.close()
        _fail(400, f"structure path is unavailable: {exc}")
    try:
        opened_stat = os.fstat(fd)
        if not stat.S_ISREG(opened_stat.st_mode):
            _fail(400, "structure path is not a regular file")
        target = _final_path_for_fd(fd)
        _verify_directory_anchor(workspace_object, workspace)
        for root_object, approved_root in zip(root_objects, roots):
            _verify_directory_anchor(root_object, approved_root)
        if os.name == "nt":
            target_is_authorized = (_within(target, workspace)
                                    and any(_within(target, root) for root in roots))
        else:
            # On POSIX every path component was opened relative to the held
            # workspace descriptor with O_NOFOLLOW. Its current final path is
            # used only to prove the target came from that descriptor, never
            # to move the configured authorization boundary.
            target_is_authorized = _within(target, workspace_object.final_path())
        if not target_is_authorized:
            _fail(403, "opened structure is outside the authorized workspace")
        if _format_for_path(target) != requested_format:
            _fail(400, "opened structure format does not match the requested path")
        size = opened_stat.st_size
        if size > limit:
            _fail(413, f"structure exceeds the {limit} byte limit")
        with os.fdopen(fd, "rb", closefd=True) as handle:
            fd = None
            raw = handle.read(limit + 1)
    except StructureAccessError:
        raise
    except OSError as exc:
        _fail(400, f"structure could not be read: {exc}")
    finally:
        if fd is not None:
            os.close(fd)
        if workspace_object is not None:
            workspace_object.close()
        for root_object in root_objects:
            root_object.close()
    if len(raw) > limit:
        _fail(413, f"structure exceeds the {limit} byte limit")
    try:
        content = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        _fail(422, "structure is not valid UTF-8 text")
    _validate_structure_text(content, requested_format)
    return {
        "source": "gateway-workspace",
        "name": target.name,
        "path": relative.as_posix(),
        "format": requested_format,
        "size": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "content": content,
        "truncated": False,
    }


def _configured_allowed_roots() -> list[str]:
    roots: list[str] = []
    env_value = os.getenv("HERMES_MOLSTAR_ALLOWED_ROOTS", "")
    if env_value:
        roots.extend(part.strip() for part in env_value.split(os.pathsep) if part.strip())
    try:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly() or {}
        entries = ((config.get("plugins") or {}).get("entries") or {})
        settings = ((entries.get(PLUGIN_ID) or {}).get("settings") or {})
        configured = settings.get("allowed_roots") or []
        if isinstance(configured, list):
            roots.extend(str(item).strip() for item in configured if str(item).strip())
    except Exception:
        # No config import in a standalone test harness; environment roots are
        # still explicit authorization and an empty result fails closed.
        pass
    return list(dict.fromkeys(roots))


def load_viewer_document_artifact(path: Path | None = None) -> dict[str, Any]:
    """Load the build-owned guest document and verify its recorded digest."""
    artifact_path = path or Path(__file__).with_name("viewer-document.json")
    try:
        raw = artifact_path.read_bytes()
    except OSError as exc:
        raise RuntimeError("viewer document artifact is unavailable") from exc
    if not raw or len(raw) > MAX_VIEWER_DOCUMENT_BYTES + 4096:
        raise RuntimeError("viewer document artifact size is invalid")
    try:
        payload = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("viewer document artifact is invalid JSON") from exc
    if not isinstance(payload, dict) or payload.get("schema") != 1:
        raise RuntimeError("viewer document artifact schema is invalid")
    document = payload.get("document")
    expected = payload.get("sha256")
    if not isinstance(document, str) or not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise RuntimeError("viewer document artifact envelope is invalid")
    document_bytes = document.encode("utf-8")
    if not document_bytes or len(document_bytes) > MAX_VIEWER_DOCUMENT_BYTES:
        raise RuntimeError("viewer document size is invalid")
    if hashlib.sha256(document_bytes).hexdigest() != expected:
        raise RuntimeError("viewer document integrity verification failed")
    if not document.lower().startswith("<!doctype html>"):
        raise RuntimeError("viewer document markup is invalid")
    return {"schema": 1, "sha256": expected, "document": document}


class StructureRequest(BaseModel):
    source: str = Field(pattern=r"^gateway-workspace$")
    path: str = Field(min_length=1, max_length=1024)
    workspace_root: str = Field(min_length=1, max_length=4096)


router = APIRouter()


@router.get("/viewer-document")
def get_viewer_document() -> dict[str, Any]:
    # This authenticated JSON route is called by ctx.rest in the Desktop shell.
    # The opaque frame receives only the resulting data URL, never credentials.
    return load_viewer_document_artifact()


@router.post("/structure")
def get_structure(body: StructureRequest) -> dict[str, Any]:
    try:
        return read_authorized_structure(
            source=body.source,
            relative_path=body.path,
            workspace_root=body.workspace_root,
            allowed_roots=_configured_allowed_roots(),
        )
    except StructureAccessError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
