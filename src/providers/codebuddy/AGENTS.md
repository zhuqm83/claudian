# CodeBuddy constraints

- CodeBuddy speaks standard ACP over stdio via `codebuddy --acp` (ndJsonStream, protocol version 1). Keep provider code inside this directory; share only protocol mechanics from `src/providers/acp/`.
- On Windows the CLI is a Node script installed by npm (no extension, `#!/usr/bin/env node`). Never launch the `.cmd` shim directly; resolve the script path and let `cliPathRequiresNode` route it through Node.
- Authentication is native. Never call ACP `authenticate` or persist Tencent credentials; the CLI reads its own session store.
- CodeBuddy advertises no `sessionCapabilities.fork`, so forking and rewind stay disabled. Do not claim capabilities the protocol does not expose.
- Permission modes map onto ACP session modes: `normal` → `default`, `yolo` → `bypassPermissions`, `plan` → `plan`. Reasoning uses the `thought_level` config option; model selection uses `session/set_model`.
- Model discovery opens a short-lived ACP process with `--no-session-persistence` and reads `session/new`. Never prompt the discovery session.
- Preserve unknown tool payloads. CodeBuddy reports Claude Code style tool titles (`Read`, `Glob`, ...) plus incremental `rawInput`; keep the first resolved tool name for a call rather than letting descriptive titles override it.
- The system prompt is **not** accepted through ACP `_meta`: `_meta.systemPromptOverride` on `session/new` is silently ignored (verified against CLI 2.158.0). Pass it as a native CLI flag at process launch instead — `--append-system-prompt` for provider-default instructions and `--system-prompt` for an explicit override. Native session reuse must restart the process when those arguments change.
- Model discovery opens a short-lived ACP process with `--no-session-persistence` and reads `session/new`; the flag is honoured in ACP mode. Never prompt the discovery session.
- Verified ACP surface (CLI 2.158.0): `session/set_model`, `session/set_config_option` (`model`, `thought_level`), `session/set_mode` and `session/load` all succeed, and `session/new` emits `config_option_update` before its response.
- CodeBuddy `_meta` fields are namespaced under `codebuddy.ai/*`. Read them for usage and titles only; do not depend on undocumented extension methods.
