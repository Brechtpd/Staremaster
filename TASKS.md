# Codex Orchestrator — Design Document

> **Purpose**: Enable multiple Codex CLI sessions to collaborate on a single task by (1) drafting independent requirements, (2) reconciling via a consensus step with sign‑offs, (3) fanning out implementation/testing work, (4) reviewing/discussing findings, and (5) marking tasks **done** when approvals meet thresholds—without requiring a central server or MCP.

---

## 1. Goals & Non‑Goals

### Goals
- **Consensus‑first workflow**: Two analyzers independently produce requirements drafts that are reconciled into a single **Final Requirements** doc.
- **Review & approval gating**: Certain tasks require N approvals before moving to **done**.
- **Back‑and‑forth discussion**: Each task carries a markdown conversation log for clarifications and findings.
- **Parallel work across CLIs**: Any number of Codex CLI sessions (roles) can run simultaneously, safely claiming tasks.
- **Simple, auditable persistence**: File‑based queues under `.codex/` suitable for Git history, code reviews, and CI.
- **Rust implementation**: A single binary (`codex-orchestrator`) manages tasks, workers, consensus, and gates.

### Non‑Goals
- No centralized server or database.
- No networked RPC or MCP by default (can be added later).
- No long‑running background daemons beyond CLI loops you explicitly start.

---

## 2. User Stories & Requirements

### Functional
1. **Create initial epic/task** and spawn two analysis tasks (Analyst A & B).
2. **Analysts** draft requirements independently → artifacts saved in `.codex/out/`.
3. **Consensus builder** reconciles both drafts into **Final Requirements**, opens a **consensus review** task requiring 2 approvals.
4. **Approvals** (by named roles) are tracked; when approvals ≥ required, the task becomes **done**.
5. **Splitter** creates downstream tasks (implementation, testing) from the final requirements.
6. **Workers** for roles (analyst_a, analyst_b, implementer, tester) pick tasks from their queues and run `codex exec` with role‑scoped profiles.
7. **Reviewers** provide comments and approvals; conversation goes into `.codex/conversations/<task-id>.md`.
8. **Review gate** promotes tasks from `awaiting_review` to `done` when approval thresholds are met.

### Non‑Functional
- **Deterministic locking** so two workers don’t double‑claim a task.
- **Git‑friendly**: all state is text; tasks are readable/mergeable; works with `git worktree`.
- **Low cognitive overhead**: one binary, a handful of commands.
- **Extensible**: pluggable storage backends and orchestration strategies in future (MCP, GitHub labels, S3, etc.).

---

## 3. Architecture Overview

```
+------------------------------+          +------------------------------+
|  Codex CLI (analyst_a)       |          |  Codex CLI (analyst_b)       |
|  worker: picks analysis task |          |  worker: picks analysis task |
+---------------+--------------+          +---------------+--------------+
                |                                             |
                v                                             v
        .codex/tasks/analysis/*.json                  .codex/tasks/analysis/*.json
                \_____________________________________________/
                              produce drafts (artifacts)
                                    |
                                    v
                           .codex/out/*-output.md
                                    |
                                    v
                        consensus builder (Rust CLI)
                             |   creates review task (2 approvals)
                             v
                     .codex/out/<EPIC>-consensus.md
                             |
                             v
                        approvals & review gate
                             |
                     +-------+----------------------+
                     |                              |
                     v                              v
        splitter → .codex/tasks/impl/*.json   .codex/tasks/test/*.json
                     |                              |
                     v                              v
  Codex CLI (implementer)                 Codex CLI (tester)
  writes artifacts, status → review/done   writes test reports → done
```

### Modules
- **Task Store (FS)**: JSON task files under `.codex/tasks/{analysis,impl,test,review,done}`.
- **Worker Engine**: Long‑poll loops per role; safe claiming via `.lock` files; runs `codex exec`.
- **Consensus Builder**: Aggregates ≥2 analysis artifacts → produces final requirements; opens review task with `approvals_required=2`.
- **Review Gate**: Moves tasks from `awaiting_review` to `done` when approvals are met.
- **Splitter**: Generates implementation & testing tasks from the final requirements.
- **Conversation Log**: Append‑only markdown per task ID.

---

## 4. Data Model

