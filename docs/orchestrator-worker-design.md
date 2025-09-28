# In-App Orchestrator Worker — Design

## 1. Objectives
- Eliminate the dependency on an external `codex-orchestrator` binary by running orchestration and role workers fully inside the Electron app.
- Preserve existing workflow semantics (task seeding, approvals, artifacts, conversation logs) while improving observability and determinism.
- Keep heavy Codex execution isolated from the GUI by hosting it inside a dedicated worker thread.
- Provide rich telemetry (logs, heartbeats, status) so the renderer can display real-time progress and surfaces actionable diagnostics.

## 2. High-Level Architecture
```
Electron Main Process
 ├─ WorktreeService / GitService / CodexSessionManager
 ├─ WorkerOrchestratorBridge (new)
 │    │  spawn()
 │    ▼
 │  Worker Thread
 │    ├─ OrchestratorCoordinator
 │    ├─ TaskClaimStore (new)
 │    ├─ WorkerSupervisor (new)
 │    │    └─ RoleWorker (per role)
 │    ├─ CodexExecutor (Codex CLI adapter)
 │    └─ TaskStore / WorkerLauncher (reused)
 │
 └─ IPC handlers → Renderer

Renderer Process
 └─ OrchestratorProvider → OrchestratorPane
```

## 3. Core Components
### WorkerOrchestratorBridge (main process)
- Owns a `worker_threads.Worker` running `worker-entry.js`.
- Exposes typed methods (`getSnapshot`, `startRun`, `submitFollowUp`, `startRoleWorkers`, `stopRoleWorkers`, `approveTask`, `addComment`).
- Translates Orchestrator events from the worker into Electron broadcasts.
- Tracks pending requests per message `id` with automatic retries on worker restart.

### TaskClaimStore (worker thread)
- Stores tasks under `codex-runs/<runId>/tasks/*`, mirroring the new directory structure.
- Provides atomic claim/release using `fs.mkdir(lockDir, { recursive: false })` to avoid race conditions.
- Persists task status transitions (`ready → in_progress → done/blocked`) and keeps structured trace counters.

### WorkerSupervisor & RoleWorker (worker thread)
- Supervisor manages the lifecycle of per-role workers. Auto-start triggers spawn all roles; manual controls can start/stop individual roles.
- Each RoleWorker runs an async loop:
  1. Claim next `ready` task for its role.
  2. Execute the task prompt through the in-process Codex CLI adapter (honours `CODEX_PROFILE_<ROLE>`), streaming stdout/stderr back to the UI bridge.
  3. Stream executor stdout/stderr back to the bridge as `worker-log` events; emit heartbeat every `heartbeatMs` (default 2000ms).
  4. On success: write artifacts, mark task `done`, append runner notes.
  5. On executor failure: mark task `blocked`, attach error log, release claim.
  6. Repeat.
- Prior to completion, re-read task JSON to detect external approval/status changes; if mismatched, abort the write to avoid clobbering reviewers.
 - The implementer role holds the single-writer lock; while it is in `working`, no other implementer task can claim the workspace. Testers/reviewers never modify files.

### CodexExecutor Abstraction
- Default implementation (`CodexCliExecutor`) shells out to `codex exec --json -`, resolves per-role profiles via environment (`CODEX_PROFILE_<ROLE>`), and returns parsed agent output plus markdown artifacts.
- Uses `AbortSignal` to terminate processes on worker shutdown; propagates stderr back to task summaries when exits are non-zero.
- Still injected for tests so deterministic executors/fault injection remain possible.
 - Specialized executors:
- `ImplementerExecutor` wraps `codex apply`, captures `git diff`, and enforces a file lock under `codex-runs/<runId>/locks/implementer.lock`.
- `TesterExecutor` shells out to a configurable command (e.g., the worker-chosen test command) when running deterministic harnesses; in production it simply relays whatever Codex decides to execute for validation.
- `ReviewerExecutor` reuses `CodexCliExecutor` in read-only mode so approvals never touch disk.
- Snapshot/worker telemetry now carries desired worker counts and model priority per role. Supervisor launches N workers per role with unique IDs/models, and the renderer persists per-role selections so snapshots and UI stay aligned after refresh.

