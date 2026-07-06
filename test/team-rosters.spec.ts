import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the team / roster / lineup-membership triggers: owner bootstrap
// and captain rules on teams, invite conversion on team_roster, captain
// election and ban enforcement on match_lineup_players, and the sanction
// trigger that clears the VAC flag.
describe("teams, rosters and lineup membership (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TeamRostersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const seedPlayer = () => fx.player();

  // tbi_team_roster reads current_setting('hasura.user') without a fallback, so
  // roster writes must carry a user context.
  const asUser = <T>(
    steamId: string,
    role: string,
    fn: (
      query: (sql: string, params?: Array<unknown>) => Promise<unknown>,
    ) => Promise<T>,
  ) => runAsUser(postgres, steamId, role, fn);

  const createTeam = async (owner: string) => {
    const [team] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [fx.nextName("team"), owner],
    );
    return team.id;
  };

  const getTeamCaptain = async (teamId: string) => {
    const [team] = await postgres.query<
      Array<{ captain_steam_id: string | null }>
    >("SELECT captain_steam_id FROM teams WHERE id = $1", [teamId]);
    return team.captain_steam_id;
  };

  const rosterRow = async (teamId: string, steam: string) => {
    const [row] = await postgres.query<Array<{ role: string }>>(
      "SELECT role FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
      [teamId, steam],
    );
    return row;
  };

  describe("teams and team_roster", () => {
    it("creating a team enrolls the owner as Admin and captain", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);

      expect((await rosterRow(teamId, owner))?.role).toBe("Admin");
      expect(await getTeamCaptain(teamId)).toBe(owner);
    });

    it("a regular user adding a player creates an invite instead of a roster row", async () => {
      const owner = await seedPlayer();
      const invitee = await seedPlayer();
      const teamId = await createTeam(owner);

      await asUser(owner, "user", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
          [teamId, invitee],
        ),
      );

      expect(await rosterRow(teamId, invitee)).toBeUndefined();
      const invites = await postgres.query<
        Array<{ invited_by_player_steam_id: string }>
      >(
        "SELECT invited_by_player_steam_id FROM team_invites WHERE team_id = $1 AND steam_id = $2",
        [teamId, invitee],
      );
      expect(invites.length).toBe(1);
      expect(invites[0].invited_by_player_steam_id).toBe(owner);
    });

    it("an admin adds players to the roster directly as Member", async () => {
      const owner = await seedPlayer();
      const member = await seedPlayer();
      const teamId = await createTeam(owner);

      await asUser(owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
          [teamId, member],
        ),
      );

      expect((await rosterRow(teamId, member))?.role).toBe("Member");
    });

    it("rejects a captain who is not on the roster", async () => {
      const owner = await seedPlayer();
      const outsider = await seedPlayer();
      const teamId = await createTeam(owner);

      await expect(
        postgres.query("UPDATE teams SET captain_steam_id = $1 WHERE id = $2", [
          outsider,
          teamId,
        ]),
      ).rejects.toThrow(/captain must be a team member/i);
    });

    it("removing the captain from the roster falls back to the owner", async () => {
      const owner = await seedPlayer();
      const member = await seedPlayer();
      const teamId = await createTeam(owner);

      await asUser(owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
          [teamId, member],
        ),
      );
      await postgres.query(
        "UPDATE teams SET captain_steam_id = $1 WHERE id = $2",
        [member, teamId],
      );

      await postgres.query(
        "DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, member],
      );

      expect(await getTeamCaptain(teamId)).toBe(owner);
    });

    it("removing the owner-captain from the roster leaves the team captainless", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);

      await postgres.query(
        "DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, owner],
      );

      expect(await getTeamCaptain(teamId)).toBeNull();
    });
  });

  describe("match lineup membership", () => {
    // Wingman keeps lineups at two slots, enough for captain-handover tests.
    const createMatch = () => fx.match({ type: "Wingman", mr: 8, mapVeto: true });

    const addPlayer = (lineupId: string, steam?: string) =>
      fx.lineupPlayer(lineupId, steam);

    const lineupPlayers = (lineupId: string) =>
      postgres.query<Array<{ steam_id: string; captain: boolean }>>(
        "SELECT steam_id, captain FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id",
        [lineupId],
      );

    it("the first player to join a lineup becomes captain", async () => {
      const match = await createMatch();
      const first = await addPlayer(match.lineup_1_id);
      const second = await addPlayer(match.lineup_1_id);

      const players = await lineupPlayers(match.lineup_1_id);
      expect(players.find((p) => p.steam_id === first)?.captain).toBe(true);
      expect(players.find((p) => p.steam_id === second)?.captain).toBe(false);
    });

    it("rejects joining both lineups of the same match", async () => {
      const match = await createMatch();
      const player = await addPlayer(match.lineup_1_id);

      await expect(addPlayer(match.lineup_2_id, player)).rejects.toThrow(
        /already added to match/i,
      );
    });

    it("rejects a lineup beyond the type's capacity", async () => {
      const match = await createMatch();
      await addPlayer(match.lineup_1_id);
      await addPlayer(match.lineup_1_id);

      await expect(addPlayer(match.lineup_1_id)).rejects.toThrow(
        /Max number of players/i,
      );
    });

    it("promoting a player to captain demotes the previous captain", async () => {
      const match = await createMatch();
      const first = await addPlayer(match.lineup_1_id);
      const second = await addPlayer(match.lineup_1_id);

      await postgres.query(
        "UPDATE match_lineup_players SET captain = true WHERE match_lineup_id = $1 AND steam_id = $2",
        [match.lineup_1_id, second],
      );

      const players = await lineupPlayers(match.lineup_1_id);
      expect(players.find((p) => p.steam_id === first)?.captain).toBe(false);
      expect(players.find((p) => p.steam_id === second)?.captain).toBe(true);
    });

    it("deleting the captain elects a replacement", async () => {
      const match = await createMatch();
      const first = await addPlayer(match.lineup_1_id);
      const second = await addPlayer(match.lineup_1_id);

      await postgres.query(
        "DELETE FROM match_lineup_players WHERE match_lineup_id = $1 AND steam_id = $2",
        [match.lineup_1_id, first],
      );

      const players = await lineupPlayers(match.lineup_1_id);
      expect(players.length).toBe(1);
      expect(players[0].steam_id).toBe(second);
      expect(players[0].captain).toBe(true);
    });

    it("a captain moved to the other lineup loses captaincy and both lineups re-elect", async () => {
      const match = await createMatch();
      const cap = await addPlayer(match.lineup_1_id);
      const mate = await addPlayer(match.lineup_1_id);
      const opponent = await addPlayer(match.lineup_2_id);

      await postgres.query(
        "UPDATE match_lineup_players SET match_lineup_id = $1 WHERE steam_id = $2",
        [match.lineup_2_id, cap],
      );

      const lineup1 = await lineupPlayers(match.lineup_1_id);
      expect(lineup1.length).toBe(1);
      expect(lineup1[0].steam_id).toBe(mate);
      expect(lineup1[0].captain).toBe(true);

      const lineup2 = await lineupPlayers(match.lineup_2_id);
      expect(lineup2.find((p) => p.steam_id === cap)?.captain).toBe(false);
      expect(lineup2.find((p) => p.steam_id === opponent)?.captain).toBe(true);
    });

    it("rejects players with an active ban and admits them once it is lifted or expired", async () => {
      const match = await createMatch();
      const admin = await seedPlayer();
      const banned = await seedPlayer();

      const [sanction] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id)
         VALUES ($1, 'ban', $2) RETURNING id`,
        [banned, admin],
      );
      await expect(addPlayer(match.lineup_1_id, banned)).rejects.toThrow(
        /Currently Banned/i,
      );

      // Soft-deleting the sanction lifts the ban.
      await postgres.query(
        "UPDATE player_sanctions SET deleted_at = now() WHERE id = $1",
        [sanction.id],
      );
      await addPlayer(match.lineup_1_id, banned);

      // An expired ban does not block either.
      const expired = await seedPlayer();
      await postgres.query(
        `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id, remove_sanction_date)
         VALUES ($1, 'ban', $2, now() - interval '1 day')`,
        [expired, admin],
      );
      await addPlayer(match.lineup_2_id, expired);
    });
  });

  describe("player sanctions (tau_player_sanctions)", () => {
    it("soft-deleting an automatic ban clears the VAC flag", async () => {
      const player = await seedPlayer();
      await postgres.query(
        "UPDATE players SET vac_banned = true WHERE steam_id = $1",
        [player],
      );
      const [sanction] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id)
         VALUES ($1, 'ban', NULL) RETURNING id`,
        [player],
      );

      await postgres.query(
        "UPDATE player_sanctions SET deleted_at = now() WHERE id = $1",
        [sanction.id],
      );

      const [row] = await postgres.query<Array<{ vac_banned: boolean }>>(
        "SELECT vac_banned FROM players WHERE steam_id = $1",
        [player],
      );
      expect(row.vac_banned).toBe(false);
    });

    it("soft-deleting a manual ban leaves the VAC flag alone", async () => {
      const admin = await seedPlayer();
      const player = await seedPlayer();
      await postgres.query(
        "UPDATE players SET vac_banned = true WHERE steam_id = $1",
        [player],
      );
      const [sanction] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id)
         VALUES ($1, 'ban', $2) RETURNING id`,
        [player, admin],
      );

      await postgres.query(
        "UPDATE player_sanctions SET deleted_at = now() WHERE id = $1",
        [sanction.id],
      );

      const [row] = await postgres.query<Array<{ vac_banned: boolean }>>(
        "SELECT vac_banned FROM players WHERE steam_id = $1",
        [player],
      );
      expect(row.vac_banned).toBe(true);
    });
  });
});
