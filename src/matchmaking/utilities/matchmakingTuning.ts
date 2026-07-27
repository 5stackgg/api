// mirrors _default_elo / _scale_factor in hasura/functions/match/match_player_elo.sql
export const DEFAULT_ELO = 5000;
export const ELO_SCALE_FACTOR = 4000;

// cost weights - every term is in "elo points of team average difference"
export const SPREAD_WEIGHT = 0.15;
export const SPREAD_FREE_BAND = 1000;
export const WAIT_WEIGHT = 25;
export const WAIT_SATURATION_SECONDS = 120;

// splits within TIE_EPSILON of each other are treated as equally good and
// picked between at random, so a recurring group doesn't get the same teams
// every night
export const TIE_EPSILON = 10;
export const EARLY_EXIT_COST = 5;

// max lobbies claimed and searched per match, and the hard ceiling on search
// nodes. 16 lobbies is ~630k leaves unpruned for 5v5, roughly 10ms of cpu.
export const WINDOW_CAP = 16;
export const NODE_BUDGET = 150_000;

// the acceptable rank gap to the longest waiting lobby, widening the longer
// they have been queued
export const RANK_WINDOW_BASE = 500;
export const RANK_WINDOW_GROWTH_PER_SECOND = 25;
export const RANK_WINDOW_MAX = 4000;

export function getRankWindow(waitSeconds: number) {
  return Math.min(
    RANK_WINDOW_MAX,
    RANK_WINDOW_BASE + RANK_WINDOW_GROWTH_PER_SECOND * Math.max(0, waitSeconds),
  );
}

/** Expected win rate for the stronger team, using the same curve as the elo engine. */
export function winProbability(avgRankDifference: number) {
  return 1 / (1 + Math.pow(10, -Math.abs(avgRankDifference) / ELO_SCALE_FACTOR));
}
