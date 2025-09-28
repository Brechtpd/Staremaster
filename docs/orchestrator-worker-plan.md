# In-App Worker Runtime — Implementation Plan (Progress)

## ✅ Phase 0 – Contracts & Executor Abstraction
- Established the execution contract between worker thread and `CodexSessionManager`; added `CodexExecutor` interface and a temporary `StubCodexExecutor` (real adapter still pending).

## ✅ Phase 1 – TaskClaimStore & Instrumentation
- Delivered `TaskClaimStore` with atomic claim/release (`fs.mkdir` locks) and debug counters; TaskStore now works against per-run `codex-runs/<runId>` roots.

## ✅ Phase 2 – WorkerSupervisor & RoleWorker
- Worker loops now run against the in-process `CodexCliExecutor`, stream logs/heartbeats, and persist structured artifacts. Added deterministic unit coverage for success/failure paths (`role-worker.spec.ts`).
- Task graph expansion seeds consensus, splitter, implementer, tester, and reviewer tasks once upstream requirements are met (`TaskStore.ensureWorkflowExpansion`).
- Introduced role-specific executors: implementer wraps `codex patch` with a workspace lock/diff capture, tester runs configurable shell commands and streams logs.

## ✅ Phase 3 – Worker Bridge & IPC Updates
- Worker bridge routes `startWorkers`/`stopWorkers` through Electron IPC, rehydrates runtime context, and mirrors worker updates into coordinator snapshots.

## ✅ Phase 4 – Renderer Synchronization
- Renderer store exposes worker control actions; Orchestrator pane shows live logs/heartbeats and in-app “Start/Stop all” controls (CLI hint removed).

## 🔄 Phase 5 – End-to-End Validation
- Added unit suites for `TaskClaimStore`, per-role worker loops, the worker supervisor scaling logic, and bridge-level coverage for `startWorkers` error propagation/resume flows. A gated real-Codex smoke (`RUN_REAL_CODEX_E2E=1`) now drives the entire pipeline (analyst → reviewer) through the Codex CLI; deterministic fallbacks remain for CI. Additional env toggles (`RUN_REAL_CODEX_IMPLEMENTER`, `RUN_REAL_CODEX_TESTER`, `RUN_REAL_CODEX_REVIEWER`) allow overriding individual stages.
- Worker bridge tests simulate worker restarts/errors to verify pending request rejection and automatic respawn logic.

## 🔜 Phase 6 – Cleanup & Documentation
- Pending: purge `CODEX_ORCHESTRATOR_BIN`, refresh README/TASKS.md, finalize docs once phases 2–5 complete.
- Per-role model priorities and worker counts are now fully configurable in-app (IPC/renderer wiring, UI controls, and multi-worker tests landed). Next: update onboarding docs/screenshots and fold the configuration story into TASKS.md.

**Next Steps**
1. Capture UI screenshots for the configuration grid and fold them into README/onboarding docs.
2. Consider adding lightweight telemetry around executor failures (optional post-MVP).
