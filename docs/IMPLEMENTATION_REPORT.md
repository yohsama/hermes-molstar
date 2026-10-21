# Hermes Mol* V1 implementation report

Date: 2026-10-22 (Asia/Shanghai)  
Repository: `D:/hermes-molstar`  
Staged plugin: `D:/hermes-molstar/dist/hermes-molstar`

## Outcome

V1 is implemented and staged. It provides a supported Hermes Desktop route/sidebar/palette entry, browser-local PDB/mmCIF selection and drag/drop, a validated `::hermes-molstar{file="..."}` transcript card for authorized gateway paths, and one lazy reusable Mol* 5.13.1 viewer in an opaque `SandboxedFrame`.

The original admission failure is fixed at the architectural boundary. `desktop/plugin.js` no longer embeds or creates a script payload. The current reviewed stage contains a **16,683-byte** SDK/React shell. The build-owned viewer document is served as authenticated JSON by the plugin backend, checked against a SHA-256 fixed into the Desktop build and a 3 MiB limit, then used as the guest frame's absolute data URL. The viewer frame contains the prebuilt vendor runtime; credentials remain in the shell. The current Hermes validator passes the Desktop surface and all 15 admission checks; its generic scanner emits one transparent caution for the Linux `/proc/self/fd` final-path-by-handle implementation, recorded below.

No installed Hermes source, live profile, auth/config/skills, running app, or user plugin directory was changed. Nothing was installed, enabled, published, pushed, or restarted.

## Contracts inspected read-only

Before selecting APIs and manifests, the implementation inspected the installed tree at `C:/Users/yoh_s/AppData/Local/hermes/hermes-agent`, including:

- `website/docs/developer-guide/desktop-plugin-sdk.md`
- `apps/desktop/src/sdk/index.ts`
- `apps/desktop/src/contrib/plugin.ts`
- `apps/desktop/src/contrib/runtime-loader.ts`
- `apps/desktop/src/components/ui/sandboxed-frame.tsx`
- `apps/desktop/src/api/plugins.ts`
- `hermes_cli/plugin_validate.py`
- `hermes_cli/plugin_validate_desktop.py`
- `hermes_constants.py`
- `hermes_cli/main.py`, `hermes_cli/profiles.py`, and `hermes_cli/plugins_cmd*.py`
- unified plugin/dashboard manifests and installed examples in the same source tree
- plugin discovery/install documentation in the same source tree

The selected public contracts are `ROUTES_AREA`, `SIDEBAR_NAV_AREA`, `PALETTE_AREA`, `TRANSCRIPT_DIRECTIVE_AREA`, `SandboxedFrame`, `host.navigate`, `host.state.cwd`, and namespaced `ctx.rest`. The Desktop artifact externalizes only `react`, `react/*`, `@hermes/plugin-sdk`, and `@hermes/plugin-sdk/*`. No private native bridge or DOM interception is used.

The inspection also confirmed these constraints, which are reflected in code and tests:

- Desktop source is capped at 16 MiB and may not import arbitrary npm/relative runtime modules.
- `SandboxedFrame` accepts absolute HTTP(S)/data sources and keeps opaque origin.
- normal text preview is truncated at 512 KiB, so gateway structures need a dedicated complete-read route;
- `ctx.rest` is the authenticated JSON-oriented backend channel;
- there is no public V1 file-extension preview takeover API;
- Desktop admission rejects script-injection patterns in the privileged entry.

The installation contract was re-audited during the documentation closeout. Hermes discovers the unified package under the selected profile's effective `HERMES_HOME/plugins/<id>`. `get_hermes_home()` uses a scoped override, then `HERMES_HOME`, then the platform default; the CLI consumes `-p/--profile` before normal imports and maps a named profile to `<Hermes root>/profiles/<name>`. The unified Desktop half is synchronized into the app-level Desktop plugin area on Rescan/restart, but its **Capabilities → Plugins** toggle and the profile's Python `plugins.enabled` allow-list are independent, default-off gates. The README now requires an explicit effective profile home instead of constructing `USERPROFILE/.hermes`, documents both opt-ins, and states that even browser-local viewing needs the backend to deliver the controlled viewer document. Browser-local structure bytes themselves still never go to that backend.

## Implemented vertical slices and RED/GREEN evidence

Work used focused behavior tests before the matching implementation. The most relevant recorded transitions were:

