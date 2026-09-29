import { Logger } from "@nestjs/common";
import CaptainEvent from "./CaptainEvent";

describe("CaptainEvent", () => {
  let processor: CaptainEvent;
  let hasura: { mutation: jest.Mock };
  let matchAssistant: { getMatchLineups: jest.Mock };
  let logger: Logger;

  beforeEach(() => {
    // Hasura rejects a null comparison value outright rather than matching
    // nothing, so the whole event fails and is never acknowledged.
    hasura = {
      mutation: jest.fn(async (mutation) => {
        const where = mutation.update_match_lineup_players?.__args.where ?? {};
        if (Object.values(where).some((value: any) => value?._eq === null)) {
          throw "unexpected null value for type 'String'";
        }
        return {};
      }),
    };
    logger = new Logger("CaptainEventTest");
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    matchAssistant = {
      getMatchLineups: jest.fn(async () => ({
        lineup_1_id: "lineup-1",
        lineup_2_id: "lineup-2",
        lineup_players: [
          { steam_id: "76561198000000001", discord_id: null },
          { steam_id: null, discord_id: "discord-2", placeholder_name: "bob" },
          { steam_id: null, discord_id: null, placeholder_name: "carl" },
        ] as Array<Record<string, string | null>>,
      })),
    };

    processor = new CaptainEvent(
      logger,
      hasura as any,
      matchAssistant as any,
      {} as any,
      {} as any,
    );
  });

  function updateWhere() {
    return hasura.mutation.mock.calls[0][0].update_match_lineup_players.__args
      .where;
  }

  it("only changes the captain in this match's lineups", async () => {
    processor.setData("11111111-1111-1111-1111-111111111111", {
      claim: true,
      steam_id: "76561198000000001",
      player_name: "alice",
    });

    await processor.process();

    expect(updateWhere()).toEqual({
      steam_id: { _eq: "76561198000000001" },
      match_lineup_id: { _in: ["lineup-1", "lineup-2"] },
    });
  });

  it("scopes a placeholder player's claim to this match too", async () => {
    processor.setData("11111111-1111-1111-1111-111111111111", {
      claim: true,
      steam_id: "0",
      player_name: "bob",
    });

    await processor.process();

    expect(updateWhere()).toEqual({
      discord_id: { _eq: "discord-2" },
      match_lineup_id: { _in: ["lineup-1", "lineup-2"] },
    });
  });

  it("drops a claim for a placeholder with neither a steam nor a discord id instead of throwing", async () => {
    processor.setData("11111111-1111-1111-1111-111111111111", {
      claim: true,
      steam_id: "76561198000000009",
      player_name: "carl",
    });

    await expect(processor.process()).resolves.toBeUndefined();

    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
