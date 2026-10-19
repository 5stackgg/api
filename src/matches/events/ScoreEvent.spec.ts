import ScoreEvent from "./ScoreEvent";

describe("ScoreEvent", () => {
  let lastPlayed = 6;
  const hasura = {
    mutation: jest.fn(async (_mutation: any) => ({})),
    query: jest.fn(async () => ({
      match_map_rounds_aggregate: { aggregate: { max: { round: lastPlayed } } },
    })),
  };

  const process = async (backupFile: string, round = 7) => {
    const event = new ScoreEvent(
      { log: jest.fn() } as never,
      hasura as never,
      {} as never,
      {} as never,
      {} as never,
    );
    event.setData("match-1", {
      time: "2026-10-19T12:00:00Z",
      round,
      match_map_id: "map-1",
      lineup_1_score: 4,
      lineup_1_money: 21000,
      lineup_1_timeouts_available: 3,
      lineup_2_score: 3,
      lineup_2_money: 18000,
      lineup_2_timeouts_available: 2,
      lineup_1_side: "CT",
      lineup_2_side: "TERRORIST",
      winning_side: "CT",
      backup_file: backupFile,
      winning_reason: "CTsWin",
    } as never);
    await event.process();
  };

  const mutations = () =>
    hasura.mutation.mock.calls.map(([mutation]: [any]) => mutation);

  const purged = () =>
    mutations().some((mutation) => mutation.delete_match_map_rounds);

  beforeEach(() => {
    jest.clearAllMocks();
    lastPlayed = 6;
  });

  // A round that is still on the map was played, so its backup is where a
  // restore to it has to land, even if the server reports the round again.
  it("never replaces the backup of a round already recorded", async () => {
    await process("new backup");

    const [cleanup, insert, backup] = mutations();
    expect(cleanup.delete_match_map_rounds.__args.where).toEqual({
      deleted_at: { _is_null: false },
      match_map_id: { _eq: "map-1" },
    });
    expect(
      insert.insert_match_map_rounds_one.__args.on_conflict.update_columns,
    ).not.toContain("backup_file");
    expect(backup.update_match_map_rounds.__args).toEqual({
      where: {
        match_map_id: { _eq: "map-1" },
        round: { _eq: 7 },
        _or: [
          { backup_file: { _is_null: true } },
          { backup_file: { _eq: "" } },
        ],
      },
      _set: { backup_file: "new backup" },
    });
  });

  it("only throws away what a reset undid once a round past it is played", async () => {
    await process("", 7);
    expect(purged()).toBe(true);
  });

  // Warmup ending reports round 0, so a map restarted from warmup would lose
  // its undone rounds before anyone played a round.
  it("keeps what a reset undid when the server reports a round already on the map", async () => {
    lastPlayed = 0;
    await process("", 0);
    expect(purged()).toBe(false);

    lastPlayed = 7;
    await process("", 7);
    expect(purged()).toBe(false);
  });

  it("has no backup to fill when the server sent none", async () => {
    await process("");

    expect(mutations()).toHaveLength(2);
  });
});
