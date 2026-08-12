import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Reassigning a tournament winner moves the team in the downstream bracket slot.
// The downstream match already exists at that point, so its lineups have to be
// re-pointed too, or they keep playing as the team that was advanced by mistake.
describe("tournament winner reassignment (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentWinnerReassignmentTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199600000000n);
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
  });

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
  ];

  const lineupTeams = (matchId: string) =>
    postgres.query<Array<{ id: string; team_id: string | null }>>(
      `SELECT ml.id, ml.team_id
         FROM match_lineups ml
         JOIN matches m ON m.id = $1
        WHERE ml.id IN (m.lineup_1_id, m.lineup_2_id)
        ORDER BY ml.id`,
      [matchId],
    );

  const lineupSteamIds = (lineupId: string) =>
    postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id FROM match_lineup_players
        WHERE match_lineup_id = $1 AND steam_id IS NOT NULL
        ORDER BY steam_id`,
      [lineupId],
    );

  // Four-team cup with both semis played, so the final exists with real lineups.
  const semisPlayed = async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    const brackets = await tfx.getBrackets(t.stageIds[0]);
    const semis = brackets.filter((b) => b.round === 1);
    const final = brackets.find((b) => b.round === 2);
    return { t, semis, final };
  };

  it("re-points the final's lineup when a semifinal winner is reassigned", async () => {
    const { semis, final } = await semisPlayed();
    expect(final?.match_id).toBeTruthy();

    const beforeTeams = (await lineupTeams(final!.match_id!)).map(
      (l) => l.team_id,
    );

    // Flip the first semifinal to the other side and re-run advancement.
    const semi = semis[0];
    await tfx.winMatch(semi.match_id!, "lineup_2_id");

    const [refreshedFinal] = await postgres.query<
      Array<{ tournament_team_id_1: string; tournament_team_id_2: string }>
    >(
      `SELECT tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets WHERE id = $1`,
      [final!.id],
    );

    const advanced = [
      refreshedFinal.tournament_team_id_1,
      refreshedFinal.tournament_team_id_2,
    ];

    const teamIdsFor = await postgres.query<Array<{ team_id: string }>>(
      `SELECT team_id FROM tournament_teams WHERE id = ANY($1::uuid[])`,
      [advanced],
    );

    const afterTeams = (await lineupTeams(final!.match_id!)).map(
      (l) => l.team_id,
    );

    // The final's lineups now carry the teams the bracket actually holds.
    expect(afterTeams.filter(Boolean).sort()).toEqual(
      teamIdsFor.map((r) => r.team_id).filter(Boolean).sort(),
    );
    expect(afterTeams).not.toEqual(beforeTeams);
  });

  // Roster of the tournament team occupying a bracket slot, in steam_id order.
  const rosterOfTournamentTeam = async (tournamentTeamId: string) => {
    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id FROM tournament_team_roster
        WHERE tournament_team_id = $1 ORDER BY player_steam_id`,
      [tournamentTeamId],
    );
    return rows.map((r) => r.player_steam_id).sort();
  };

  it("seats the newly advanced team's actual players, replacing the old ones", async () => {
    const { semis, final } = await semisPlayed();
    const semi = semis[0];

    // Who was wrongly advanced, and who should be there after the flip.
    const [semiRow] = await postgres.query<
      Array<{ tournament_team_id_1: string; tournament_team_id_2: string }>
    >(
      `SELECT tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets WHERE id = $1`,
      [semi.id],
    );
    const previouslyAdvanced = await rosterOfTournamentTeam(
      semiRow.tournament_team_id_1,
    );
    const shouldAdvance = await rosterOfTournamentTeam(
      semiRow.tournament_team_id_2,
    );
    expect(shouldAdvance.length).toBeGreaterThan(0);
    expect(shouldAdvance).not.toEqual(previouslyAdvanced);

    await tfx.winMatch(semi.match_id!, "lineup_2_id");

    const lineups = await lineupTeams(final!.match_id!);
    const seatedAcrossFinal: Array<string> = [];
    for (const lineup of lineups) {
      seatedAcrossFinal.push(
        ...(await lineupSteamIds(lineup.id)).map((s) => s.steam_id),
      );
    }

    // The team that actually won the semi is now seated in the final...
    for (const steamId of shouldAdvance) {
      expect(seatedAcrossFinal).toContain(steamId);
    }
    // ...and the team that was advanced by mistake is no longer in it.
    for (const steamId of previouslyAdvanced) {
      expect(seatedAcrossFinal).not.toContain(steamId);
    }
  });

  it("does not trip the minimum-player guard while swapping the roster", async () => {
    const { semis, final } = await semisPlayed();

    const before = (await lineupTeams(final!.match_id!)).length;

    // The swap is in-place precisely so this does not raise
    // "Cannot remove players: not enough players in lineup".
    await expect(
      tfx.winMatch(semis[0].match_id!, "lineup_2_id"),
    ).resolves.not.toThrow();

    const lineups = await lineupTeams(final!.match_id!);
    expect(lineups.length).toBe(before);
    for (const lineup of lineups) {
      const seated = await lineupSteamIds(lineup.id);
      // Still a full lineup - not emptied, not doubled up.
      expect(seated.length).toBeGreaterThan(0);
      expect(new Set(seated.map((s) => s.steam_id)).size).toBe(seated.length);
    }
  });

  it("can_reassign_winner blocks once the downstream match has been played", async () => {
    const { t, semis, final } = await semisPlayed();

    const canReassign = async (matchId: string) => {
      const [row] = await postgres.query<Array<{ can: boolean }>>(
        `SELECT can_reassign_winner(m, json_build_object(
            'x-hasura-role', 'administrator',
            'x-hasura-user-id', $2::text
         )) AS can
           FROM matches m WHERE m.id = $1`,
        [matchId, t.organizer],
      );
      return row?.can;
    };

    // Final still unplayed: the semifinal is safe to reassign.
    await expect(canReassign(semis[0].match_id!)).resolves.toBe(true);

    // Play the final, and the semifinal is no longer safe to reassign.
    await tfx.winMatch(final!.match_id!);
    await expect(canReassign(semis[0].match_id!)).resolves.toBe(false);
  });
});
