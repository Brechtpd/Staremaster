import { describe, expect, it } from 'vitest';
import { parseCodexExecJson } from '../../../../src/main/services/CodexSummarizer';

describe('parseCodexExecJson', () => {
  it('returns the last agent message when present', () => {
    const payload = [
      JSON.stringify({ msg: { type: 'agent_message', message: 'First summary' } }),
      JSON.stringify({ msg: { type: 'agent_message', message: 'Final summary' } })
    ].join('\n');

    const result = parseCodexExecJson(payload);

    expect(result.message).toBe('Final summary');
    expect(result.error).toBeUndefined();
  });

  it('captures error messages emitted by codex exec', () => {
    const payload = JSON.stringify({ msg: { type: 'error', message: 'unexpected status 400' } });

    const result = parseCodexExecJson(payload);

    expect(result.message).toBeUndefined();
    expect(result.error).toBe('unexpected status 400');
  });

  it('ignores malformed lines gracefully', () => {
    const payload = ['not-json', JSON.stringify({ msg: { type: 'agent_message', message: 'Safe' } })].join('\n');

    const result = parseCodexExecJson(payload);

    expect(result.message).toBe('Safe');
    expect(result.error).toBeUndefined();
  });
});
