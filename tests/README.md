# Test Suite Overview

- **Unit Tests (`tests/unit`)** — Run with `npm run test` (Vitest/JSdom). Mocked Codex and IPC layers keep execution offline.
- **End-to-End Tests (`tests/e2e`)** — Playwright harness that boots the packaged Electron app. Disabled by default; run with `E2E_ELECTRON=1 xvfb-run --auto-servernum npm run e2e`. The Electron renderer needs shared memory and an X server, so local runs may require `xvfb` or `/dev/shm` access.
- **Coverage** — Execute `npm run coverage` to generate lcov/text reports.

> When adding integration cases that depend on external tools (e.g., Codex CLI), document the requirements here and guard the specs with `test.skip` so CI can run without credentials.
