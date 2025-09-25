import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { _electron as electron, ElectronApplication, Page } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface LaunchElectronResult {
  app: ElectronApplication;
  window: Page;
}

export const launchElectronApp = async (): Promise<LaunchElectronResult> => {
  const projectRoot = path.resolve(__dirname, '../../..');
  const baseTmp = process.env.TMPDIR ? path.resolve(process.env.TMPDIR) : os.tmpdir();

  let tmpDir: string;
  try {
    tmpDir = await fs.mkdtemp(path.join(baseTmp, 'ai-gui-'));
    await fs.chmod(tmpDir, 0o777);
  } catch (error) {
    console.warn('[e2e] mkdtemp failed, falling back to project tmp dir', error);
    tmpDir = path.join(projectRoot, '.tmp');
    await fs.mkdir(tmpDir, { recursive: true, mode: 0o777 });
    await fs.chmod(tmpDir, 0o777);
  }

  const electronApp = await electron.launch({
    args: ['--headless', '.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_HEADLESS: '1',
      ELECTRON_ENABLE_LOGGING: '0',
      TMPDIR: tmpDir
    }
  });

  electronApp.process().stdout?.on('data', (data) => {
    process.stdout.write(`[electron] ${data}`);
  });

  electronApp.process().stderr?.on('data', (data) => {
    process.stderr.write(`[electron] ${data}`);
  });

  const window = await waitForFirstWindow(electronApp);
  await window.waitForLoadState('load');

  return { app: electronApp, window };
};

const waitForFirstWindow = async (electronApp: ElectronApplication): Promise<Page> => {
  const existing = electronApp.windows();
  if (existing.length > 0) {
    return existing[0];
  }

  return electronApp.waitForEvent('window', { timeout: 30_000 });
};
