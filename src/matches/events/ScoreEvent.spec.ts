import { Logger } from "@nestjs/common";
import ScoreEvent from "./ScoreEvent";

function backup(round: number, players = true) {
  const team = (name: string, accountId: number) =>
    players
      ? `\t"${name}"\n\t{\n\t\t"${accountId}"\n\t\t{\n\t\t\t"name"\t\t"p"\n\t\t}\n\t}\n`
      : "";

  return (
    `"SaveFile"\n{\n\t"map"\t\t"de_inferno"\n\t"round"\t\t"${round}"\n` +
    `\t"RoundResults"\n\t{\n\t\t"round1"\t\t"1"\n\t}\n` +
    team("PlayersOnTeam1", 874739096) +
    team("PlayersOnTeam2", 874739097) +
    `}\n`
  );
}

describe("ScoreEvent", () => {
  const matchId = "11111111-1111-1111-1111-111111111111";
  const matchMapId = "22222222-2222-2222-2222-222222222222";

  let processor: ScoreEvent;
  let recorded: Array<Record<string, unknown>>;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let matchAssistant: { sendServerMatchId: jest.Mock };

  function score(overrides: Record<string, unknown> = {}) {
    processor.setData(matchId, {
      time: "2026-09-19T13:41:02.123Z",
      round: 1,
      match_map_id: matchMapId,
      lineup_1_score: 0,
      lineup_1_money: 0,
      lineup_1_timeouts_available: 3,
      lineup_2_score: 1,
      lineup_2_money: 0,
      lineup_2_timeouts_available: 3,
      lineup_1_side: "CT",
      lineup_2_side: "TERRORIST",
      winning_side: "TERRORIST",
      winning_reason: "BombExploded",
      backup_file: backup(1),
      ...overrides,
    } as any);
  }

  function inserted() {
    const call = hasura.mutation.mock.calls.find(
      ([mutation]) => mutation.insert_match_map_rounds_one,
    );
    return call?.[0].insert_match_map_rounds_one.__args.object;
  }

  beforeEach(() => {
    recorded = [];
    hasura = {
      query: jest.fn(async () => ({ match_map_rounds: recorded })),
      mutation: jest.fn(async () => ({})),
    };
    matchAssistant = { sendServerMatchId: jest.fn() };

    processor = new ScoreEvent(
      new Logger("ScoreEventTest"),
      hasura as any,
      matchAssistant as any,
      {} as any,
      {} as any,
    );
  });

  it("records the next round", async () => {
    score();

    await processor.process();

    expect(inserted().round).toBe(1);
    expect(inserted().backup_file).toBe(backup(1));
    expect(matchAssistant.sendServerMatchId).not.toHaveBeenCalled();
  });

  it("only looks at rounds that are still live", async () => {
    // a restore soft-deletes the rounds it undoes, which is what lets the
    // replayed ones back in
    score({ round: 6 });

    await processor.process();

    expect(hasura.query.mock.calls[0][0].match_map_rounds.__args.where).toEqual(
      {
        match_map_id: { _eq: matchMapId },
        round: { _gte: 6 },
        deleted_at: { _is_null: true },
      },
    );
  });

  it("purges the rounds a restore voided before recording the replay", async () => {
    score({ round: 6 });

    await processor.process();

    const [cleanup, insert] = hasura.mutation.mock.calls.map(([m]) => m);
    expect(cleanup.delete_match_map_rounds).toBeDefined();
    expect(insert.insert_match_map_rounds_one).toBeDefined();
  });

  it("refuses a restarted server replaying a round that is already recorded", async () => {
    // 2026-09-19: a rebooted server at 0-0 published its own round 1 over the
    // real one, backup included
    recorded = [
      {
        id: "r1",
        round: 1,
        time: "2026-09-19T13:41:02.123+00:00",
        backup_file: backup(1),
      },
    ];
    score({
      time: "2026-09-19T13:49:42.000Z",
      winning_side: "CT",
      backup_file: backup(1, false),
    });

    await processor.process();

    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(matchAssistant.sendServerMatchId).toHaveBeenCalledWith(matchId);
  });

  it("refuses a round behind the latest recorded one", async () => {
    recorded = [{ id: "r7", round: 7, time: "2026-09-19T13:48:00+00:00" }];
    score({ round: 3 });

    await processor.process();

    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(matchAssistant.sendServerMatchId).toHaveBeenCalledWith(matchId);
  });

  it("treats a redelivered score as already handled", async () => {
    recorded = [
      {
        id: "r1",
        round: 1,
        time: "2026-09-19T13:41:02.123+00:00",
        backup_file: backup(1),
      },
    ];
    score();

    await processor.process();

    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(matchAssistant.sendServerMatchId).not.toHaveBeenCalled();
  });

  it("lets a redelivery supply a backup the first delivery lacked", async () => {
    recorded = [
      {
        id: "r1",
        round: 1,
        time: "2026-09-19T13:41:02.123+00:00",
        backup_file: "",
      },
    ];
    score();

    await processor.process();

    expect(
      hasura.mutation.mock.calls[0][0].update_match_map_rounds_by_pk.__args,
    ).toEqual({
      pk_columns: { id: "r1" },
      _set: { backup_file: backup(1) },
    });
  });

  it("does not store a backup with no players in it", async () => {
    score({ backup_file: backup(1, false) });

    await processor.process();

    expect(inserted().backup_file).toBe("");
  });

  it("does not store a backup for a different round", async () => {
    score({ round: 2, backup_file: backup(1) });

    await processor.process();

    expect(inserted().backup_file).toBe("");
  });
});
