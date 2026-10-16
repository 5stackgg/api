import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The match page reads v_match_player_buy_types, v_match_lineup_buy_types,
// v_match_lineup_map_stats, v_match_player_opening_duels and
// v_player_match_map_roles by match_id.
describe("match stats views", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchStatsViewsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199400000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const firstMap = async (matchId: string) => {
    const [existing] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_maps WHERE match_id = $1",
      [matchId],
    );
    return (
      existing?.id ??
      (
        await postgres.query<Array<{ id: string }>>(
          `INSERT INTO match_maps (match_id, map_id, "order")
           SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
          [matchId],
        )
      )[0].id
    );
  };

  // Four rounds, lineup 1 on T and lineup 2 on CT throughout. Lineup 1 ends
  // rounds on $25,000 / $3,000 and lineup 2 on $15,000 / $30,000, so round 1 is
  // the pistol, rounds 2 and 4 are lineup 1's full buy into lineup 2's force,
  // and round 3 is lineup 1's eco into lineup 2's full buy. T wins the odd
  // rounds. First kills: a1 in round 1, b1 in round 2, a1 in round 3, none in 4.
  const playedMatch = async () => {
    const match = await fx.match({ type: "Competitive", mr: 12 });
    const mapId = await firstMap(match.id);
    const a1 = await fx.lineupPlayer(match.lineup_1_id);
    const a2 = await fx.lineupPlayer(match.lineup_1_id);
    const b1 = await fx.lineupPlayer(match.lineup_2_id);
    const b2 = await fx.lineupPlayer(match.lineup_2_id);

    await postgres.query(
      `INSERT INTO match_map_rounds
         (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
          "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
          lineup_1_side, lineup_2_side, winning_side)
       SELECT $1, r, 0, 0,
         CASE WHEN r % 2 = 1 THEN 25000 ELSE 3000 END,
         CASE WHEN r % 2 = 1 THEN 15000 ELSE 30000 END,
         now() - make_interval(mins => 100 - r), 3, 3,
         'TERRORIST', 'CT', CASE WHEN r % 2 = 1 THEN 'TERRORIST' ELSE 'CT' END
       FROM generate_series(1, 4) r`,
      [mapId],
    );

    const ctx = { matchId: match.id, mapId };
    const at = (round: number, second: number) =>
      new Date(
        Date.now() - (100 - round) * 60_000 + second * 1000,
      ).toISOString();
    const t = { attackerTeam: "TERRORIST", victimTeam: "CT" };
    const ct = { attackerTeam: "CT", victimTeam: "TERRORIST" };
    await fx.kill(ctx, a1, b1, { ...t, round: 1, time: at(1, 1) });
    await fx.kill(ctx, a2, b2, { ...t, round: 1, time: at(1, 2) });
    await fx.kill(ctx, b1, a1, { ...ct, round: 2, time: at(2, 1) });
    await fx.kill(ctx, b2, a2, { ...ct, round: 2, time: at(2, 2) });
    await fx.kill(ctx, a1, b2, { ...t, round: 3, time: at(3, 1) });
    await fx.kill(ctx, b1, a2, { ...ct, round: 3, time: at(3, 2) });

    return { match, mapId, a1, a2, b1, b2 };
  };

  const playerBuyTypes = (matchId: string) =>
    postgres.query<
      Array<{
        steam_id: string;
        matchup: string;
        rounds: number;
        kills: number;
        deaths: number;
      }>
    >(
      `SELECT steam_id::text, matchup, rounds, kills, deaths
         FROM v_match_player_buy_types WHERE match_id = $1
        ORDER BY steam_id, matchup`,
      [matchId],
    );

  const lineupBuyTypes = (matchId: string, lineupId: string) =>
    postgres.query<Array<{ matchup: string; rounds: number; wins: number }>>(
      `SELECT matchup, rounds, wins FROM v_match_lineup_buy_types
        WHERE match_id = $1 AND match_lineup_id = $2 ORDER BY matchup`,
      [matchId, lineupId],
    );

  const mapStats = async (matchId: string, lineupId: string) => {
    const [row] = await postgres.query<Array<Record<string, number>>>(
      `SELECT rounds, round_wins, pistol_rounds, pistol_wins, opening_attempts,
              opening_wins, man_adv_rounds, man_adv_wins, man_dis_rounds,
              man_dis_wins, won_buy_pistol, won_buy_eco, won_buy_force, won_buy_full
         FROM v_match_lineup_map_stats WHERE match_id = $1 AND match_lineup_id = $2`,
      [matchId, lineupId],
    );
    return row;
  };

  it("credits each player's kills and deaths to the matchup of the round", async () => {
    const { match, a1, a2, b1, b2 } = await playedMatch();
    const row = (
      steam_id: string,
      matchup: string,
      rounds: number,
      kills: number,
      deaths: number,
    ) => ({ steam_id, matchup, rounds, kills, deaths });

    expect(await playerBuyTypes(match.id)).toEqual(
      [
        row(a1, "eco_v_full", 1, 1, 0),
        row(a1, "full_v_force", 2, 0, 1),
        row(a1, "pistol_v_pistol", 1, 1, 0),
        row(a2, "eco_v_full", 1, 0, 1),
        row(a2, "full_v_force", 2, 0, 1),
        row(a2, "pistol_v_pistol", 1, 1, 0),
        row(b1, "force_v_full", 2, 1, 0),
        row(b1, "full_v_eco", 1, 1, 0),
        row(b1, "pistol_v_pistol", 1, 0, 1),
        row(b2, "force_v_full", 2, 1, 0),
        row(b2, "full_v_eco", 1, 0, 1),
        row(b2, "pistol_v_pistol", 1, 0, 1),
      ].sort((x, y) =>
        x.steam_id === y.steam_id
          ? x.matchup.localeCompare(y.matchup)
          : x.steam_id.localeCompare(y.steam_id),
      ),
    );
  });

  it("counts each lineup's rounds and wins per matchup", async () => {
    const { match } = await playedMatch();

    expect(await lineupBuyTypes(match.id, match.lineup_1_id)).toEqual([
      { matchup: "eco_v_full", rounds: 1, wins: 1 },
      { matchup: "full_v_force", rounds: 2, wins: 0 },
      { matchup: "pistol_v_pistol", rounds: 1, wins: 1 },
    ]);
    expect(await lineupBuyTypes(match.id, match.lineup_2_id)).toEqual([
      { matchup: "force_v_full", rounds: 2, wins: 2 },
      { matchup: "full_v_eco", rounds: 1, wins: 0 },
      { matchup: "pistol_v_pistol", rounds: 1, wins: 0 },
    ]);
  });

  it("scores openings, man advantage and buy wins from each round's first kill", async () => {
    const { match } = await playedMatch();

    expect(await mapStats(match.id, match.lineup_1_id)).toEqual({
      rounds: 4,
      round_wins: 2,
      pistol_rounds: 1,
      pistol_wins: 1,
      opening_attempts: 3,
      opening_wins: 2,
      man_adv_rounds: 3,
      man_adv_wins: 2,
      man_dis_rounds: 1,
      man_dis_wins: 0,
      won_buy_pistol: 1,
      won_buy_eco: 1,
      won_buy_force: 0,
      won_buy_full: 0,
    });
    expect(await mapStats(match.id, match.lineup_2_id)).toEqual({
      rounds: 4,
      round_wins: 2,
      pistol_rounds: 1,
      pistol_wins: 0,
      opening_attempts: 3,
      opening_wins: 1,
      man_adv_rounds: 2,
      man_adv_wins: 2,
      man_dis_rounds: 2,
      man_dis_wins: 0,
      won_buy_pistol: 0,
      won_buy_eco: 0,
      won_buy_force: 2,
      won_buy_full: 0,
    });
  });

  it("credits openings and the trade of an opening death to each player", async () => {
    const match = await fx.match({ type: "Competitive", mr: 12 });
    const mapId = await firstMap(match.id);
    const a1 = await fx.lineupPlayer(match.lineup_1_id);
    const a2 = await fx.lineupPlayer(match.lineup_1_id);
    const b1 = await fx.lineupPlayer(match.lineup_2_id);
    const b2 = await fx.lineupPlayer(match.lineup_2_id);
    await postgres.query(
      `INSERT INTO match_map_rounds
         (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
          "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
          lineup_1_side, lineup_2_side, winning_side)
       SELECT $1, r, 0, 0, 4000, 4000, now() - make_interval(mins => 100 - r), 3, 3,
              'TERRORIST', 'CT', 'CT'
         FROM generate_series(1, 2) r`,
      [mapId],
    );
    const ctx = { matchId: match.id, mapId };
    const at = (round: number, second: number) =>
      new Date(
        Date.now() - (100 - round) * 60_000 + second * 1000,
      ).toISOString();
    const t = { attackerTeam: "TERRORIST", victimTeam: "CT" };
    const ct = { attackerTeam: "CT", victimTeam: "TERRORIST" };
    // Round 1: a1 opens on b1, and b2 trades a1. Round 2: b2 opens on a2.
    await fx.kill(ctx, a1, b1, { ...t, round: 1, time: at(1, 1) });
    await fx.kill(ctx, b2, a1, { ...ct, round: 1, time: at(1, 2) });
    await fx.kill(ctx, b2, a2, { ...ct, round: 2, time: at(2, 1) });

    const rows = await postgres.query<
      Array<{
        steam_id: string;
        attempts: number;
        wins: number;
        deaths: number;
        traded_deaths: number;
      }>
    >(
      `SELECT steam_id::text, attempts, wins, deaths, traded_deaths
         FROM v_match_player_opening_duels WHERE match_id = $1 ORDER BY steam_id`,
      [match.id],
    );
    const row = (steam_id: string, wins: number, traded_deaths: number) => ({
      steam_id,
      attempts: 1,
      wins,
      deaths: 1 - wins,
      traded_deaths,
    });
    expect(rows).toEqual(
      [row(a1, 1, 0), row(a2, 0, 0), row(b1, 0, 1), row(b2, 1, 0)].sort(
        (x, y) => x.steam_id.localeCompare(y.steam_id),
      ),
    );
  });

  it("picks each lineup's entry and support from openings and utility", async () => {
    const { match, mapId, a1, a2, b1, b2 } = await playedMatch();
    for (const [steam, kills, deaths, flashAssists, flashes] of [
      [a1, 2, 1, 0, 0],
      [a2, 1, 2, 2, 3],
      [b1, 2, 1, 0, 0],
      [b2, 1, 2, 0, 0],
    ] as Array<[string, number, number, number, number]>) {
      await postgres.query(
        `INSERT INTO player_match_map_stats
           (steam_id, match_map_id, match_id, kills, deaths, assists, damage, flash_assists,
            he_damage, molotov_damage, flashes_thrown, trade_kill_successes,
            traded_death_successes, rounds_played, kast_rounds, kast_total_rounds)
         VALUES ($1, $2, $3, $4, $5, 0, 100, $6, 0, 0, $7, 0, 0, 4, 2, 4)`,
        [steam, mapId, match.id, kills, deaths, flashAssists, flashes],
      );
    }

    const rows = await postgres.query<
      Array<{
        steam_id: string;
        role: string;
        opening_attempts: number;
        open_kills: number;
        open_deaths: number;
      }>
    >(
      `SELECT steam_id::text, role, opening_attempts, open_kills, open_deaths
         FROM v_player_match_map_roles WHERE match_id = $1 ORDER BY steam_id`,
      [match.id],
    );
    expect(rows).toEqual(
      [
        {
          steam_id: a1,
          role: "Entry",
          opening_attempts: 3,
          open_kills: 2,
          open_deaths: 1,
        },
        {
          steam_id: a2,
          role: "Support",
          opening_attempts: 0,
          open_kills: 0,
          open_deaths: 0,
        },
        {
          steam_id: b1,
          role: "Entry",
          opening_attempts: 2,
          open_kills: 1,
          open_deaths: 1,
        },
        {
          steam_id: b2,
          role: "Rifler",
          opening_attempts: 1,
          open_kills: 0,
          open_deaths: 1,
        },
      ].sort((x, y) => x.steam_id.localeCompare(y.steam_id)),
    );
  });

  // The profile and role-filtered leaderboards read roles by player, which no
  // match filter narrows: there each logical scan of player_kills reads them
  // all, so first_kills must not be expanded once per use.
  it("scans player_kills once per use when roles are read by player", async () => {
    const { match, mapId, a1 } = await playedMatch();
    await postgres.query(
      `INSERT INTO player_match_map_stats
         (steam_id, match_map_id, match_id, kills, deaths, rounds_played)
       VALUES ($1, $2, $3, 2, 1, 4)`,
      [a1, mapId, match.id],
    );
    const chunks = (
      await postgres.query<Array<{ name: string }>>(
        `SELECT chunk_name AS name FROM timescaledb_information.chunks
          WHERE hypertable_name = 'player_kills'`,
      )
    ).map(({ name }) => name);
    const killTables = new Set(["player_kills", ...chunks]);

    const [{ "QUERY PLAN": plan }] = await postgres.query<
      Array<{ "QUERY PLAN": Array<{ Plan: Record<string, any> }> }>
    >(
      "EXPLAIN (FORMAT JSON) SELECT * FROM v_player_match_map_roles WHERE steam_id = $1",
      [a1],
    );
    const scans = new Set<string>();
    const walk = (node: Record<string, any>) => {
      if (killTables.has(node["Relation Name"])) {
        scans.add(node.Alias);
      }
      for (const child of node.Plans ?? []) {
        walk(child);
      }
    };
    walk(plan[0].Plan);

    expect(scans.size).toBe(2);
  });

  // Measured at two panel sizes with fresh statistics both times, so the
  // comparison is the same plan reading more data, not two different plans.
  // Doubling a small panel still costs a read filtered to one match a few
  // buffers as tiny tables trade seq scans for index lookups; reading the
  // whole panel costs hundreds.
  it("reads one match the same however many other matches the panel holds", async () => {
    const { match, mapId, a1, a2, b1, b2 } = await playedMatch();
    const stats = (steam: string, matchId: string, matchMapId: string) =>
      postgres.query(
        `INSERT INTO player_match_map_stats
           (steam_id, match_map_id, match_id, kills, deaths, assists, damage, flash_assists,
            he_damage, molotov_damage, flashes_thrown, trade_kill_successes,
            traded_death_successes, rounds_played, kast_rounds, kast_total_rounds)
         VALUES ($1, $2, $3, 1, 1, 0, 100, 0, 0, 0, 0, 0, 0, 4, 2, 4)`,
        [steam, matchMapId, matchId],
      );
    for (const steam of [a1, a2, b1, b2]) {
      await stats(steam, match.id, mapId);
    }

    const views = [
      "SELECT * FROM v_match_player_buy_types WHERE match_id = $1",
      "SELECT * FROM v_match_lineup_buy_types WHERE match_id = $1",
      "SELECT * FROM v_match_lineup_map_stats WHERE match_id = $1",
      "SELECT * FROM v_match_player_opening_duels WHERE match_id = $1",
      "SELECT * FROM v_player_match_map_roles WHERE match_id = $1",
    ];
    const buffers = async () => {
      await postgres.query(
        "ANALYZE match_map_rounds, player_kills, match_maps, matches, match_lineup_players, player_match_map_stats",
      );
      const read: Array<number> = [];
      for (const sql of views) {
        const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
        await postgres.query(explain, [match.id]);
        const [{ "QUERY PLAN": plan }] = await postgres.query<
          Array<{ "QUERY PLAN": Array<{ Plan: Record<string, number> }> }>
        >(explain, [match.id]);
        read.push(
          plan[0].Plan["Shared Hit Blocks"] +
            plan[0].Plan["Shared Read Blocks"],
        );
      }
      return read;
    };
    const addMatches = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const { matchId, mapId } = await fx.bareMatch(new Date().toISOString());
        await postgres.query(
          `INSERT INTO match_map_rounds
             (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
              "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
              lineup_1_side, lineup_2_side, winning_side)
           SELECT $1, r, 0, 0, 10000, 10000, now() - make_interval(mins => 100 - r), 3, 3,
                  'TERRORIST', 'CT', 'CT'
             FROM generate_series(1, 30) r`,
          [mapId],
        );
        await postgres.query(
          `INSERT INTO player_kills
             (match_id, match_map_id, round, attacker_steam_id, attacker_team,
              attacked_steam_id, attacked_team, attacked_location, "with", hitgroup, "time")
           SELECT $1, $2, r, $3, 'TERRORIST', $4, 'CT', 'site', 'ak47', 'head',
                  now() - make_interval(mins => 100 - r, secs => k)
             FROM generate_series(1, 30) r CROSS JOIN generate_series(1, 3) k`,
          [matchId, mapId, a1, b1],
        );
        await stats(a1, matchId, mapId);
        await stats(b1, matchId, mapId);
      }
    };

    await addMatches(75);
    const before = await buffers();
    await addMatches(75);
    const after = await buffers();

    const growth = views.map((sql, i) => ({
      sql,
      buffers: after[i] - before[i],
    }));
    expect(growth.filter(({ buffers }) => buffers > 30)).toEqual([]);
  }, 180_000);
});
