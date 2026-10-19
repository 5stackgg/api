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
        restartServerMap: async (): Promise<string> => "",
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

  describe("putting a map back to a round", () => {
    // The live map from liveMatch, played on to round 5 with a backup and a
    // kill in every round, and round 6 under way.
    const fiveRounds = async () => {
      const live = await liveMatch();
      const { match, mapId } = live;
      await postgres.query(
        "UPDATE match_map_rounds SET backup_file = $2 WHERE match_map_id = $1",
        [mapId, backup(157864, "vexa", 4100)],
      );
      for (const round of [3, 4, 5]) {
        await postgres.query(
          `INSERT INTO match_map_rounds
             (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
              "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
              lineup_1_side, lineup_2_side, winning_side, backup_file)
           VALUES ($1, $2, $2, 0, 800, 800, now(), $3, 1, 'CT', 'TERRORIST', 'CT', $4)`,
          [mapId, round, 5 - round, backup(157864, "vexa", 4100)],
        );
      }
      for (const round of [1, 3, 4, 5, 6]) {
        await kill(match.id, mapId, round);
      }
      await postgres.query(
        "UPDATE match_maps SET lineup_1_timeouts_available = 0, lineup_2_timeouts_available = 1 WHERE id = $1",
        [mapId],
      );

      return live;
    };

    const kill = (matchId: string, mapId: string, round: number) =>
      fx.kill({ matchId, mapId }, steamId(157864), steamId(235177), {
        round,
      });

    const reset = (mapId: string, round: number) =>
      postgres.query("SELECT reset_match_map_to_round($1, $2)", [mapId, round]);

    const state = async (mapId: string) => {
      const [rounds] = await postgres.query<
        Array<{ live: Array<number>; undone: Array<number> }>
      >(
        `SELECT COALESCE(array_agg(round ORDER BY round) FILTER (WHERE deleted_at IS NULL), '{}') AS live,
                COALESCE(array_agg(round ORDER BY round) FILTER (WHERE deleted_at IS NOT NULL), '{}') AS undone
           FROM match_map_rounds WHERE match_map_id = $1`,
        [mapId],
      );
      const [kills] = await postgres.query<
        Array<{ live: Array<number>; undone: Array<number> }>
      >(
        `SELECT COALESCE(array_agg(round ORDER BY round) FILTER (WHERE deleted_at IS NULL), '{}') AS live,
                COALESCE(array_agg(round ORDER BY round) FILTER (WHERE deleted_at IS NOT NULL), '{}') AS undone
           FROM player_kills WHERE match_map_id = $1`,
        [mapId],
      );
      const [timeouts] = await postgres.query<
        Array<{ lineup_1: number; lineup_2: number }>
      >(
        `SELECT lineup_1_timeouts_available AS lineup_1, lineup_2_timeouts_available AS lineup_2
           FROM match_maps WHERE id = $1`,
        [mapId],
      );

      return { rounds, kills, timeouts };
    };

    const shown = async (mapId: string) => {
      const [row] = await postgres.query<
        Array<{ lineup_1: number; kills: number }>
      >(
        `SELECT lineup_1_score(mm) AS lineup_1,
                COALESCE((SELECT sum(kills) FROM player_match_map_stats WHERE match_map_id = mm.id), 0)::int AS kills
           FROM match_maps mm WHERE mm.id = $1`,
        [mapId],
      );
      return row;
    };

    it("shows the score and the scoreboard of the round it went back to", async () => {
      const { match, mapId } = await fiveRounds();

      await reset(mapId, 3);
      expect(await shown(mapId)).toEqual({ lineup_1: 3, kills: 3 });

      await reset(mapId, 5);
      expect(await shown(mapId)).toEqual({ lineup_1: 5, kills: 5 });

      await service().restartMatchMap(match.id, admin);
      expect(await shown(mapId)).toEqual({ lineup_1: 0, kills: 0 });
    });

    it("rolls back to a round and drops the round that was under way", async () => {
      const { mapId } = await fiveRounds();

      await reset(mapId, 3);

      expect(await state(mapId)).toEqual({
        rounds: { live: [1, 2, 3], undone: [4, 5] },
        kills: { live: [1, 2, 3], undone: [4, 5] },
        timeouts: { lineup_1: 2, lineup_2: 1 },
      });
    });

    it("refuses a round the map doesn't have, and changes nothing", async () => {
      const { mapId } = await fiveRounds();
      const before = await state(mapId);

      await expect(reset(mapId, 9)).rejects.toMatchObject({
        code: "P0002",
        message: "there is no round 9 on this map to go back to",
      });

      expect(await state(mapId)).toEqual(before);
    });

    it("rolls forward again until the next round is played, without counting the replayed round twice", async () => {
      const { match, mapId } = await fiveRounds();
      await reset(mapId, 3);
      await kill(match.id, mapId, 4);

      await reset(mapId, 5);

      expect(await state(mapId)).toEqual({
        rounds: { live: [1, 2, 3, 4, 5], undone: [] },
        kills: { live: [1, 2, 3, 4, 5], undone: [] },
        timeouts: { lineup_1: 0, lineup_2: 1 },
      });
    });

    // How a restore to round 3 leaves the map: rounds 4 and 5 are undone, but
    // kept until round 4 is played again.
    it("can still go forward to a round an earlier restore undid", async () => {
      const { match, mapId } = await fiveRounds();
      await postgres.query(
        "UPDATE match_map_rounds SET deleted_at = now() WHERE match_map_id = $1 AND round > 3",
        [mapId],
      );
      const sent: Array<number> = [];

      const restore = await service(sent).getRestoreRounds(match.id, admin);
      await service(sent).restoreRound(match.id, 5, admin);

      expect(restore.live_round).toBe(4);
      expect(
        restore.rounds.map((round) => [round.round, round.undone]),
      ).toEqual([
        [1, false],
        [2, false],
        [3, false],
        [4, true],
        [5, true],
      ]);
      expect(sent).toEqual([5]);
    });

    it("restarts the map from warmup with every round still restorable", async () => {
      const { match, mapId } = await fiveRounds();
      const sent: Array<number> = [];

      await service(sent).restartMatchMap(match.id, admin);

      expect(await state(mapId)).toEqual({
        rounds: { live: [], undone: [1, 2, 3, 4, 5] },
        kills: { live: [], undone: [1, 2, 3, 4, 5] },
        timeouts: { lineup_1: 3, lineup_2: 3 },
      });

      const restore = await service(sent).getRestoreRounds(match.id, admin);
      expect(restore.live_round).toBe(1);
      expect(restore.restorable).toBe(true);
      expect(restore.rounds.map((round) => round.undone)).toEqual([
        true,
        true,
        true,
        true,
        true,
      ]);

      await postgres.query(
        "UPDATE match_maps SET status = 'Warmup' WHERE id = $1",
        [mapId],
      );
      await expect(
        service(sent).restoreRound(match.id, 4, admin),
      ).rejects.toThrow("the map isn't live yet");

      await postgres.query(
        "UPDATE match_maps SET status = 'Live' WHERE id = $1",
        [mapId],
      );
      await service(sent).restoreRound(match.id, 4, admin);
      expect(sent).toEqual([4]);
    });

    it("does the same when the whole match is restarted", async () => {
      const { match, mapId } = await fiveRounds();

      await service().restartMatch(match.id);

      expect(await state(mapId)).toMatchObject({
        rounds: { live: [], undone: [1, 2, 3, 4, 5] },
        kills: { live: [], undone: [1, 2, 3, 4, 5] },
      });
    });
  });
});