| Slice | RED command and observed result | Minimal GREEN result |
|---|---|---|
| Directive/local validation, frame authentication, lifecycle | `npm test` initially failed because the tested core modules/exports did not exist | validation and source/schema/nonce tests passed; lifecycle creates one viewer, serializes replacement loads, resizes, resets, and disposes once |
| Authorized complete backend read | `python -m unittest -v tests/test_plugin_api.py` first exposed content/newline and error-shape mismatches | complete >512 KiB read, strict formats/UTF-8/size, explicit roots, traversal/outside-root checks passed |
| Async teardown | focused Node lifecycle test failed because a viewer resolving after teardown leaked | factory resolution after teardown now disposes immediately; test passes |
| Raw unsafe segments | traversal suite failed for `./`, nested `./`, and repeated separators after path normalization | raw path segments are rejected before `PurePath` normalization; suite passes |
| Supported thin Desktop boundary | `npm test` on 2026-10-20: 18 discovered, 13 passed and 5 failed; failures included absent `viewer-document.json`, 2,050,538-byte non-thin Desktop artifact, missing `loadViewerDocument`, and old `connect-src 'none'` | build produced 11,941-byte Desktop shell; controlled artifact, SHA/schema/size checks, and `connect-src data:` tests passed |
| Backend viewer artifact integrity | `npm run test:python`: 7 discovered, 5 passed, 1 skipped, 1 errored because `load_viewer_document_artifact` did not exist | artifact JSON/schema/size/SHA/doctype checks implemented; 6 passed and 1 privilege skip |
| Reproducible browser runner | first full `npm run test:browser` rendered both fixtures but failed while writing evidence because Windows PowerShell lacked `Get-FileHash` | runner switched to built-in .NET SHA-256 and passed from a fresh browser session |
| Clean browser console | exploratory real-browser run found one loopback `favicon.ico` 404 | harness now declares a data favicon; final run reports zero console errors and no HTTP(S) resource after harness navigation |

No validator rule was removed or weakened. The compressed Mol* payload was moved out of the privileged renderer because the supported shell/guest boundary requires it, not renamed or obfuscated to evade lint. The controlled viewer document and its digest remain directly inspectable in the staged package.

## Architecture and security controls

### Thin Desktop shell

- Registers the `/molstar` route, nav item, palette command, and namespaced transcript directive through public SDK areas.
- Loads the controlled viewer document through authenticated `ctx.rest('/viewer-document')`.
- Enforces response schema, exact staged SHA-256, strict UTF-8 byte count, 3 MiB cap, and HTML doctype before creating the data URL.
- Reads browser-local `File.arrayBuffer()` directly; it does not send browser-local bytes or paths to the gateway.
- Sends structure text to the frame only after extension, size, UTF-8, and minimal PDB/mmCIF checks.

### Opaque viewer frame

- Uses only `sandbox="allow-scripts"`; there is no `allow-same-origin`.
- Verifies parent `event.source`, schema, per-instance 128-bit random nonce, message type, format, name, and payload size.
- Contains the prebuilt Mol* 5.13.1 JS/CSS plus the small bridge; no CDN is required.
- CSP denies all by default and has no HTTP(S) connect source. `connect-src data:` is limited to Mol*'s bundled optional data-WASM path. `unsafe-eval` is confined here because the upstream prebuilt Emscripten helper needs it.
- Disables extensions, custom remote formats, remote state, volume streaming, remote import UI, fullscreen, animation, and trajectory controls for V1.

### Gateway backend

- Requires `source='gateway-workspace'` and an active absolute workspace path.
- Defaults to no authorized roots. Roots are explicit plugin settings or `HERMES_MOLSTAR_ALLOWED_ROOTS` on the gateway host.
- Rejects empty/dot/dot-dot segments, repeated separators, backslashes, absolute/drive/nested-drive paths, raw control characters, colons/ADS, Windows reserved names, trailing dots/spaces, unsupported extensions, directories, invalid UTF-8, malformed structures, and >16 MiB content.
- Opens and holds allowed-root and workspace directory objects, opens the candidate with no-follow directory-relative traversal on POSIX, verifies regular-file type and final path from the **opened handle**, rechecks root/workspace/target containment after the open, and reads from that same descriptor. Windows uses `GetFinalPathNameByHandleW`; Linux uses `/proc/self/fd/<fd>`; macOS uses `F_GETPATH`; unsupported platforms fail closed.
- Reads at most limit + 1 byte and returns the raw byte count, SHA-256, and `truncated: false`; the Desktop recomputes UTF-8 byte length and SHA-256 before accepting the envelope.
- Uses neither ordinary 512 KiB preview reads nor iframe credentials.

### Lazy mount and teardown audit

This closeout compared the implementation with both the installed Hermes lifecycle and the existing tests:

- Hermes `ChatRoutesSurface` places each `ROUTES_AREA` contribution in a React Router `<Route>` and invokes its `render` callback through `ContribRender` only for the matched route. Registering the plugin therefore does not mount `MolstarPage`.
- `MolstarPage` fetches and validates the controlled viewer document only after `/molstar` mounts, then mounts `SandboxedFrame`. Inside the frame, `createViewerLifecycle(() => createMolstarAdapter(...))` does not call Mol* `Viewer.create` until the first validated `molstar.load`, so WebGL creation is genuinely lazy rather than merely hidden.
- Route unmount runs `ViewerFrame`'s effect cleanup, sends `molstar.dispose`, and removes the parent message listener. The guest also disposes on `pagehide` or `beforeunload`, disconnects its `ResizeObserver`, removes its message listener, and makes disposal idempotent.
- Hermes hot reload calls `unloadRuntimePlugin` before re-registration. `ctx.registerMany` and `ctx.onDispose` are tracked by the runtime loader, so contribution removal unmounts a matched page and the plugin's style node is removed.
- `tests/frame-core.test.mjs` proves zero viewer creations before first load, one reused instance, serialized replacement loads, resize/reset forwarding, idempotent disposal, rejection after disposal, and disposal when an asynchronous factory resolves after teardown. `tests/molstar-adapter.test.mjs` additionally controls delayed clear/load promises and proves disposal cannot resume work on a destroyed Mol* instance. `tests/shell-core.test.mjs` proves scoped one-shot request consumption and controlled-document/integrity loading. `tests/plugin-component.test.mjs` builds the real React source and proves click-time scope capture, cross-scope discard, context-change invalidation, and stale frame-reply rejection.

