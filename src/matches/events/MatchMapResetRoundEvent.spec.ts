jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import MatchMapResetRoundEvent from "./MatchMapResetRoundEvent";

function createEvent(data: Record<string, any>) {
  const hasura = {
    mutation: jest.fn().mockResolvedValue({}),
    query: jest.fn().mockResolvedValue({ match_map_rounds: [] }),
  };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = { restoreMatchRound: jest.fn().mockResolvedValue(undefined) };
  const chat = {};
  const event = new MatchMapResetRoundEvent(
    logger as any,
    hasura as any,
    matchAssistant as any,
    chat as any,
  );
  event.setData("match-1", data as any);
  return { event, hasura, matchAssistant, logger };
}

describe("MatchMapResetRoundEvent", () => {
  it("first mutation clears deleted_at on stats tables for rounds > target", async () => {
    const { event, hasura } = createEvent({ round: "5", match_map_id: "map-1" });

    await event.process();

    const firstCall = hasura.mutation.mock.calls[0][0];
    const tables = [
      "update_player_kills",
      "update_player_assists",
      "update_player_damages",
      "update_player_flashes",
      "update_player_utility",
      "update_player_objectives",
    ];
    for (const table of tables) {
      expect(firstCall[table].__args.where.round._gt).toBe(5);
      expect(firstCall[table].__args.where.match_map_id._eq).toBe("map-1");
      expect(firstCall[table].__args._set.deleted_at).toBeNull();
    }
    // unused_utility has no round filter
    expect(firstCall.update_player_unused_utility.__args.where.match_map_id._eq).toBe("map-1");
    expect(firstCall.update_player_unused_utility.__args._set.deleted_at).toBeNull();
  });

  it("second mutation sets deleted_at on stats tables for rounds > target", async () => {
    const { event, hasura } = createEvent({ round: "5", match_map_id: "map-1" });

    await event.process();

    const secondCall = hasura.mutation.mock.calls[1][0];
    const tables = [
      "update_player_kills",
      "update_player_assists",
      "update_player_damages",
      "update_player_flashes",
      "update_player_utility",
      "update_player_objectives",
      "update_player_unused_utility",
    ];
    for (const table of tables) {
      expect(secondCall[table].__args._set.deleted_at).toBeInstanceOf(Date);
    }
  });

  it("clears deleted_at on match_map_rounds", async () => {
    const { event, hasura } = createEvent({ round: "3", match_map_id: "map-1" });

    await event.process();

    const thirdCall = hasura.mutation.mock.calls[2][0];
    expect(thirdCall.update_match_map_rounds.__args.where.match_map_id._eq).toBe("map-1");
    expect(thirdCall.update_match_map_rounds.__args._set.deleted_at).toBeNull();
  });

  it("queries rounds > target and marks them with deleted_at", async () => {
    const { event, hasura } = createEvent({ round: "3", match_map_id: "map-1" });
    hasura.query.mockResolvedValueOnce({
      match_map_rounds: [
        { id: "r4", round: 4, lineup_1_timeouts_available: 1, lineup_2_timeouts_available: 1 },
        { id: "r5", round: 5, lineup_1_timeouts_available: 1, lineup_2_timeouts_available: 0 },
      ],
    });

    await event.process();

    // Should mark rounds 4 and 5 for deletion (both > 3)
    const deleteCalls = hasura.mutation.mock.calls.slice(3);
    expect(deleteCalls.length).toBe(2);
    expect(deleteCalls[0][0].update_match_map_rounds_by_pk.__args.pk_columns.id).toBe("r4");
    expect(deleteCalls[0][0].update_match_map_rounds_by_pk.__args._set.deleted_at).toBeInstanceOf(Date);
    expect(deleteCalls[1][0].update_match_map_rounds_by_pk.__args.pk_columns.id).toBe("r5");
  });

  it("restores timeout availability from target round", async () => {
    const { event, hasura } = createEvent({ round: "3", match_map_id: "map-1" });
    hasura.query.mockResolvedValueOnce({
      match_map_rounds: [
        { id: "r3", round: 3, lineup_1_timeouts_available: 2, lineup_2_timeouts_available: 1 },
        { id: "r4", round: 4, lineup_1_timeouts_available: 1, lineup_2_timeouts_available: 1 },
      ],
    });

    await event.process();

    // The round matching statsRound (3) should trigger timeout restoration
    const timeoutCall = hasura.mutation.mock.calls[3][0];
    expect(timeoutCall.update_match_maps_by_pk.__args._set.lineup_1_timeouts_available).toBe(2);
    expect(timeoutCall.update_match_maps_by_pk.__args._set.lineup_2_timeouts_available).toBe(1);
  });

  it("calls matchAssistant.restoreMatchRound", async () => {
    const { event, matchAssistant } = createEvent({ round: "5", match_map_id: "map-1" });

    await event.process();

    expect(matchAssistant.restoreMatchRound).toHaveBeenCalledWith("match-1", 5);
  });
});
