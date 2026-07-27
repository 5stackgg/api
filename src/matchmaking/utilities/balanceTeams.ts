import { BalancedTeams } from "../types/BalancedTeams";
import { MatchmakingLobby } from "../types/MatchmakingLobby";
import { joinedAtMillis } from "./selectMatchCandidates";
import {
  EARLY_EXIT_COST,
  NODE_BUDGET,
  SPREAD_FREE_BAND,
  SPREAD_WEIGHT,
  TIE_EPSILON,
  WAIT_SATURATION_SECONDS,
  WAIT_WEIGHT,
} from "./matchmakingTuning";

const UNUSED = 0;
const TEAM_1 = 1;
const TEAM_2 = 2;

const MAX_TIED_SOLUTIONS = 16;

export interface BalanceTeamsOptions {
  now?: number;
  nodeBudget?: number;
  random?: () => number;
  // candidates[0] is the longest waiting lobby and is forced into the match
  pinAnchor?: boolean;
}

interface LobbyStats {
  size: number;
  rankSum: number;
  minRank: number;
  maxRank: number;
  waitMillis: number;
}

/**
 * Can these lobby sizes be split into two teams of exactly requiredPlayers / 2,
 * given that a lobby can never be split across teams?
 */
export function canFillTeams(sizes: number[], requiredPlayers: number): boolean {
  const half = requiredPlayers / 2;

  if (!Number.isInteger(half) || half <= 0) {
    return false;
  }

  const width = half + 1;
  let reach = new Uint8Array(width * width);
  reach[0] = 1;

  for (const size of sizes) {
    if (size <= 0 || size > half) {
      continue;
    }

    const next = Uint8Array.from(reach);
    for (let a = 0; a <= half; a++) {
      for (let b = 0; b <= half; b++) {
        if (!reach[a * width + b]) {
          continue;
        }
        if (a + size <= half) {
          next[(a + size) * width + b] = 1;
        }
        if (b + size <= half) {
          next[a * width + b + size] = 1;
        }
      }
    }
    reach = next;
  }

  return reach[half * width + half] === 1;
}

/**
 * The pre-existing greedy assignment, kept so the search can be seeded with it.
 * That seed is what guarantees the new balancer is never worse than the old
 * behaviour, even when the node budget truncates the search - do not remove it.
 */
export function greedyAssign(
  candidates: MatchmakingLobby[],
  requiredPlayers: number,
): { team1: MatchmakingLobby[]; team2: MatchmakingLobby[] } | null {
  const half = requiredPlayers / 2;
  const team1: MatchmakingLobby[] = [];
  const team2: MatchmakingLobby[] = [];

  let count1 = 0;
  let count2 = 0;
  let sum1 = 0;
  let sum2 = 0;

  for (const lobby of candidates) {
    const size = lobby.players.length;
    const hasRoom1 = count1 + size <= half;
    const hasRoom2 = count2 + size <= half;

    if (!hasRoom1 && !hasRoom2) {
      continue;
    }

    const lobbySum = lobby.players.reduce((acc, player) => acc + player.rank, 0);

    let target: typeof TEAM_1 | typeof TEAM_2;
    if (!hasRoom1) {
      target = TEAM_2;
    } else if (!hasRoom2) {
      target = TEAM_1;
    } else {
      const new1 = (sum1 + lobbySum) / (count1 + size);
      const new2 = (sum2 + lobbySum) / (count2 + size);
      const current1 = count1 > 0 ? sum1 / count1 : 0;
      const current2 = count2 > 0 ? sum2 / count2 : 0;
      target =
        Math.abs(new1 - current2) <= Math.abs(current1 - new2)
          ? TEAM_1
          : TEAM_2;
    }

    if (target === TEAM_1) {
      team1.push(lobby);
      count1 += size;
      sum1 += lobbySum;
    } else {
      team2.push(lobby);
      count2 += size;
      sum2 += lobbySum;
    }
  }

  if (count1 !== half || count2 !== half) {
    return null;
  }

  return { team1, team2 };
}

