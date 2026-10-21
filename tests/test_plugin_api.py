from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).parents[1] / "plugin" / "dashboard" / "plugin_api.py"
TMP_ROOT = Path(__file__).parents[1] / ".tmp" / "unittest"


def load_module():
    spec = importlib.util.spec_from_file_location("hermes_molstar_plugin_api", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pdb_text(atom_count: int = 1) -> str:
    atoms = "".join(
        f"ATOM  {index:5d}  CA  GLY A{index % 9999:4d}    {index % 99:8.3f}{0:8.3f}{0:8.3f}  1.00 20.00           C  \n"
        for index in range(1, atom_count + 1)
    )
    return "HEADER    SYNTHETIC SECURITY/IO TEST FIXTURE\n" + atoms + "END\n"


class PluginApiTests(unittest.TestCase):
    def setUp(self):
        TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp_path = Path(tempfile.mkdtemp(prefix="case-", dir=TMP_ROOT))
        self.api = load_module()

    def tearDown(self):
        shutil.rmtree(self.tmp_path)

    def assert_access_error(self, status_code, **kwargs):
        with self.assertRaises(self.api.StructureAccessError) as error:
            self.api.read_authorized_structure(**kwargs)
        self.assertEqual(error.exception.status_code, status_code)

    def test_reads_complete_structure_beyond_preview_limit(self):
        root = self.tmp_path / "workspace"
        root.mkdir()
        content = pdb_text(9000)
        self.assertGreater(len(content.encode()), 512 * 1024)
        (root / "large.pdb").write_bytes(content.encode("utf-8"))
        result = self.api.read_authorized_structure(
            source="gateway-workspace", relative_path="large.pdb",
            workspace_root=str(root), allowed_roots=[root])
        self.assertEqual(result["content"], content)
        self.assertEqual(result["size"], len(content.encode()))
        self.assertEqual(result["sha256"], hashlib.sha256(content.encode()).hexdigest())
        self.assertIs(result["truncated"], False)

    def test_preserves_non_ascii_crlf_bytes_and_rejects_invalid_utf8(self):
        root = self.tmp_path / "workspace"
        root.mkdir()
        content = (
            "HEADER    CAFÉ CRLF FIXTURE\r\n"
            "ATOM      1  CA  GLY A   1       0.000   0.000   0.000  1.00 20.00           C  \r\n"
            "END\r\n"
        )
        raw = content.encode("utf-8")
        (root / "unicode.pdb").write_bytes(raw)
        result = self.api.read_authorized_structure(
            source="gateway-workspace", relative_path="unicode.pdb",
            workspace_root=str(root), allowed_roots=[root])
        self.assertEqual(result["content"], content)
        self.assertEqual(result["size"], len(raw))
        self.assertEqual(result["sha256"], hashlib.sha256(raw).hexdigest())

        (root / "invalid.pdb").write_bytes(b"HEADER X\nATOM  \xff\n")
        self.assert_access_error(
            422, source="gateway-workspace", relative_path="invalid.pdb",
            workspace_root=str(root), allowed_roots=[root])

    def test_rejects_traversal_and_absolute_paths(self):
        root = self.tmp_path / "workspace"
        root.mkdir()
        for relative_path in [
            "../outside.pdb", "models/../../outside.pdb", "/absolute.pdb",
            "C:/absolute.pdb", "\\\\server\\share\\x.pdb", "./model.pdb",
            "models/./model.pdb", "models//model.pdb",
            "payload.txt:hidden.pdb", "models/C:/secret.pdb", "\nmodel.pdb",
            "model.pdb\n", "CON.pdb", "models/NUL.cif", "model.pdb ",
        ]:
            with self.subTest(relative_path=relative_path):
                self.assert_access_error(
                    400, source="gateway-workspace", relative_path=relative_path,
                    workspace_root=str(root), allowed_roots=[root])

    def test_authorization_is_bound_to_the_actually_opened_file_handle(self):
        root = self.tmp_path / "workspace"
        outside = self.tmp_path / "outside"
        root.mkdir()
        outside.mkdir()
        inside_path = root / "model.pdb"
        outside_path = outside / "secret.pdb"
        inside_path.write_bytes(pdb_text(1).encode("utf-8"))
        outside_path.write_bytes(pdb_text(2).encode("utf-8"))
        real_open = self.api._open_candidate_fd

        def raced_open(path, *args, **kwargs):
            if Path(path) == inside_path:
                return real_open(outside_path, *args, **kwargs)
            return real_open(path, *args, **kwargs)

        # Deterministically model a path-check/open race: the pathname was
        # authorized, but the OS open resolves to a different object. The
        # implementation must authorize the returned handle, not the old name.
        with mock.patch.object(
            self.api, "_open_candidate_fd", side_effect=raced_open, create=True
        ):
            self.assert_access_error(
                403, source="gateway-workspace", relative_path="model.pdb",
                workspace_root=str(root), allowed_roots=[root])

    def test_opened_directory_handles_cannot_redefine_authorization_anchors(self):
        allowed = self.tmp_path / "allowed"
        workspace = allowed / "workspace"
        outside = self.tmp_path / "outside"
        outside_workspace = outside / "workspace"
        workspace.mkdir(parents=True)
        outside_workspace.mkdir(parents=True)
        (workspace / "model.pdb").write_bytes(pdb_text(1).encode("utf-8"))
        outside_model = outside_workspace / "model.pdb"
        outside_model.write_bytes(pdb_text(2).encode("utf-8"))
        approved_allowed = allowed.resolve(strict=True)
        approved_workspace = workspace.resolve(strict=True)
        real_open_directory = self.api._open_directory_object

        def redirected_directory_open(path):
            if Path(path) == approved_allowed:
                return real_open_directory(outside.resolve(strict=True))
            if Path(path) == approved_workspace:
                return real_open_directory(outside_workspace.resolve(strict=True))
            return real_open_directory(path)

        def redirected_candidate_open(_path, *_args, **_kwargs):
            flags = self.api._file_open_flags()
            if os.name == "posix":
                flags |= getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
            return os.open(outside_model, flags)

        # Use real opened directory/file objects while deterministically
        # modeling a junction/ancestor retarget between resolve and open.
        # The approved canonical paths must remain the authorization anchors.
        with (
            mock.patch.object(self.api, "_open_directory_object", side_effect=redirected_directory_open),
            mock.patch.object(self.api, "_open_candidate_fd", side_effect=redirected_candidate_open),
        ):
            self.assert_access_error(
                403, source="gateway-workspace", relative_path="model.pdb",
                workspace_root=str(workspace), allowed_roots=[allowed])

    def test_workspace_path_component_swap_cannot_redirect_the_open(self):
        allowed = self.tmp_path / "allowed"
        workspace = allowed / "workspace"
        replacement = allowed / "replacement"
        parked = allowed / "workspace-parked"
        workspace.mkdir(parents=True)
        replacement.mkdir()
        (workspace / "model.pdb").write_bytes(pdb_text(1).encode("utf-8"))
        (replacement / "model.pdb").write_bytes(pdb_text(2).encode("utf-8"))
        real_open = self.api._open_candidate_fd
        swapped = False

        def swap_workspace_then_open(path, *args, **kwargs):
            nonlocal swapped
            if not swapped:
                workspace.rename(parked)
                replacement.rename(workspace)
                swapped = True
            return real_open(path, *args, **kwargs)

        # The authorization code has already resolved `workspace`. Replace
        # that pathname before the file open. A safe implementation opens
        # relative to the previously held workspace directory object or
        # detects that its final path no longer matches the opened target.
        with mock.patch.object(self.api, "_open_candidate_fd", side_effect=swap_workspace_then_open):
            if os.name == "posix":
                result = self.api.read_authorized_structure(
                    source="gateway-workspace", relative_path="model.pdb",
                    workspace_root=str(workspace), allowed_roots=[allowed])
                self.assertEqual(result["content"], pdb_text(1))
            else:
                self.assert_access_error(
                    403, source="gateway-workspace", relative_path="model.pdb",
                    workspace_root=str(workspace), allowed_roots=[allowed])

    def test_candidate_open_flags_are_nonblocking_only_on_posix(self):
        flags = self.api._candidate_open_flags()
        nonblocking = getattr(os, "O_NONBLOCK", 0)
        if os.name == "posix":
            self.assertNotEqual(flags & nonblocking, 0)
        elif nonblocking:
            self.assertEqual(flags & nonblocking, 0)

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "mkfifo"), "POSIX FIFO test")
    def test_fifo_candidate_is_rejected_without_blocking(self):
        root = self.tmp_path / "workspace"
        root.mkdir()
        fifo = root / "pipe.pdb"
        os.mkfifo(fifo)
        started = time.monotonic()
        with self.assertRaises(self.api.StructureAccessError) as error:
            self.api.read_authorized_structure(
                source="gateway-workspace", relative_path="pipe.pdb",
                workspace_root=str(root), allowed_roots=[root])
        self.assertEqual(error.exception.status_code, 400)
        self.assertLess(time.monotonic() - started, 1.0)

    def test_rejects_workspace_outside_explicit_allowed_roots(self):
        allowed = self.tmp_path / "allowed"
        outside = self.tmp_path / "outside"
        allowed.mkdir()
        outside.mkdir()
        (outside / "model.pdb").write_bytes(pdb_text().encode("utf-8"))
        self.assert_access_error(
            403, source="gateway-workspace", relative_path="model.pdb",
            workspace_root=str(outside), allowed_roots=[allowed])

    def test_rejects_symlink_escape_when_supported(self):
        root = self.tmp_path / "workspace"
        outside = self.tmp_path / "outside"
        root.mkdir()
        outside.mkdir()
        (outside / "secret.pdb").write_bytes(pdb_text().encode("utf-8"))
        try:
            (root / "escape.pdb").symlink_to(outside / "secret.pdb")
        except OSError as exc:
            self.skipTest(f"symlink creation unavailable: {exc}")
        self.assert_access_error(
            403, source="gateway-workspace", relative_path="escape.pdb",
            workspace_root=str(root), allowed_roots=[root])

    def test_rejects_wrong_source_unsupported_malformed_and_oversize(self):
        root = self.tmp_path / "workspace"
        root.mkdir()
        (root / "model.txt").write_bytes(b"ATOM")
        (root / "broken.pdb").write_bytes(b"not a structure")
        (root / "oversize.pdb").write_bytes(pdb_text(10).encode("utf-8"))
        cases = [
            ({"source": "browser-local", "relative_path": "broken.pdb"}, 400),
            ({"source": "gateway-workspace", "relative_path": "model.txt"}, 415),
            ({"source": "gateway-workspace", "relative_path": "broken.pdb"}, 422),
            ({"source": "gateway-workspace", "relative_path": "oversize.pdb", "max_bytes": 16}, 413),
        ]
        for overrides, expected in cases:
            with self.subTest(overrides=overrides):
                self.assert_access_error(
                    expected, workspace_root=str(root), allowed_roots=[root], **overrides)

    def test_mmcif_is_accepted_and_identified(self):
        root = self.tmp_path / "workspace"
        root.mkdir()
        content = "data_test\nloop_\n_atom_site.id\n_atom_site.type_symbol\n1 C\n"
        (root / "model.mmcif").write_bytes(content.encode("utf-8"))
        result = self.api.read_authorized_structure(
            source="gateway-workspace", relative_path="model.mmcif",
            workspace_root=str(root), allowed_roots=[root])
        self.assertEqual(result["format"], "mmcif")
        self.assertEqual(result["content"], content)

    def test_viewer_document_artifact_is_integrity_checked(self):
        document = "<!doctype html><title>viewer</title>"
        artifact = self.tmp_path / "viewer-document.json"
        artifact.write_text(json.dumps({
            "schema": 1,
            "sha256": hashlib.sha256(document.encode("utf-8")).hexdigest(),
            "document": document,
        }), encoding="utf-8")
        result = self.api.load_viewer_document_artifact(artifact)
        self.assertEqual(result["document"], document)

        artifact.write_text(json.dumps({
            "schema": 1,
            "sha256": "0" * 64,
            "document": document,
        }), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            self.api.load_viewer_document_artifact(artifact)


if __name__ == "__main__":
    unittest.main()
