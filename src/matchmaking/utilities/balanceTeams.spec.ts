import { e_match_types_enum } from "generated";
import { MatchmakingLobby } from "../types/MatchmakingLobby";
import {
  balanceTeams,
  canFillTeams,
  greedyAssign,
  matchCost,
} from "./balanceTeams";
import { TIE_EPSILON } from "./matchmakingTuning";

const NOW = 1_700_000_000_000;
const COMPETITIVE: e_match_types_enum = "Competitive";

let nextLobbyId = 0;

function lobby(
  ranks: number[],
  overrides?: { id?: string; waitSeconds?: number; type?: e_match_types_enum },
): MatchmakingLobby {
  const waitSeconds = overrides?.waitSeconds ?? 30;

  return {
    type: overrides?.type ?? COMPETITIVE,
    regions: ["us-east"],
    joinedAt: new Date(NOW - waitSeconds * 1000),
    lobbyId: overrides?.id ?? `lobby-${++nextLobbyId}`,
    players: ranks.map((rank, index) => ({
      steam_id: `${overrides?.id ?? `lobby-${nextLobbyId}`}-p${index}`,
      rank,
    })),
    regionPositions: {},
    avgRank: ranks.reduce((acc, rank) => acc + rank, 0) / ranks.length,
  };
}

function solos(ranks: number[]): MatchmakingLobby[] {
  return ranks.map((rank) => lobby([rank]));
}

function teamRanks(team: MatchmakingLobby[]): number[] {
  return team.flatMap((entry) => entry.players.map((player) => player.rank));
}

