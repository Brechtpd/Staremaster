# Staremaster

Desktop companion that lets you spin up isolated git worktrees, drive Codex agents inside each one, and review diffs side by side. Start a feature from the GUI, keep the agent scoped to a dedicated directory, and ship confident changes.

## Getting Started

```bash
npm install
npm run dev
```

The dev command will:

- Compile Electron main/preload code with TypeScript (`tsc --watch`).
- Boot the Vite renderer on <http://localhost:5173>.
- Launch Electron pointing at the freshly built main bundle.

Build the distributable bundle with:

```bash
npm run build
```

## Repository Layout

```
src/
  main/       Electron main process (worktree orchestration, Codex sessions)
  renderer/   React UI for the multi-tab workflow
  shared/     Cross-process contracts and typings
scripts/      CLI helpers and future automation hooks
tests/        Vitest unit specs + Playwright E2E harness
assets/       Static assets served into the renderer
```

## Core Capabilities

- **Project picker:** Choose a git repo root; the app validates `.git` and persists the selection.
- **Worktree engine:** Create/delete feature worktrees via `git worktree add/remove`, with status surfaced in the sidebar.
- **Codex orchestration:** Launch `codex resume --yolo` inside a worktree using `node-pty`, stream output to the UI, and stop sessions on demand.
- **Tabbed UX:** Sidebar lists active worktrees; main pane splits Codex terminal output and a placeholder for diff tooling.

## Quality & Tooling

- **Linting:** `npm run lint`
- **Unit tests:** `npm run test`
- **Coverage reports:** `npm run coverage`
- **E2E (Electron smoke):** `E2E_ELECTRON=1 xvfb-run --auto-servernum npm run e2e`

Vitest runs against a mocked IPC layer so suites stay offline. Playwright specs are stubbed—wire them to an Electron harness before enabling in CI.
