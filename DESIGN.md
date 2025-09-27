# Staremaster Architecture Overview

This document describes the current architecture of the Staremaster Electron app, focusing on the terminal/Codex flows, state persistence, and alias handling. It is meant to help contributors understand where responsibilities live and how data flows across processes.

## Process Layout

- `src/main/` (Electron main process)
  - Orchestrates projects/worktrees, Codex sessions, terminals, IPC, and persistence.
- `src/renderer/` (renderer process)
  - React UI: project/worktree list, panes (Codex + terminals), status/debug views.
- `src/shared/` (contracts)
  - Shared TypeScript types and IPC channel names.
- `assets/`, `scripts/`, `tests/` — assets, helpers, and test suites.

## Core Concepts

### Worktrees and Aliases

- Each git worktree is identified by a canonical `worktreeId` (a hash of its path).
- The UI also exposes a synthetic “main” tab per project, using an alias id `project-root:<projectId>`.
- Main maps aliases to canonical ids via `resolveCanonicalWorktreeId()` in `src/main/services/WorktreeService.ts`. The renderer now passes `worktree.id` as-is; canonical mapping happens centrally in main.

### App State and Persistence

- `state.json` lives in Electron `userData` and is managed by `ProjectStore`.
  - Projects: `id`, `root`, `name`, timestamps; `defaultWorktreeId`; `codexResumeCommand` for the project-root alias.
  - Worktrees: `id`, `projectId`, `path`, `branch`, `featureName`, status; `codexStatus`, `codexResumeCommand`.
  - Sessions: last known Codex sessions per worktree id.
- Codex logs are written to `<userData>/codex-logs/<worktreeId>.log`.
- Terminal history is persisted to `<userData>/terminal-logs/<worktreeId>[:paneId].jsonl` (see TerminalService), and also kept in memory with limits.

## Core Services

### WorktreeService (`src/main/services/WorktreeService.ts`)

- Manages project discovery and worktree CRUD operations.
- Provides alias→canonical mapping:
  - `resolveCanonicalWorktreeId(worktreeId)` returns canonical for alias ids.
  - `getProjectIdForWorktree(worktreeId)` resolves owning project id.
- Updates `state.json` via `ProjectStore` and emits `state-changed` events used by the renderer.

### TerminalService (`src/main/services/TerminalService.ts`)

- Unified terminal engine for both generic shells and Codex terminals.
- Responsibilities:
  - Spawn pty processes with configurable shells.
  - Track per-worktree (and pane) sessions; emit `terminal-output` and `terminal-exit` events.
  - History buffering with size limits; supports multi-pane (`worktreeId:paneId`).
  - Disk-backed history (JSONL): append on every chunk; lazy load from disk in `getSnapshot`/`getDelta` (both async).
- Disk persistence (current): JSONL grows over time; memory-enforced cropping ensures in-memory tail is bounded. Rotation/deletion is TODO (see Known Gaps).

### CodexSessionManager (`src/main/services/CodexSessionManager.ts`)

- Manages Codex processes (pty under the hood) and owns Codex-specific behavior:
  - Robust resume command detection from stdout: strips ANSI, tolerates varied flags/orders/ids.
  - Filesystem fallback: scans `~/.codex/sessions` (with day offsets, realpath match) and `~/.codex/history.jsonl` (accepts `session_id` or `id`).
  - Persists detected resume commands to both canonical worktree and its `project-root:<id>` alias.
  - Writes Codex logs to `<userData>/codex-logs`.
  - Does not clear persisted resume on non-zero exit (we keep stale candidates and rely on next resume attempt).

## IPC Layer (`src/main/ipc/registerIpcHandlers.ts`)

- Registers all IPC handlers exposed to the renderer via preload.
- Canonical mapping: All incoming `worktreeId`s are resolved centrally (`resolveCanonical(...)`).
- Event mirroring (terminal): For `terminal-output` and `terminal-exit`, payloads are mirrored to both canonical and alias ids via `maybeMirrorPayload`.
- Codex terminal gating: Codex terminal events use a tracked Set of pane keys (`<worktreeId>:<paneId>`). Only keys added via `codexTerminalStart` get codexTerminalOutput/Exit forwarded.
  - Note: Exit payloads don’t carry `paneId`; gating cleanup is partial today (see Known Gaps).