These are source and unit-test findings. A real Hermes Electron route transition or hot-reload session was not run, so Electron navigation/HMR behavior remains a stated integration limit rather than a claimed test result.

## Final commands and real results

### Build and unit/security tests

Final commands (run from `D:/hermes-molstar`):

```powershell
npm run build
npm run test:all
```

Recorded result before the documentation-only pass:

- build succeeded; `dist/hermes-molstar/desktop/plugin.js` = **11,941 bytes** (Hermes cap 16,777,216 bytes);
- Node TAP: **22 tests, 22 passed, 0 failed, 0 skipped**;
- Python unittest: **7 discovered, 6 passed, 0 failed, 1 skipped**;
- skipped test: Windows returned `WinError 1314` while creating a symlink for the escape test. This is a host privilege limitation, not a mocked pass.

The final post-documentation rerun is recorded below in the “Final rerun” section.

### Superseded real offline browser smoke — generated at 2026-10-20T04:12:32Z

Command:

```powershell
npm run test:browser
```

Recorded result from the earlier implementation run: exit code 0. The script built the package, started a loopback-only static harness, opened Chromium on `about:blank`, loaded only the harness while online, captured a fresh element snapshot, set the browser network state offline, and only then selected the PDB (which starts the viewer). It reused the same frame for mmCIF.

That run originally wrote `docs/evidence/browser-smoke.json` and `output/playwright/smoke/molstar-offline-smoke.png`; both paths have since been replaced by the fresh current-build run documented below. Its measured record is retained here rather than silently relabelled as current evidence.

Observed facts:

- `@playwright/cli` 0.1.22; Chromium **155.0.8059.40**;
- `viewerStartedOnline: false`; final `navigator.onLine: false`;
- HTTP(S) resources after harness navigation: **0**;
- PDB `1CRN.pdb`: **327 atoms, 1 model, 1 structure, 1 canvas**;
- mmCIF `1CRN.cif`: **327 atoms, 1 model, 1 structure, 1 canvas**;
- lifecycle: **2 loads**, events `ready, loaded, loaded`, **1 iframe**;
- canvas: **964 × 564**, client **964 × 564**, `WebGL2: true`;
- browser console errors: **0**;
- request log: only `GET http://127.0.0.1:4173/ => 200`, performed before offline mode;
- screenshot was visually inspected: the 1CRN cartoon, sequence strip, axes, and Mol* structure controls are rendered.

Fixture SHA-256 values:

- `fixtures/1CRN.pdb`: `42199a30a0701864a2a5cc76cd7f35cc544cd0e65fbcf63e03c166543249b811`
- `fixtures/1CRN.cif`: `23787562c427d7c1abe5420e86d5f1d0a6c7007dec1e8ce85645a6d69c32e8ba`

Both are attributed public RCSB PDB 1CRN downloads; provenance is recorded in `fixtures/README.md`. Counts are parser/render smoke observations, not a new scientific result.

This remediation changed `src/plugin.jsx`, `src/viewer-frame-entry.mjs`, `src/frame-core.mjs`, `src/molstar-adapter.mjs`, and the generated harness after that run. The `04:12:32Z` result is therefore **superseded** and is not proof for the current stage.

### Fresh current-build real offline browser smoke

After the automatic approval infrastructure became available, the exact repository command was run normally under the unchanged workspace-write sandbox:

```powershell
npm run test:browser
```

The first fresh run exited 0 at `2026-10-20T10:02:10.9741325Z` and exercised the current request-ID protocol, but its evidence schema did not yet contain the requested build-artifact hashes. A focused regression then failed 0/1 because `artifacts.desktopPlugin` was absent. The test runner—not the viewer protocol—was minimally extended to record the exact stage file sizes and SHA-256 values, and the same real browser command was rerun. The regression then passed 1/1.

Final machine evidence: `docs/evidence/browser-smoke.json`  
Final screenshot: `output/playwright/smoke/molstar-offline-smoke.png`  
Final `generatedAt`: **`2026-10-20T10:04:01.5862120Z`**  
Scope recorded by the evidence: **`Chromium browser harness; not Hermes Electron`**

The final run exited 0 and measured:

- `@playwright/cli` **0.1.22**, Chromium **155.0.8059.40**;
- network switched offline before the viewer started: `setBeforeViewerStart: true`;
- `viewerStartedOnline: false`, `navigatorOnlineAtEnd: false`;
- HTTP(S) resource entries after harness navigation: **0**;
- PDB `1CRN.pdb`: request ID `35eb46f0-b8bc-40f2-a28a-1b90bc0d58aa`, **327 atoms, 1 model, 1 structure, 1 canvas**;
- mmCIF `1CRN.cif`: request ID `c5c314f0-9e46-47fd-a8df-4ac726906db5`, **327 atoms, 1 model, 1 structure, 1 canvas**;
- lifecycle: **2 loads**, exactly **1** `molstar.ready`, then 2 `molstar.loaded` events, **1 iframe**;
- canvas backing/client size: **964 × 564**, `WebGL2: true`;
- browser console errors: **0**;
- request log: only `GET http://127.0.0.1:4173/ => 200`, made to load the harness before offline viewer startup.

