import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises recompute_player_match_map_stats (driven by the match_map_rounds
// trigger): finalized-round gating, per-map kill/death/assist/damage
// aggregation, team-kill exclusion, multi-kill buckets, the bulk-import skip
// switch — and detect_round_clutch's won/saved/lost outcomes.
describe("per-map stat recompute and clutch detection (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("StatRecomputeTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199200000000n);
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

  const mapStats = async (mapId: string, steam: string) => {
    const [row] = await postgres.query<
      Array<{
        kills: number;
        hs_kills: number;
        deaths: number;
        assists: number;
        damage: number;
        two_kill_rounds: number;
        three_kill_rounds: number;
        rounds_played: number;
      }>
    >(
      "SELECT * FROM player_match_map_stats WHERE match_map_id = $1 AND steam_id = $2",
      [mapId, steam],
    );
    return row;
  };

  const T = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it("only counts events from finalized rounds, catching up as rounds land", async () => {
    const ctx = await fx.bareMatch();
    const [attacker, victim] = await fx.players(2);

    await fx.kill(ctx, attacker, victim, { round: 1, time: T(10) });
    await fx.kill(ctx, attacker, victim, { round: 2, time: T(5) });

    // No rounds finalized yet: the recompute never ran.
    expect(await mapStats(ctx.mapId, attacker)).toBeUndefined();

    await fx.round(ctx.mapId, 1, { time: T(9) });
    expect(await mapStats(ctx.mapId, attacker)).toMatchObject({
      kills: 1,
      rounds_played: 1,
    });

    await fx.round(ctx.mapId, 2, { time: T(4) });
    expect(await mapStats(ctx.mapId, attacker)).toMatchObject({
      kills: 2,
      rounds_played: 2,
    });
  });

  it("aggregates kills, headshots, deaths, assists, and damage per map", async () => {
    const ctx = await fx.bareMatch();
    const [attacker, assister, victim] = await fx.players(3);

    await fx.kill(ctx, attacker, victim, {
      round: 1,
      headshot: true,
      time: T(10),
    });
    await fx.assist(ctx, assister, victim, T(10));
    await fx.damage(ctx, attacker, victim, 73, { round: 1 });
    await fx.round(ctx.mapId, 1, { time: T(9) });

    expect(await mapStats(ctx.mapId, attacker)).toMatchObject({
      kills: 1,
      hs_kills: 1,
      deaths: 0,
      damage: 73,
    });
    expect(await mapStats(ctx.mapId, victim)).toMatchObject({
      kills: 0,
      deaths: 1,
    });
    expect(await mapStats(ctx.mapId, assister)).toMatchObject({ assists: 1 });
  });

  it("excludes team kills from the kill count (they still count as deaths)", async () => {
    const ctx = await fx.bareMatch();
    const [griefer, teammate] = await fx.players(2);

    await fx.kill(ctx, griefer, teammate, {
      round: 1,
      attackerTeam: "CT",
      victimTeam: "CT",
      time: T(10),
    });
    await fx.round(ctx.mapId, 1, { time: T(9) });

    expect(await mapStats(ctx.mapId, griefer)).toMatchObject({ kills: 0 });
    expect(await mapStats(ctx.mapId, teammate)).toMatchObject({ deaths: 1 });
  });

  it("buckets multi-kill rounds exclusively", async () => {
    const ctx = await fx.bareMatch();
    const players = await fx.players(6);
    const ace = players[0];

    // Three kills in round 1, two kills in round 2.
    for (let i = 1; i <= 3; i++) {
      await fx.kill(ctx, ace, players[i], { round: 1, time: T(20 - i) });
    }
    await fx.kill(ctx, ace, players[4], { round: 2, time: T(10) });
    await fx.kill(ctx, ace, players[5], { round: 2, time: T(9) });
    await fx.round(ctx.mapId, 1, { time: T(15) });
    await fx.round(ctx.mapId, 2, { time: T(8) });

    expect(await mapStats(ctx.mapId, ace)).toMatchObject({
      kills: 5,
      three_kill_rounds: 1,
      two_kill_rounds: 1,
    });
  });

  it("deleting a round drops its events back out of the stats", async () => {
    const ctx = await fx.bareMatch();
    const [attacker, victim] = await fx.players(2);

    await fx.kill(ctx, attacker, victim, { round: 1, time: T(10) });
    await fx.kill(ctx, attacker, victim, { round: 2, time: T(5) });
    await fx.round(ctx.mapId, 1, { time: T(9) });
    await fx.round(ctx.mapId, 2, { time: T(4) });
    expect(await mapStats(ctx.mapId, attacker)).toMatchObject({ kills: 2 });

    await postgres.query(
      "DELETE FROM match_map_rounds WHERE match_map_id = $1 AND round = 2",
      [ctx.mapId],
    );
    expect(await mapStats(ctx.mapId, attacker)).toMatchObject({ kills: 1 });
  });

  it("honors the bulk-import switch that skips per-row recomputes", async () => {
    const ctx = await fx.bareMatch();
    const [attacker, victim] = await fx.players(2);
    await fx.kill(ctx, attacker, victim, { round: 1, time: T(10) });

    await postgres.transaction(async (client) => {
      await client.query(
        "SELECT set_config('app.skip_round_recompute', 'on', true)",
      );
      await client.query(
        `INSERT INTO match_map_rounds
           (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
            "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
            lineup_1_side, lineup_2_side, winning_side)
         VALUES ($1, 1, 1, 0, 800, 800, now(), 3, 3, 'CT', 'TERRORIST', 'CT')`,
        [ctx.mapId],
      );
    });
    // Round landed, but the recompute was suppressed.
    expect(await mapStats(ctx.mapId, attacker)).toBeUndefined();

    // The importer's final full recompute picks everything up.
    await postgres.query("SELECT recompute_player_match_map_stats($1)", [
      ctx.mapId,
    ]);
    expect(await mapStats(ctx.mapId, attacker)).toMatchObject({ kills: 1 });
  });

  describe("detect_round_clutch", () => {
    // A 2v2 with named players so the kill feed can construct 1vX endgames.
    const clutchSetup = async () => {
      const match = await fx.match({ type: "Wingman", mr: 8, mapVeto: true });
      const [a, b, c, d] = await fx.players(4);
      await fx.lineupPlayer(match.lineup_1_id, a);
      await fx.lineupPlayer(match.lineup_1_id, b);
      await fx.lineupPlayer(match.lineup_2_id, c);
      await fx.lineupPlayer(match.lineup_2_id, d);
      const [map] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_maps (match_id, map_id, "order")
         SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
        [match.id],
      );
      return {
        ctx: { matchId: match.id, mapId: map.id },
        a,
        b,
        c,
        d,
      };
    };

    const clutch = async (mapId: string, round: number) => {
      const [row] = await postgres.query<
        Array<{
          clutcher_steam_id: string;
          against_count: number;
          kills_in_clutch: number;
          outcome: string;
        }>
      >("SELECT * FROM detect_round_clutch($1, $2)", [mapId, round]);
      return row;
    };

    it("a 1v2 conversion is a won clutch with its kill count", async () => {
      const { ctx, a, b, c, d } = await clutchSetup();
      // b falls first: a is alone against c and d, then closes it out.
      await fx.kill(ctx, c, b, { round: 1, time: T(10), attackerTeam: "TERRORIST", victimTeam: "CT" });
      await fx.kill(ctx, a, c, { round: 1, time: T(9), attackerTeam: "CT", victimTeam: "TERRORIST" });
      await fx.kill(ctx, a, d, { round: 1, time: T(8), attackerTeam: "CT", victimTeam: "TERRORIST" });
      await fx.round(ctx.mapId, 1, { winningSide: "CT", time: T(7) });

      expect(await clutch(ctx.mapId, 1)).toMatchObject({
        clutcher_steam_id: a,
        against_count: 2,
        kills_in_clutch: 2,
        outcome: "won",
      });
    });

    it("dying in the 1v2 is a lost clutch", async () => {
      const { ctx, a, b, c } = await clutchSetup();
      await fx.kill(ctx, c, b, { round: 1, time: T(10), attackerTeam: "TERRORIST", victimTeam: "CT" });
      await fx.kill(ctx, c, a, { round: 1, time: T(9), attackerTeam: "TERRORIST", victimTeam: "CT" });
      await fx.round(ctx.mapId, 1, { winningSide: "TERRORIST", time: T(7) });

      expect(await clutch(ctx.mapId, 1)).toMatchObject({
        clutcher_steam_id: a,
        against_count: 2,
        outcome: "lost",
      });
    });

    it("surviving to a round win without killing everyone is a saved clutch", async () => {
      const { ctx, a, b, c } = await clutchSetup();
      // a ends up 1v2, nobody else dies, but a's side takes the round
      // (e.g. defuse or time).
      await fx.kill(ctx, c, b, { round: 1, time: T(10), attackerTeam: "TERRORIST", victimTeam: "CT" });
      await fx.round(ctx.mapId, 1, { winningSide: "CT", time: T(7) });

      expect(await clutch(ctx.mapId, 1)).toMatchObject({
        clutcher_steam_id: a,
        against_count: 2,
        kills_in_clutch: 0,
        outcome: "saved",
      });
    });

    it("reports no clutch for a round without a 1vX situation", async () => {
      // In a 2v2 the very first kill creates a 1v2, so the only round that
      // never reaches a clutch is one with no kills at all (e.g. a timeout).
      const { ctx } = await clutchSetup();
      await fx.round(ctx.mapId, 1, { winningSide: "CT", time: T(7) });

      expect(await clutch(ctx.mapId, 1)).toBeUndefined();
    });
  });
});
