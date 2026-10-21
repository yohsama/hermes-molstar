# Hermes Mol* Viewer V1

An offline-first Mol* structure viewer plugin for Hermes Desktop. V1 opens complete UTF-8 PDB and mmCIF files in one reusable, sandboxed WebGL viewer without changing Hermes core or taking over normal file previews.

## What V1 provides

- A Hermes Desktop page at `/molstar`, a **Mol* Viewer** sidebar item, and an **Open Mol* Structure Viewer** palette command.
- Browser-local `.pdb`, `.cif`, and `.mmcif` selection plus drag-and-drop. These bytes stay in the Desktop renderer and are never sent to the gateway backend.
- An agent/chat card for an existing file under the active gateway workspace:

  ```text
  ::hermes-molstar{file="results/model.pdb"}
  ```

- Complete backend reads up to 16 MiB. The backend fails closed unless the active workspace and resolved file are beneath an explicitly configured allowed root.
- Bundled `molstar@5.13.1` with sequence, selection/focus, common representations, screenshot controls, rotation/zoom, and camera reset. Remote state, annotation extensions, density streaming, fullscreen, and remote import UI are disabled for V1.
- One lazily created viewer that is reused across file loads and disposed with the frame/page lifecycle.

The exact directive name is `hermes-molstar`, not the early feasibility placeholder `molstar`, so it is namespaced and tested consistently. V1 does not automatically intercept ordinary `.pdb`/`.cif` file clicks.

## Architecture and security boundary

The staged Desktop entry is a small, prebuilt thin shell (16,683 bytes in the current verified stage). It imports only React and the public `@hermes/plugin-sdk`, then registers the route, navigation item, palette action, and transcript directive. It does not inject scripts or import arbitrary runtime files.

Mol* and the viewer bridge are prebuilt into `dashboard/viewer-document.json`. The authenticated shell retrieves this JSON through its own `ctx.rest('/viewer-document')` namespace, enforces a 3 MiB document limit, and verifies the build-time SHA-256 embedded in the Desktop bundle. Only then does it create an absolute `data:text/html` source for `SandboxedFrame`. The frame remains opaque-origin with `sandbox="allow-scripts"`; it receives neither gateway credentials nor filesystem access.

Structure payloads cross the shell/frame boundary through a versioned message schema. Both sides verify `event.source`, an exact per-message schema, payload field/count bounds, a per-load `requestId`, and a random per-frame nonce. The shell accepts a loaded/error acknowledgement only for its current request, so a late result cannot replace newer status. The frame CSP permits only inline/bundled execution, styles, `data:`/`blob:` rendering resources, and `data:` connections needed by Mol*'s bundled optional WASM path. HTTP(S) connections are not permitted in the viewer frame. Mol*'s prebuilt Emscripten code requires `unsafe-eval`; that permission is confined to the opaque guest frame and is absent from the privileged Desktop entry.

Gateway paths must be forward-slash relative paths with no empty, `.`, `..`, drive, absolute, backslash, colon/ADS, reserved-device, trailing-dot/space, or control-character segments. Authorization is bound to held directory objects and the actually opened regular-file handle: Windows uses final-path-by-handle checks, while supported POSIX systems use no-follow directory-relative opens plus a final descriptor path check. Unsupported platforms fail closed. The backend reads that same descriptor at most 16 MiB plus one byte, validates strict UTF-8 and a minimal structure signature, and returns the exact raw byte count, SHA-256, and `truncated: false`; the Desktop recomputes both integrity values.

## Build and verify

Requirements are Node.js 22 or newer, npm, and Python with the Hermes runtime dependencies available. This matches the pinned Mol* dependency's supported baseline. Dependencies are project-local and pinned by `package-lock.json`.

```powershell
cd D:\hermes-molstar
npm ci
npm run build
npm run test:all
npm run test:browser
```

`npm run test:browser` uses pinned `@playwright/cli@0.1.22`, a repository-local npm cache, and a repository-local Playwright browser cache. On its first run it may download that test runner and Chromium; this setup traffic occurs before the tested browser session. The smoke script starts a loopback-only server for the generated harness, loads that page, switches Chromium offline **before** starting the viewer, then loads both checked-in 1CRN fixtures. It writes:

- machine-readable results: `docs/evidence/browser-smoke.json`
- screenshot: `output/playwright/smoke/molstar-offline-smoke.png`

The checked-in JSON evidence is from the fresh round-2 current-build run at `2026-10-21T17:31:44.3192075Z` and pins the exact staged Desktop and viewer-document SHA-256 values it exercised. The report retains the earlier runs as explicitly superseded history. Generated browser output below `output/` is ignored. Fixture provenance and checksums are in `fixtures/README.md`.

Validate the staged package with the installed Hermes CLI:

```powershell
hermes plugins validate D:\hermes-molstar\dist\hermes-molstar --json
```