The evidence fixture hashes were independently compared with the current files:

- `fixtures/1CRN.pdb`: `42199a30a0701864a2a5cc76cd7f35cc544cd0e65fbcf63e03c166543249b811`;
- `fixtures/1CRN.cif`: `23787562c427d7c1abe5420e86d5f1d0a6c7007dec1e8ce85645a6d69c32e8ba`.

The evidence is pinned to the exact built artifacts exercised by Chromium:

- `dist/hermes-molstar/desktop/plugin.js`: **15,498 bytes**, SHA-256 `5848f44091751fe625c089ba690b6d58e9e1caf01aa0e25a0c310835ff3643dc`;
- `dist/hermes-molstar/dashboard/viewer-document.json`: **2,041,227 bytes**, SHA-256 `241a5fad9edde4ad454ff281dfa1aad80c320d165461e1898762e7b8de81dbba`.

The final screenshot was inspected at its original resolution. It shows a green 1CRN cartoon/ribbon protein representation centered on the Mol* canvas, the three-axis orientation marker at bottom left, the full residue sequence strip across the top, and the right-side Mol* **Structure Tools**, **Measurements**, **Quick Styles**, **Procedural Annotation**, and **Components** UI. The harness status line reports the mmCIF result and its current request ID. No error overlay or failed-load message is visible.

### Earlier Hermes admission validation (superseded by the current review-fix result below)

The official installed CLI code was run against the stage with an isolated `HERMES_HOME` under this repository:

```powershell
$env:HERMES_HOME='D:/hermes-molstar/.tmp/hermes-home'
$env:PYTHONPATH='C:/Users/yoh_s/AppData/Local/hermes/hermes-agent'
python -m hermes_cli.main plugins validate D:/hermes-molstar/dist/hermes-molstar --json
```

JSON result: `ok: true`, **15/15 checks passed**, warnings array empty. In particular:

- capability probe: `register() ran in isolation`;
- security scan: `safe`;
- no core override: `no runtime rebinds of Hermes core`;
- desktop surface: `stays inside the plugin SDK surface`;
- isolation verdict: `host`, `host_ready: true`; the dashboard API is served through the buffered plugin host.

The launcher also printed a separate pre-command warning that a source-update completion could not replace the read-only installed Hermes Python executable (`WinError 5`) and continued with previous dependencies. The validation itself exited successfully and returned the result above. The parent later independently confirmed installed `validate_plugin_dir` at **15/15** with zero warnings. A subsequent failed invocation never reached validation: the sandbox setup helper could not update the ACL of repository `.tmp` after its TEMP/TMP/TMPDIR variables had been redirected there (recorded in `C:/Users/yoh_s/.codex/.sandbox/sandbox.2026-10-20.log`, lines 624–627). This continuation used the restored original approved Hermes scratch environment, verified ordinary sandbox commands worked, did not alter ACLs, and did not retry the review-blocked browser command. No installed file was changed.

## Staged artifacts

- `dist/hermes-molstar/plugin.yaml` — unified plugin manifest
- `dist/hermes-molstar/__init__.py` — no-tool registration stub
- `dist/hermes-molstar/desktop/plugin.js` — thin Desktop entry
- `dist/hermes-molstar/dashboard/manifest.json` and `plugin_api.py` — backend route
- `dist/hermes-molstar/dashboard/viewer-document.json` — integrity-addressed self-contained guest document
- `dist/hermes-molstar/skills/molstar-viewer/SKILL.md` — directive instructions
- `dist/hermes-molstar/BUILD_MANIFEST.json` — version, sizes, transport, and viewer SHA
- `dist/hermes-molstar/THIRD_PARTY_NOTICES.md`
- `dist/hermes-molstar/third_party/molstar-LICENSE.txt`

The build deletes and recreates only repository `dist/`. It has no install step and does not write to Hermes home.

## Known limits and remaining verification

1. **Hermes Electron not exercised.** The current stage passed a fresh real Chromium/WebGL2 offline browser harness, but this does not test the exact running Hermes Electron version, Electron hardware GPU/driver path, theme integration, hot reload, or Desktop navigation. No live plugin was installed because that was explicitly forbidden.
2. **Remote gateway not exercised end to end.** Path authorization and JSON contracts are tested locally. A future explicit installation must test a real remote gateway with roots configured on the gateway host.
3. **Windows symlink privilege.** The symlink escape test skipped because this account cannot create a test symlink. Resolved containment is implemented, but this host did not execute the positive symlink-creation branch.
4. **Formats and size.** V1 is strict UTF-8 PDB/mmCIF only, maximum 16 MiB. There is no BCIF, trajectory, density, multi-structure comparison, or scientific analysis.
5. **Viewer delivery.** The compact document uses `DecompressionStream` and targets Chrome 120+. It remains under the tested data-navigation limit and is capped at 3 MiB, but Electron-specific URL limits still need live verification.
6. **No automatic takeover.** Ordinary Hermes file previews remain unchanged because the inspected public SDK has no file-preview provider registration.
7. **Not catalog approval.** Local admission success is not publication, review, signing, or catalog acceptance. Nothing was published or pushed.
8. **No implementation commit in this run.** The latest parent instruction explicitly requested leaving the code ready for independent review without committing. `HEAD` therefore remains the bootstrap commit; this overrides the earlier TASK.md commit request.

