import { describe, expect, it } from 'vitest';
import { longestSuffixPrefixOverlap } from '../../../src/renderer/utils/overlap';

describe('longestSuffixPrefixOverlap', () => {
  it('returns 0 when there is no overlap', () => {
    expect(longestSuffixPrefixOverlap('abc', 'xyz')).toBe(0);
  });

  it('finds full overlap when strings match', () => {
    expect(longestSuffixPrefixOverlap('banner', 'banner')).toBe('banner'.length);
  });

  it('finds partial overlap at the boundary', () => {
    const a = '...OpenAI Codex (v0.41.0)\n';
    const b = 'OpenAI Codex (v0.41.0)\nnext';
    expect(longestSuffixPrefixOverlap(a, b)).toBe('OpenAI Codex (v0.41.0)\n'.length);
  });

  it('is bounded by the shorter string length', () => {
    expect(longestSuffixPrefixOverlap('xx123', '123')).toBe(3);
    expect(longestSuffixPrefixOverlap('45', '12345')).toBe(0);
  });
});