/** The objective, over a finished match. Exported so callers and tests score the same way. */
export function matchCost(
  team1: MatchmakingLobby[],
  team2: MatchmakingLobby[],
  requiredPlayers: number,
  now: number = Date.now(),
) {
  const half = requiredPlayers / 2;
  const played = [...team1, ...team2];
  const ranks = played.flatMap((lobby) =>
    lobby.players.map((player) => player.rank),
  );
  const sumOf = (team: MatchmakingLobby[]) =>
    team.reduce(
      (acc, lobby) =>
        acc + lobby.players.reduce((total, player) => total + player.rank, 0),
      0,
    );

  const avgRankDifference = Math.abs(sumOf(team1) - sumOf(team2)) / half;
  const spread = Math.max(...ranks) - Math.min(...ranks);
  const quality =
    avgRankDifference +
    SPREAD_WEIGHT * Math.max(0, spread - SPREAD_FREE_BAND);

  const waitMillis = played.reduce(
    (acc, lobby) =>
      acc +
      Math.max(0, now - joinedAtMillis(lobby.joinedAt)) * lobby.players.length,
    0,
  );
  const avgWaitSeconds = waitMillis / requiredPlayers / 1000;
  const wait =
    WAIT_WEIGHT *
    (1 - Math.min(1, Math.max(0, avgWaitSeconds / WAIT_SATURATION_SECONDS)));

  return { cost: quality + wait, quality, avgRankDifference, spread };
}

/**
 * Chooses which of `candidates` play and how they split into two even teams.
 *
 * Both teams always end up with exactly h = requiredPlayers / 2 players, so
 * |avg(team1) - avg(team2)| reduces to |sum1 - sum2| / h and the primary
 * objective is an integer subset-difference problem. Each lobby independently
 * goes to team1, team2 or unused, which means one search picks the cohort and
 * the split together - the two cannot be separated, because the spread term
 * only distinguishes cohorts while the balance term only distinguishes splits.
 *
 * Pure and synchronous. Returns null when no exact partition exists.
 */
