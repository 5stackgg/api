import { PostgresService } from "./../src/postgres/postgres.service";
import { MatchesController } from "./../src/matches/matches.controller";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The check-in button is gated by can_check_in, but the action is callable
// directly, so it has to apply the same rule for the caller's own session.
describe("checkIntoMatch enforces the match's check-in setting (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchCheckInTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199950000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");
  });

  const waitingMatch = async (checkInSetting: string) => {
    const match = await fx.match({ type: "Wingman", mr: 8 });
    await postgres.query(
      "UPDATE match_options SET check_in_setting = $2 WHERE id = $1",
      [match.options_id, checkInSetting],
    );
    const first = await fx.lineupPlayer(match.lineup_1_id);
    const second = await fx.lineupPlayer(match.lineup_1_id);
    await postgres.query(
      "UPDATE matches SET status = 'WaitingForCheckIn' WHERE id = $1",
      [match.id],
    );

    const [{ steam_id: captain }] = await postgres.query<
      Array<{ steam_id: string }>
    >(
      `SELECT steam_id::text FROM match_lineup_players
        WHERE match_lineup_id = $1 AND captain`,
      [match.lineup_1_id],
    );

    return {
      id: match.id,
      captain,
      player: captain === first ? second : first,
    };
  };

  const checkIn = async (matchId: string, steamId: string) => {
    const controller = Object.create(MatchesController.prototype);

    controller.postgres = postgres;
    controller.camera = { isRequired: jest.fn().mockResolvedValue(false) };
    controller.hasura = {
      getHasuraHeaders: jest.fn(async (id: string) => {
        const [player] = await postgres.query<Array<{ role: string }>>(
          "SELECT role FROM players WHERE steam_id = $1",
          [id],
        );
        return { "x-hasura-role": player.role, "x-hasura-user-id": id };
      }),
      query: jest.fn(async () => {
        const [match] = await postgres.query<Array<{ status: string }>>(
          "SELECT status FROM matches WHERE id = $1",
          [matchId],
        );
        return { matches_by_pk: match };
      }),
      mutation: jest.fn().mockResolvedValue({
        update_match_lineup_players: { affected_rows: 1 },
        update_matches: { affected_rows: 0 },
      }),
    };

    const result = controller.checkIntoMatch({
      match_id: matchId,
      user: { steam_id: steamId, role: "user" },
    });

    return { result, mutation: controller.hasura.mutation as jest.Mock };
  };

  it("Admin: a player in the lineup cannot check themselves in", async () => {
    const match = await waitingMatch("Admin");

    const { result, mutation } = await checkIn(match.id, match.player);

    await expect(result).rejects.toThrow(
      "you are not allowed to check in to this match",
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("Admin: an administrator in the lineup can check in", async () => {
    const match = await waitingMatch("Admin");
    await postgres.query(
      "UPDATE players SET role = 'administrator' WHERE steam_id = $1",
      [match.player],
    );

    const { result } = await checkIn(match.id, match.player);

    await expect(result).resolves.toEqual({ success: true });
  });

  it("Captains: a player who is not captain cannot check in", async () => {
    const match = await waitingMatch("Captains");

    const { result, mutation } = await checkIn(match.id, match.player);

    await expect(result).rejects.toThrow(
      "you are not allowed to check in to this match",
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("Captains: the captain can check in", async () => {
    const match = await waitingMatch("Captains");

    const { result } = await checkIn(match.id, match.captain);

    await expect(result).resolves.toEqual({ success: true });
  });

  it("Players: anyone in a lineup can check in, nobody outside it", async () => {
    const match = await waitingMatch("Players");

    await expect(
      (await checkIn(match.id, match.player)).result,
    ).resolves.toEqual({ success: true });

    const outsider = await checkIn(match.id, await fx.player());
    await expect(outsider.result).rejects.toThrow(
      "you are not allowed to check in to this match",
    );
    expect(outsider.mutation).not.toHaveBeenCalled();
  });

  it("still refuses a match that is not waiting for check-in", async () => {
    const match = await waitingMatch("Players");
    await postgres.query(
      "UPDATE matches SET status = 'PickingPlayers' WHERE id = $1",
      [match.id],
    );

    const { result, mutation } = await checkIn(match.id, match.player);

    await expect(result).rejects.toThrow(
      "match is not accepting check in's at this time",
    );
    expect(mutation).not.toHaveBeenCalled();
  });
});