## Documentation closeout verification

The parent independently verified the frozen implementation before this documentation pass:

- `npm run build`: passed;
- Node: **22/22 passed**;
- Python: **6 passed, 1 skipped, 0 failed** (the skip is the Windows symlink-privilege case);
- installed Hermes `validate_plugin_dir`: **15/15 passed**, zero warnings;
- `git diff --check`: exit 0.

After README/report correction, this continuation rechecks the staged documentation and relevant non-browser tests with:

```powershell
npm run build
npm run test:all
git diff --check
git status --short
```

Closeout result:

- `npm run build`: exit 0; Desktop artifact **11,941 bytes**, viewer document **2,039,956 bytes** with SHA-256 `1142484ce198940f6c4c2c85a22e799161707e3e7c23518f8519f66e8c35e712`;
- `npm run test:all`: exit 0; Node **22/22 passed, 0 failed, 0 skipped**; Python **7 discovered, 6 passed, 0 failed, 1 skipped** (`WinError 1314` symlink privilege);
- fresh browser smoke: **not run in this continuation**, as explained above;
- installed `validate_plugin_dir`: parent-confirmed **15/15 passed**, zero warnings, security safe, Desktop surface allowed; not rerun after this documentation-only change;
- `git diff --check`: exit 0; only Git's Windows LF-to-CRLF notices were printed;
- `git status --short`: implementation files are modified/untracked as expected because the parent requested no implementation commit; `HEAD` remains `305ce29 chore: bootstrap Hermes Molstar plugin project`.

There is no current blocker for normal sandboxed documentation/build/unit-test work. The only bounded item not rerun is the explicitly prohibited browser invocation described above. No ACL was changed, no sandbox/review control was bypassed, and the prior browser command was not retried. No claim of a clean worktree is made because the implementation is intentionally uncommitted. Repository-local caches, `dist/`, test temporaries, and Playwright session internals are ignored; the prior screenshot and machine-readable evidence are retained for review. No implementation commit was created while the independent reviewer examines the frozen source snapshot.

## Independent review round 1 remediation (current result)

The frozen-snapshot review returned `passed: false`. This round changed only R1–R6 and directly related validation gaps. The following are the actual focused RED/GREEN transitions; no failing assertion was deleted, skipped, or weakened.

| Finding | Focused RED actually observed | Focused GREEN actually observed |
|---|---|---|
| R1 opened-handle authorization | `python -m unittest -v tests.test_plugin_api.PluginApiTests.test_rejects_traversal_and_absolute_paths tests.test_plugin_api.PluginApiTests.test_authorization_is_bound_to_the_actually_opened_file_handle` reached 2 tests and exposed 8 failing unsafe-path/handle-race subcases. The later deterministic ancestor-swap test, run with the installed Hermes venv, failed 1/1 because no `StructureAccessError` was raised. | The four-test handle/read/symlink focus ran 4 tests: 3 passed and 1 skipped only for Windows `WinError 1314`. Both deterministic races now pass: a substituted opened file is rejected and a workspace path-component swap between directory authorization and file open is rejected. |
| R2 scoped one-shot requests/context teardown | `node --test --test-name-pattern="open request store" tests/shell-core.test.mjs` first failed 0/1 with the old unscoped API. A later active-mismatched-subscriber regression then ran 2 tests with 1 pass/1 fail, proving the request could still be retained and replayed after switching back. `node --test tests/plugin-component.test.mjs` failed 0/4 because the real components were not exported/testable and still used the old store/protocol. | Store focus now passes 2/2, including permanent discard at publish time when an active different scope refuses the request. Real-component focus passes 4/4: click-time connection/profile/cwd capture, different-scope discard, context-change invalidation, and current request use. Unmount/context cleanup increments the generation and clears the active request. |
| R3 request identity through frame | The same component RED was 0/4; additionally `node --test --test-name-pattern="browser smoke harness" tests/build-artifact.test.mjs` failed 0/1 because the generated harness had no `requestId`. | Components passed 4/4. `requestId` is required in shell→frame load and frame→shell loaded/error schemas; stale replies are ignored. The generated-harness focus passed 1/1 after adding matching request IDs. |
| R4 disposal during awaited work | `node --test --test-name-pattern="disposal during delayed clear|in-flight structure load|controlled load" tests/molstar-adapter.test.mjs tests/frame-core.test.mjs` failed 0/3: disposal could destroy too early and controlled load could resolve after teardown. | The same command passed 3/3. The adapter rechecks liveness after every await, prevents load-after-clear, and defers final Mol* destruction until an already-running load settles; the lifecycle rejects a load that settles after disposal. |
| R5 envelope integrity | `node --test --test-name-pattern="gateway loading" tests/shell-core.test.mjs` ran 3 tests: 2 passed, 1 failed because wrong size/hash was accepted. | The same focus passed 3/3 after correcting success fixtures and comparing both backend `size` and SHA-256 with the actual UTF-8 bytes. |
| R6 install/enable contract | The earlier documentation closeout had already removed the reviewed hardcoded path. A new regression test initially ran 6 tests with 5 passed/1 failed because the required browser-local backend dependency wording was not exact. | `node --test tests/build-artifact.test.mjs` passed 6/6 after the README explicitly stated profile-aware `HERMES_HOME`, profile-explicit backend enable, independent Desktop opt-in, both switches default off, backend viewer-document delivery for local viewing, and the remote Desktop-half requirement. |
| Related path/frame schemas | `node --test tests/desktop-core.test.mjs tests/frame-core.test.mjs` ran 10 tests: 7 passed, 3 failed for raw controls/ADS/nested drives and permissive per-type frame replies. | The same command passed 10/10 after validating raw path input before trimming and enforcing exact per-type fields, request IDs, formats, messages, and bounded integer statistics. |