function average(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function greedyGap(
  candidates: MatchmakingLobby[],
  requiredPlayers: number,
): number | null {
  const result = greedyAssign(candidates, requiredPlayers);
  if (!result) {
    return null;
  }
  return Math.abs(
    average(teamRanks(result.team1)) - average(teamRanks(result.team2)),
  );
}

// deterministic prng so the fuzz cases are reproducible
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const options = { now: NOW, random: () => 0 };

describe("balanceTeams", () => {
  beforeEach(() => {
    nextLobbyId = 0;
  });

  describe("beats the previous greedy assignment", () => {
    it("finds a perfect split where greedy is off by 1120 elo", () => {
      // total 48000, so a 24000/24000 split exists:
      //   6000 5800 5600 5400 1200  vs  5200 5000 4800 4600 4400
      // greedy places the 1200 last and can never move it.
      const ranks = [
        6000, 5800, 5600, 5400, 5200, 5000, 4800, 4600, 4400, 1200,
      ];
      const candidates = solos(ranks);

      expect(greedyGap(candidates, 10)).toBe(1120);

      const result = balanceTeams(candidates, 10, options);

      expect(result).not.toBeNull();
      expect(result.avgRankDifference).toBe(0);
      expect(result.team1.length + result.team2.length).toBe(10);
      expect(result.unused).toHaveLength(0);
    });

    it("skips a lobby entirely, which greedy has no move for", () => {
      // the duo of 9000s poisons any team it lands on; the right answer is to
      // leave it in the queue and play the ten 5000s.
      const anchor = lobby([5000], { id: "anchor" });
      const duo = lobby([9000, 9000], { id: "duo" });
      const rest = solos(new Array(12).fill(5000));
      const candidates = [anchor, duo, ...rest];

      const greedy = greedyGap(candidates, 10);
      expect(greedy).toBeGreaterThan(0);

      const result = balanceTeams(candidates, 10, options);

      expect(result.avgRankDifference).toBe(0);
      expect(result.spread).toBe(0);
      expect(result.unused.map((entry) => entry.lobbyId)).toContain("duo");
      expect(teamRanks([...result.team1, ...result.team2])).not.toContain(9000);
    });

    it("never returns a costlier match than greedy across random queues", () => {
      const random = mulberry32(20260726);
      let compared = 0;

      for (let iteration = 0; iteration < 500; iteration++) {
        nextLobbyId = 0;
        const lobbyCount = 3 + Math.floor(random() * 14);
        const candidates: MatchmakingLobby[] = [];

        for (let i = 0; i < lobbyCount; i++) {
          const size = 1 + Math.floor(random() * 5);
          const ranks = Array.from(
            { length: size },
            () => 2000 + Math.floor(random() * 7000),
          );
          candidates.push(lobby(ranks, { waitSeconds: 10 }));
        }

        const greedy = greedyAssign(candidates, 10);
        const result = balanceTeams(candidates, 10, {
          now: NOW,
          random: () => 0,
        });

        // greedy has no anchor concept, so only compare when it happened to
        // keep the anchor - otherwise the two are solving different problems
        if (
          !greedy ||
          ![...greedy.team1, ...greedy.team2].includes(candidates[0])
        ) {
          continue;
        }

        compared++;
        expect(result).not.toBeNull();
        expect(result.cost).toBeLessThanOrEqual(
          matchCost(greedy.team1, greedy.team2, 10, NOW).cost + 1e-9,
        );
      }

      expect(compared).toBeGreaterThan(50);
    });

    it("reports a cost that matches the split it returned", () => {
      const candidates = solos([
        6000, 5800, 5600, 5400, 5200, 5000, 4800, 4600, 4400, 1200,
      ]);
      const result = balanceTeams(candidates, 10, options);

      expect(result.cost).toBeCloseTo(
        matchCost(result.team1, result.team2, 10, NOW).cost,
        9,
      );
    });
  });

  describe("constraints", () => {
    it("keeps parties together and on opposite teams when forced", () => {
      // two trios plus four solos: the only legal shape puts one trio on each
      // side, 18000+10000 vs 12000+10000
      const candidates = [
        lobby([6000, 6000, 6000], { id: "trio-high" }),
        lobby([4000, 4000, 4000], { id: "trio-low" }),
        ...solos([5000, 5000, 5000, 5000]),
      ];

      const result = balanceTeams(candidates, 10, options);

      expect(result).not.toBeNull();
      expect(result.team1).toHaveLength(3);
      expect(result.team2).toHaveLength(3);
      expect(result.avgRankDifference).toBe(1200);

      const high = [...result.team1, ...result.team2].find(
        (entry) => entry.lobbyId === "trio-high",
      );
      const low = [...result.team1, ...result.team2].find(
        (entry) => entry.lobbyId === "trio-low",
      );
      expect(high).toBeDefined();
      expect(low).toBeDefined();
      expect(result.team1.includes(high)).not.toBe(result.team1.includes(low));
    });

    it("returns null when party sizes cannot fill two lineups", () => {
      // five duos is ten players, but 2s cannot sum to 5
      const candidates = [
        lobby([5000, 5000]),
        lobby([5000, 5000]),
        lobby([5000, 5000]),
        lobby([5000, 5000]),
        lobby([5000, 5000]),
      ];

      expect(canFillTeams([2, 2, 2, 2, 2], 10)).toBe(false);
      expect(balanceTeams(candidates, 10, options)).toBeNull();
    });

    it("always plays the anchor", () => {
      const random = mulberry32(7);

      for (let iteration = 0; iteration < 200; iteration++) {
        nextLobbyId = 0;
        const candidates: MatchmakingLobby[] = [];
        for (let i = 0; i < 6 + Math.floor(random() * 8); i++) {
          const size = 1 + Math.floor(random() * 5);
          candidates.push(
            lobby(
              Array.from(
                { length: size },
                () => 2000 + Math.floor(random() * 7000),
              ),
              { waitSeconds: 10 },
            ),
          );
        }

        const result = balanceTeams(candidates, 10, {
          now: NOW,
          random: () => 0,
        });
        if (!result) {
          continue;
        }

        const played = [...result.team1, ...result.team2];
        expect(played).toContain(candidates[0]);
      }
    });

    it("holds its invariants across random queues", () => {
      const random = mulberry32(99);

      for (let iteration = 0; iteration < 300; iteration++) {
        nextLobbyId = 0;
        const candidates: MatchmakingLobby[] = [];
        for (let i = 0; i < 4 + Math.floor(random() * 12); i++) {
          const size = 1 + Math.floor(random() * 5);
          candidates.push(
            lobby(
              Array.from(
                { length: size },
                () => 2000 + Math.floor(random() * 7000),
              ),
              { waitSeconds: 10 },
            ),
          );
        }

        const result = balanceTeams(candidates, 10, {
          now: NOW,
          random: () => 0,
        });
        if (!result) {
          continue;
        }

        expect(teamRanks(result.team1)).toHaveLength(5);
        expect(teamRanks(result.team2)).toHaveLength(5);

        const played = [...result.team1, ...result.team2];
        expect(new Set(played).size).toBe(played.length);
        expect(new Set([...played, ...result.unused]).size).toBe(
          candidates.length,
        );

        const steamIds = played.flatMap((entry) =>
          entry.players.map((player) => player.steam_id),
        );
        expect(new Set(steamIds).size).toBe(10);
      }
    });
  });

  describe("objective", () => {
    it("rejects an equal-average split made of extremes", () => {
      // {10000,10000,2000,2000,2000} vs {5200 x5} both average 5200, but the
      // spread term prices it out in favour of the tight cohort
      const candidates = [
        lobby([5200], { id: "anchor" }),
        ...solos(new Array(9).fill(5200)),
        ...solos([10000, 10000, 2000, 2000, 2000]),
      ];

      const result = balanceTeams(candidates, 10, options);

      expect(result.avgRankDifference).toBe(0);
      expect(result.spread).toBe(0);
      const played = teamRanks([...result.team1, ...result.team2]);
      expect(played).not.toContain(10000);
      expect(played).not.toContain(2000);
    });

    it("balances wingman (2v2)", () => {
      const candidates = solos([6000, 5000, 5000, 4000]);

      expect(greedyGap(candidates, 4)).toBe(1000);

      const result = balanceTeams(candidates, 4, options);

      expect(result.avgRankDifference).toBe(0);
      expect(result.team1).toHaveLength(2);
      expect(result.team2).toHaveLength(2);
    });

    it("balances duel (1v1) and leaves the mismatch queued", () => {
      const candidates = [
        lobby([5000], { id: "anchor" }),
        lobby([5100], { id: "close" }),
        lobby([8000], { id: "far" }),
      ];

      const result = balanceTeams(candidates, 2, options);

      expect(result.avgRankDifference).toBe(100);
      expect(result.unused.map((entry) => entry.lobbyId)).toEqual(["far"]);
    });
  });

  describe("variety", () => {
    const compositionOf = (result: { team1: MatchmakingLobby[] }) =>
      result.team1
        .map((entry) => entry.lobbyId)
        .sort()
        .join(",");

    it("does not hand the same ten players the same teams every time", () => {
      const random = mulberry32(1234);
      const candidates = solos(new Array(10).fill(5000));
      const seen = new Set<string>();

      for (let i = 0; i < 200; i++) {
        seen.add(
          compositionOf(balanceTeams(candidates, 10, { now: NOW, random })),
        );
      }

      // 126 distinct splits exist for ten interchangeable players. a fixed
      // candidate order would return the same one every time, which is what a
      // recurring group would experience as "always the same teams".
      expect(seen.size).toBeGreaterThan(50);
    });

    it("finds every perfectly balanced split once ratings have spread out", () => {
      const random = mulberry32(99);
      const candidates = [
        ...solos([6200, 5900, 5600]),
        ...solos([5100, 5000, 5000, 4900]),
        ...solos([4400, 4200, 3900]),
      ];
      const seen = new Set<string>();

      for (let i = 0; i < 200; i++) {
        const result = balanceTeams(candidates, 10, { now: NOW, random });
        seen.add(compositionOf(result));
        expect(result.avgRankDifference).toBe(0);
      }

      // exhaustive enumeration of this rating set says exactly 5 of the 126
      // partitions are dead even. variety here is bounded by the ratings, not
      // by the search - and it reaches all 5 rather than settling on one.
      expect(seen.size).toBe(5);
    });

    it("splits the strongest players up instead of stacking them", () => {
      const random = mulberry32(5);
      const strong = ["s0", "s1", "s2"];
      const candidates = [
        ...strong.map((id) => lobby([7000], { id })),
        ...solos(new Array(7).fill(4000)),
      ];

      for (let i = 0; i < 100; i++) {
        const result = balanceTeams(candidates, 10, { now: NOW, random });
        const onTeam1 = new Set(result.team1.map((entry) => entry.lobbyId));
        const stacked = strong.filter((id) => onTeam1.has(id)).length;

        // three strong on one side averages 5200 vs 4000; two versus one
        // averages 4800 vs 4400, so the balancer always breaks them up
        expect(stacked === 0 || stacked === 3).toBe(false);
      }
    });

    it("keeps mixing the winners as their ratings pull away", () => {
      // the three strongest keep winning and the three weakest keep losing, so
      // the spread widens every round. the teams should keep churning rather
      // than settling into a fixed lineup.
      const random = mulberry32(2026);
      const elo = new Map<string, number>(
        Array.from({ length: 10 }, (_, i) => [`p${i}`, 5000]),
      );
      const winners = new Set(["p0", "p1", "p2"]);
      const losers = new Set(["p7", "p8", "p9"]);

      const seen = new Set<string>();
      let stackedRounds = 0;
      let widestGap = 0;

      for (let round = 0; round < 40; round++) {
        const candidates = [...elo.entries()].map(([id, rank]) =>
          lobby([rank], { id }),
        );

        const result = balanceTeams(candidates, 10, { now: NOW, random });
        expect(result).not.toBeNull();

        seen.add(compositionOf(result));
        widestGap = Math.max(widestGap, result.avgRankDifference);

        const onTeam1 = new Set(result.team1.map((entry) => entry.lobbyId));
        const together = [...winners].filter((id) => onTeam1.has(id)).length;
        if (together === 0 || together === 3) {
          stackedRounds++;
        }

        for (const id of elo.keys()) {
          if (winners.has(id)) {
            elo.set(id, elo.get(id) + 40);
          } else if (losers.has(id)) {
            elo.set(id, elo.get(id) - 40);
          }
        }
      }

      // ratings really did diverge over the run
      expect(elo.get("p0") - elo.get("p9")).toBe(3200);

      // and the balancer kept producing different lineups rather than locking in
      expect(seen.size).toBeGreaterThan(20);
      expect(stackedRounds).toBe(0);

      // while still keeping every one of those games close
      expect(widestGap).toBeLessThan(200);
    });

    it("rotates which of the top three play together as the field pulls apart", () => {
      // the three strongest win every game and the three weakest lose every one
      // at a different rate, so the ratings spread unevenly and dead even splits
      // stop existing. counting lineups is not enough here - the ratings change
      // every round, so even a fixed candidate order produces new lineups. what
      // matters is whether the same two of the top three keep landing together.
      const winners = ["p0", "p1", "p2"];
      const losers = new Set(["p7", "p8", "p9"]);
      const pairs = [
        ["p0", "p1"],
        ["p0", "p2"],
        ["p1", "p2"],
      ];
      const rounds = 40;

      for (const seed of [2026, 7, 555, 31337]) {
        const random = mulberry32(seed);
        const elo = new Map<string, number>(
          Array.from({ length: 10 }, (_, i) => [`p${i}`, 5000]),
        );

        const pairedRounds = new Map(pairs.map(([a, b]) => [`${a}|${b}`, 0]));
        const teammates = new Map(winners.map((id) => [id, new Set<string>()]));
        const seen = new Set<string>();
        let longestRepeat = 0;
        let repeat = 0;
        let previousCarve = "";
        let widestGap = 0;

        for (let round = 0; round < rounds; round++) {
          const candidates = [...elo.entries()].map(([id, rank]) =>
            lobby([rank], { id }),
          );

          const result = balanceTeams(candidates, 10, { now: NOW, random });
          expect(result).not.toBeNull();

          const onTeam1 = new Set(result.team1.map((entry) => entry.lobbyId));
          const sideOf = (id: string) => (onTeam1.has(id) ? 1 : 2);

          seen.add(compositionOf(result));
          widestGap = Math.max(widestGap, result.avgRankDifference);

          for (const [a, b] of pairs) {
            if (sideOf(a) === sideOf(b)) {
              const key = `${a}|${b}`;
              pairedRounds.set(key, pairedRounds.get(key) + 1);
            }
          }

          for (const id of winners) {
            for (const other of elo.keys()) {
              if (other !== id && sideOf(other) === sideOf(id)) {
                teammates.get(id).add(other);
              }
            }
          }

          // which of the top three sat together, independent of side
          const carve = winners
            .map((id) => (sideOf(id) === sideOf(winners[0]) ? "a" : "b"))
            .join("");
          repeat = carve === previousCarve ? repeat + 1 : 1;
          previousCarve = carve;
          longestRepeat = Math.max(longestRepeat, repeat);

          for (const id of elo.keys()) {
            if (winners.includes(id)) {
              elo.set(id, elo.get(id) + 40);
            } else if (losers.has(id)) {
              elo.set(id, elo.get(id) - 25);
            }
          }
        }

        // the field really did pull apart, and unevenly
        expect(elo.get("p0") - elo.get("p9")).toBe(2600);

        // none of the top three ends up with a fixed circle - each one plays
        // alongside every other player at some point over the run
        for (const id of winners) {
          expect(teammates.get(id).size).toBe(9);
        }

        // an even rotation puts each pair together a third of the time. the
        // bounds are loose, but a pair that has calcified sits at one extreme:
        // before the tie-break was randomised one pair shared a team 36 rounds
        // out of 40 while another never shared one at all.
        for (const together of pairedRounds.values()) {
          expect(together).toBeGreaterThan(3);
          expect(together).toBeLessThan(28);
        }

        // and no single carve of the top three survives for long
        expect(longestRepeat).toBeLessThanOrEqual(12);
        expect(seen.size).toBeGreaterThanOrEqual(18);

        // the spread is absorbed rather than pushed into the scoreline
        expect(widestGap).toBeLessThan(150);
      }
    });

    it("collects alternatives before bailing out on a tightly packed field", () => {
      // every rating here is distinct but only 60 elo separates first from
      // last, so no two players sit the same distance from the reference and
      // the random tie-break never gets a tie to break. the only thing keeping
      // this group off identical teams is the search collecting alternatives
      // instead of returning the first good split it walks into - bailing on
      // the first leaf pins this exact field to one lineup, on every seed.
      const tight = [5021, 5015, 5011, 5003, 4996, 4988, 4983, 4975, 4968, 4961];

      for (const seed of [1, 99, 2026]) {
        const random = mulberry32(seed);
        const candidates = tight.map((rank, index) =>
          lobby([rank], { id: `p${index}` }),
        );
        const seen = new Set<string>();
        let widestGap = 0;

        for (let i = 0; i < 200; i++) {
          const result = balanceTeams(candidates, 10, { now: NOW, random });
          seen.add(compositionOf(result));
          widestGap = Math.max(widestGap, result.avgRankDifference);
        }

        expect(seen.size).toBeGreaterThanOrEqual(12);

        // the variety is not bought with worse games. these alternatives are
        // all inside TIE_EPSILON, so the widest is a rounding error next to
        // the 60 elo the field already spans
        expect(widestGap).toBeLessThanOrEqual(TIE_EPSILON);
      }
    });
  });

  describe("search bounds", () => {
    it("falls back to the greedy seed when the node budget is exhausted", () => {
      const candidates = solos([
        6000, 5800, 5600, 5400, 5200, 5000, 4800, 4600, 4400, 1200,
      ]);

      const result = balanceTeams(candidates, 10, {
        now: NOW,
        random: () => 0,
        nodeBudget: 1,
      });

      expect(result).not.toBeNull();
      expect(result.exhausted).toBe(false);
      expect(result.team1).toHaveLength(5);
      expect(result.team2).toHaveLength(5);
      // still no worse than today's behaviour
      expect(result.avgRankDifference).toBeLessThanOrEqual(1120);
    });

    it("stays inside the node budget on a full window of solo lobbies", () => {
      const random = mulberry32(4242);
      const candidates = Array.from({ length: 16 }, () =>
        lobby([2000 + Math.floor(random() * 7000)], { waitSeconds: 10 }),
      );

      const result = balanceTeams(candidates, 10, {
        now: NOW,
        random: () => 0,
      });

      expect(result).not.toBeNull();
      expect(result.nodesVisited).toBeLessThanOrEqual(150_000);
    });

    it("is deterministic when the tie-break rng is fixed", () => {
      const candidates = solos([
        5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000,
      ]);

      const runs = Array.from({ length: 10 }, () =>
        balanceTeams(candidates, 10, { now: NOW, random: () => 0 })
          .team1.map((entry) => entry.lobbyId)
          .sort()
          .join(","),
      );

      expect(new Set(runs).size).toBe(1);
    });
  });
});

describe("canFillTeams", () => {
  it.each([
    [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 10, true],
    [[5, 5], 10, true],
    [[3, 2, 3, 2], 10, true],
    [[2, 2, 2, 2, 2], 10, false],
    [[3, 3, 3, 3], 10, false],
    [[4, 4, 4], 10, false],
    [[4, 4, 1, 1], 10, true],
    [[3, 2, 4, 1], 10, true],
    [[1, 1, 1, 1], 4, true],
    [[2, 2], 4, true],
    [[1, 1], 2, true],
  ])("canFillTeams(%p, %i) === %p", (sizes, requiredPlayers, expected) => {
    expect(canFillTeams(sizes as number[], requiredPlayers as number)).toBe(
      expected,
    );
  });
});
