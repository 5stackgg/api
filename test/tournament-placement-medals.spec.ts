import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// schedule_tournament_match seats the whole roster, substitutes included, in
// every match, so a seat is not proof of play: placement medals go to the
// players the game server recorded activity for.
describe("tournament placement medals (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentPlacementMedalsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199680000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM awards WHERE system_key IS NULL");
  });

  type Lineup = { tournamentTeamId: string; roster: Array<string> };
  type Matchup = {
    round: number;
    matchNumber: number;
    matchId: string;
    one: Lineup;
    two: Lineup;
  };
  type Plays = (matchup: Matchup, lineup: Lineup) => Array<string>;

  const starters: Plays = (_, lineup) => lineup.roster.slice(0, 2);

  const seats = async (lineupId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        `SELECT steam_id::text FROM match_lineup_players
          WHERE match_lineup_id = $1 ORDER BY steam_id`,
        [lineupId],
      )
    ).map((row) => row.steam_id);

  const rosterOf = async (tournamentTeamId: string) =>
    (
      await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id::text FROM tournament_team_roster
          WHERE tournament_team_id = $1 ORDER BY player_steam_id`,
        [tournamentTeamId],
      )
    ).map((row) => row.player_steam_id);

  const mapFor = async (matchId: string) => {
    const [existing] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_maps WHERE match_id = $1 ORDER BY "order" LIMIT 1`,
      [matchId],
    );
    if (existing) {
      return { matchId, mapId: existing.id };
    }
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [matchId],
    );
    return { matchId, mapId: map.id };
  };

  // Four Wingman teams of four (two starters, two substitutes) through a
  // single-elimination bracket with a third-place decider, lineup 1 winning
  // every match. `plays` names who records activity in each lineup; a match
  // in `forfeits` ends the way CancelExpiredMatches ends a no-show, or, without
  // `noShows`, the way an organizer forfeits it.
  const playCup = async (
    plays: Plays,
    forfeits: (matchup: Matchup) => boolean = () => false,
    noShows = true,
  ) => {
    const t = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
    ]);
    await postgres.query(
      `UPDATE match_options SET number_of_substitutes = 2
        WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
      [t.id],
    );
    await postgres.query(
      "UPDATE tournament_stages SET third_place_match = true WHERE tournament_id = $1",
      [t.id],
    );
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(t.id, await fx.team(3));
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
    await tfx.setStatus(t.id, t.organizer, "Live");

    const played = new Map<string, Set<string>>();
    const seated = new Map<string, Set<string>>();

    for (let round = 1; round <= 2; round++) {
      const brackets = await postgres.query<
        Array<{
          match_id: string;
          match_number: number;
          team_1: string;
          team_2: string;
          lineup_1: string;
          lineup_2: string;
        }>
      >(
        `SELECT tb.match_id, tb.match_number,
                tb.tournament_team_id_1 AS team_1, tb.tournament_team_id_2 AS team_2,
                m.lineup_1_id AS lineup_1, m.lineup_2_id AS lineup_2
           FROM tournament_brackets tb
           JOIN matches m ON m.id = tb.match_id
          WHERE tb.tournament_stage_id = $1 AND tb.round = $2
            AND tb.finished = false
          ORDER BY tb.match_number`,
        [t.stageIds[0], round],
      );
      expect(brackets).toHaveLength(2);

      for (const bracket of brackets) {
        const matchup: Matchup = {
          round,
          matchNumber: bracket.match_number,
          matchId: bracket.match_id,
          one: {
            tournamentTeamId: bracket.team_1,
            roster: await rosterOf(bracket.team_1),
          },
          two: {
            tournamentTeamId: bracket.team_2,
            roster: await rosterOf(bracket.team_2),
          },
        };

        for (const [lineup, lineupId] of [
          [matchup.one, bracket.lineup_1],
          [matchup.two, bracket.lineup_2],
        ] as const) {
          const lineupSeats = await seats(lineupId);
          expect(lineupSeats).toEqual(lineup.roster);
          expect(lineupSeats).toHaveLength(4);
          const teamSeated = seated.get(lineup.tournamentTeamId) ?? new Set();
          lineupSeats.forEach((steam) => teamSeated.add(steam));
          seated.set(lineup.tournamentTeamId, teamSeated);
        }

        const active1 = plays(matchup, matchup.one);
        const active2 = plays(matchup, matchup.two);
        expect(active1.length).toBe(active2.length);

        if (active1.length > 0) {
          const ctx = await mapFor(bracket.match_id);
          for (let i = 0; i < active1.length; i++) {
            await fx.kill(ctx, active1[i], active2[i]);
            await fx.kill(ctx, active2[i], active1[i], { round: 2 });
          }
        }

        for (const [lineup, active] of [
          [matchup.one, active1],
          [matchup.two, active2],
        ] as const) {
          const teamPlayed = played.get(lineup.tournamentTeamId) ?? new Set();
          active.forEach((steam) => teamPlayed.add(steam));
          played.set(lineup.tournamentTeamId, teamPlayed);
        }

        if (forfeits(matchup)) {
          for (const steam of noShows ? matchup.two.roster : []) {
            await postgres.query(
              "INSERT INTO abandoned_matches (steam_id, match_id) VALUES ($1, $2)",
              [steam, matchup.matchId],
            );
          }
          await postgres.query(
            `UPDATE matches SET status = 'Forfeit', winning_lineup_id = lineup_1_id
              WHERE id = $1`,
            [matchup.matchId],
          );
        } else {
          await tfx.winMatch(bracket.match_id);
        }
      }
    }

    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

    const sorted = (map: Map<string, Set<string>>) => (teamId: string) =>
      [...(map.get(teamId) ?? [])].sort();

    return {
      id: t.id,
      played: sorted(played),
      seated: sorted(seated),
    };
  };

  type Podium = Array<{
    placement: number;
    tournamentTeamId: string;
    players: Array<string>;
  }>;

  const podium = async (tournamentId: string): Promise<Podium> => {
    const teams = await postgres.query<
      Array<{ placement: number; tournament_team_id: string }>
    >(
      `SELECT placement, tournament_team_id FROM award_recipients
        WHERE tournament_id = $1 AND source = 'tournament'
          AND team_id IS NOT NULL
        ORDER BY placement`,
      [tournamentId],
    );
    const result: Podium = [];
    for (const team of teams) {
      const players = await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id::text FROM award_recipients
          WHERE tournament_id = $1 AND source = 'tournament'
            AND placement = $2 AND tournament_team_id = $3
            AND player_steam_id IS NOT NULL
          ORDER BY player_steam_id`,
        [tournamentId, team.placement, team.tournament_team_id],
      );
      result.push({
        placement: Number(team.placement),
        tournamentTeamId: team.tournament_team_id,
        players: players.map((row) => row.player_steam_id),
      });
    }
    return result;
  };

  it("medals the starters who played and none of the substitutes who sat every match out", async () => {
    const cup = await playCup(starters);

    const places = await podium(cup.id);
    expect(places.map((place) => place.placement)).toEqual([1, 2, 3]);

    for (const place of places) {
      const roster = await rosterOf(place.tournamentTeamId);
      expect(cup.seated(place.tournamentTeamId)).toEqual(roster);
      expect(place.players).toEqual(roster.slice(0, 2));
      for (const substitute of roster.slice(2)) {
        expect(place.players).not.toContain(substitute);
      }
    }
  });

  it("recalculating medals the same players without duplicates", async () => {
    const cup = await playCup(starters);
    const before = await podium(cup.id);

    await postgres.query("SELECT calculate_tournament_awards($1)", [cup.id]);
    await postgres.query("SELECT recalculate_tournament_awards($1)", [cup.id]);

    expect(await podium(cup.id)).toEqual(before);
  });

  it("medals a player who played only some of the team's matches", async () => {
    const cup = await playCup((matchup, lineup) =>
      matchup.round === 1
        ? [lineup.roster[0], lineup.roster[1]]
        : [lineup.roster[0], lineup.roster[2]],
    );

    const places = await podium(cup.id);
    expect(places).toHaveLength(3);
    for (const place of places) {
      const roster = await rosterOf(place.tournamentTeamId);
      expect(place.players).toEqual(roster.slice(0, 3));
      expect(place.players).toEqual(cup.played(place.tournamentTeamId));
      expect(place.players).not.toContain(roster[3]);
    }
  });

  it("a forfeit does not hand the medal to the bench", async () => {
    const isForfeit = (matchup: Matchup) =>
      matchup.round === 1 && matchup.matchNumber === 1;
    const cup = await playCup(
      (matchup, lineup) =>
        isForfeit(matchup) ? [] : starters(matchup, lineup),
      isForfeit,
    );

    const places = await podium(cup.id);
    expect(places).toHaveLength(3);
    for (const place of places) {
      const roster = await rosterOf(place.tournamentTeamId);
      expect(place.players).toEqual(roster.slice(0, 2));
    }
  });

  it("an organizer's forfeit does not hand the medal to the bench either", async () => {
    const isForfeit = (matchup: Matchup) =>
      matchup.round === 1 && matchup.matchNumber === 1;
    const cup = await playCup(
      (matchup, lineup) =>
        isForfeit(matchup) ? [] : starters(matchup, lineup),
      isForfeit,
      false,
    );

    const places = await podium(cup.id);
    expect(places).toHaveLength(3);
    for (const place of places) {
      const roster = await rosterOf(place.tournamentTeamId);
      expect(place.players).toEqual(roster.slice(0, 2));
    }
  });

  it("a match finished with nothing recorded counts everyone seated in it", async () => {
    const isFinal = (matchup: Matchup) =>
      matchup.round === 2 && matchup.matchNumber === 1;
    const cup = await playCup((matchup, lineup) =>
      isFinal(matchup) ? [] : starters(matchup, lineup),
    );

    const places = await podium(cup.id);
    expect(places.map((place) => place.placement)).toEqual([1, 2, 3]);
    for (const place of places) {
      const roster = await rosterOf(place.tournamentTeamId);
      expect(place.players).toEqual(
        place.placement === 3 ? roster.slice(0, 2) : roster,
      );
    }
  });

  it("a team that only ever won by forfeit keeps every seated player", async () => {
    const cup = await playCup(
      () => [],
      () => true,
    );

    const places = await podium(cup.id);
    expect(places).toHaveLength(3);
    for (const place of places) {
      expect(place.players).toHaveLength(4);
      expect(place.players).toEqual(cup.seated(place.tournamentTeamId));
    }
  });

  it("leaves hand-granted awards alone, even for a substitute who never played", async () => {
    const cup = await playCup(starters);
    const [gold] = await podium(cup.id);
    const substitute = (await rosterOf(gold.tournamentTeamId))[3];
    expect(gold.players).not.toContain(substitute);

    const [goldAward] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM awards WHERE system_key = 'tournament_gold'",
    );
    const [pick] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO awards (name, tier, allow_multiple)
       VALUES ('Organizer''s Pick', 'special', false) RETURNING id`,
    );
    const granted = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO award_recipients
          (award_id, tournament_id, tournament_team_id, player_steam_id, source, placement)
        VALUES ($1, $3, $4, $5, 'manual', 1), ($2, $3, $4, $5, 'manual', NULL)
        RETURNING id`,
      [goldAward.id, pick.id, cup.id, gold.tournamentTeamId, substitute],
    );

    await postgres.query("SELECT calculate_tournament_awards($1)", [cup.id]);

    const held = await postgres.query<
      Array<{ id: string; source: string; placement: number | null }>
    >(
      `SELECT id, source, placement FROM award_recipients
        WHERE tournament_id = $1 AND player_steam_id = $2
        ORDER BY id`,
      [cup.id, substitute],
    );
    expect(held.map((row) => row.id).sort()).toEqual(
      granted.map((row) => row.id).sort(),
    );
    expect(held.every((row) => row.source === "manual")).toBe(true);
    expect(held.map((row) => row.placement)).toContain(1);
  });
});
