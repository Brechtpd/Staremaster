import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalService } from '../../../../src/main/services/TerminalService';

const flushPersistence = async (service: TerminalService) => {
  const persistMap: Map<string, Promise<void>> = (service as unknown as { historyPersistPromises: Map<string, Promise<void>> }).historyPersistPromises;
  while (persistMap.size > 0) {
    await Promise.all(Array.from(persistMap.values()));
  }
};

describe('TerminalService history persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-history-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const createService = () =>
    new TerminalService(
      () => '/tmp',
      {
        history: {
          enabled: true,
          limit: 64
        },
        persistDir: tempDir
      }
    );

  it('rewrites persisted history to retain only the in-memory tail and reloads correctly', async () => {
    const service = createService();
    expect((service as unknown as { persistDir?: string }).persistDir).toBe(tempDir);
    const recordHistory = (data: string) => (service as unknown as { recordHistoryEvent: (worktreeId: string, paneId: string | undefined, chunk: string) => number | undefined }).recordHistoryEvent('wt-main', undefined, data);

    for (let index = 0; index < 16; index += 1) {
      recordHistory(`seed-${index}\n`);
    }
    await flushPersistence(service);

    for (let index = 16; index < 216; index += 1) {
      recordHistory(`data-${index}\n`);
    }
    await flushPersistence(service);

    const historyRecord = (service as unknown as { historyByKey: Map<string, { events: Array<{ id: number; data: string }> }> }).historyByKey.get('wt-main::default');
    expect(historyRecord).toBeTruthy();
    const events = historyRecord!.events;

    (service as unknown as { rewritePersistedHistory: (key: string, record: unknown) => void }).rewritePersistedHistory('wt-main::default', historyRecord!);
    await flushPersistence(service);

    const historyFileName = (await fs.readdir(tempDir)).find((file) => file.endsWith('.jsonl'));
    expect(historyFileName).toBeDefined();
    const historyFile = path.join(tempDir, historyFileName!);
    const contents = await fs.readFile(historyFile, 'utf8');
    const persistedEvents = contents
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; data: string });

    expect(persistedEvents.length).toBe(events.length);
    expect(persistedEvents.map((event) => event.id)).toEqual(events.map((event) => event.id));

    const reloaded = createService();
    const snapshot = await reloaded.getSnapshot('wt-main');
    expect(snapshot.content).toBe(events.map((event) => event.data).join(''));

    reloaded.dispose('wt-main');
    await flushPersistence(reloaded);

    expect(Array.from((service as unknown as { historyByKey: Map<string, unknown> }).historyByKey.keys())).toContain('wt-main::default');
    service.dispose('wt-main');
    await flushPersistence(service);
  });
});