### Current implementation details by finding

- **R1:** authorization is based on held directory objects and the file descriptor actually read, not a previously checked pathname. The final path, containment, `fstat` regular-file type, requested/final format, and size are checked before reading the same descriptor. POSIX opens each component relative to the held workspace with `O_NOFOLLOW`; unsupported handle/directory facilities return 503.
- **R2:** `DirectiveCard` captures exactly `{connectionId, profile, workspaceRoot}` at click time and publishes a cryptographically random request ID. `createOpenRequestStore` consumes one request once; the first subscription attempt discards a scope mismatch rather than replaying it later. `MolstarPage` subscribes with the current public host scope and invalidates pending async work on scope change and unmount.
- **R3:** a new browser or gateway read immediately becomes the only current request. Load, loaded, and error messages carry that ID; an old A acknowledgement cannot overwrite newer B progress or error state. Exact frame reply schemas reject empty or over-broad payloads.
- **R4:** the adapter cannot call `loadStructureFromData` after disposal during `clear()`, and an in-flight load owns the viewer until it settles. No resize/reset/load proceeds after disposal.
- **R5:** backend `size` remains `len(raw)` and SHA-256 is over those raw bytes. Because accepted content is strict UTF-8, the Desktop's `TextEncoder` produces the same bytes; both size and digest must match before frame delivery.
- **R6:** README keeps the selected profile's effective `HERMES_HOME`, `hermes -p <profile>`, backend `plugins.enabled`, and Desktop **Capabilities → Plugins** as separate contracts. Browser-local structure bytes never reach the backend, but the backend is still needed to deliver `/viewer-document`.

### Current final commands and results

The process environment retained the approved scratch values throughout: `TEMP`, `TMP`, and `TMPDIR` were all `C:/Users/yoh_s/AppData/Local/hermes/cache/scratch` (Windows separators in the actual output). The first `python` on this shell's inherited `PATH` points at a broken Hermes environment, so Python test commands prepended only the installed Hermes project's existing venv to `PATH`; no interpreter, global config, or installed file was changed.

```powershell
npm run build
npm test
$env:PATH='C:\Users\yoh_s\AppData\Local\hermes\hermes-agent\venv\Scripts;' + $env:PATH
npm run test:python
npm run test:all
```

Results for the current source/stage:

- `npm run build`: exit 0; `desktop/plugin.js` **15,498 bytes**.
- standalone final `npm test`: **34 passed, 0 failed, 0 skipped**.
- standalone `npm run test:python`: **9 discovered, 8 passed, 0 failed, 1 skipped**; the sole skip is unprivileged Windows symlink creation (`WinError 1314`).
- `npm run test:all`: exit 0; Node **34 passed, 0 failed, 0 skipped**; Python **9 discovered, 8 passed, 0 failed, 1 skipped**.
- React component tests emit `react-test-renderer` deprecation and a few `act(...)` diagnostic warnings, but all four behavior tests pass; no warning was converted to a skip.

The final installed-source admission call was read-only against Hermes and used an isolated repository-local `HERMES_HOME`:

```powershell
$env:HERMES_HOME='D:/hermes-molstar/.tmp/hermes-home-round1-final'
$env:PYTHONPATH='C:/Users/yoh_s/AppData/Local/hermes/hermes-agent'
& 'C:/Users/yoh_s/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe' -c "import json; from pathlib import Path; from hermes_cli.plugin_validate import validate_plugin_dir; report=validate_plugin_dir(Path(r'D:/hermes-molstar/dist/hermes-molstar')); print(json.dumps(report.to_dict(), indent=2)); raise SystemExit(report.exit_code)"
```

Result: exit 0, `ok: true`, **15/15 checks passed**, isolation `host_ready: true`, Desktop surface allowed, and **1 warning**. The warning is `security scan caution: proc_access (plugin_api.py:156)`, caused by the explicit Linux `/proc/self/fd/<fd>` final-path check required to bind authorization to the opened descriptor. It is not hidden or obfuscated; on this Windows run that branch is not executed. This differs from the earlier pre-R1 validator result, which had zero warnings before the safe POSIX handle check existed.

