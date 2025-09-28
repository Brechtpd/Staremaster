import { EventEmitter } from 'node:events';
import type { OrchestratorEvent } from '@shared/orchestrator';

type Listener = (event: OrchestratorEvent) => void;

export class OrchestratorEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  subscribe(listener: Listener): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  publish(event: OrchestratorEvent): void {
    this.emitter.emit('event', event);
  }

  dispose(): void {
    this.emitter.removeAllListeners();
  }
}
