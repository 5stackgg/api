// One 64Hz sample of the run-up the practice plugin recorded before a release.
// t is milliseconds relative to the release tick, so the last sample is 0 and
// the rest are negative. buttons is the IN_* bitmask held on that tick.
export type UtilityApproachPoint = {
  t: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  pitch: number;
  yaw: number;
  buttons: number;
  on_ground: boolean;
  ducked: boolean;
};
