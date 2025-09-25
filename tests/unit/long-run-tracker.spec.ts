import { describe, expect, it } from 'vitest';
import { LongRunTracker } from '../../src/renderer/App';

describe('LongRunTracker', () => {
  it('flags long-running work when busy exceeds threshold', () => {
    const tracker = new LongRunTracker(10_000);

    expect(tracker.update('alpha', true, 0)).toBe(false);
    expect(tracker.update('alpha', true, 5_000)).toBe(false);
    expect(tracker.update('alpha', false, 12_000)).toBe(true);

    // subsequent idle updates do not notify again
    expect(tracker.update('alpha', false, 13_000)).toBe(false);

    // new busy period shorter than threshold does not notify
    expect(tracker.update('alpha', true, 20_000)).toBe(false);
    expect(tracker.update('alpha', false, 27_000)).toBe(false);
  });

  it('prunes stale entries', () => {
    const tracker = new LongRunTracker(10_000);

    tracker.update('alpha', true, 0);
    tracker.update('beta', true, 0);

    tracker.prune(new Set(['beta']));

    // alpha was removed, so it should behave like a fresh entry
    expect(tracker.update('alpha', true, 5_000)).toBe(false);
    expect(tracker.update('alpha', false, 16_000)).toBe(true);
  });
});
