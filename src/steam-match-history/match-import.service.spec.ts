import { MatchImportService } from "./match-import.service";

// detectMatchType / computeStartingSides are pure private statics; reach them
// directly rather than standing up the whole Nest service with its deps.
const detectMatchTypeRaw = (
  MatchImportService as unknown as {
    detectMatchType: (parsed: unknown) => string;
  }
).detectMatchType;

// The detector now takes the parsed demo (players + game-rule signals).
const detectMatchType = (
  players: unknown[],
  rules: {
    overtime_enabled?: boolean;
    player_count?: number;
    max_rounds?: number;
    game_mode?: number;
    map_name?: string;
    server_name?: string;
  } = {},
) => detectMatchTypeRaw({ players, ...rules });

const computeStartingSides = (
  MatchImportService as unknown as {
    computeStartingSides: (parsed: unknown) => Map<string, "T" | "CT">;
  }
).computeStartingSides;

describe("MatchImportService.detectMatchType", () => {
  it("uses the majority rank_type, not the first player", () => {
    const players = [
      { steam_id: "1", name: "a", rank_type: 12 }, // outlier
      { steam_id: "2", name: "b", rank_type: 11 },
      { steam_id: "3", name: "c", rank_type: 11 },
      { steam_id: "4", name: "d", rank_type: 11 },
    ];
    expect(detectMatchType(players)).toBe("Premier");
  });

  it("maps Valve rank types (6=Wingman, 7=Competitive, 11=Premier)", () => {
    expect(detectMatchType([{ steam_id: "1", name: "a", rank_type: 6 }])).toBe(
      "Wingman",
    );
    expect(detectMatchType([{ steam_id: "1", name: "a", rank_type: 7 }])).toBe(
      "Competitive",
    );
    expect(detectMatchType([{ steam_id: "1", name: "a", rank_type: 11 }])).toBe(
      "Premier",
    );
  });

  it("falls back to player count when no rank_type is present", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
    }));
    expect(detectMatchType(five)).toBe("Competitive");
    expect(detectMatchType(five.slice(0, 3))).toBe("Wingman");
  });

  it("classifies 5v5 by overtime when rank_type is absent (CS2 competitive)", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
    }));
    // No overtime -> Competitive; overtime enabled -> Premier.
    expect(detectMatchType(five, { player_count: 10 })).toBe("Competitive");
    expect(
      detectMatchType(five, { player_count: 10, overtime_enabled: true }),
    ).toBe("Premier");
  });

  it("treats rank_type 10 (private/FACEIT) as Competitive, never Premier", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
      rank_type: 10,
    }));
    expect(
      detectMatchType(five, { player_count: 10, overtime_enabled: true }),
    ).toBe("Competitive");
  });

  it("treats 2v2 as Wingman regardless of overtime", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
    }));
    expect(
      detectMatchType(four, { player_count: 4, overtime_enabled: true }),
    ).toBe("Wingman");
  });

  it("classifies Wingman by game_mode/mp_maxrounds even when rank_type reads 7", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
      rank_type: 7,
    }));
    expect(detectMatchType(four, { player_count: 4, game_mode: 2 })).toBe(
      "Wingman",
    );
    expect(detectMatchType(four, { player_count: 4, max_rounds: 16 })).toBe(
      "Wingman",
    );
  });

  it("classifies game_mode 6 as Rush even when rank_type reads 7", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
      rank_type: 7,
    }));
    expect(
      detectMatchType(six, { player_count: 6, game_mode: 6, max_rounds: 15 }),
    ).toBe("Rush");
  });

  it("classifies a rush_ map as Rush when the demo carries no game_mode", () => {
    // Rush has no skill group, so the scoreboard shows another ladder.
    const six = Array.from({ length: 6 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
      rank_type: 11,
    }));
    expect(
      detectMatchType(six, { player_count: 6, map_name: "rush_001" }),
    ).toBe("Rush");
  });

  it("does not treat the cs_rush hostage map as Rush", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
      rank_type: 7,
    }));
    expect(
      detectMatchType(five, { player_count: 10, map_name: "cs_rush" }),
    ).toBe("Competitive");
  });
});

