---
name: molstar-viewer
description: Open an existing PDB or mmCIF file from the active gateway workspace in the Hermes Mol* viewer.
---

# Hermes Mol* viewer directive

Use this skill only when the user wants to view an existing molecular structure file in Hermes Desktop.

Emit this exact directive as its own paragraph:

```text
::hermes-molstar{file="relative/path/to/structure.pdb"}
```

Rules:

- `file` must be a forward-slash relative path beneath the active gateway workspace.
- Supported suffixes are `.pdb`, `.cif`, and `.mmcif`.
- Never emit an absolute path, `..`, a URL, a browser-local path, or invented structure data.
- Browser-local files are opened by the user with the viewer page's file picker or drag-and-drop; they cannot be addressed by this directive.
- Emit the directive only after a real file path is known. Do not claim it loaded or rendered until the UI reports success.
