import { PostgresService } from "./../src/postgres/postgres.service";
import { MatchRecoveryService } from "../src/matches/match-recovery/match-recovery.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

const steamId = (accountId: number) =>
  (BigInt(accountId) + 76561197960265728n).toString();

const backup = (accountId: number, name: string, cash: number) => `"SaveFile"
{
	"round"		"1"
	"PlayersOnTeam1"
	{
		"${accountId}"
		{
			"name"		"${name}"
			"cash"		"${cash}"
			"kills"		"1"
			"deaths"		"0"
			"assists"		"0"
			"Items"
			{
				"item"		"weapon_m4a1_silencer"
			}
		}
	}
}
`;

// Runs MatchRecoveryService's own queries against a migrated database, and
// drives a restart through the real match triggers.
describe("match recovery (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchRecoveryTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199410000000n);
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

  const service = (sent: Array<number> = []) =>
    new MatchRecoveryService(
      { log: jest.fn(), warn: jest.fn() } as never,
      postgres,
      {
        requestRoundRestore: async (_matchId: string, round: number) => {
          sent.push(round);
          return "";
        },
        updateMatchStatus: (matchId: string, status: string) =>
          postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
            matchId,
            status,
          ]),
      } as never,
    );

  const liveMatch = async () => {
    const match = await fx.match({ type: "Competitive", mr: 12 });
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order", status, lineup_1_side, lineup_2_side)
       SELECT $1, id, 1, 'Live', 'CT', 'TERRORIST' FROM maps ORDER BY name LIMIT 1
       RETURNING id`,
      [match.id],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);

    for (const [lineupId, accountId, name] of [
      [match.lineup_1_id, 157864, "vexa"],
      [match.lineup_2_id, 235177, "osk"],
    ] as Array<[string, number, string]>) {
      await postgres.query(
        "INSERT INTO players (steam_id, name) VALUES ($1, $2)",
        [steamId(accountId), name],
      );
      await postgres.query(
        `INSERT INTO match_lineup_players (match_lineup_id, steam_id, is_connected)
         VALUES ($1, $2, true)`,
        [lineupId, steamId(accountId)],
      );
    }

    for (const [round, file] of [
      [1, backup(157864, "vexa", 3250)],
      [2, null],
    ] as Array<[number, string | null]>) {
      await postgres.query(
        `INSERT INTO match_map_rounds
           (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
            "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
            lineup_1_side, lineup_2_side, winning_side, backup_file)
         VALUES ($1, $2, $2, 0, 800, 800, now(), 3, 3, 'CT', 'TERRORIST', 'CT', $3)`,
        [map.id, round, file],
      );
    }

    return { match, mapId: map.id };
  };

  it("reads the current map's backups and who is connected", async () => {
    const { match, mapId } = await liveMatch();
    await postgres.query(
      "UPDATE match_lineup_players SET is_connected = false WHERE steam_id = $1",
      [steamId(235177)],
    );

    const result = await service().getRestoreRounds(match.id);

    expect(result).toMatchObject({
      match_map_id: mapId,
      restorable: true,
      live_round: 3,
      disconnected: ["osk"],
    });
    expect(result.rounds.map((round) => round.has_backup)).toEqual([
      true,
      false,
    ]);
    expect(result.rounds[0].players).toEqual([
      expect.objectContaining({
        steam_id: steamId(157864),
        lineup: 1,
        cash: 3250,
        weapons: ["weapon_m4a1_silencer"],
      }),
    ]);
  });

  it("sends a restore only for a round that has a backup", async () => {
    const { match } = await liveMatch();
    const sent: Array<number> = [];

    await expect(service(sent).restoreRound(match.id, 2)).rejects.toThrow(
      "round 2 has no backup to restore",
    );
    await service(sent).restoreRound(match.id, 1);

    expect(sent).toEqual([1]);
  });

  it("restarts a live match back to check-in", async () => {
    const { match } = await liveMatch();

    await service().restartMatch(match.id);

    const [after] = await postgres.query<
      Array<{ status: string; winning_lineup_id: string | null }>
    >("SELECT status, winning_lineup_id FROM matches WHERE id = $1", [
      match.id,
    ]);
    expect(after).toEqual({
      status: "WaitingForCheckIn",
      winning_lineup_id: null,
    });
  });
});
