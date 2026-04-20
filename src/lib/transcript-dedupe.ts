const MAX_OVERLAP_CHARS = 300;
const MIN_OVERLAP_CHARS = 10;

export const dedupeOverlap = (prevTail: string, newHead: string): string => {
  const normalizedPrevTail = prevTail.slice(-MAX_OVERLAP_CHARS);
  const normalizedNewHead = newHead.slice(0, MAX_OVERLAP_CHARS);
  const maxCandidateLength = Math.min(normalizedPrevTail.length, normalizedNewHead.length);

  for (let candidateLength = maxCandidateLength; candidateLength >= MIN_OVERLAP_CHARS; candidateLength -= 1) {
    const candidatePrefix = normalizedNewHead.slice(0, candidateLength);

    if (normalizedPrevTail.endsWith(candidatePrefix)) {
      return newHead.slice(candidateLength);
    }
  }

  return newHead;
};