- Codex manager events: Forward Codex stdout/status to the renderer; (see Known Gaps for alias mirroring).
- Diagnostics: Adds `codex:refresh-resume-logs` to rescan stored logs and backfill resume commands.

## Renderer

### App Shell (`src/renderer/App.tsx`)

- Renders the sidebar and main pane layout; manages pane instances and their bootstrapping.
- Debug panel toggle shows per-project Codex data (project-root resume, per-worktree last session id + resume command).
- No alias juggling: passes `worktree.id` through; main resolves canonical ids and mirrors events.

### CodexPane (`src/renderer/components/CodexPane.tsx`)

- Manager-driven Codex UI (not a shell):
  - Start/stop/input via Codex IPC.
  - Hydration: fetch `getCodexLog(worktree.id)` and stream Codex output/status events.
  - Footer shows derived Session ID and resume command; a “Rescan Resume” button calls `refreshCodexResumeFromLogs/Command` and updates local display.

### CodexTerminalShellPane (`src/renderer/components/CodexTerminalShellPane.tsx`)

- Terminal-driven Codex UI using the unified TerminalService:
  - Starts a pty with a Codex startup command (resume or fresh) and sets up snapshot/delta hydration.
  - Footer shows PID, Session ID (derived), and resume command with a “Rescan Resume” button.
  - Input/resize is sent to terminal IPC.

## Resume Handling Summary

- Multiple capture paths:
  - Stdout detection (Codex manager, and opportunistically on terminal output in main).
  - Log file parsing via the codex log directory.
  - `~/.codex` sessions/history scanning.
- Persistence targets (always both):
  - Canonical `worktree.id` entry and `project-root:<projectId>` alias.
- Default worktree: The project’s `defaultWorktreeId` is updated to the latest known resume target when new candidates are found.

## Terminal History and Hydration

- Memory buffer with events and size limit per key (`worktree[:pane]`).
- Disk-backed JSONL tail in `<userData>/terminal-logs`.
- `getSnapshot`/`getDelta` are async and await disk load to ensure first render contains persisted content.

## Preload and Shared API

- `src/main/preload.ts` exposes a `RendererApi` with project/worktree ops, Codex ops, terminal ops, and convenience methods (e.g., resume rescan).
- `src/shared/api.ts` and `src/shared/ipc.ts` define API and channel contracts.

## Known Gaps / TODOs

- Codex event mirroring to alias:
  - Terminal events are mirrored; Codex manager events (codexOutput/codexStatus) should mirror to `project-root:<id>` as well so alias tabs see Codex activity without renderer alias logic.
- Precise Codex gating cleanup:
  - Track `sessionId → paneKey` when a Codex terminal starts to remove the exact gating key on exit (payloads lack `paneId`). Currently, cleanup on exit is conservative and can leave keys behind.
- Disk history rotation and cleanup:
  - JSONL files can grow unbounded. Implement rotation (rewrite to tail) when in-memory size grows past the configured limit and delete `terminal-logs/<key>.jsonl` on `dispose()` and worktree removal.
- Optional: Optimize Codex detection on terminal output by short-circuiting for non-Codex lines.
- Optional: Drop codex-terminal IPC wrappers entirely and use only generic terminal channels in renderer.

## Testing Notes

- Unit tests cover:
  - Robust Codex resume parsing.
  - Renderer behaviour for Codex panes (manager and terminal).
  - Basic terminal hydration and input/resize flows.
- Suggested additional tests:
  - Codex event mirroring to alias for project-root tabs.
  - Codex terminal gating cleanup using a `sessionId → paneKey` mapping.
  - Disk history rotation and cleanup on worktree removal.

---

This document reflects the current implementation. The Known Gaps section is a short backlog to bring behaviour fully in line with VS Code‑style persistence and to further simplify the renderer by centralising alias handling and Codex detection in the main process.