### Task JSON (simplified)
```json
{
  "id": "uuid-or-stable-id",
  "epic": "EPIC-0001",
  "kind": "analysis | consensus | impl | test | review",
  "title": "...",
  "prompt": "codex exec prompt string",
  "role": "analyst_a | analyst_b | implementer | tester | reviewer",
  "status": "ready | in_progress | awaiting_review | changes_requested | approved | blocked | done",
  "cwd": ".",
  "artifacts": [".codex/out/<id>-output.md"],
  "depends_on": ["..."],
  "approvals_required": 0,
  "approvals": ["analyst_a", "analyst_b"],
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

### Directory Layout
```
.repo/
  .codex/
    tasks/
      analysis/  impl/  test/  review/  done/  backlog/
    out/                 # artifacts: drafts, consensus, notes, reports
    conversations/       # <task-id>.md threaded log
```

### State Machine

```
ready → (claimed) → in_progress →
  ├─ analysis → done
  ├─ impl → awaiting_review → done (when approvals ≥ required)
  ├─ test → done
  └─ consensus/review → awaiting_review → done (on approvals)
```

> Implementation notes: The worker currently sets `analysis → done` to make consensus consider finished drafts. `impl` tasks go to `awaiting_review` and require approvals.

### Locking
- **Claim**: create `task.json.lock` via `create_new=true`. If creation succeeds, the worker owns the task; otherwise skip.
- **Finalize**: write updated JSON, move file between queues atomically.

---

## 5. Workflows (Sequence)

### A) Analysis → Consensus → Sign‑off
```
User seeds epic ─▶ two analysis tasks (A,B) ─▶ analysts draft
  └─▶ consensus builds Final Requirements ─▶ creates CONSENSUS-<EPIC> (needs 2 approvals)
       └─▶ reviewers approve ─▶ review gate marks consensus task done
```

### B) Split → Implementation → Review → Done
```
Final Requirements ─▶ splitter creates impl & test tasks
   └─▶ implementer works ─▶ awaiting_review
        └─▶ reviewers discuss/approve ─▶ review gate → done
   └─▶ tester writes report ─▶ done
```

---

## 6. CLI Commands (Rust)

- `worker <role> [--once]`
  - Watches the role’s queue; claims tasks; runs `codex exec <prompt>`; stores artifacts; moves state.
  - Role → queue mapping: `analyst_* → analysis`, `implementer → impl`, `tester → test`, `reviewer → review` (reviewers typically act manually).

- `consensus <EPIC_ID>`
  - Reads ≥2 analysis artifacts for the epic; prompts Codex to reconcile; writes `out/<EPIC>-consensus.md` and creates `CONSENSUS-<EPIC>` review task with `approvals_required=2`.

- `review-gate`
  - Scans `review/` for tasks with `approvals ≥ approvals_required`; promotes to `done`.

- `task seed-example`
  - Seeds `EPIC-0001` and two analysis tasks.

- `task new <role> <kind> "<title>" "<prompt>" [cwd=. ] [epic=""]`
- `task approve <TASK_ID> <who>`
- `task comment <TASK_ID> "message"`
- `task move <TASK_ID> <status>`
- `task info <TASK_ID>`
- `task split <EPIC_ID>`

### Configuration
- `CODEX_BIN` → path to `codex` binary (default: `codex`).
- `CODEX_PROFILE_<ROLE>` → e.g., `CODEX_PROFILE_IMPLEMENTER=coder`, `CODEX_PROFILE_ANALYST_A=reviewer`.

---

## 7. Error Handling & Idempotency
- **Lock collisions**: benign; next loop iteration retries unclaimed tasks.
- **codex exec non‑zero**: worker records failure (stderr to console) and leaves task in place; operator can `task comment` and `task move` to `blocked`.
- **Partial artifacts**: artifacts are only registered after successful completion.
- **Idempotent gates**: `review-gate` is safe to run repeatedly; only moves eligible tasks.

---

## 8. Security & Isolation
- **Profiles**: Per‑role `--profile` ensures least privilege (e.g., analysts/testers read‑only; implementer write).
- **Worktrees**: Run roles in separate `git worktree`s to avoid file contention and enable independent commits.
- **Approval thresholds**: Prevent unreviewed merges; consensus requires ≥2; impl can require ≥1 (tunable).
- **Conversation logs**: No secrets; plain text; consider repo privacy.

---

## 9. Observability
- **Artifacts** in `.codex/out/` double as audit trail.
- **Conversations** in `.codex/conversations/` capture rationale and back‑and‑forth.
- **Git**: Commit the `.codex/` directory (or selected subfolders) to version task states.

---

## 10. Performance
- Workers poll every ~1–2s; negligible overhead for typical repo sizes.
- Scaling to dozens of tasks: run multiple workers per role or add a `--parallel N` option in future.

---

## 11. Extensibility (Roadmap)
- **MCP adapter**: Replace filesystem store with MCP tools (`list`, `claim`, `update`), keeping the same domain model.
- **GitHub labels backend**: Mirror states to PR labels; use `gh` to route reviews/approvals.
- **Dashboards**: TUI/HTML page summarizing queues, artifacts, approvals.
- **Auto‑splitter**: Parse consensus headings (API/UI/Docs/Tests) and spawn more granular impl tasks.
- **Policy engine**: YAML rules for approvals per `kind`/`epic`.

---

## 12. Risks & Mitigations
- **Concurrent edits**: Use worktrees and small PRs; avoid editing the same files across roles.
- **Human review fatigue**: Encode minimal‑diff expectations in prompts; require justifiable changes.
- **Artifact drift**: Always reference task IDs in commit messages; link artifacts in PR descriptions.

---

## 13. Example End‑to‑End (Commands)

```bash
# Seed epic and analysis tasks
codex-orchestrator task seed-example

