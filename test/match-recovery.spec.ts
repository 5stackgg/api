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
        refreshServerMatch: async (): Promise<void> => undefined,
      } as never,
    );

  const admin = {
    steam_id: "76561199419999999",
    role: "administrator",
  } as const;

  // A duel on its second map: map 1 is over, map 2 is being played.
  const liveMatch = async () => {
    const match = await fx.match({ type: "Duel", bestOf: 3 });
    const [finished] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order", status, lineup_1_side, lineup_2_side)
       SELECT $1, id, 1, 'Finished', 'CT', 'TERRORIST' FROM maps ORDER BY name LIMIT 1
       RETURNING id`,
      [match.id],
    );
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order", status, lineup_1_side, lineup_2_side)
       SELECT $1, id, 2, 'Live', 'CT', 'TERRORIST' FROM maps ORDER BY name OFFSET 1 LIMIT 1
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

    for (const [mapId, round, file] of [
      [finished.id, 1, null],
      [map.id, 1, backup(157864, "vexa", 3250)],
      [map.id, 2, null],
    ] as Array<[string, number, string | null]>) {
      await postgres.query(
        `INSERT INTO match_map_rounds
           (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
            "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
            lineup_1_side, lineup_2_side, winning_side, backup_file)
         VALUES ($1, $2, $2, 0, 800, 800, now(), 3, 3, 'CT', 'TERRORIST', 'CT', $3)`,
        [mapId, round, file],
      );
    }

    await fx.kill(
      { matchId: match.id, mapId: map.id },
      steamId(157864),
      steamId(235177),
      { round: 2 },
    );

    return { match, mapId: map.id, finishedMapId: finished.id };
  };

  it("reads the current map's backups and who is connected", async () => {
    const { match, mapId } = await liveMatch();
    await postgres.query(
      "UPDATE match_lineup_players SET is_connected = false WHERE steam_id = $1",
      [steamId(235177)],
    );

    const result = await service().getRestoreRounds(match.id, admin);

    expect(result).toMatchObject({
      match_map_id: mapId,
      restorable: true,
      blocked_reason: null,
      live_round: 3,
      economy_hidden: false,
      connected_players: 1,
      expected_players: 2,
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

  it("treats a lineup's coach as on that team", async () => {
    const { match } = await liveMatch();
    const coach = await fx.player();
    await postgres.query(
      "UPDATE match_lineups SET coach_steam_id = $2 WHERE id = $1",
      [match.lineup_1_id, coach],
    );

    const result = await service().getRestoreRounds(match.id, {
      steam_id: coach,
      role: "user",
    });

    expect(result).toMatchObject({
      economy_hidden: true,
      blocked_reason: "team_member",
    });
    expect(result.rounds[0].players).toEqual([]);
    await expect(
      service().restoreRound(match.id, 1, { steam_id: coach, role: "user" }),
    ).rejects.toThrow("organizers on one of the teams can't restore rounds");
  });

  it("sends a restore only for a round that has a backup", async () => {
    const { match } = await liveMatch();
    const sent: Array<number> = [];

    await expect(
      service(sent).restoreRound(match.id, 2, admin),
    ).rejects.toThrow("round 2 has no backup to restore");
    await service(sent).restoreRound(match.id, 1, admin);

    expect(sent).toEqual([1]);
  });

  it("restarts a live match from check-in with the map in progress back at the start", async () => {
    const { match, mapId, finishedMapId } = await liveMatch();

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

    const maps = await postgres.query<Array<{ id: string; status: string }>>(
      'SELECT id, status FROM match_maps WHERE match_id = $1 ORDER BY "order"',
      [match.id],
    );
    expect(maps).toEqual([
      { id: finishedMapId, status: "Finished" },
      { id: mapId, status: "Scheduled" },
    ]);

    const live = await postgres.query<Array<{ table: string; left: number }>>(
      `SELECT 'rounds' AS table, count(*)::int AS left FROM match_map_rounds
        WHERE match_map_id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT 'kills', count(*)::int FROM player_kills
        WHERE match_map_id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT 'finished rounds', count(*)::int FROM match_map_rounds
        WHERE match_map_id = $2 AND deleted_at IS NULL`,
      [mapId, finishedMapId],
    );
    expect(live).toEqual([
      { table: "rounds", left: 0 },
      { table: "kills", left: 0 },
      { table: "finished rounds", left: 1 },
    ]);
  });

  // Canceling stamps cancels_at with now, and without auto-cancel nothing
  // re-arms it, so CancelExpiredMatches would cancel the reopened match again.
  it("doesn't reopen the match already past its deadline", async () => {
    const { match } = await liveMatch();
    await postgres.query(
      "UPDATE match_options SET auto_cancellation = false WHERE id = $1",
      [match.options_id],
    );

    await service().restartMatch(match.id);

    const [after] = await postgres.query<
      Array<{
        status: string;
        cancels_at: Date | null;
        server_id: string | null;
      }>
    >("SELECT status, cancels_at, server_id FROM matches WHERE id = $1", [
      match.id,
    ]);
    expect(after).toEqual({
      status: "WaitingForCheckIn",
      cancels_at: null,
      server_id: null,
    });
  });

  it("puts a map still in its knife round back to the start", async () => {
    const { match, mapId } = await liveMatch();
    await postgres.query(
      "UPDATE match_maps SET status = 'Knife' WHERE id = $1",
      [mapId],
    );

    await service().restartMatch(match.id);

    const [map] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM match_maps WHERE id = $1",
      [mapId],
    );
    expect(map.status).toBe("Scheduled");
  });
});
