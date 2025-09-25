import { expect, test } from '@playwright/test';
import { accessSync, constants } from 'node:fs';

const sharedMemoryRoot = process.env.TMPDIR ?? process.env.XDG_RUNTIME_DIR ?? '/dev/shm';
const shouldRun = process.env.E2E_ELECTRON === '1';

const canUseSharedMemory = (() => {
  try {
    accessSync(sharedMemoryRoot, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

test.describe.configure({ mode: 'serial' });

test.skip(!shouldRun, 'Set E2E_ELECTRON=1 to enable Electron smoke tests.');
test.skip(!canUseSharedMemory, `Shared memory root unavailable (${sharedMemoryRoot}); skip Electron e2e.`);
import { launchElectronApp } from './utils/electron-app';

test.describe('Electron shell', () => {
  test('shows the empty state when no project is selected', async () => {
    const { app, window } = await launchElectronApp();

    try {
      window.on('console', (message) => {
        console.log(`[renderer] ${message.type()}: ${message.text()}`);
      });

      window.on('pageerror', (error) => {
        console.log(`[renderer-error] ${error.message}`);
      });

      await window.waitForEvent('console', {
        timeout: 10_000,
        predicate: (message) => message.text().includes('[renderer] App mounted')
      });

      await expect(window.getByRole('heading', { name: /ai worktree studio/i })).toBeVisible();
      await expect(window.getByRole('button', { name: /choose project folder/i })).toBeEnabled();
    } finally {
      await app.close();
    }
  });
});
