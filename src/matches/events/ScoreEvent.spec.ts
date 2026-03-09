jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import ScoreEvent from "./ScoreEvent";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = {};
  const chat = {};
  const event = new ScoreEvent(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura };
}

describe("ScoreEvent", () => {
  it("calls cleanupData before inserting round", async () => {
    const { event, hasura } = createEvent({
      time: "2026-01-01T00:00:00Z",
      round: 5,
      match_map_id: "map-1",
      lineup_1_score: 3,
      lineup_1_money: 5000,
      lineup_1_timeouts_available: 1,
      lineup_2_score: 2,
      lineup_2_money: 4500,
      lineup_2_timeouts_available: 1,
      lineup_1_side: "CT",
      lineup_2_side: "TERRORIST",
      winning_side: "CT",
      backup_file: "backup_005.txt",
      winning_reason: "TerroristsEliminated",
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledTimes(2);

    // First call is cleanup
    const cleanupCall = hasura.mutation.mock.calls[0][0];
    expect(cleanupCall).toHaveProperty("delete_match_map_rounds");
    expect(cleanupCall).toHaveProperty("delete_player_kills");
    expect(cleanupCall).toHaveProperty("delete_player_assists");
    expect(cleanupCall).toHaveProperty("delete_player_damages");
    expect(cleanupCall).toHaveProperty("delete_player_flashes");
    expect(cleanupCall).toHaveProperty("delete_player_utility");
    expect(cleanupCall).toHaveProperty("delete_player_objectives");
    expect(cleanupCall).toHaveProperty("delete_player_unused_utility");
  });

  it("inserts round with upsert on_conflict", async () => {
    const { event, hasura } = createEvent({
      time: "2026-01-01T00:00:00Z",
      round: 5,
      match_map_id: "map-1",
      lineup_1_score: 3,
      lineup_1_money: 5000,
      lineup_1_timeouts_available: 1,
      lineup_2_score: 2,
      lineup_2_money: 4500,
      lineup_2_timeouts_available: 1,
      lineup_1_side: "CT",
      lineup_2_side: "TERRORIST",
      winning_side: "CT",
      backup_file: "backup_005.txt",
      winning_reason: "TerroristsEliminated",
    });

    await event.process();

    const insertCall = hasura.mutation.mock.calls[1][0];
    expect(insertCall.insert_match_map_rounds_one.__args.object).toEqual({
      time: new Date("2026-01-01T00:00:00Z"),
      round: 5,
      backup_file: "backup_005.txt",
      match_map_id: "map-1",
      lineup_1_score: 3,
      lineup_1_money: 5000,
      lineup_1_timeouts_available: 1,
      lineup_2_score: 2,
      lineup_2_money: 4500,
      lineup_2_timeouts_available: 1,
      lineup_1_side: "CT",
      lineup_2_side: "TERRORIST",
      winning_side: "CT",
      winning_reason: "TerroristsEliminated",
    });
    expect(insertCall.insert_match_map_rounds_one.__args.on_conflict).toEqual({
      constraint: "match_rounds_match_id_round_key",
      update_columns: [
        "lineup_1_score",
        "lineup_1_money",
        "lineup_1_timeouts_available",
        "lineup_2_score",
        "lineup_2_money",
        "lineup_2_timeouts_available",
        "lineup_1_side",
        "lineup_2_side",
        "winning_side",
        "backup_file",
      ],
    });
  });

  it("cleanup deletes soft-deleted records filtering by match_map_id", async () => {
    const { event, hasura } = createEvent({
      time: "2026-01-01T00:00:00Z",
      round: 1,
      match_map_id: "map-42",
      lineup_1_score: 1,
      lineup_1_money: 3000,
      lineup_1_timeouts_available: 1,
      lineup_2_score: 0,
      lineup_2_money: 2000,
      lineup_2_timeouts_available: 1,
      lineup_1_side: "CT",
      lineup_2_side: "TERRORIST",
      winning_side: "CT",
      backup_file: "backup_001.txt",
      winning_reason: "BombDefused",
    });

    await event.process();

    const cleanupCall = hasura.mutation.mock.calls[0][0];
    for (const key of Object.keys(cleanupCall)) {
      const where = cleanupCall[key].__args.where;
      expect(where.deleted_at._is_null).toBe(false);
      expect(where.match_map_id._eq).toBe("map-42");
    }
  });
});
