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
    await postgres.query("DELETE FROM tournaments");
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

    const teamRanks = (teamId: string) =>
      postgres.query<
        Array<{
          roster_size: number;
          avg_elo: number;
          avg_wingman_elo: number | null;
          avg_duel_elo: number | null;
        }>
      >("SELECT * FROM v_team_ranks WHERE team_id = $1", [teamId]);

    const rosterOf = async (teamId: string) => {
      const rows = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id",
        [teamId],
      );
      return rows.map((r) => r.player_steam_id);
    };

    it("excludes coaches from the roster averages", async () => {
      const team = await fx.team(1);
      const [p1, p2] = await rosterOf(team.id);
      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $3, 'Competitive', 6000, 0, now() - interval '1 hour'),
                ($2, $3, 'Competitive', 2000, 0, now() - interval '1 hour')`,
        [p1, p2, matchId],
      );
      await postgres.query(
        "UPDATE team_roster SET coach = true WHERE team_id = $1 AND player_steam_id = $2",
        [team.id, p2],
      );

      const [ranks] = await teamRanks(team.id);
      // The 2000 coach must not drag the average down.
      expect(Number(ranks.roster_size)).toBe(1);
      expect(Number(ranks.avg_elo)).toBe(6000);
    });

    it("uses the active-season rating, not a stale lifetime row", async () => {
      await fx.enableSeasons(true);
      const seasonId = await fx.season(T(60 * 24));
      const team = await fx.team(1);
      const [p1, p2] = await rosterOf(team.id);
      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $3, 'Competitive', 7000, 0, now() - interval '1 hour', $4),
                ($2, $3, 'Competitive', 9000, 0, now() - interval '1 hour', NULL)`,
        [p1, p2, matchId, seasonId],
      );

      const [ranks] = await teamRanks(team.id);
      // p1 counts at their season row (7000); p2 has no season row so they
      // count at the 5000 season default, never their stale 9000.
      expect(Number(ranks.avg_elo)).toBe(6000);
    });

    it("resolves Wingman and Duel averages independently of Competitive", async () => {
      const team = await fx.team(0);
      const [solo] = await rosterOf(team.id);
      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $2, 'Competitive', 6000, 0, now() - interval '1 hour'),
                ($1, $2, 'Wingman', 3000, 0, now() - interval '1 hour'),
                ($1, $2, 'Duel', 1000, 0, now() - interval '1 hour')`,
        [solo, matchId],
      );

      const [ranks] = await teamRanks(team.id);
      expect(Number(ranks.avg_elo)).toBe(6000);
      expect(Number(ranks.avg_wingman_elo)).toBe(3000);
      expect(Number(ranks.avg_duel_elo)).toBe(1000);
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
    type LeaderboardRow = {
      player_steam_id: string;
      value: number;
      secondary_value: number | null;
      tertiary_value: number | null;
      matches_played: number;
    };

    const leaderboard = (category: string, windowDays: number, type?: string) =>
      postgres.query<Array<LeaderboardRow>>(
        "SELECT * FROM get_leaderboard($1, $2, $3)",
        [category, windowDays, type ?? null],
      );

    // A finished '5stack' match with a materialized map to hang kills on. The
    // stat categories inner-join match_options, so bareMatch (optionless, the
    // demo-import shape) would be invisible to them.
    const statMatch = async () => {
      const { poolId } = await fx.mapPool(1);
      const match = await fx.match({ mapPoolId: poolId });
      const [map] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      return { match, ctx: { matchId: match.id, mapId: map.id } };
    };

    // Marks a match as a tournament match by hanging a bracket off it, which is
    // what the leaderboard's tournament detection actually keys on.
    const markAsTournamentMatch = async (matchId: string, organizer: string) => {
      const [options] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
         SELECT 8, 1, 'Competitive', id, false, true, '{TestA}'
         FROM map_pools WHERE type = 'Competitive' AND seed = true RETURNING id`,
      );
      const [tournament] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
         VALUES ($1, now() + interval '1 day', $2, $3, 'Setup') RETURNING id`,
        [fx.nextName("cup"), organizer, options.id],
      );
      const [stage] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
         VALUES ($1, 'SingleElimination', 1, 4, 8) RETURNING id`,
        [tournament.id],
      );
      await postgres.query(
        `INSERT INTO tournament_brackets (tournament_stage_id, match_id, round)
         VALUES ($1, $2, 1)`,
        [stage.id, matchId],
      );
    };

    const seasonLeaderboard = (seasonId: string, type = "Competitive") =>
      postgres.query<Array<LeaderboardRow>>(
        "SELECT * FROM get_leaderboard($1, $2, $3, $4, $5, $6)",
        ["elo", 0, type, false, null, seasonId],
      );

    it("counts tournament elo toward the active season", async () => {
      await fx.enableSeasons(true);
      const seasonId = await fx.season(T(60 * 24 * 7));
      const [player] = await fx.players(1);

      const regular = await fx.bareMatch(T(60 * 24 * 2));
      const tourney = await fx.bareMatch(T(60 * 24));
      await markAsTournamentMatch(tourney.matchId, player);

      // Regular season row carries the season rating; the tournament row is
      // written season-independent (season_id NULL) and only contributes its
      // change.
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Competitive', 5100, 100, now() - interval '2 days', $4),
                ($1, $3, 'Competitive', 7000, 200, now() - interval '1 day', NULL)`,
        [player, regular.matchId, tourney.matchId, seasonId],
      );

      const [row] = await seasonLeaderboard(seasonId);

      // Season rating (5100) adjusted by the tournament swing (+200) -- never
      // the tournament ladder's own 7000.
      expect(Number(row.value)).toBe(5300);
      expect(Number(row.matches_played)).toBe(2);
    });

    it("includes a tournament-only player in the active season at the baseline", async () => {
      await fx.enableSeasons(true);
      const seasonId = await fx.season(T(60 * 24 * 7));
      const [player] = await fx.players(1);

      const tourney = await fx.bareMatch(T(60 * 24));
      await markAsTournamentMatch(tourney.matchId, player);

      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Competitive', 7000, 150, now() - interval '1 day', NULL)`,
        [player, tourney.matchId],
      );

      const [row] = await seasonLeaderboard(seasonId);

      // No regular-season row yet: season baseline plus the tournament swing.
      expect(Number(row.value)).toBe(5150);
      expect(Number(row.matches_played)).toBe(1);
    });

    const sourceLeaderboard = (
      category: string,
      source: string,
      type = "Competitive",
    ) =>
      postgres.query<Array<LeaderboardRow>>(
        "SELECT * FROM get_leaderboard($1, $2, $3, $4, $5, $6, $7)",
        [category, 30, type, false, null, null, source],
      );

    it("carries the player's custom avatar through every producer", async () => {
      const [player, victim] = await fx.players(2);
      await postgres.query(
        "UPDATE players SET custom_avatar_url = $2 WHERE steam_id = $1",
        [player, "https://cdn.example/custom.png"],
      );

      const mm = await statMatch();
      await fx.kill(mm.ctx, player, victim);
      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $2, 'Competitive', 5100, 100, now() - interval '1 day')`,
        [player, matchId],
      );

      // RETURN QUERY matches the composite type by position, so a producer that
      // selects the new column out of order silently returns it as another
      // field rather than failing. Check a value that could only be the avatar.
      for (const category of ["elo", "best_kdr", "highest_hs_pct"]) {
        const rows = await postgres.query<
          Array<LeaderboardRow & { player_custom_avatar_url: string | null }>
        >("SELECT * FROM get_leaderboard($1, $2, $3)", [
          category,
          30,
          "Competitive",
        ]);
        const row = rows.find((r) => r.player_steam_id === player);
        expect(row).toBeDefined();
        expect(row!.player_custom_avatar_url).toBe(
          "https://cdn.example/custom.png",
        );
        // Neighbouring positional fields must not have absorbed it.
        expect(Number.isFinite(Number(row!.value))).toBe(true);
        expect(Number.isFinite(Number(row!.matches_played))).toBe(true);
      }
    });

    it("buckets stat leaderboards by match source", async () => {
      const [mmPlayer, tPlayer, victim] = await fx.players(3);

      const mm = await statMatch();
      await fx.kill(mm.ctx, mmPlayer, victim);

      const tourney = await statMatch();
      await markAsTournamentMatch(tourney.match.id, tPlayer);
      await fx.kill(tourney.ctx, tPlayer, victim);

      const overall = await sourceLeaderboard("best_kdr", "overall");
      expect(overall.map((r) => r.player_steam_id).sort()).toEqual(
        [mmPlayer, tPlayer].sort(),
      );

      const matchmaking = await sourceLeaderboard("best_kdr", "matchmaking");
      expect(matchmaking.map((r) => r.player_steam_id)).toEqual([mmPlayer]);

      const tournamentOnly = await sourceLeaderboard("best_kdr", "tournament");
      expect(tournamentOnly.map((r) => r.player_steam_id)).toEqual([tPlayer]);
    });

    it("keeps ELO value source-invariant while scoping change and matches", async () => {
      const [player] = await fx.players(1);
      const mm = await fx.bareMatch(T(60 * 24 * 2));
      const tourney = await fx.bareMatch(T(60 * 24));
      await markAsTournamentMatch(tourney.matchId, player);

      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $2, 'Competitive', 5100, 100, now() - interval '2 days'),
                ($1, $3, 'Competitive', 5300, 200, now() - interval '1 day')`,
        [player, mm.matchId, tourney.matchId],
      );

      const [overall] = await sourceLeaderboard("elo", "overall");
      const [matchmaking] = await sourceLeaderboard("elo", "matchmaking");
      const [tournamentOnly] = await sourceLeaderboard("elo", "tournament");

      // The canonical rating is one ladder: it must not move with the filter.
      expect(Number(overall.value)).toBe(5300);
      expect(Number(matchmaking.value)).toBe(5300);
      expect(Number(tournamentOnly.value)).toBe(5300);

      // Only the contribution figures scope.
      expect(Number(overall.matches_played)).toBe(2);
      expect(Number(matchmaking.matches_played)).toBe(1);
      expect(Number(matchmaking.secondary_value)).toBe(100);
      expect(Number(tournamentOnly.matches_played)).toBe(1);
      expect(Number(tournamentOnly.secondary_value)).toBe(200);
    });

    it("scopes the ELO win streak to the selected source", async () => {
      const [a, b] = await fx.players(2);

      // Two tournament wins, then two matchmaking wins, all won by `a`.
      for (const daysAgo of [8, 7]) {
        const match = await ratedDuel(a, b, daysAgo);
        await markAsTournamentMatch(match.id, a);
      }
      await ratedDuel(a, b, 3);
      await ratedDuel(a, b, 2);

      const [overall] = await sourceLeaderboard("elo", "overall", "Duel");
      const [matchmaking] = await sourceLeaderboard(
        "elo",
        "matchmaking",
        "Duel",
      );
      const [tournamentOnly] = await sourceLeaderboard(
        "elo",
        "tournament",
        "Duel",
      );

      // Without scoping, the non-Overall rows silently report the Overall
      // streak of 4 while showing only 2 matches.
      expect(Number(overall.tertiary_value)).toBe(4);
      expect(Number(matchmaking.tertiary_value)).toBe(2);
      expect(Number(tournamentOnly.tertiary_value)).toBe(2);
    });

    it("still resolves the pre-_source call signature", async () => {
      const [player] = await fx.players(1);
      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $2, 'Competitive', 5100, 100, now() - interval '1 day')`,
        [player, matchId],
      );

      const rows = await postgres.query<Array<LeaderboardRow>>(
        "SELECT * FROM get_leaderboard($1, $2, $3, $4, $5, $6)",
        ["elo", 30, "Competitive", false, null, null],
      );
      expect(rows.length).toBe(1);
      expect(Number(rows[0].value)).toBe(5100);
    });

    it("computes the tournament-free all-time peak without letting later tournament results move it", async () => {
      const [player] = await fx.players(1);
      const climb = await fx.bareMatch(T(60 * 24 * 9));
      const drop = await fx.bareMatch(T(60 * 24 * 5));
      const tourney = await fx.bareMatch(T(60 * 24));
      await markAsTournamentMatch(tourney.matchId, player);

      // Non-tournament trajectory: 5000 -> 6000 -> 5500, so the true
      // tournament-free peak is 6000. The tournament win afterwards must not
      // change a peak that was already set before it happened.
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $2, 'Competitive', 6000, 1000, now() - interval '9 days'),
                ($1, $3, 'Competitive', 5500, -500, now() - interval '5 days'),
                ($1, $4, 'Competitive', 6300, 800,  now() - interval '1 day')`,
        [player, climb.matchId, drop.matchId, tourney.matchId],
      );

      const [row] = await postgres.query<Array<LeaderboardRow>>(
        "SELECT * FROM get_leaderboard($1, $2, $3, $4)",
        ["elo", 0, "Competitive", true],
      );

      // Subtracting the lifetime tournament total (800) from the raw peak
      // (6300) would report 5500 -- an 800 swing that landed after the peak.
      expect(Number(row.value)).toBe(6000);
    });

    it("reports rolling-window ELO change as the sum of in-window changes", async () => {
      const [player] = await fx.players(1);
      const first = await fx.bareMatch(T(60 * 24 * 5));
      const reset = await fx.bareMatch(T(60 * 24 * 3));
      const last = await fx.bareMatch(T(60));

      // Three in-window rows. The middle one is a rating discontinuity: current
      // drops to 5000 with change 0, the shape a season reset leaves behind.
      // Summing in-window changes gives the ELO actually earned from matches
      // (100 + 0 + 50 = 150). The old "latest minus the window's starting
      // baseline" formula instead reads 5050 - 5000 = 50, silently absorbing
      // the reset as if the player had lost that rating by playing.
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $2, 'Competitive', 5100, 100, now() - interval '5 days'),
                ($1, $3, 'Competitive', 5000, 0,   now() - interval '3 days'),
                ($1, $4, 'Competitive', 5050, 50,  now() - interval '1 day')`,
        [player, first.matchId, reset.matchId, last.matchId],
      );

      const [row] = await leaderboard("elo", 30, "Competitive");
      expect(Number(row.value)).toBe(5050);
      expect(Number(row.secondary_value)).toBe(150);
      expect(Number(row.matches_played)).toBe(3);
    });

    it("ranks the elo ladder and per-player stats categories", async () => {
      const [a, b] = await fx.players(2);
      await ratedDuel(a, b, 2);
      await ratedDuel(a, b, 1); // a wins twice: clearly ahead

      const elo = await leaderboard("elo", 30, "Duel");
      expect(elo.length).toBe(2);
      expect(elo[0].player_steam_id).toBe(a);
      expect(Number(elo[0].value)).toBeGreaterThan(Number(elo[1].value));
    });

    it("best_kdr divides kills by deaths, falling back to kill count for the deathless", async () => {
      const { ctx } = await statMatch();
      const [ace, feeder, cleaner, target] = await fx.players(4);
      for (const round of [1, 2, 3]) {
        await fx.kill(ctx, ace, feeder, { round });
      }
      await fx.kill(ctx, feeder, ace);
      await fx.kill(ctx, cleaner, target);
      await fx.kill(ctx, cleaner, target, { round: 2 });

      const rows = await leaderboard("best_kdr", 30, "Competitive");
      // ace 3/1, cleaner deathless (value = raw kill count 2), feeder 1/3.
      expect(rows.map((r) => r.player_steam_id)).toEqual([
        ace,
        cleaner,
        feeder,
      ]);
      const byId = new Map(rows.map((r) => [r.player_steam_id, r]));
      expect(Number(byId.get(ace)!.value)).toBe(3);
      expect(Number(byId.get(ace)!.secondary_value)).toBe(3); // kills
      expect(Number(byId.get(ace)!.tertiary_value)).toBe(1); // deaths
      expect(Number(byId.get(cleaner)!.value)).toBe(2);
      expect(Number(byId.get(cleaner)!.tertiary_value)).toBe(0);
      expect(Number(byId.get(feeder)!.value)).toBeCloseTo(0.33, 2);
      // Never got a kill: not on the board, despite the deaths.
      expect(byId.has(target)).toBe(false);
    });

    it("best_win_rate is the finished-match win percentage with win/loss detail", async () => {
      const [champ, rival] = await fx.players(2);
      await ratedDuel(champ, rival); // ratedDuel: first player wins
      await ratedDuel(champ, rival);
      await ratedDuel(rival, champ);

      const rows = await leaderboard("best_win_rate", 30, "Duel");
      expect(rows.map((r) => r.player_steam_id)).toEqual([champ, rival]);
      const [top, bottom] = rows;
      expect(Number(top.value)).toBeCloseTo(66.67, 2);
      expect(Number(top.secondary_value)).toBe(2); // wins
      expect(Number(top.tertiary_value)).toBe(1); // losses
      expect(Number(top.matches_played)).toBe(3);
      expect(Number(bottom.value)).toBeCloseTo(33.33, 2);
    });

    it("highest_hs_pct ranks headshot ratios from the kill feed", async () => {
      const { ctx } = await statMatch();
      const [surgeon, sprayer, victim] = await fx.players(3);
      await fx.kill(ctx, surgeon, victim, { headshot: true });
      await fx.kill(ctx, sprayer, victim, { headshot: true });
      await fx.kill(ctx, sprayer, victim, { headshot: false, round: 2 });
      await fx.kill(ctx, sprayer, victim, { headshot: false, round: 3 });

      const rows = await leaderboard("highest_hs_pct", 30, "Competitive");
      expect(rows.map((r) => r.player_steam_id)).toEqual([surgeon, sprayer]);
      expect(Number(rows[0].value)).toBe(100);
      expect(Number(rows[0].secondary_value)).toBe(1); // total kills
      expect(Number(rows[1].value)).toBeCloseTo(33.33, 2);
      expect(Number(rows[1].secondary_value)).toBe(3);
    });

    it("stat categories respect the day window, with 0 meaning all time", async () => {
      const { ctx } = await statMatch();
      const [a, b] = await fx.players(2);
      await fx.kill(ctx, a, b, { time: T(60 * 24 * 40) }); // 40 days back

      expect((await leaderboard("best_kdr", 30, "Competitive")).length).toBe(0);
      expect((await leaderboard("best_kdr", 0, "Competitive")).length).toBe(1);
    });

    it("get_player_leaderboard_rank locates a player inside the ladder", async () => {
      const [champ, rival] = await fx.players(2);
      await ratedDuel(champ, rival);

      const [rank] = await postgres.query<
        Array<{ rank: number; total: number; value: number }>
      >(
        "SELECT * FROM get_player_leaderboard_rank('elo', 30, $1, 'Duel')",
        [rival],
      );
      expect(Number(rank.rank)).toBe(2);
      expect(Number(rank.total)).toBe(2);
    });

    it("rejects unknown categories loudly instead of returning an empty ladder", async () => {
      await expect(
        postgres.query("SELECT * FROM get_leaderboard('bogus', 30, NULL)"),
      ).rejects.toThrow(/Invalid category/);
    });
  });
});