describe("MatchImportService.computeStartingSides", () => {
  it("reads sides from round 1 only, ignoring post-halftime swaps", () => {
    const parsed = {
      round_ticks: [
        { round: 1, start_tick: 0, end_tick: 100 },
        { round: 13, start_tick: 1300, end_tick: 1400 },
      ],
      kills: [
        {
          tick: 50,
          killer: "A",
          killer_team: "CT",
          victim: "B",
          victim_team: "TERRORIST",
        },
        // C's only kill is after the halftime swap — must not define its side.
        {
          tick: 1350,
          killer: "C",
          killer_team: "CT",
          victim: "A",
          victim_team: "TERRORIST",
        },
      ],
    };
    const sides = computeStartingSides(parsed);
    expect(sides.get("A")).toBe("CT");
    expect(sides.get("B")).toBe("T");
    expect(sides.has("C")).toBe(false);
  });

  it("prefers the parser's starting_side over the kill scan", () => {
    const parsed = {
      players: [
        { steam_id: "A", name: "a", starting_side: "t" },
        { steam_id: "B", name: "b", starting_side: "ct" },
      ],
      round_ticks: [{ round: 1, start_tick: 0, end_tick: 100 }],
      kills: [
        // Contradicts the demo's own team assignment; must lose.
        {
          tick: 50,
          killer: "A",
          killer_team: "CT",
          victim: "B",
          victim_team: "TERRORIST",
        },
      ],
    };
    const sides = computeStartingSides(parsed);
    expect(sides.get("A")).toBe("T");
    expect(sides.get("B")).toBe("CT");
  });

  it("covers players who never appear in a round 1 kill", () => {
    const parsed = {
      // C neither killed nor died in round 1 — without starting_side it would
      // be dealt into whichever lineup happened to be shorter.
      players: [
        { steam_id: "A", name: "a", starting_side: "ct" },
        { steam_id: "B", name: "b", starting_side: "t" },
        { steam_id: "C", name: "c", starting_side: "t" },
      ],
      round_ticks: [{ round: 1, start_tick: 0, end_tick: 100 }],
      kills: [
        {
          tick: 50,
          killer: "A",
          killer_team: "CT",
          victim: "B",
          victim_team: "TERRORIST",
        },
      ],
    };
    expect(computeStartingSides(parsed).get("C")).toBe("T");
  });

  it("falls back to the kill scan for players the parser gave no side", () => {
    const parsed = {
      // Demo parsed before the parser emitted starting_side.
      players: [{ steam_id: "A", name: "a" }],
      round_ticks: [{ round: 1, start_tick: 0, end_tick: 100 }],
      kills: [
        {
          tick: 50,
          killer: "A",
          killer_team: "CT",
          victim: "B",
          victim_team: "TERRORIST",
        },
      ],
    };
    const sides = computeStartingSides(parsed);
    expect(sides.get("A")).toBe("CT");
    expect(sides.get("B")).toBe("T");
  });

  it("falls back to all kills when the demo has no round data", () => {
    const parsed = {
      round_ticks: [] as unknown[],
      kills: [
        {
          tick: 1350,
          killer: "C",
          killer_team: "CT",
          victim: "A",
          victim_team: "TERRORIST",
        },
      ],
    };
    const sides = computeStartingSides(parsed);
    expect(sides.get("C")).toBe("CT");
    expect(sides.get("A")).toBe("T");
  });
});

describe("MatchImportService duplicate guards", () => {
  const rounds = (...winners: Array<string | undefined>) => ({
    round_ticks: winners.map((winner, i) => ({
      round: i + 1,
      start_tick: i * 100,
      end_tick: i * 100 + 99,
      winner,
    })),
  });

  it("builds the round winner sequence in round order", () => {
    const parsed = rounds("CT", "T", "TERRORIST", "ct");
    parsed.round_ticks.reverse();
    expect(MatchImportService.roundWinnerSequence(parsed as never)).toEqual([
      "CT",
      "TERRORIST",
      "TERRORIST",
      "CT",
    ]);
  });

  it("drops a round still running when the demo stopped", () => {
    expect(
      MatchImportService.roundWinnerSequence(
        rounds("CT", "T", undefined) as never,
      ),
    ).toEqual(["CT", "TERRORIST"]);
  });

  it("gives up on the sequence when a played round has no winner", () => {
    expect(
      MatchImportService.roundWinnerSequence(
        rounds("CT", undefined, "T") as never,
      ),
    ).toEqual([]);
  });

  it("never imports a demo recorded on a 5Stack server", async () => {
    // Rejected before any dependency is touched, so no Nest wiring is needed.
    const service = Object.create(
      MatchImportService.prototype,
    ) as MatchImportService;
    await expect(
      service.importExternalDemo(
        {
          server_name: "5Stack.gg",
          players: [{ steam_id: "76561198000000001", name: "a" }],
          ...rounds("CT"),
        } as never,
        "valve",
        "upload",
      ),
    ).resolves.toEqual({
      matchId: null,
      skipped: "recorded on a 5Stack server",
    });
  });
});
