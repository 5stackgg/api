const basePattern = ["Ban", "Ban", "Pick", "Pick"];

export default function getPattern(pool: Array<string>, bestOf: number) {
  const pattern: Array<string> = [];

  while(pattern.length !== pool.length - 1) {
    const picks: Array<string> = pattern.filter((type) => type === "Pick");

    if(picks.length === bestOf - 1) {
      pattern.push('Ban');
      continue;
    }

    const picksLeft = pool.length - pattern.length - 1;

    if(picksLeft < picks.length + 2) {
      pattern.push("Pick");
      continue;
    }

    pattern.push(...basePattern.slice(0, picksLeft));
  }

  return pattern;
}


