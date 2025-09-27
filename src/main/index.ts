import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerIpcHandlers } from './ipc/registerIpcHandlers';
import { ProjectStore } from './services/ProjectStore';
import { WorktreeService } from './services/WorktreeService';
import { CodexSessionManager } from './services/CodexSessionManager';
import { GitService } from './services/GitService';
import { WindowStateStore, WindowBounds } from './services/WindowStateStore';
import { TerminalService } from './services/TerminalService';

const isDevelopment = process.env.NODE_ENV === 'development';
const isHeadless = process.env.ELECTRON_HEADLESS === '1';

if (isHeadless) {
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('single-process');
  app.disableHardwareAcceleration();
}

let worktreeService: WorktreeService;
let gitService: GitService;
let codexManager: CodexSessionManager;
let windowStateStore: WindowStateStore;
let terminalService: TerminalService;

const preloadPath = (): string => {
  return path.join(__dirname, 'preload.js');
};

const getRendererEntry = (): string =>
  isDevelopment ? 'http://localhost:5173' : path.join(__dirname, '../renderer/index.html');

const loadRenderer = async (window: BrowserWindow): Promise<void> => {
  const entry = getRendererEntry();

  if (!isDevelopment) {
    await window.loadFile(entry);
    return;
  }

  const maxAttempts = 50;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await window.loadURL(entry);
      return;
    } catch (error) {
      console.warn('[main] renderer load failed', { attempt, message: (error as Error).message });
      await delay(200);
    }
  }

  throw new Error(`Failed to connect to Vite dev server after ${maxAttempts} attempts`);
};

const createMainWindow = async (bounds: WindowBounds | null): Promise<BrowserWindow> => {
  const window = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      preload: preloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: isHeadless
    },
    show: !isHeadless
  });

  if (bounds?.isMaximized) {
    window.maximize();
  }

  const scheduleSaveBounds = (() => {
    let timeout: NodeJS.Timeout | null = null;
    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        timeout = null;
        if (window.isDestroyed()) {
          return;
        }
        const windowBounds = window.getBounds();
        void windowStateStore.save({
          ...windowBounds,
          isMaximized: window.isMaximized()
        });
      }, 200);
    };
  })();

  window.on('resize', scheduleSaveBounds);
  window.on('move', scheduleSaveBounds);
  window.on('close', () => {
    if (window.isDestroyed()) {
      return;
    }
    const windowBounds = window.getBounds();
    void windowStateStore.save({
      ...windowBounds,
      isMaximized: window.isMaximized()
    });
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[main] preload error', preloadPath, error);
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[main] failed to load', { errorCode, errorDescription, validatedURL });
  });

  await loadRenderer(window);

  if (isDevelopment) {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  return window;
};

const bootstrap = async () => {
  await app.whenReady();

  const store = new ProjectStore(app.getPath('userData'));
  windowStateStore = new WindowStateStore(app.getPath('userData'));
  worktreeService = new WorktreeService(store);
  gitService = new GitService((id) => worktreeService.getWorktreePath(id));
  codexManager = new CodexSessionManager(store);
  terminalService = new TerminalService((id) => worktreeService.getWorktreePath(id), {
    history: {
      enabled: true,
      limit: 500_000
    },
    persistDir: path.join(app.getPath('userData'), 'terminal-logs')
  });
  // Codex terminals use the same TerminalService (no special-casing)
  await worktreeService.load();

  const savedBounds = await windowStateStore.load();
  const window = await createMainWindow(savedBounds);
  registerIpcHandlers(
    window,
    worktreeService,
    gitService,
    codexManager,
    terminalService
  );

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const latestBounds = await windowStateStore.load();
      const newWindow = await createMainWindow(latestBounds);
      registerIpcHandlers(newWindow, worktreeService, gitService, codexManager, terminalService);
    }
  });
};

bootstrap().catch((error) => {
  console.error('Failed to bootstrap application', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
