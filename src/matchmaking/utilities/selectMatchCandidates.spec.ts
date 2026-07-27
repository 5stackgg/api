import { e_match_types_enum } from "generated";
import { MatchmakingLobby } from "../types/MatchmakingLobby";
import { selectMatchCandidates } from "./selectMatchCandidates";
import { RANK_WINDOW_BASE } from "./matchmakingTuning";

const NOW = 1_700_000_000_000;
const COMPETITIVE: e_match_types_enum = "Competitive";

function lobby(
  id: string,
  ranks: number[],
  waitSeconds = 10,
): MatchmakingLobby {
  return {
    type: COMPETITIVE,
    regions: ["us-east"],
    joinedAt: new Date(NOW - waitSeconds * 1000),
    lobbyId: id,
    players: ranks.map((rank, index) => ({
      steam_id: `${id}-p${index}`,
      rank,
    })),
    regionPositions: {},
    avgRank: ranks.reduce((acc, rank) => acc + rank, 0) / ranks.length,
  };
}

function solos(count: number, rank: number, waitSeconds = 10) {
  return Array.from({ length: count }, (_, index) =>
    lobby(`solo-${index}`, [rank], waitSeconds),
  );
}

describe("selectMatchCandidates", () => {
  it("anchors on the longest waiting lobby", () => {
    const oldest = lobby("oldest", [5000], 300);
    const result = selectMatchCandidates(
      [...solos(10, 5000, 10), oldest],
      10,
      { now: NOW },
    );

    expect(result.anchor).toBe(oldest);
    expect(result.candidates[0]).toBe(oldest);
  });

  it("breaks equal wait times on lobby id so the order is stable", () => {
    const a = lobby("aaa", [5000], 10);
    const b = lobby("bbb", [5000], 10);
    const result = selectMatchCandidates([b, a, ...solos(9, 5000)], 10, {
      now: NOW,
    });

    expect(result.anchor.lobbyId).toBe("aaa");
  });

  it("orders the rest by rank proximity to the anchor", () => {
    const anchor = lobby("anchor", [5000], 300);
    const near = lobby("near", [5100]);
    const mid = lobby("mid", [5300]);
    const far = lobby("far", [5450]);

    const result = selectMatchCandidates(
      [far, mid, near, anchor, ...solos(7, 5000)],
      10,
      { now: NOW },
    );

    const ordered = result.candidates.map((entry) => entry.lobbyId);
    expect(ordered[0]).toBe("anchor");
    expect(ordered.indexOf("near")).toBeLessThan(ordered.indexOf("mid"));
    expect(ordered.indexOf("mid")).toBeLessThan(ordered.indexOf("far"));
  });

  it("drops lobbies too large to fit a lineup", () => {
    const oversized = lobby("oversized", [5000, 5000, 5000, 5000, 5000, 5000]);
    const result = selectMatchCandidates(
      [oversized, ...solos(10, 5000)],
      10,
      { now: NOW },
    );

    expect(result.candidates.map((entry) => entry.lobbyId)).not.toContain(
      "oversized",
    );
  });

  it("returns null when the queue cannot reach a full match", () => {
    expect(selectMatchCandidates(solos(9, 5000), 10, { now: NOW })).toBeNull();
  });

  it("enforces the rank window when it can still fill a match", () => {
    const anchor = lobby("anchor", [5000], 10);
    const smurf = lobby("smurf", [9000], 10);
    const result = selectMatchCandidates(
      [anchor, smurf, ...solos(10, 5000)],
      10,
      { now: NOW },
    );

    expect(Math.abs(smurf.avgRank - anchor.avgRank)).toBeGreaterThan(
      RANK_WINDOW_BASE,
    );
    expect(result.candidates.map((entry) => entry.lobbyId)).not.toContain(
      "smurf",
    );
  });

  it("widens the window the longer the anchor has waited", () => {
    const anchor = lobby("anchor", [5000], 300);
    const distant = lobby("distant", [7000], 10);
    const result = selectMatchCandidates(
      [anchor, distant, ...solos(10, 5000)],
      10,
      { now: NOW },
    );

    // 300s of waiting opens the window past a 2000 point gap
    expect(result.candidates.map((entry) => entry.lobbyId)).toContain(
      "distant",
    );
  });

  it("demotes rather than drops out of window lobbies on a thin queue", () => {
    const anchor = lobby("anchor", [5000], 10);
    const distant = lobby("distant", [9000], 10);
    const result = selectMatchCandidates(
      [anchor, distant, ...solos(8, 5000)],
      10,
      { now: NOW },
    );

    // only 10 players exist, so the queue plays rather than stalling
    expect(result.candidates).toHaveLength(10);
    expect(result.candidates.at(-1).lobbyId).toBe("distant");
  });

  it("returns null on a thin queue when the window is hard enforced", () => {
    const anchor = lobby("anchor", [5000], 10);
    const distant = lobby("distant", [9000], 10);

    expect(
      selectMatchCandidates([anchor, distant, ...solos(8, 5000)], 10, {
        now: NOW,
        softWindow: false,
      }),
    ).toBeNull();
  });
});
