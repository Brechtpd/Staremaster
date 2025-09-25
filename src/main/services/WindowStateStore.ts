import path from 'node:path';
import { promises as fs } from 'node:fs';

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

export class WindowStateStore {
  private readonly filePath: string;

  constructor(private readonly userDataDir: string) {
    this.filePath = path.join(this.userDataDir, 'window-state.json');
  }

  async load(): Promise<WindowBounds | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as WindowBounds;
      if (!parsed || typeof parsed.width !== 'number' || typeof parsed.height !== 'number') {
        return null;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.warn('[window-state] failed to load window state', error);
      return null;
    }
  }

  async save(bounds: WindowBounds): Promise<void> {
    try {
      await fs.mkdir(this.userDataDir, { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(bounds, null, 2), 'utf8');
    } catch (error) {
      console.warn('[window-state] failed to persist window state', error);
    }
  }
}
