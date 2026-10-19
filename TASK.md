# Codex implementation task: Hermes Mol* plugin V1

Implement and exercise a usable first version; do not stop at planning.

## User request

Create the Git project at `D:/hermes-molstar` and have Codex CLI implement the Mol* Hermes plugin discussed in the feasibility assessment.

## V1 behavior

1. Provide a supported Hermes Desktop pane/page and command to open structures. Use a reusable viewer instance rather than eagerly creating one viewer per chat card.
2. Support complete local `.pdb`, `.cif`/`.mmcif` input through file selection (drag-and-drop if straightforward), plus a proposed `::molstar{file="relative/path.pdb"}` chat directive/card for gateway workspace paths. Add a bundled skill/instructions teaching the agent to emit the actual directive. If namespace/manifest contracts require a different exact name, document and test it consistently.
3. Use real bundled Mol* with rotation/zoom/reset and common structure representations/selection via Mol* UI. No external CDN or required network access to view a local structure. Disable irrelevant remote state/density/annotation retrieval by default.
4. Prefer a thin Desktop plugin, isolated prebuilt viewer, and minimal unified-plugin Python API for complete authorized backend reads. Validate the installed Hermes public SDK and actual unified-plugin manifests first. You may simplify architecture when a supported alternative better meets the same requirements; explain the trade-off rather than inventing an API.
5. No Hermes core modifications and no automatic takeover of normal .pdb file clicks. No MD trajectory or scientific analysis scope expansion.

## Acceptance and evidence

- Reproducible dependency lockfile, build, staged installable package/artifacts, user-facing README and dry-run/install instructions. Installation must require an explicit user command; do not deploy into the live Hermes home.
- Test complete file reading beyond 512 KiB, unsupported/malformed/oversize inputs, path traversal/outside-root rejection, and explicit local-versus-backend file handling.
- Test directive attribute validation and message source/schema/nonce validation. Avoid privileged native-bridge access or DOM interception.
- Test viewer lifecycle/resize/cleanup as appropriate. Do not allow hidden previews to accumulate GPU instances.
- Run a real browser smoke using a checked-in, attributed public PDB fixture and mmCIF fixture (small, provenance recorded). With network blocked after local assets load, prove actual structures and a Mol* canvas initialize; record structure/atom counts and a screenshot/artifact. Never fabricate success if WebGL is blocked; state the exact blocker and preserve real outputs.
- Use genuine public fixture data for the rendered smoke; any generated stress/security input must be labelled synthetic test data, never a molecular/scientific result.
- Run the relevant Hermes plugin validation/admission checks if available, or document precisely which checks were not runnable. A local implementation is not proof of catalog approval. Do not evade a validator by obfuscating forbidden code.
- Write `docs/IMPLEMENTATION_REPORT.md`, run final build/tests, inspect git diff/status, and commit locally. The report must separate verified behavior, known limits and remaining real-Electron/live-install verification.

## Useful read-only starting points

- `C:/Users/yoh_s/AppData/Local/hermes/hermes-agent/website/docs/developer-guide/desktop-plugin-sdk.md`
- `.../apps/desktop/src/sdk/index.ts`
- `.../apps/desktop/src/contrib/plugin.ts`
- `.../apps/desktop/src/contrib/runtime-loader.ts`
- `.../apps/desktop/src/components/ui/sandboxed-frame.tsx`
- `.../apps/desktop/src/api/plugins.ts`
- `.../hermes_cli/plugin_validate_desktop.py`
- Official Mol* embedding docs: https://molstar.org/docs/plugin/instance/
- Full feasibility note: `docs/feasibility.md`

Use your own tools, inspect the live contracts, and fix real build/test failures until this V1 is exercised or an honest external blocker is established.
