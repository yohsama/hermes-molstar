# Repository instructions

## Ownership and scope

This is a new, independent Git project at `D:/hermes-molstar`. Implement the plugin in this repository. Do not modify the installed Hermes core, the running Desktop app, any Hermes profile/config/auth/skills, or unrelated projects. Do not install or enable the plugin in the live user environment. A staged build plus dry-run/explicit installation instructions is the deliverable. Do not publish, push, create a remote repository, restart the user's app, or commit credentials.

Use the existing Codex CLI configuration and authentication. Do not edit global Codex configuration. Do not invent a biological research target or scientific results; fixtures are only test fixtures.

## Sources and contracts

Authoritative Hermes docs: https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk
Installed source, read-only: `C:/Users/yoh_s/AppData/Local/hermes/hermes-agent`.
Read the matching SDK source and plugin/backend manifest examples before choosing public APIs. `docs/feasibility.md` records inspected constraints, not proof that a proposed API exists. Prefer actual public SDK APIs to private native bridge access. Do not patch app DOM or broaden sandbox permissions.

The Desktop entry cannot import arbitrary npm modules or relative JS/CSS at runtime. Prebuild vendor assets. `SandboxedFrame` accepts absolute http(s)/data sources and remains opaque-origin. Do not rely on iframe credentials or same-origin fetch. `ctx.rest` is JSON-oriented. Ordinary text-preview reads truncate at 512 KiB: never use them for complete structure parsing. Do not claim automatic file-extension takeover; it is out of scope for V1.

## Engineering

Follow test-first vertical slices: write a focused failing behavior test, actually run RED, implement minimally, run GREEN, then refactor. Record the commands and real results. Do not replace real integration tests with mocked success messages.

Pin Mol* and include the dependency lockfile. Initial inspected package is `molstar@5.13.1`; verify its actual APIs and required resources. Include required third-party license notices. Keep the Desktop shell thin, isolate the viewer using supported interfaces, and lazy-mount one reusable WebGL viewer. Handle resize, disposal, hot reload and malformed inputs.

Treat directive attributes, file paths and postMessage payloads as untrusted. Enforce allowed roots/explicit file authorization and size limits. Distinguish browser-local selected files from gateway paths, including remote gateway mode. Keep gateway credentials outside the viewer frame. Check event.source, schema and a per-instance nonce; opaque origin alone is not authentication.

## Environment

Windows host. Hermes terminal uses Git Bash, but discover the shell of your own command tool. Pass native programs `D:/...` / `C:/...` paths. `python` is available; do not assume `python3` or `pip`. `uv`, Node and npm may be used after checking them. Use project `.tmp/`/`.cache/` or `C:/Users/yoh_s/AppData/Local/hermes/cache/scratch` for temporary data, never a bare `/tmp` or system temp. Install project dependencies locally, not globally.

## Completion

A scaffold or plan alone is not completion. Build the staged plugin; run unit/security tests and a real browser integration smoke test with actual PDB/mmCIF input and a rendered Mol* canvas if the environment permits. Prove offline behavior with network blocked during load. Clearly distinguish browser smoke coverage from actual Hermes Electron verification.

Write `docs/IMPLEMENTATION_REPORT.md` with exact commands/results, artifact paths and remaining limitations. Make a coherent local implementation commit only after verification; do not amend/rewrite the bootstrap commit. Leave a clean worktree except ignored generated artifacts. Final user-facing report should be concise Chinese.
