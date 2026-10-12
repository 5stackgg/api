import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Round 1 is drawn when registration closes, and rosters stay editable above
// the minimum lineup after that. A roster or captain change has to reach the
// team's matches that exist but have not started, or the match keeps seating a
// player who left and never seats the one who replaced them.
describe("tournament roster edits reach unstarted matches (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentRosterLineupRefreshTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199610000000n);
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
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM players");
  });

  type Cup = {
    tournamentId: string;
    organizer: string;
    matchId: string;
    lineup1: string;
    lineup2: string;
    tt1: string;
    tt2: string;
    team1: { id: string; owner: string };
  };

  // Four Competitive teams of 1 + `mates` players with two substitute slots,
  // so a lineup holds up to 7. Registration is closed, so round 1 is seated.
  const drawnCup = async (mates: number): Promise<Cup> => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, 'Competitive', id, false, true, '{TestA}', 2
       FROM map_pools WHERE type = 'Competitive' AND seed = true RETURNING id`,
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup') RETURNING id`,
      [fx.nextName("cup"), organizer, options.id],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 8)`,
      [tournament.id],
    );
    await setStatus(tournament.id, organizer, "RegistrationOpen");

    const teams: Array<{ id: string; owner: string }> = [];
    for (let i = 0; i < 4; i++) {
      const team = await fx.team(mates);
      teams.push(team);
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          `INSERT INTO tournament_teams (tournament_id, team_id, name)
           SELECT $1, id, name FROM teams WHERE id = $2`,
          [tournament.id, team.id],
        ),
      );
    }
    await setStatus(tournament.id, organizer, "RegistrationClosed");

    const [bracket] = await postgres.query<
      Array<{
        match_id: string;
        tournament_team_id_1: string;
        tournament_team_id_2: string;
        lineup_1_id: string;
        lineup_2_id: string;
        team_id_1: string;
      }>
    >(
      `SELECT tb.match_id, tb.tournament_team_id_1, tb.tournament_team_id_2,
              m.lineup_1_id, m.lineup_2_id, tt.team_id AS team_id_1
       FROM tournament_brackets tb
       INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       INNER JOIN matches m ON m.id = tb.match_id
       INNER JOIN tournament_teams tt ON tt.id = tb.tournament_team_id_1
       WHERE ts.tournament_id = $1
       ORDER BY tb.round, tb.match_number LIMIT 1`,
      [tournament.id],
    );

    return {
      tournamentId: tournament.id,
      organizer,
      matchId: bracket.match_id,
      lineup1: bracket.lineup_1_id,
      lineup2: bracket.lineup_2_id,
      tt1: bracket.tournament_team_id_1,
      tt2: bracket.tournament_team_id_2,
      team1: teams.find((team) => team.id === bracket.team_id_1)!,
    };
  };

  const setStatus = (tournamentId: string, organizer: string, status: string) =>
    runAsUser(postgres, organizer, "admin", (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );

  const matchStatus = async (matchId: string) => {
    const [row] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM matches WHERE id = $1",
      [matchId],
    );
    return row.status;
  };

  const seated = (lineupId: string) =>
    postgres.query<
      Array<{
        id: string;
        steam_id: string;
        captain: boolean;
        checked_in: boolean;
      }>
    >(
      `SELECT id, steam_id::text, captain, checked_in
       FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id`,
      [lineupId],
    );

  const seatedSteamIds = async (lineupId: string) =>
    (await seated(lineupId)).map((row) => row.steam_id);

  const roster = async (tournamentTeamId: string) => {
    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id::text FROM tournament_team_roster
       WHERE tournament_team_id = $1 ORDER BY player_steam_id`,
      [tournamentTeamId],
    );
    return rows.map((row) => row.player_steam_id);
  };

  const captainOf = async (tournamentTeamId: string) => {
    const [row] = await postgres.query<
      Array<{ captain_steam_id: string | null }>
    >("SELECT captain_steam_id::text FROM tournament_teams WHERE id = $1", [
      tournamentTeamId,
    ]);
    return row.captain_steam_id;
  };

  const lineupCaptains = async (lineupId: string) =>
    (await seated(lineupId))
      .filter((row) => row.captain)
      .map((row) => row.steam_id);

  const removeFromRoster = (cup: Cup, steamId: string) =>
    runAsUser(postgres, cup.organizer, "admin", (query) =>
      query(
        `DELETE FROM tournament_team_roster
         WHERE tournament_team_id = $1 AND player_steam_id = $2`,
        [cup.tt1, steamId],
      ),
    );

  const addToRoster = async (cup: Cup, steamId?: string) => {
    const player = steamId ?? (await fx.player());
    await runAsUser(postgres, cup.organizer, "admin", (query) =>
      query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [cup.tt1, player, cup.tournamentId],
      ),
    );
    return player;
  };

  const nonCaptain = async (cup: Cup) => {
    const captain = await captainOf(cup.tt1);
    return (await roster(cup.tt1)).find((steamId) => steamId !== captain)!;
  };

  const drawnCupAt = async (status: string, mates = 5) => {
    const cup = await drawnCup(mates);
    if (status === "WaitingForCheckIn") {
      await setStatus(cup.tournamentId, cup.organizer, "Live");
    }
    expect(await matchStatus(cup.matchId)).toBe(status);
    return cup;
  };

  describe.each(["Scheduled", "WaitingForCheckIn"])("a %s match", (status) => {
    it("drops a player removed from the roster", async () => {
      const cup = await drawnCupAt(status);
      const removed = await nonCaptain(cup);

      await removeFromRoster(cup, removed);

      const lineup = await seatedSteamIds(cup.lineup1);
      expect(lineup).not.toContain(removed);
      expect(lineup).toEqual(await roster(cup.tt1));
    });

    it("seats a substitute added to the roster", async () => {
      const cup = await drawnCupAt(status);

      const added = await addToRoster(cup);

      const lineup = await seatedSteamIds(cup.lineup1);
      expect(lineup).toContain(added);
      expect(lineup).toHaveLength(7);
      expect(lineup).toEqual(await roster(cup.tt1));
    });
  });

  it("a swap keeps the seated players' check-ins and the newcomer starts unchecked", async () => {
    const cup = await drawnCupAt("WaitingForCheckIn");
    await postgres.query(
      "UPDATE match_lineup_players SET checked_in = true WHERE match_lineup_id = $1",
      [cup.lineup1],
    );
    const captain = await captainOf(cup.tt1);
    const removed = await nonCaptain(cup);

    await removeFromRoster(cup, removed);
    const added = await addToRoster(cup);

    const lineup = await seated(cup.lineup1);
    expect(lineup.map((row) => row.steam_id)).toEqual(await roster(cup.tt1));
    expect(lineup.find((row) => row.steam_id === added)?.checked_in).toBe(
      false,
    );
    expect(
      lineup
        .filter((row) => row.steam_id !== added)
        .every((row) => row.checked_in),
    ).toBe(true);
    expect(await lineupCaptains(cup.lineup1)).toEqual([captain]);
  });

  it("a team at the minimum swaps a player by adding first, and still cannot drop below it", async () => {
    const cup = await drawnCupAt("Scheduled", 4);
    const removed = await nonCaptain(cup);

    await expect(removeFromRoster(cup, removed)).rejects.toThrow(
      /minimum lineup/i,
    );

    const added = await addToRoster(cup);
    await removeFromRoster(cup, removed);

    const lineup = await seatedSteamIds(cup.lineup1);
    expect(lineup).toContain(added);
    expect(lineup).not.toContain(removed);
    expect(lineup).toHaveLength(5);
  });

  it("leaves the other team's lineup alone", async () => {
    const cup = await drawnCupAt("WaitingForCheckIn");
    const before = await seated(cup.lineup2);

    await removeFromRoster(cup, await nonCaptain(cup));
    await addToRoster(cup);

    expect(await seated(cup.lineup2)).toEqual(before);
  });

  it("does not seat a banned player, and adding one does not fail the edit", async () => {
    const cup = await drawnCupAt("WaitingForCheckIn");
    const banned = await fx.player();
    await postgres.query(
      "INSERT INTO player_sanctions (player_steam_id, type) VALUES ($1, 'ban')",
      [banned],
    );

    await addToRoster(cup, banned);

    expect(await roster(cup.tt1)).toContain(banned);
    expect(await seatedSteamIds(cup.lineup1)).not.toContain(banned);
  });

  it.each(["Live", "Finished"])(
    "leaves a %s match's lineup as it was played",
    async (played) => {
      const cup = await drawnCupAt("WaitingForCheckIn");
      await postgres.query(
        `INSERT INTO match_maps (match_id, map_id, "order")
         SELECT $1, id, 1 FROM maps WHERE type = 'Competitive' ORDER BY name LIMIT 1`,
        [cup.matchId],
      );
      await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
        cup.matchId,
        played,
      ]);
      const before = await seated(cup.lineup1);

      await removeFromRoster(cup, await nonCaptain(cup));
      await addToRoster(cup);

      expect(await seated(cup.lineup1)).toEqual(before);
    },
  );

  describe("the tournament captain", () => {
    it("removed from the roster, hands the captaincy to the lowest remaining steam id", async () => {
      const cup = await drawnCupAt("WaitingForCheckIn");
      const captain = (await captainOf(cup.tt1))!;

      await removeFromRoster(cup, captain);

      const [heir] = await roster(cup.tt1);
      expect(await captainOf(cup.tt1)).toBe(heir);
      expect(await seatedSteamIds(cup.lineup1)).not.toContain(captain);
      expect(await lineupCaptains(cup.lineup1)).toEqual([heir]);
    });

    it("removed from the roster, prefers a roster Admin", async () => {
      const cup = await drawnCupAt("WaitingForCheckIn");
      const captain = (await captainOf(cup.tt1))!;
      const admin = (await roster(cup.tt1)).filter((s) => s !== captain).pop()!;
      await postgres.query(
        `UPDATE tournament_team_roster SET role = 'Admin'
         WHERE tournament_team_id = $1 AND player_steam_id = $2`,
        [cup.tt1, admin],
      );

      await removeFromRoster(cup, captain);

      expect(await captainOf(cup.tt1)).toBe(admin);
      expect(await lineupCaptains(cup.lineup1)).toEqual([admin]);
    });

    it("removed from the roster, falls back to the team's own captain when they are still on it", async () => {
      const cup = await drawnCupAt("WaitingForCheckIn");
      const standIn = (await roster(cup.tt1)).find(
        (s) => s !== cup.team1.owner,
      )!;
      await postgres.query(
        "UPDATE tournament_teams SET captain_steam_id = $2 WHERE id = $1",
        [cup.tt1, standIn],
      );

      await removeFromRoster(cup, standIn);

      expect(await captainOf(cup.tt1)).toBe(cup.team1.owner);
      expect(await lineupCaptains(cup.lineup1)).toEqual([cup.team1.owner]);
    });

    it("removed from the roster, never changes the team's own captain", async () => {
      const cup = await drawnCupAt("WaitingForCheckIn");

      await removeFromRoster(cup, cup.team1.owner);

      const [team] = await postgres.query<Array<{ captain_steam_id: string }>>(
        "SELECT captain_steam_id::text FROM teams WHERE id = $1",
        [cup.team1.id],
      );
      expect(team.captain_steam_id).toBe(cup.team1.owner);
    });

    it("changed by the organizer, becomes the only lineup captain", async () => {
      const cup = await drawnCupAt("WaitingForCheckIn");
      const next = await nonCaptain(cup);

      await runAsUser(postgres, cup.organizer, "admin", (query) =>
        query(
          "UPDATE tournament_teams SET captain_steam_id = $2 WHERE id = $1",
          [cup.tt1, next],
        ),
      );

      expect(await lineupCaptains(cup.lineup1)).toEqual([next]);
    });
  });
});
