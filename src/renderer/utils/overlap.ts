// Returns the length of the longest suffix of `a` that is also a prefix of `b`.
// Useful for trimming duplicate boundaries when stitching two streams.
export const longestSuffixPrefixOverlap = (a: string, b: string): number => {
  if (!a || !b) return 0;
  const max = Math.min(a.length, b.length);
  for (let len = max; len > 0; len -= 1) {
    if (a.slice(a.length - len) === b.slice(0, len)) {
      return len;
    }
  }
  return 0;
};