Final staged artifact measurements:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `dist/hermes-molstar/desktop/plugin.js` | 15,498 | `5848f44091751fe625c089ba690b6d58e9e1caf01aa0e25a0c310835ff3643dc` |
| `dist/hermes-molstar/dashboard/viewer-document.json` | 2,041,227 | `241a5fad9edde4ad454ff281dfa1aad80c320d165461e1898762e7b8de81dbba` |
| embedded viewer document | 2,041,104 | `9357a4f6829a321f987bac56eb5967ae65c7cfaca945bb586c5af5f07b8c5f2a` |
| `dist/hermes-molstar/BUILD_MANIFEST.json` | 395 | `5bfe4a13877c43b2e306b715658fd3bae60366781bfd96ad366a8239451d13f1` |

`git diff --check` is rerun after this report and recorded in `.codex/runs/fix-round1-summary.md`. The current stage now has fresh, artifact-pinned Chromium browser evidence, while Hermes Electron remains explicitly untested. No live install, enable, publish, push, restart, core/profile/global-config edit, ACL change, approval bypass, or implementation commit occurred. `HEAD` remains `305ce29`; the coordinator owns the next independent review and commit gate.

## Independent review round 2 remediation (current final result)

Round 2 was limited to S1/S2/L1/L2 and the directly requested Node/scope/UTF-8/documentation gaps. The implementation stayed on the public SDK fields confirmed in the installed source: `host.state.connectionId` is `null | string`, `host.state.cwd` may be `''`, `host.state.profile` is the active gateway profile, and plugin backend calls remain namespace-relative `ctx.rest`. No private bridge was added.

### Actual RED/GREEN evidence

| Finding | RED actually run and observed | GREEN actually run and observed |
|---|---|---|
| S1 fixed authorization anchors | `python -m unittest -v tests.test_plugin_api.PluginApiTests.test_opened_directory_handles_cannot_redefine_authorization_anchors tests.test_plugin_api.PluginApiTests.test_candidate_open_flags_are_nonblocking_only_on_posix` ran 2 tests: the real-handle anchor-redirection regression **failed** because no 403 was raised, and the flag test **errored** because `_candidate_open_flags` did not exist. | The focused handle/flag/workspace/file/FIFO command ran 5 tests: **4 passed, 0 failed, 1 skipped** (the real FIFO case is POSIX-only). Opened roots/workspaces are now compared with the pre-open approved canonical paths, bound to stable handle identities, reverified before the read, and never redefined from arbitrary `final_path()` values. Windows additionally rechecks the handle's final path; POSIX keeps safe access bound to the original directory inode across rename. |
| S2 nonblocking special-file rejection | The same RED exposed the absent platform-specific candidate flag. The pre-fix source used blocking POSIX `O_RDONLY` before `fstat`, so a FIFO with no writer could hang. | POSIX candidate opens add `O_NONBLOCK`, then immediately use `fstat` to reject anything non-regular. The Windows decision test passed; `test_fifo_candidate_is_rejected_without_blocking` is collected but honestly skipped on Windows and remains the real bounded integration test on POSIX. The workspace-swap regression now expects safe original-directory access on POSIX and rejection on Windows instead of modeling the platforms identically. |
| L1 nullable/detached SDK scope | `node --test --test-name-pattern="complete live gateway scope|temporarily invalid|StrictMode effect replay" tests/plugin-component.test.mjs` ran 3 tests and **all 3 failed**: the directive button stayed enabled, detached-page mounting threw `invalid open request subscription`, and StrictMode delivered zero frame loads. | The same command passed **3/3**. Detached/Home transition state never subscribes with an invalid scope, pending gateway requests are discarded, viewer-document bootstrap/local selection still mount, and the directive button is disabled with a visible gateway/workspace explanation. Click time is revalidated so a transition cannot throw or navigate. |
| L2 StrictMode one-shot claim | The same component RED observed one request consumed during the first effect setup and no `molstar.load` after the replay. | Request claiming is separate from async processing. Component state retains the claimed request across replay, while a request-ID/scope-keyed promise ref ensures exactly one `/structure` read; the replay attaches to that task and exactly one current request reaches `molstar.load`. Scope change/unmount still invalidates generations and stale replies. |
| Scope-switch provenance | `node --test --test-name-pattern="remounts the frame" tests/plugin-component.test.mjs` initially failed **0/1** because switching workspace cleared state but did not dispose/remount the old guest. | The same test passed **1/1** after a scope epoch remounted the frame, sent `molstar.dispose`, cleared prior gateway metadata, and displayed current-context guidance. Browser-local structures are not silently relabelled as gateway content. |
| Node baseline | `node --test --test-name-pattern="lockfile pins" tests/build-artifact.test.mjs` failed **0/1** (`'>=20' !== '>=22'`). | The same test passed **1/1** after `package.json`, lock metadata, and README were aligned to Node.js 22 or newer. |
| UTF-8 edge coverage | New non-ASCII/CRLF exact-byte/hash and invalid-UTF-8 tests were run directly. They passed on first run because the existing strict decoder and raw-byte/`TextEncoder` integrity implementation already had the required behavior; no production logic was changed merely to manufacture a RED. | Node **2/2** and Python **1/1** passed. Backend CRLF/non-ASCII content preserves exact bytes and SHA-256; browser-local and backend invalid UTF-8 are rejected. |

