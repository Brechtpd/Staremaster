import { describe, expect, it } from 'vitest';
import { detectResumeCommands, type ResumeDetectionState } from '../../../../src/main/services/CodexSessionManager';

describe('Codex resume detection', () => {
  it('extracts resume commands from streamed Codex output', () => {
    const state: ResumeDetectionState = {
      buffer: '',
      resumeCaptured: false,
      resumeTarget: null
    };

    const first = detectResumeCommands(state, '\u001b[32mstatus:\u001b[0m codex res');
    expect(first).toEqual([]);

    const second = detectResumeCommands(state, 'ume --yolo deadbeefdeadbeef\n');
    expect(second).toEqual([
      {
        codexSessionId: 'deadbeefdeadbeef',
        command: 'codex resume --yolo deadbeefdeadbeef',
        alreadyCaptured: false
      }
    ]);
    expect(state.resumeTarget).toBe('deadbeefdeadbeef');
    expect(state.resumeCaptured).toBe(true);

    const third = detectResumeCommands(state, 'codex resume --yolo deadbeefdeadbeef\n');
    expect(third).toEqual([
      {
        codexSessionId: 'deadbeefdeadbeef',
        command: 'codex resume --yolo deadbeefdeadbeef',
        alreadyCaptured: true
      }
    ]);
  });

  it('emits new commands when Codex reports a different session id later', () => {
    const state: ResumeDetectionState = {
      buffer: '',
      resumeCaptured: false,
      resumeTarget: null
    };

    const first = detectResumeCommands(state, 'codex resume --yolo 11111111-2222-3333-4444-555555555555\n');
    expect(first).toEqual([
      {
        codexSessionId: '11111111-2222-3333-4444-555555555555',
        command: 'codex resume --yolo 11111111-2222-3333-4444-555555555555',
        alreadyCaptured: false
      }
    ]);

    const second = detectResumeCommands(state, 'codex resume --yolo 66666666-7777-8888-9999-aaaaaaaaaaaa\n');
    expect(second).toEqual([
      {
        codexSessionId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
        command: 'codex resume --yolo 66666666-7777-8888-9999-aaaaaaaaaaaa',
        alreadyCaptured: false
      }
    ]);
    expect(state.resumeTarget).toBe('66666666-7777-8888-9999-aaaaaaaaaaaa');
  });
});
