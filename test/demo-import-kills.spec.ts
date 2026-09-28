import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// persist_imported_demo turns a demo-parser payload into player_kills rows.
// The parser emits one entry per death, and a death has no killer when the
// bomb or the world did it. Those rows still have to land: the live event path
// (KillEvent.ts) records them as self-inflicted, so dropping them here would
// mean the same death counts in a live match and disappears from an imported
// demo — the victim quietly loses a death, and every stat derived from it
// (K/D, survival, KAST, HLTV rating) drifts with it.
describe("persist_imported_demo kill ingestion", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("DemoImportKillsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199300000000n);
    await seedRegionWithServer(postgres, "TestDemoImport");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM players");
  });

  // Wires a demo row onto a bare match so persist_imported_demo can resolve it.
  const demoFor = async (ctx: { matchId: string; mapId: string }) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_map_demos (match_id, match_map_id, file)
       VALUES ($1, $2, 'test.dem') RETURNING id`,
      [ctx.matchId, ctx.mapId],
    );
    return row.id;
  };

  const importDemo = async (demoId: string, parsed: unknown) => {
    await postgres.query(
      "SELECT public.persist_imported_demo($1::uuid, $2::jsonb)",
      [demoId, JSON.stringify(parsed)],
    );
  };

  const killRows = async (mapId: string) =>
    postgres.query<
      Array<{
        attacker_steam_id: string | null;
        attacked_steam_id: string;
        with: string;
      }>
    >(
      `SELECT attacker_steam_id::text, attacked_steam_id::text, "with"
         FROM player_kills WHERE match_map_id = $1 ORDER BY time`,
      [mapId],
    );

  it("keeps a bomb death, attributing it to the victim like the live path", async () => {
    const ctx = await fx.bareMatch();
    const demoId = await demoFor(ctx);
    const [shooter, victim, bombVictim] = await fx.players(3);

    await importDemo(demoId, {
      map_name: "de_cache",
      tick_rate: 64,
      total_ticks: 2000,
      round_ticks: [{ round: 1, start_tick: 0, end_tick: 2000 }],
      players: [shooter, victim, bombVictim].map((steam_id) => ({
        steam_id,
        name: `p-${steam_id}`,
      })),
      kills: [
        {
          tick: 100,
          killer: shooter,
          killer_team: "ct",
          victim,
          victim_team: "t",
          weapon: "ak47",
        },
        // Bomb detonation: the parser reports the victim with no killer.
        {
          tick: 200,
          killer: "",
          killer_team: "",
          victim: bombVictim,
          victim_team: "ct",
          weapon: "c4",
        },
      ],
    });

    const rows = await killRows(ctx.mapId);
    expect(rows).toHaveLength(2);

    const bomb = rows.find((r) => r.with === "c4");
    expect(bomb).toBeDefined();
    expect(bomb!.attacked_steam_id).toBe(bombVictim);
    // Self-attributed, exactly as KillEvent.ts does for a killer-less death.
    expect(bomb!.attacker_steam_id).toBe(bombVictim);
  });

  it("counts a bomb death as a death without inventing a kill", async () => {
    const ctx = await fx.bareMatch();
    const demoId = await demoFor(ctx);
    const [shooter, bombVictim] = await fx.players(2);

    await importDemo(demoId, {
      map_name: "de_cache",
      tick_rate: 64,
      total_ticks: 2000,
      round_ticks: [{ round: 1, start_tick: 0, end_tick: 2000 }],
      players: [shooter, bombVictim].map((steam_id) => ({
        steam_id,
        name: `p-${steam_id}`,
      })),
      kills: [
        {
          tick: 200,
          killer: "",
          killer_team: "",
          victim: bombVictim,
          victim_team: "ct",
          weapon: "c4",
        },
      ],
    });

    const [stats] = await postgres.query<
      Array<{ kills: number; deaths: number }>
    >(
      `SELECT kills, deaths FROM player_match_map_stats
        WHERE match_map_id = $1 AND steam_id = $2`,
      [ctx.mapId, bombVictim],
    );

    expect(stats?.deaths).toBe(1);
    // kills is FILTER (attacker_team <> attacked_team), so a self-kill is out.
    expect(stats?.kills).toBe(0);
  });

  // The demo keeps recording after the final round — the post-match walkaround,
  // where players shoot each other for fun. Those are not scoreboard deaths.
  it("drops a death that lands after the last round ended", async () => {
    const ctx = await fx.bareMatch();
    const demoId = await demoFor(ctx);
    const [shooter, victim] = await fx.players(2);

    await importDemo(demoId, {
      map_name: "de_cache",
      tick_rate: 64,
      total_ticks: 5000,
      round_ticks: [{ round: 1, start_tick: 0, end_tick: 2000 }],
      players: [shooter, victim].map((steam_id) => ({
        steam_id,
        name: `p-${steam_id}`,
      })),
      kills: [
        {
          tick: 100, // during the round
          killer: shooter,
          killer_team: "ct",
          victim,
          victim_team: "t",
          weapon: "ak47",
        },
        {
          tick: 4000, // long after round 1 ended at 2000
          killer: shooter,
          killer_team: "ct",
          victim,
          victim_team: "t",
          weapon: "deagle",
        },
        {
          tick: 4100, // a post-match world death, likewise ignored
          killer: "",
          killer_team: "",
          victim,
          victim_team: "t",
          weapon: "world",
        },
      ],
    });

    const rows = await killRows(ctx.mapId);
    expect(rows.map((r) => r.with)).toEqual(["ak47"]);

    const [stats] = await postgres.query<Array<{ deaths: number }>>(
      `SELECT deaths FROM player_match_map_stats
        WHERE match_map_id = $1 AND steam_id = $2`,
      [ctx.mapId, victim],
    );
    expect(stats?.deaths).toBe(1);
  });

  it("drops a post-match assist along with its kill", async () => {
    const ctx = await fx.bareMatch();
    const demoId = await demoFor(ctx);
    const [shooter, victim, helper] = await fx.players(3);

    await importDemo(demoId, {
      map_name: "de_cache",
      tick_rate: 64,
      total_ticks: 5000,
      round_ticks: [{ round: 1, start_tick: 0, end_tick: 2000 }],
      players: [shooter, victim, helper].map((steam_id) => ({
        steam_id,
        name: `p-${steam_id}`,
      })),
      kills: [
        {
          tick: 4000,
          killer: shooter,
          killer_team: "ct",
          victim,
          victim_team: "t",
          weapon: "ak47",
          assist: helper,
        },
      ],
    });

    expect(await killRows(ctx.mapId)).toHaveLength(0);
    const [assists] = await postgres.query<Array<{ count: string }>>(
      "SELECT COUNT(*)::text AS count FROM player_assists WHERE match_map_id = $1",
      [ctx.mapId],
    );
    expect(assists.count).toBe("0");
  });

  it("still drops an entry with no victim at all", async () => {
    const ctx = await fx.bareMatch();
    const demoId = await demoFor(ctx);
    const [shooter] = await fx.players(1);

    await importDemo(demoId, {
      map_name: "de_cache",
      tick_rate: 64,
      total_ticks: 2000,
      round_ticks: [{ round: 1, start_tick: 0, end_tick: 2000 }],
      players: [{ steam_id: shooter, name: "p" }],
      kills: [
        {
          tick: 100,
          killer: shooter,
          killer_team: "ct",
          victim: "",
          weapon: "ak47",
        },
      ],
    });

    expect(await killRows(ctx.mapId)).toHaveLength(0);
  });

  describe("Valve ranks on a Rush import", () => {
    const importWithRanks = async (type: string) => {
      const { matchId } = await fx.bareMatch();
      const optionsId = await fx.matchOptions({ type, mr: 8 });
      await postgres.query(
        "UPDATE matches SET match_options_id = $1 WHERE id = $2",
        [optionsId, matchId],
      );
      // A single-map seed pool (Rush) re-materializes the match's maps.
      const [map] = await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM match_maps WHERE match_id = $1 ORDER BY "order" LIMIT 1`,
        [matchId],
      );
      const ctx = { matchId, mapId: map.id };
      const [player] = await fx.players(1);
      await importDemo(await demoFor(ctx), {
        map_name: "rush_001",
        tick_rate: 64,
        total_ticks: 2000,
        round_ticks: [{ round: 1, start_tick: 0, end_tick: 2000 }],
        players: [
          {
            steam_id: player,
            name: `p-${player}`,
            rank: 15000,
            rank_type: 11,
            previous_rank: 14800,
          },
        ],
        kills: [],
      });

      const history = await postgres.query<Array<{ rank: number }>>(
        "SELECT rank FROM player_premier_rank_history WHERE match_id = $1",
        [ctx.matchId],
      );
      const [row] = await postgres.query<
        Array<{ premier_rank: number | null }>
      >("SELECT premier_rank FROM players WHERE steam_id = $1", [player]);
      return { history, premierRank: row.premier_rank };
    };

    // Rush has no skill group; the scoreboard's Premier rating is not this
    // match's rank.
    it("records no rank history and leaves premier_rank alone", async () => {
      const { history, premierRank } = await importWithRanks("Rush");
      expect(history).toHaveLength(0);
      expect(premierRank).toBeNull();
    });

    it("still records Premier ranks on a non-Rush import", async () => {
      const { history, premierRank } = await importWithRanks("Competitive");
      expect(history.map((h) => h.rank)).toEqual([15000]);
      expect(premierRank).toBe(15000);
    });
  });

  // MatchImportService.insertMatchMap clears these before adding the demo's
  // map; without that, every Rush import is rejected as one map too many.
  it("materializes a Rush import's map on insert, leaving no room for another", async () => {
    const optionsId = await fx.matchOptions({ type: "Rush" });
    const [l1] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
    );
    const [l2] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
    );
    const [match] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO matches (source, status, lineup_1_id, lineup_2_id, match_options_id, started_at, ended_at)
       VALUES ('valve', 'Finished', $1, $2, $3, now(), now()) RETURNING id`,
      [l1.id, l2.id, optionsId],
    );
    const insertMap = () =>
      postgres.query(
        `INSERT INTO match_maps (match_id, map_id, "order", status)
         SELECT $1, id, 0, 'Finished' FROM maps WHERE name = 'rush_001' AND type = 'Rush'`,
        [match.id],
      );

    await expect(insertMap()).rejects.toThrow(
      "Match already has the maximum number of picked maps",
    );

    await postgres.query("DELETE FROM match_maps WHERE match_id = $1", [
      match.id,
    ]);
    await insertMap();
    const maps = await postgres.query<Array<{ order: number }>>(
      `SELECT "order" FROM match_maps WHERE match_id = $1`,
      [match.id],
    );
    expect(maps.map((m) => m.order)).toEqual([0]);
  });

  it("never swaps an imported Rush match's sides", async () => {
    const sides = await postgres.query<
      Array<{ competitive: string; rush: string }>
    >(
      `SELECT public._import_lineup_1_side(r, 8, 'Competitive') AS competitive,
              public._import_lineup_1_side(r, 8, 'Rush') AS rush
       FROM unnest(ARRAY[1, 8, 9, 15]) AS r`,
    );

    expect(sides.map((s) => s.competitive)).toEqual([
      "TERRORIST",
      "TERRORIST",
      "CT",
      "CT",
    ]);
    expect(sides.map((s) => s.rush)).toEqual([
      "TERRORIST",
      "TERRORIST",
      "TERRORIST",
      "TERRORIST",
    ]);
  });

  // An uploaded 5stack demo had one player release several grenades on the
  // same tick; player_utility's PK is (match_map_id, attacker_steam_id, time).
  it("keeps every grenade one player throws on the same tick", async () => {
    const ctx = await fx.bareMatch();
    const demoId = await demoFor(ctx);
    const [thrower, victim] = await fx.players(2);

    const throwAt = (gid: number, type: string) => ({
      tick: 300,
      round: 1,
      gid,
      thrower,
      thrower_team: "ct",
      type,
    });

    await importDemo(demoId, {
      map_name: "de_cache",
      tick_rate: 64,
      total_ticks: 2000,
      round_ticks: [{ round: 1, start_tick: 0, end_tick: 2000 }],
      players: [thrower, victim].map((steam_id) => ({
        steam_id,
        name: `p-${steam_id}`,
      })),
      grenade_throws: [
        throwAt(1, "HE"),
        throwAt(2, "HE"),
        throwAt(3, "Flash"),
      ],
      flashes: [1, 2].map(() => ({
        tick: 350,
        round: 1,
        attacker: thrower,
        victim,
        duration: 2,
      })),
    });

    const [utility] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*) FROM player_utility WHERE match_map_id = $1`,
      [ctx.mapId],
    );
    expect(Number(utility.count)).toBe(3);

    const [flashes] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*) FROM player_flashes WHERE match_map_id = $1`,
      [ctx.mapId],
    );
    expect(Number(flashes.count)).toBe(2);
  });
});