The installable staging directory is `dist/hermes-molstar/`. Do not install the repository root because it contains tests and build tooling.

## Dry run and explicit installation

This repository does not install or enable itself. Review the exact staged tree first:

```powershell
$stage = (Resolve-Path D:\hermes-molstar\dist\hermes-molstar).Path
hermes plugins validate $stage --json
Get-ChildItem -LiteralPath $stage -Recurse | Select-Object FullName,Length
```

Only after review, a user may explicitly place the staged directory in the selected profile's plugin discovery directory and opt in. Hermes resolves that profile directory as the effective `HERMES_HOME`: an explicit `HERMES_HOME` is honored, `hermes -p <name>` resolves a named profile below the Hermes root's `profiles/<name>`, and an unqualified CLI command may follow the sticky active profile. Do not derive it from `USERPROFILE`.

For a deliberately explicit installation, set `HERMES_HOME` in that shell to the **exact target profile home** first. The following commands are examples and were **not** run during implementation:

```powershell
$stage = (Resolve-Path D:\hermes-molstar\dist\hermes-molstar).Path
if ([string]::IsNullOrWhiteSpace($env:HERMES_HOME)) {
  throw 'Set HERMES_HOME to the exact target profile home before copying.'
}
$profileHome = (Resolve-Path -LiteralPath $env:HERMES_HOME).Path
$target = Join-Path $profileHome 'plugins\hermes-molstar'
if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite existing $target" }
Copy-Item -LiteralPath $stage -Destination $target -Recurse
$profileName = 'default' # replace with the selected named profile ID when applicable
hermes -p $profileName plugins enable hermes-molstar
```

For an existing named profile, the backend opt-in is `hermes -p <name> plugins enable hermes-molstar`; the copied package must be in that same resolved profile home. Keep the explicit selector so a sticky active profile cannot redirect the enable operation. `hermes plugins enable` changes the Python/backend allow-list for the selected profile and takes effect in the next backend session.

The Desktop half has a **separate opt-in**. After an explicit copy, use the installed Hermes version's reload/restart or **Capabilities → Plugins → Rescan** flow so Hermes can synchronize `desktop/plugin.js` into its app-level Desktop plugin area, then enable **Mol* Structure Viewer** in **Capabilities → Plugins**. This plugin declares `defaultEnabled: false`, and the Desktop toggle does not enable or import its Python backend. Both switches default off. No rescan, reload, restart, enable, or installation was performed by this project.

Browser-local structure **bytes** stay in the Desktop renderer and work without `allowed_roots`, but the plugin backend is still required to deliver the integrity-checked controlled viewer document through `ctx.rest('/viewer-document')`. Consequently browser-local viewing needs the Python/backend half enabled and reachable; disabling it prevents the viewer from bootstrapping. The chat directive additionally fails closed until `plugins.entries.hermes-molstar.settings.allowed_roots` contains absolute gateway-side roots, or the plugin host is started with `HERMES_MOLSTAR_ALLOWED_ROOTS` containing platform-path-separated absolute roots. In remote gateway mode these must be paths on the gateway host, not paths from the Desktop machine; the Desktop half must also be installed on the Desktop machine because a remote gateway's filesystem cannot supply it.

## Directive rules

The bundled `molstar-viewer` skill teaches the agent to emit the directive only for a known, existing relative gateway path:

```text
::hermes-molstar{file="relative/path/to/structure.cif"}
```

Absolute paths, URLs, browser-local paths, traversal, backslashes, unknown attributes, unsupported extensions, and invented scientific data are rejected. A directive is an open request, not evidence that a structure rendered; success is reported only by the viewer.

## Current limits

- The current staged build passed a fresh real headless Chromium/WebGL2 offline PDB/mmCIF smoke. This is a standalone browser harness, not the user's running Hermes Electron process; live install, Desktop theme integration, Electron GPU/driver behavior, hot reload, and actual remote gateway operation remain explicit follow-up verification.
- Windows denied unprivileged test symlink creation, so the symlink-escape test is skipped on this host; the resolved-path containment check is still present and the test runs where symlink creation is permitted.
- Mol* exposes screenshot UI, but screenshot export/download behavior was not exercised by the sandboxed browser smoke and remains unverified in Hermes Electron; V1 adds no download privilege or native export bridge.
- V1 supports UTF-8 PDB/mmCIF files up to 16 MiB. It does not support trajectories, density maps, comparative analysis, binary CIF, scientific computation, automatic file-extension takeover, or publication/catalog approval.
- The self-contained viewer depends on Chromium's `DecompressionStream` and a compact data URL. The build targets Chrome 120 or newer and rejects a viewer document above 3 MiB.

See [docs/IMPLEMENTATION_REPORT.md](docs/IMPLEMENTATION_REPORT.md) for inspected contracts, RED/GREEN history, exact final results, artifacts, and remaining verification boundaries. Third-party licensing is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
