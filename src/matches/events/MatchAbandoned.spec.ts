import { Logger } from "@nestjs/common";
import MatchAbandoned from "./MatchAbandoned";

describe("MatchAbandoned", () => {
  let processor: MatchAbandoned;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let notifications: { send: jest.Mock };
  let affectedRows: number;

  beforeEach(() => {
    affectedRows = 1;

    hasura = {
      query: jest.fn(async () => ({ players_by_pk: { name: "keith" } })),
      mutation: jest.fn(async () => ({
        insert_abandoned_matches: { affected_rows: affectedRows },
      })),
    };
    notifications = { send: jest.fn() };

    processor = new MatchAbandoned(
      new Logger("MatchAbandonedTest"),
      hasura as any,
      {} as any,
      {} as any,
      notifications as any,
    );
    processor.setData("11111111-1111-1111-1111-111111111111", {
      steam_id: "76561198000000001",
    });
  });

  function insertArgs() {
    return hasura.mutation.mock.calls[0][0].insert_abandoned_matches.__args;
  }

  it("records the abandon against the match", async () => {
    await processor.process();

    expect(insertArgs().objects).toEqual([
      {
        steam_id: "76561198000000001",
        match_id: "11111111-1111-1111-1111-111111111111",
      },
    ]);
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it("ignores a repeat abandon for the same match", async () => {
    // the plugin can report the same leave more than once, and every extra row
    // would escalate the player's cooldown a rung
    await processor.process();

    expect(insertArgs().on_conflict).toEqual({
      constraint: "abandoned_matches_steam_id_match_id_key",
      update_columns: [],
    });
  });

  it("does not notify admins twice for one abandon", async () => {
    affectedRows = 0;

    await processor.process();

    expect(notifications.send).not.toHaveBeenCalled();
  });
});