The React tests continue to print the upstream `react-test-renderer is deprecated` notice. Test-triggered state and frame events were moved into `act(...)`; the final suite prints no React missing-`act` diagnostic. No behavior assertion was removed or relaxed.

### Fresh real browser evidence for the exact round-2 stage

The normal approval path accepted and executed:

```powershell
npm run test:browser
```

Exit code: **0**. The script rebuilt the 16,683-byte shell, drove Chromium/WebGL2 through the current request-ID frame protocol, set the browser offline before viewer startup, loaded the actual checked-in PDB and mmCIF through the browser file input, and wrote new evidence rather than editing old hashes.

- evidence: `docs/evidence/browser-smoke.json`;
- screenshot: `output/playwright/smoke/molstar-offline-smoke.png`;
- `generatedAt`: **`2026-10-21T17:31:44.3192075Z`** (2026-10-22 Asia/Shanghai);
- scope: **`Chromium browser harness; not Hermes Electron`**;
- offline before startup: true; `viewerStartedOnline: false`; `navigatorOnlineAtEnd: false`;
- HTTP(S) resources after harness navigation: **0**; browser console errors: **0**;
- lifecycle: **2 loads**, exactly **1** `molstar.ready`, 2 `molstar.loaded`, **1 iframe**;
- PDB and mmCIF: **327 atoms, 1 model, 1 structure, 1 canvas each**;
- WebGL2 canvas: **964 × 564**, nonzero client/backing dimensions;
- fixture SHA-256 values independently matched: PDB `42199a30a0701864a2a5cc76cd7f35cc544cd0e65fbcf63e03c166543249b811`, mmCIF `23787562c427d7c1abe5420e86d5f1d0a6c7007dec1e8ce85645a6d69c32e8ba`.

Artifact pins recorded by the real run and independently rechecked:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `dist/hermes-molstar/desktop/plugin.js` | 16,683 | `f95ea8a3514a98189b946f90e18a8ccf0f371ac0707708cfbff96eddb23b82e1` |
| `dist/hermes-molstar/dashboard/viewer-document.json` | 2,041,227 | `241a5fad9edde4ad454ff281dfa1aad80c320d165461e1898762e7b8de81dbba` |
| embedded viewer document | 2,041,104 | `9357a4f6829a321f987bac56eb5967ae65c7cfaca945bb586c5af5f07b8c5f2a` |
| `dist/hermes-molstar/BUILD_MANIFEST.json` | 395 | `bd1b1d66f3007697f824a67c797f8b1e8f9ff2d3d17a4e2ad82ea1fc276bd94d` |

The screenshot was opened at original resolution and visually inspected. It renders a centered green 1CRN cartoon with visible helices, beta arrows and loops; the XYZ axis marker is present at lower left, the residue sequence strip spans the top, and the right-hand Mol* Structure Tools, Measurements, Quick Styles, Procedural Animation, and Components UI is visible. The harness displays the current mmCIF 327-atom reply. There is no error overlay, blank canvas, or resource-failure message. The previous `2026-10-20T10:04:01.5862120Z` evidence is superseded by this run, just as the earlier `04:12:32Z` record was; neither is relabelled as current.

### Final round-2 commands and results

The final acceptance commands were run separately so an aggregate command could not hide an intermediate failure:

```powershell
npm run build
npm test
$env:PATH='C:\Users\yoh_s\AppData\Local\hermes\hermes-agent\venv\Scripts;' + $env:PATH
npm run test:python
npm run test:all
git diff --check
```

Measured results:

- build: exit 0, Desktop bundle **16,683 bytes**;
- Node: **40 passed, 0 failed, 0 skipped**;
- Python: **13 discovered, 11 passed, 0 failed, 2 skipped**;
- Python skips: real POSIX FIFO test (Windows host) and symlink escape creation (`WinError 1314`, no privilege);
- aggregate `npm run test:all`: exit 0 with the same **40/40 Node** and **11 pass/2 skip Python** counts;
- isolated installed-Hermes `validate_plugin_dir`: exit 0, `ok: true`, **15/15 checks passed**, isolation `host`, `host_ready: true`, Desktop surface allowed, **1 warning**: `security scan caution: proc_access (plugin_api.py:204)` for the explicit Linux opened-descriptor path check;
- `git diff --check`: exit 0 after the reports; no whitespace errors (only Git's informational LF→CRLF working-copy notices).

### Remaining boundaries after round 2

- The fresh proof is a real Chromium browser harness, not Hermes Electron. Live Electron navigation, StrictMode/HMR in the installed app, theme integration, Electron GPU/driver behavior, live remote gateway routing, and live install/enable remain unexercised.
- Real FIFO behavior is covered by a platform-gated POSIX test but could not run on Windows. Windows symlink creation was also unavailable without privilege. No ACL or privilege was changed to force either branch.
- Mol* exposes screenshot UI, but export/download behavior is not exercised by this sandboxed smoke and is unverified in Hermes Electron. No download permission or native export bridge was added.
- No plugin was installed/enabled, no Hermes core/profile/auth/global config was edited, and nothing was committed, pushed, published, or restarted. `HEAD` remains `305ce29`; the coordinator owns the final review and commit/deployment gate.
