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
    await postgres.query("SELECT public.persist_imported_demo($1::uuid, $2::jsonb)", [
      demoId,
      JSON.stringify(parsed),
    ]);
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
        { tick: 100, killer: shooter, killer_team: "ct", victim: "", weapon: "ak47" },
      ],
    });

    expect(await killRows(ctx.mapId)).toHaveLength(0);
  });
});
