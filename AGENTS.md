# Repository Guidelines

## Project Structure & Module Organization
Runtime code stays under `src/`: `src/main/` handles Electron orchestration (worktrees, Codex), `src/renderer/` renders the Staremaster panels, and `src/shared/` carries contracts shared between processes. Mirror any new module inside `tests/` (for example, code in `src/renderer/panels` gains a sibling spec under `tests/renderer/panels`). CLI helpers live in `scripts/`; static icons, fonts, or preload assets belong in `assets/`.

## Build, Test, and Development Commands
Run `npm install` once per worktree. Use `npm run dev` for the hot-reloading Electron + Vite stack, `npm run build` to emit production bundles, and `npm run lint` before opening a PR. Execute `npm run test` for Vitest, `npm run coverage` to enforce the ≥80% target, and `E2E_ELECTRON=1 xvfb-run --auto-servernum npm run e2e` for the Playwright smoke harness inside headless Linux environments.

## Coding Style & Naming Conventions
Author new code in strict TypeScript with 2-space indentation and single quotes; rely on Prettier via the ESLint config (`npm run lint -- --fix`). React components, hooks, and stores use PascalCase (`FeaturePanel.tsx`), while services/utilities stay kebab-case (`codex-session-manager.ts`). Keep renderer files UI-only; delegate filesystem or git access to `src/main/` services.

## Testing Guidelines
Co-locate unit specs under `tests/unit` using the `*.spec.ts` pattern and stub Codex I/O so suites stay deterministic. Prefer component-level tests over snapshots. Update `tests/README.md` if you introduce new external dependencies. For new panes, add an end-to-end check in `tests/e2e/` that boots Electron and exercises the workflow.

## Commit & Pull Request Guidelines
Write small, imperative commits (`Refine Codex resume flow`) and reference the active worktree or issue in the body. PRs should include a clear summary, screenshots for UI shifts, and confirmation of `npm run lint` plus the relevant test commands. Call out any reviewer setup—especially changes that affect Codex binaries or node-pty rebuilds.

## Security & Configuration Tips
Never commit Codex tokens; store them in `.env.local` and access via `process.env`. Sanitize any user-supplied paths before shelling out (e.g., worktree creation) and log the sanitized command. When scripting automation, prefer `git worktree` commands over direct `.git` edits to avoid destructive mistakes.

## Agent Workflow Tips
Each worktree maintains its own Codex session and terminal state. Start the app via `npm run dev`, create a worktree from the sidebar, and Codex will automatically resume within that directory. Keep logs concise by clearing inactive sessions with the UI’s stop action before switching contexts.

Long-running tooling (tests, docker compose, migrations, etc.) must always be invoked with sensible timeouts or in non-interactive batch mode. Never leave a shell command waiting indefinitely—prefer explicit timeouts, scripted runs, or log polling after the command exits.
