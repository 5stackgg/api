import { e_veto_pick_types_enum } from "../../generated";

const basePattern: Array<e_veto_pick_types_enum> = [
  "Ban",
  "Ban",
  "Pick",
  "Pick",
];

export default function getVetoPattern(pool: Array<string>, bestOf: number) {
  const pattern: Array<e_veto_pick_types_enum> = [];

  while (pattern.length !== pool.length - 1) {
    const picks: Array<e_veto_pick_types_enum> = pattern.filter(
      (type) => type === "Pick",
    );

    if (picks.length === bestOf - 1) {
      pattern.push("Ban");
      continue;
    }

    const picksLeft = pool.length - pattern.length - 1;

    if (picksLeft < picks.length + 2) {
      pattern.push("Pick");
      continue;
    }

    pattern.push(...basePattern.slice(0, picksLeft));
  }

  let patternLength = pattern.length;

  for (let i = 0; i < patternLength; i++) {
    if (pattern[i] === "Pick") {
      pattern.splice(i + 1, 0, "Side");
      patternLength++;
    }
  }

  return pattern;
}
