import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the read-side SQL the app displays: the HLTV rating view, the
// clutch feed, the player ELO ledger view and profile aggregation
// (get_player_elo), team rank averages, team reputation, and the leaderboard
// entry points. These are pure reads — regressions produce wrong numbers, not
// errors, so nothing else would catch them.
describe("read-side views and aggregations (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("ViewsTest");
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
    await postgres.query("DELETE FROM team_scrim_requests");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM seasons");
    await postgres.query(
      "DELETE FROM settings WHERE name = 'public.seasons_enabled'",
    );
  });

  const T = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();

  describe("v_player_match_map_hltv", () => {
    it("computes per-round rates and the HLTV 2.0 rating from stored stats", async () => {
      const ctx = await fx.bareMatch();
      const [ace, victimOne, victimTwo] = await fx.players(3);

      await fx.kill(ctx, ace, victimOne, { round: 1, time: T(30) });
      await fx.kill(ctx, ace, victimTwo, { round: 1, time: T(29) });
      await fx.kill(ctx, ace, victimOne, { round: 2, time: T(20) });
      // Per-hit damage is capped at the victim's health by the recompute, so
      // stay under 100 per event.
      await fx.damage(ctx, ace, victimOne, 80, { round: 1 });
      await fx.damage(ctx, ace, victimTwo, 100, { round: 2 });
      await fx.round(ctx.mapId, 1, { time: T(25) });
      await fx.round(ctx.mapId, 2, { time: T(15) });

      const [row] = await postgres.query<
        Array<{
          rounds_played: number;
          kast_pct: string;
          hltv_rating: string;
          kpr: string;
          dpr: string;
          adr: string;
        }>
      >(
        "SELECT * FROM v_player_match_map_hltv WHERE match_map_id = $1 AND steam_id = $2",
        [ctx.mapId, ace],
      );

      expect(Number(row.rounds_played)).toBe(2);
      expect(Number(row.kpr)).toBeCloseTo(1.5, 3);
      expect(Number(row.dpr)).toBe(0);
      expect(Number(row.adr)).toBeCloseTo(90, 1);
      // Killed in both rounds: full KAST.
      expect(Number(row.kast_pct)).toBe(100);

      // Same formula the view encodes, from the same inputs.
      const kastPct = 100;
      const kpr = 3 / 2;
      const dpr = 0;
      const apr = 0;
      const adr = 180 / 2;
      const expectedRating =
        0.0073 * kastPct +
        0.3591 * kpr -
        0.5329 * dpr +
        0.2372 * (2.13 * kpr + 0.42 * apr - 0.41) +
        0.0032 * adr +
        0.1587;
      expect(Number(row.hltv_rating)).toBeCloseTo(
        Math.round(expectedRating * 100) / 100,
        2,
      );

      const [victimRow] = await postgres.query<
        Array<{ dpr: string; kast_pct: string }>
      >(
        "SELECT * FROM v_player_match_map_hltv WHERE match_map_id = $1 AND steam_id = $2",
        [ctx.mapId, victimOne],
      );
      // Died in both rounds without impact: 1.0 deaths per round, 0 KAST.
      expect(Number(victimRow.dpr)).toBeCloseTo(1, 3);
      expect(Number(victimRow.kast_pct)).toBe(0);
    });
  });

  describe("v_match_clutches", () => {
    it("surfaces detected clutches per finalized round", async () => {
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
      const ctx = { matchId: match.id, mapId: map.id };

      await fx.kill(ctx, c, b, { round: 1, time: T(10), attackerTeam: "TERRORIST", victimTeam: "CT" });
      await fx.kill(ctx, a, c, { round: 1, time: T(9), attackerTeam: "CT", victimTeam: "TERRORIST" });
      await fx.kill(ctx, a, d, { round: 1, time: T(8), attackerTeam: "CT", victimTeam: "TERRORIST" });
      await fx.round(ctx.mapId, 1, { winningSide: "CT", time: T(7) });

      const clutches = await postgres.query<
        Array<{
          clutcher_steam_id: string;
          against_count: number;
          outcome: string;
          round: number;
        }>
      >("SELECT * FROM v_match_clutches WHERE match_id = $1", [match.id]);

      expect(clutches.length).toBe(1);
      expect(clutches[0]).toMatchObject({
        clutcher_steam_id: a,
        outcome: "won",
      });
      expect(Number(clutches[0].against_count)).toBe(2);
    });
  });

  // A finished 1v1 with ELO generated, reused by the ledger and profile tests.
  const ratedDuel = async (a: string, b: string, endedDaysAgo = 1) => {
    const match = await fx.match({ type: "Duel" });
    await fx.lineupPlayer(match.lineup_1_id, a);
    await fx.lineupPlayer(match.lineup_2_id, b);
    await postgres.query(
      "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
      [match.id],
    );
    await postgres.query(
      "UPDATE matches SET ended_at = now() - make_interval(days => $2) WHERE id = $1",
      [match.id, endedDaysAgo],
    );
    await postgres.query("SELECT generate_player_elo_for_match($1)", [
      match.id,
    ]);
    return match;
  };

  describe("v_player_elo and get_player_elo", () => {
    it("the ledger view maps wins/losses and before/after ratings", async () => {
      const [a, b] = await fx.players(2);
      const match = await ratedDuel(a, b);

      const rows = await postgres.query<
        Array<{
          player_steam_id: string;
          match_result: string;
          current_elo: number;
          updated_elo: number;
          elo_change: number;
        }>
      >("SELECT * FROM v_player_elo WHERE match_id = $1", [match.id]);

      const winner = rows.find((r) => r.player_steam_id === a)!;
      const loser = rows.find((r) => r.player_steam_id === b)!;
      expect(winner.match_result).toBe("win");
      expect(loser.match_result).toBe("loss");
      // current_elo is the pre-match rating; updated_elo the post-match one.
      expect(Number(winner.current_elo)).toBe(5000);
      expect(Number(winner.updated_elo)).toBe(
        5000 + Number(winner.elo_change),
      );
    });

    it("profile aggregation returns per-type ladders (seasons off)", async () => {
      const [a, b] = await fx.players(2);
      await ratedDuel(a, b);

      const [profile] = await postgres.query<Array<{ elo: { duel: number } }>>(
        "SELECT get_player_elo(p) AS elo FROM players p WHERE steam_id = $1",
        [a],
      );
      expect(profile.elo.duel).toBeGreaterThan(5000);
      // Unplayed types stay null rather than defaulting.
      expect(profile.elo).toMatchObject({ competitive: null, wingman: null });
    });

    it("profile aggregation switches to season + tournament tracks (seasons on)", async () => {
      await fx.enableSeasons();
      await fx.season("2025-01-01", null); // active season covers now()
      const [a, b] = await fx.players(2);
      await ratedDuel(a, b);

      const [profile] = await postgres.query<
        Array<{ elo: Record<string, number | null> }>
      >("SELECT get_player_elo(p) AS elo FROM players p WHERE steam_id = $1", [
        a,
      ]);
      expect(profile.elo.duel).toBeGreaterThan(5000); // active-season ladder
      expect(profile.elo.tournament_duel).toBeNull(); // no tournament matches yet
    });
  });

  describe("v_team_ranks", () => {
    it("averages the displayed rating sources across the roster, ignoring gaps", async () => {
      const team = await fx.team(1);
      const roster = await postgres.query<
        Array<{ player_steam_id: string }>
      >("SELECT player_steam_id FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id", [
        team.id,
      ]);
      const [p1, p2] = roster.map((r) => r.player_steam_id);

      // Competitive elo rows for both (via the ledger the view actually reads).
      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $3, 'Competitive', 6000, 0, now() - interval '1 hour'),
                ($2, $3, 'Competitive', 4000, 0, now() - interval '1 hour')`,
        [p1, p2, matchId],
      );
      // Faceit data for only one player: the other must not drag the average.
      await postgres.query(
        "UPDATE players SET faceit_elo = 2000, faceit_skill_level = 8 WHERE steam_id = $1",
        [p1],
      );

      const [ranks] = await postgres.query<
        Array<{
          roster_size: number;
          avg_elo: number;
          min_elo: number;
          max_elo: number;
          avg_faceit_elo: number | null;
          avg_faceit_level: number | null;
        }>
      >("SELECT * FROM v_team_ranks WHERE team_id = $1", [team.id]);

      expect(Number(ranks.roster_size)).toBe(2);
      expect(Number(ranks.avg_elo)).toBe(5000);
      expect(Number(ranks.min_elo)).toBe(4000);
      expect(Number(ranks.max_elo)).toBe(6000);
      expect(Number(ranks.avg_faceit_elo)).toBe(2000);
      expect(Number(ranks.avg_faceit_level)).toBe(8);
    });
  });

  describe("v_team_reputation", () => {
    const scrimRequest = async (
      fromTeam: { id: string; owner: string },
      toTeam: { id: string; owner: string },
    ) => {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO team_scrim_requests
           (from_team_id, to_team_id, status, requested_by_steam_id, awaiting_team_id,
            proposed_scheduled_at, expires_at)
         VALUES ($1, $2, 'Matched', $3, $2, now() + interval '1 day', now() + interval '12 hours')
         RETURNING id`,
        [fromTeam.id, toTeam.id, fromTeam.owner],
      );
      return row.id;
    };

    const scrimMatch = async (
      teamA: { id: string },
      teamB: { id: string },
      requestId: string,
    ) => {
      const match = await fx.match({ type: "Wingman", mr: 8, mapVeto: true });
      await postgres.query(
        "UPDATE match_lineups SET team_id = $1 WHERE id = $2",
        [teamA.id, match.lineup_1_id],
      );
      await postgres.query(
        "UPDATE match_lineups SET team_id = $1 WHERE id = $2",
        [teamB.id, match.lineup_2_id],
      );
      await postgres.query(
        "UPDATE team_scrim_requests SET match_id = $1 WHERE id = $2",
        [match.id, requestId],
      );
      return match;
    };

    const reputation = async (teamId: string) => {
      const [row] = await postgres.query<
        Array<{
          scrims_completed: number;
          no_shows: number;
          late_cancels: number;
        }>
      >("SELECT * FROM v_team_reputation WHERE team_id = $1", [teamId]);
      return row;
    };

    it("counts completed scrims for both teams", async () => {
      const teamA = await fx.team(1);
      const teamB = await fx.team(1);
      const request = await scrimRequest(teamA, teamB);
      const match = await scrimMatch(teamA, teamB, request);

      await postgres.query(
        "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
        [match.id],
      );

      expect(Number((await reputation(teamA.id)).scrims_completed)).toBe(1);
      expect(Number((await reputation(teamB.id)).scrims_completed)).toBe(1);
    });

    it("pins a no-show on the team that never checked in, even after match GC", async () => {
      const teamA = await fx.team(1);
      const teamB = await fx.team(1);
      const request = await scrimRequest(teamA, teamB);
      const match = await scrimMatch(teamA, teamB, request);

      // Team A checked in; team B never showed. The match is canceled and
      // later garbage collected (deleted), leaving only the frozen snapshot.
      await postgres.query(
        `UPDATE match_lineup_players SET checked_in = true
         WHERE match_lineup_id = $1 AND steam_id = $2`,
        [match.lineup_1_id, teamA.owner],
      );
      await postgres.query(
        "UPDATE matches SET status = 'Canceled' WHERE id = $1",
        [match.id],
      );
      await postgres.query("DELETE FROM matches WHERE id = $1", [match.id]);

      expect(Number((await reputation(teamA.id)).no_shows)).toBe(0);
      expect(Number((await reputation(teamB.id)).no_shows)).toBe(1);
    });

    it("charges late cancels only to the team that bailed", async () => {
      const teamA = await fx.team(1);
      const teamB = await fx.team(1);
      const request = await scrimRequest(teamA, teamB);
      await scrimMatch(teamA, teamB, request);

      await postgres.query(
        `UPDATE team_scrim_requests
         SET status = 'Cancelled', canceled_late = true, canceled_by_team_id = $2
         WHERE id = $1`,
        [request, teamA.id],
      );

      expect(Number((await reputation(teamA.id)).late_cancels)).toBe(1);
      expect(Number((await reputation(teamB.id)).late_cancels)).toBe(0);
    });
  });

  describe("get_leaderboard", () => {
    it("ranks the elo ladder and per-player stats categories", async () => {
      const [a, b] = await fx.players(2);
      await ratedDuel(a, b, 2);
      await ratedDuel(a, b, 1); // a wins twice: clearly ahead

      const elo = await postgres.query<
        Array<{ player_steam_id: string; value: number }>
      >(
        "SELECT player_steam_id, value FROM get_leaderboard('elo', 30, 'Duel')",
      );
      expect(elo.length).toBe(2);
      expect(elo[0].player_steam_id).toBe(a);
      expect(Number(elo[0].value)).toBeGreaterThan(Number(elo[1].value));
    });
  });
});