### Renderer Store & Pane
- Already listens for worker events; now consumes richer data:
  - `worker-log` chunks appended to per-role log tail.
  - Heartbeats used to render "last active" timestamps.
  - A configuration grid lets operators set desired worker counts and per-worker model priority (four slots per role). Applying the configuration pushes `WorkerSpawnConfig` objects over IPC, and the pane immediately reflects assigned models and desired concurrency.
  - Auto-start toggles call the new `startRoleWorkers`/`stopRoleWorkers` APIs; pane includes "Apply configuration", "Apply & start", and "Stop all" controls alongside per-role log tails/heartbeats.

## 4. Data Flow
1. Renderer submits a briefing → IPC → `registerIpcHandlers` → Bridge `startRun`.
2. Bridge posts `start-run` request with worktree path to worker thread.
3. Worker seeds analysis tasks under `codex-runs/<runId>/tasks/analysis/*.json`, ensures watchers, and replies with run summary.
4. Supervisor spins up RoleWorkers (if auto-start) which claim tasks via TaskClaimStore and execute them via CodexExecutor.
5. Worker emits `workers-updated`, `worker-log`, and `tasks-updated` events; bridge forwards to renderer.
6. Renderer OrchestratorPane updates task queue, worker roster, and log views in real time.
7. Approvals/comments route back the same path using TaskStore utilities inside the worker thread.

## 5. Error Handling
- **Worker spawn failure:** Bridge logs error, rejects in-flight requests, respawns worker.
- **Task claim conflicts:** Claim store logs lock conflicts; workers back off and retry.
- **Executor failure:** Task status → `blocked`, error appended to conversation/log. Heartbeat continues so UI shows worker error state.
- **Unexpected status change (race):** Worker re-reads task JSON before completing; if status changed externally, it aborts and logs info.
- **IPC failures:** Bridge rejects request with meaningful error message; renderer store surfaces via `OrchestratorPane` notifications.

## 6. Telemetry & Logging
- Each claim/transition increments debug counters and optionally writes to a ring buffer for diagnostics.
- Heartbeat cadence default 2 seconds; includes `lastHeartbeatAt` in `WorkerStatus` so renderer can display staleness.
- Worker logs streamed via `worker-log` events, truncated to last 4k per role for display.

## 7. Compatibility & Migration
- Existing `.codex/` workflow remains readable, but new runs live under `codex-runs/<runId>`. Approvals/seeders still manipulated through TaskStore, preserving review audit trail.
- Renderer fallbacks maintain test stability even when orchestrator APIs are stubbed.

## 8. Future Enhancements (post-MVP)
- Pause/Resume controls per role worker.
- Worker concurrency (multiple tasks per role) via worker pool.
- Expose metrics (claims/sec, average execution time) for dashboards.
- Optional persistence of worker stdout to disk for deep debugging.
- Bridge-level restart telemetry (tests now validate respawn logic) and richer UI cues for dependency bottlenecks.

## 9. Operator Workflow (Current UX)
1. Kick off a run from the Orchestrator tab and (optionally) leave “Auto-start workers” enabled to spawn the default roster.
2. Use the Worker Configuration grid to tune concurrency and model priority before launching:
   - The “Workers” input caps out at 4 per role; the drop-downs map the first, second, third, and fourth worker to the listed models.
   - The pane highlights each worker’s assigned model/heartbeat once live.
3. Press **Apply configuration** to persist the desired counts/models without touching active workers, or **Apply & start** to push changes and launch the fleet.
4. Use **Stop all** to bring every role back to zero; the grid preserves your selections, so a subsequent **Apply & start** restores the same mix.
5. Live log tails and heartbeat timestamps help identify stuck workers; reviewers can approve/comment tasks directly from the same pane.