# Two terminals
codex-orchestrator worker analyst_a
codex-orchestrator worker analyst_b

# Build consensus & require 2 approvals
codex-orchestrator consensus EPIC-0001
codex-orchestrator task approve CONSENSUS-EPIC-0001 analyst_a
codex-orchestrator task approve CONSENSUS-EPIC-0001 analyst_b
codex-orchestrator review-gate

# Split to impl & test, run role workers
codex-orchestrator task split EPIC-0001
codex-orchestrator worker implementer
codex-orchestrator worker tester

# Review discussion & finalization
codex-orchestrator task comment <TASK_ID> "Edge case: non-standard derivation path"
codex-orchestrator task approve <TASK_ID> reviewer
codex-orchestrator review-gate
```

---

## 14. Open Questions
- Should `impl` default to `approvals_required=2` for higher assurance?
- Should we persist worker logs per task under `.codex/out/<id>.log` for easier triage?
- Do we add a `--parallel N` to process multiple tasks per worker?

---

## 15. Appendix: Role Definitions (Starter)

- **analyst_a / analyst_b**: Draft requirements independently; avoid implementation bias; deliver acceptance criteria.
- **implementer**: Implement per final requirements; produce notes and link PR.
- **tester**: Author unit/E2E tests; attach reports.
- **reviewer**: Comment and approve; ensure minimal diffs and acceptance criteria coverage.

---

## 16. Orchestrator Implementation Notes

- **Single-writer lock** – only the `implementer` role touches the filesystem. The worker acquires `codex-runs/<runId>/locks/implementer.lock` before running `codex apply` and releases it immediately after completing the task. Analysts, testers, and reviewers operate read-only.
- **Tester behaviour** – in production the tester role relies on its Codex prompt to decide how to validate the work (e.g., run `cargo test`). No additional environment configuration is required.
- **Automated validation** – run `npx vitest run --config vitest.e2e.config.ts tests/e2e/orchestrator/pong.e2e.spec.ts` to exercise the full pipeline against a temporary Cargo project. Requires a local Rust toolchain (`cargo`/`rustc`) on PATH. Set `RUN_REAL_CODEX_E2E=1` to drive every stage (analysts through reviewer) with the Codex CLI during the harness; deterministic stubs remain the default for CI.
- **Worker configuration** – runtime metadata tracks desired worker counts and model priority per role. Supervisor spawns multiple workers with role-indexed IDs/models and Codex executors honour explicit overrides. The renderer configuration grid now lives on the kickoff screen; running panes focus on active agents + logs.
- **Workflow expansion** – coordinator awaits `ensureWorkflowExpansion`, guaranteeing consensus/splitter/implementation tasks seed immediately once dependencies finish (no more “workers waiting forever” stalls).
- **Quick actions** – the orchestrator pane now exposes click-to-open shortcuts for worker artifacts and conversation logs, making follow-up reviews quicker.
- **Change requests** – when reviewers flag `changes_requested`, the orchestrator reopens implementer/tester tasks and resets the review so follow-up iterations launch automatically.
- **Agent flow** – a React Flow visualization highlights each role’s status (pending/active/done/error) and the path work is taking through the orchestration pipeline.
- **Codex CLI environment** – the embedded executor shells out to `codex exec`. Ensure `codex` is on `PATH` (or export `CODEX_BIN=/path/to/codex`), and define per-role profiles via `CODEX_PROFILE_<ROLE>` (e.g., `CODEX_PROFILE_ANALYST_A=analyst`, `CODEX_PROFILE_IMPLEMENTER=coder`). Optional knobs include `CODEX_PROFILE_FALLBACK` for a shared default and `CODEX_TIMEOUT_SECONDS` to cap execution time. The gated Fibonacci E2E harness honours `RUN_REAL_CODEX_E2E=1` to exercise the real CLI end-to-end.
