# Orchestrator Pane — Screenshot Guidelines

The worker configuration UX is easiest to understand with visuals. To capture or refresh screenshots:

1. **Prepare the environment**
   - Launch the renderer via `npm run dev`.
   - Seed a run with sample input so the Orchestrator pane shows tasks/workers.
   - Toggle “Auto-start workers” off, then use **Apply configuration** to surface the grid in its idle state.

2. **Capture key states** (save under `assets/screenshots/orchestrator/`):
   - `orchestrator-config-idle.png` — grid before starting workers (counts editable, dropdowns visible).
   - `orchestrator-config-running.png` — after **Apply & start**, showing live workers with model chips.
   - `orchestrator-config-stop.png` — post **Stop all**, highlighting persisted settings and zero workers.

3. **Update docs**
   - Reference the images in `README.md` and/or `docs/orchestrator-worker-design.md` with concise captions.
   - Note the CLI/env prerequisites (already documented) near the screenshots for quick onboarding.

4. **Housekeeping**
   - Keep PNGs ≤1 MB; run them through `pngquant` if needed.
   - When UI changes, bump filenames with a suffix (`-v2`) and update references to avoid browser cache issues.

Following this checklist keeps visual aids fresh without checking bulky assets into version control accidentally.
