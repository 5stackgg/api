import { e_veto_pick_types_enum } from '../../generated/zeus';

const basePattern = [e_veto_pick_types_enum.Ban, e_veto_pick_types_enum.Ban, e_veto_pick_types_enum.Pick, e_veto_pick_types_enum.Pick];

export default function getVetoPattern(pool: Array<string>, bestOf: number) {
  const pattern: Array<string> = [];

  while(pattern.length !== pool.length - 1) {
    const picks: Array<string> = pattern.filter((type) => type === e_veto_pick_types_enum.Pick);

    if(picks.length === bestOf - 1) {
      pattern.push(e_veto_pick_types_enum.Ban);
      continue;
    }

    const picksLeft = pool.length - pattern.length - 1;

    if(picksLeft < picks.length + 2) {
      pattern.push(e_veto_pick_types_enum.Pick);
      continue;
    }

    pattern.push(...basePattern.slice(0, picksLeft));
  }

  let patternLength = pattern.length;

  for (let i = 0; i < patternLength; i++) {
    if (pattern[i] === e_veto_pick_types_enum.Pick) {
      pattern.splice(i + 1, 0, e_veto_pick_types_enum.Side);
      patternLength++
    }
  }

  return pattern;
}