export function balanceTeams(
  candidates: MatchmakingLobby[],
  requiredPlayers: number,
  options?: BalanceTeamsOptions,
): BalancedTeams | null {
  const half = requiredPlayers / 2;

  if (!Number.isInteger(half) || half <= 0) {
    return null;
  }

  const now = options?.now ?? Date.now();
  const nodeBudget = options?.nodeBudget ?? NODE_BUDGET;
  const random = options?.random ?? Math.random;
  const pinAnchor = options?.pinAnchor ?? true;

  const usable = candidates.filter(
    (lobby) => lobby.players.length > 0 && lobby.players.length <= half,
  );

  if (!canFillTeams(
    usable.map((lobby) => lobby.players.length),
    requiredPlayers,
  )) {
    return null;
  }

  const anchorId = pinAnchor ? candidates.at(0)?.lobbyId : undefined;
  const anchor = anchorId
    ? usable.find((lobby) => lobby.lobbyId === anchorId)
    : undefined;

  // depth first search only finds good cohorts early if the lobbies that pair
  // best with the anchor come first. outliers sort to the tail, where the
  // "leave it queued" branch gets reached long before the node budget runs out.
  const reference = anchor?.avgRank ?? usable.at(0)?.avgRank ?? 0;
  const order = [...usable].sort((a, b) => {
    if (a === anchor) {
      return -1;
    }
    if (b === anchor) {
      return 1;
    }

    const rankDiff =
      Math.abs(a.avgRank - reference) - Math.abs(b.avgRank - reference);
    return rankDiff !== 0 ? rankDiff : a.lobbyId.localeCompare(b.lobbyId);
  });

  const size = order.length;
  const anchorIndex = anchor ? order.indexOf(anchor) : -1;

  const stats: LobbyStats[] = order.map((lobby) => {
    const ranks = lobby.players.map((player) => player.rank);
    return {
      size: lobby.players.length,
      rankSum: ranks.reduce((acc, rank) => acc + rank, 0),
      minRank: Math.min(...ranks),
      maxRank: Math.max(...ranks),
      waitMillis: Math.max(0, now - joinedAtMillis(lobby.joinedAt)),
    };
  });

  // --- suffix precomputation. the candidate order is fixed, so the set of
  // lobbies still available at depth d is always exactly order[d..size-1].
  const width = half + 1;
  const suffixPlayers = new Array<number>(size + 1).fill(0);
  const suffixReach: Uint8Array[] = new Array(size + 1);
  const suffixTopSum: number[][] = new Array(size + 1);
  const suffixBottomSum: number[][] = new Array(size + 1);

  suffixReach[size] = new Uint8Array(width * width);
  suffixReach[size][0] = 1;
  suffixTopSum[size] = new Array<number>(half + 1).fill(0);
  suffixBottomSum[size] = new Array<number>(half + 1).fill(0);

  const suffixRanks: number[] = [];
  for (let d = size - 1; d >= 0; d--) {
    suffixPlayers[d] = suffixPlayers[d + 1] + stats[d].size;

    const previous = suffixReach[d + 1];
    const reach = Uint8Array.from(previous);
    for (let a = 0; a <= half; a++) {
      for (let b = 0; b <= half; b++) {
        if (!previous[a * width + b]) {
          continue;
        }
        if (a + stats[d].size <= half) {
          reach[(a + stats[d].size) * width + b] = 1;
        }
        if (b + stats[d].size <= half) {
          reach[a * width + b + stats[d].size] = 1;
        }
      }
    }
    suffixReach[d] = reach;

    suffixRanks.push(...order[d].players.map((player) => player.rank));
    suffixRanks.sort((a, b) => a - b);

    const top = new Array<number>(half + 1).fill(0);
    const bottom = new Array<number>(half + 1).fill(0);
    for (let k = 1; k <= half; k++) {
      top[k] =
        k <= suffixRanks.length
          ? top[k - 1] + suffixRanks[suffixRanks.length - k]
          : top[k - 1];
      bottom[k] =
        k <= suffixRanks.length ? bottom[k - 1] + suffixRanks[k - 1] : bottom[k - 1];
    }
    suffixTopSum[d] = top;
    suffixBottomSum[d] = bottom;
  }

  // balance + spread. the part of the objective that measures how good the
  // game itself is, which is what the early exit is judged on.
  const quality = (
    sum1: number,
    sum2: number,
    minRank: number,
    maxRank: number,
  ) =>
    Math.abs(sum1 - sum2) / half +
    SPREAD_WEIGHT * Math.max(0, maxRank - minRank - SPREAD_FREE_BAND);

  const cost = (
    sum1: number,
    sum2: number,
    minRank: number,
    maxRank: number,
    waitMillis: number,
  ) => {
    const avgWaitSeconds = waitMillis / requiredPlayers / 1000;
    const wait =
      WAIT_WEIGHT *
      (1 - Math.min(1, Math.max(0, avgWaitSeconds / WAIT_SATURATION_SECONDS)));

    return quality(sum1, sum2, minRank, maxRank) + wait;
  };

  const assign = new Uint8Array(size);
  let reservoir: Uint8Array[] = [];
  let bestCost = Number.POSITIVE_INFINITY;
  let bestQuality = Number.POSITIVE_INFINITY;
  let nodesVisited = 0;
  let exhausted = true;
  let stop = false;

  const seed = greedyAssign(order, requiredPlayers);
  if (seed) {
    const seeded = new Uint8Array(size);
    let sum1 = 0;
    let sum2 = 0;
    let minRank = Number.POSITIVE_INFINITY;
    let maxRank = Number.NEGATIVE_INFINITY;
    let waitMillis = 0;

    for (let i = 0; i < size; i++) {
      const inTeam1 = seed.team1.includes(order[i]);
      const inTeam2 = seed.team2.includes(order[i]);
      if (!inTeam1 && !inTeam2) {
        continue;
      }
      seeded[i] = inTeam1 ? TEAM_1 : TEAM_2;
      if (inTeam1) {
        sum1 += stats[i].rankSum;
      } else {
        sum2 += stats[i].rankSum;
      }
      minRank = Math.min(minRank, stats[i].minRank);
      maxRank = Math.max(maxRank, stats[i].maxRank);
      waitMillis += stats[i].waitMillis * stats[i].size;
    }

    // the greedy pass has no concept of an anchor, so its answer is only a
    // usable seed when it happens to include one
    if (anchorIndex < 0 || seeded[anchorIndex] !== UNUSED) {
      bestCost = cost(sum1, sum2, minRank, maxRank, waitMillis);
      bestQuality = quality(sum1, sum2, minRank, maxRank);
      reservoir = [seeded];
    }
  }

  const record = (
    sum1: number,
    sum2: number,
    minRank: number,
    maxRank: number,
    waitMillis: number,
  ) => {
    const candidateCost = cost(sum1, sum2, minRank, maxRank, waitMillis);

    if (candidateCost < bestCost - TIE_EPSILON) {
      bestCost = candidateCost;
      bestQuality = quality(sum1, sum2, minRank, maxRank);
      reservoir = [Uint8Array.from(assign)];
    } else if (candidateCost <= bestCost + TIE_EPSILON) {
      if (candidateCost < bestCost) {
        bestCost = candidateCost;
        bestQuality = quality(sum1, sum2, minRank, maxRank);
      }
      if (reservoir.length < MAX_TIED_SOLUTIONS) {
        reservoir.push(Uint8Array.from(assign));
      }
    }

    // judged on quality, not cost - the wait term is a per-cohort offset that
    // would otherwise make this fire always or never
    if (bestQuality <= EARLY_EXIT_COST) {
      exhausted = false;
      stop = true;
    }
  };

  const search = (
    depth: number,
    count1: number,
    count2: number,
    sum1: number,
    sum2: number,
    minRank: number,
    maxRank: number,
    waitMillis: number,
  ) => {
    if (stop) {
      return;
    }

    if (++nodesVisited > nodeBudget) {
      exhausted = false;
      stop = true;
      return;
    }

    if (count1 === half && count2 === half) {
      record(sum1, sum2, minRank, maxRank, waitMillis);
      return;
    }

    if (depth === size) {
      return;
    }

    const need1 = half - count1;
    const need2 = half - count2;

    if (suffixPlayers[depth] < need1 + need2) {
      return;
    }

    if (!suffixReach[depth][need1 * width + need2]) {
      return;
    }

    // admissible lower bound: the widest and narrowest final rank gap still
    // reachable, ignoring party atomicity, plus the spread already committed.
    // the wait term is always >= 0 so leaving it out only loosens the bound.
    const delta = sum1 - sum2;
    const maxDelta =
      delta + suffixTopSum[depth][need1] - suffixBottomSum[depth][need2];
    const minDelta =
      delta + suffixBottomSum[depth][need1] - suffixTopSum[depth][need2];
    const reachableGap =
      minDelta <= 0 && maxDelta >= 0
        ? 0
        : Math.min(Math.abs(minDelta), Math.abs(maxDelta));

    const committedSpread =
      maxRank > minRank
        ? SPREAD_WEIGHT * Math.max(0, maxRank - minRank - SPREAD_FREE_BAND)
        : 0;

    if (reachableGap / half + committedSpread >= bestCost + TIE_EPSILON) {
      return;
    }

    const stat = stats[depth];
    // nothing assigned yet: putting the first lobby on team2 just mirrors
    // team1, so only explore one of them
    const mirrored = count1 === 0 && count2 === 0;
    const sides =
      mirrored || delta <= 0 ? [TEAM_1, TEAM_2] : [TEAM_2, TEAM_1];

    for (const side of sides) {
      if (mirrored && side === TEAM_2) {
        continue;
      }
      if (side === TEAM_1 && count1 + stat.size > half) {
        continue;
      }
      if (side === TEAM_2 && count2 + stat.size > half) {
        continue;
      }

      assign[depth] = side;
      search(
        depth + 1,
        side === TEAM_1 ? count1 + stat.size : count1,
        side === TEAM_2 ? count2 + stat.size : count2,
        side === TEAM_1 ? sum1 + stat.rankSum : sum1,
        side === TEAM_2 ? sum2 + stat.rankSum : sum2,
        Math.min(minRank, stat.minRank),
        Math.max(maxRank, stat.maxRank),
        waitMillis + stat.waitMillis * stat.size,
      );
      assign[depth] = UNUSED;
    }

    // the anchor has to play, so it never gets the unused branch
    if (depth === anchorIndex) {
      return;
    }

    search(depth + 1, count1, count2, sum1, sum2, minRank, maxRank, waitMillis);
  };

  search(
    0,
    0,
    0,
    0,
    0,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
  );

  if (reservoir.length === 0) {
    return null;
  }

  const chosen =
    reservoir[Math.min(reservoir.length - 1, Math.floor(random() * reservoir.length))];

  const team1 = order.filter((_, index) => chosen[index] === TEAM_1);
  const team2 = order.filter((_, index) => chosen[index] === TEAM_2);
  const used = new Set([...team1, ...team2]);
  const unused = candidates.filter((lobby) => !used.has(lobby));

  // scored from the split actually returned, which may be any of the tied
  // solutions rather than the one that last set bestCost
  const scored = matchCost(team1, team2, requiredPlayers, now);

  return {
    team1,
    team2,
    unused,
    avgRankDifference: scored.avgRankDifference,
    spread: scored.spread,
    cost: scored.cost,
    nodesVisited,
    exhausted,
  };
}
