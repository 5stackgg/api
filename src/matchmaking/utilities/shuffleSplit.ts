/**
 * Fisher-Yates shuffle, then an even cut. Replaces `sort(() => Math.random() - 0.5)`,
 * which is not a uniform shuffle - it biases toward leaving items near where
 * they started, so a party would keep getting similar teams.
 */
export function shuffleSplit<T>(
  items: T[],
  random: () => number = Math.random,
): [T[], T[]] {
  const shuffled = [...items];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const half = Math.floor(shuffled.length / 2);

  return [shuffled.slice(0, half), shuffled.slice(half)];
}
