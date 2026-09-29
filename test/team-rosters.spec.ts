import { readFileSync } from "fs";
import { join } from "path";
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

    // The owner is the team's last line of authority: can_change_team_role and
    // can_remove_from_team both fall back to owner_steam_id, so a team whose
    // owner has walked off the roster can only be managed by a site admin.
    it("refuses to drop the owner from their own roster", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);

      await expect(
        postgres.query(
          "DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
          [teamId, owner],
        ),
      ).rejects.toThrow(/owner/i);

      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1",
        [teamId],
      );
      expect(roster).toHaveLength(1);
    });

    it("lets the old owner leave once ownership is handed over", async () => {
      const owner = await seedPlayer();
      const heir = await seedPlayer();
      const teamId = await createTeam(owner);

      await asUser(owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
          [teamId, heir],
        ),
      );
      await postgres.query("UPDATE teams SET owner_steam_id = $1 WHERE id = $2", [
        heir,
        teamId,
      ]);

      await postgres.query(
        "DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, owner],
      );

      expect(await getTeamCaptain(teamId)).toBe(heir);
    });

    it("still lets the whole team be deleted", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);

      // the roster rows go with it by cascade, and the owner guard must not
      // turn that into an error
      await expect(
        postgres.query("DELETE FROM teams WHERE id = $1", [teamId]),
      ).resolves.not.toThrow();

      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1",
        [teamId],
      );
      expect(roster).toHaveLength(0);
    });

    describe("ownership", () => {
      const addMember = async (
        teamId: string,
        owner: string,
        steamId: string,
        role: "Admin" | "Member" = "Member",
      ) => {
        await asUser(owner, "admin", (query) =>
          query(
            "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
            [teamId, steamId],
          ),
        );
        if (role !== "Member") {
          await postgres.query(
            "UPDATE team_roster SET role = $1 WHERE team_id = $2 AND player_steam_id = $3",
            [role, teamId, steamId],
          );
        }
      };

      const getTeamOwner = async (teamId: string) => {
        const [team] = await postgres.query<Array<{ owner_steam_id: string }>>(
          "SELECT owner_steam_id FROM teams WHERE id = $1",
          [teamId],
        );
        return team.owner_steam_id;
      };

      it("rejects a roster Admin making themselves owner", async () => {
        const owner = await seedPlayer();
        const admin = await seedPlayer();
        const teamId = await createTeam(owner);
        await addMember(teamId, owner, admin, "Admin");

        await expect(
          asUser(admin, "user", (query) =>
            query("UPDATE teams SET owner_steam_id = $1 WHERE id = $2", [
              admin,
              teamId,
            ]),
          ),
        ).rejects.toThrow(/only the team owner/i);

        expect(await getTeamOwner(teamId)).toBe(owner);
      });

      it("lets the owner hand the team to a member, who becomes an Admin", async () => {
        const owner = await seedPlayer();
        const member = await seedPlayer();
        const teamId = await createTeam(owner);
        await addMember(teamId, owner, member);

        await asUser(owner, "user", (query) =>
          query("UPDATE teams SET owner_steam_id = $1 WHERE id = $2", [
            member,
            teamId,
          ]),
        );

        expect(await getTeamOwner(teamId)).toBe(member);
        expect((await rosterRow(teamId, member))?.role).toBe("Admin");
        expect((await rosterRow(teamId, owner))?.role).toBe("Admin");
      });

      it("rejects handing the team to someone off the roster", async () => {
        const owner = await seedPlayer();
        const outsider = await seedPlayer();
        const teamId = await createTeam(owner);

        await expect(
          asUser(owner, "user", (query) =>
            query("UPDATE teams SET owner_steam_id = $1 WHERE id = $2", [
              outsider,
              teamId,
            ]),
          ),
        ).rejects.toThrow(/must be a team member/i);

        expect(await getTeamOwner(teamId)).toBe(owner);
      });

      it.each(["tournament_organizer", "administrator"])(
        "lets a %s transfer ownership",
        async (role) => {
          const owner = await seedPlayer();
          const member = await seedPlayer();
          const staff = await seedPlayer();
          const teamId = await createTeam(owner);
          await addMember(teamId, owner, member);

          await asUser(staff, role, (query) =>
            query("UPDATE teams SET owner_steam_id = $1 WHERE id = $2", [
              member,
              teamId,
            ]),
          );

          expect(await getTeamOwner(teamId)).toBe(member);
          expect((await rosterRow(teamId, member))?.role).toBe("Admin");
        },
      );

      it("rejects a roster Admin demoting the owner", async () => {
        const owner = await seedPlayer();
        const admin = await seedPlayer();
        const teamId = await createTeam(owner);
        await addMember(teamId, owner, admin, "Admin");

        await expect(
          asUser(admin, "user", (query) =>
            query(
              "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2",
              [teamId, owner],
            ),
          ),
        ).rejects.toThrow(/owner must stay an Admin/i);

        expect((await rosterRow(teamId, owner))?.role).toBe("Admin");
      });

      it("holds staff and internal writes to the owner staying an Admin", async () => {
        const owner = await seedPlayer();
        const organizer = await seedPlayer();
        const teamId = await createTeam(owner);
        const demoteOwner =
          "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2";

        await expect(
          asUser(organizer, "tournament_organizer", (query) =>
            query(demoteOwner, [teamId, owner]),
          ),
        ).rejects.toThrow(/owner must stay an Admin/i);
        await expect(
          postgres.query(demoteOwner, [teamId, owner]),
        ).rejects.toThrow(/owner must stay an Admin/i);

        expect((await rosterRow(teamId, owner))?.role).toBe("Admin");
      });

      it("lets the new owner demote the old one after a transfer", async () => {
        const owner = await seedPlayer();
        const heir = await seedPlayer();
        const teamId = await createTeam(owner);
        await addMember(teamId, owner, heir);

        await asUser(owner, "user", (query) =>
          query("UPDATE teams SET owner_steam_id = $1 WHERE id = $2", [
            heir,
            teamId,
          ]),
        );
        await asUser(heir, "user", (query) =>
          query(
            "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2",
            [teamId, owner],
          ),
        );

        expect((await rosterRow(teamId, owner))?.role).toBe("Member");
      });

      it("lets the old owner step down to Member in the same mutation as the transfer", async () => {
        const owner = await seedPlayer();
        const heir = await seedPlayer();
        const teamId = await createTeam(owner);
        await addMember(teamId, owner, heir);

        await asUser(owner, "user", async (query) => {
          await query("UPDATE teams SET owner_steam_id = $1 WHERE id = $2", [
            heir,
            teamId,
          ]);
          await query(
            "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2",
            [teamId, owner],
          );
        });

        expect((await rosterRow(teamId, owner))?.role).toBe("Member");
        expect((await rosterRow(teamId, heir))?.role).toBe("Admin");
      });

      it("lets a roster Admin demote another Admin", async () => {
        const owner = await seedPlayer();
        const admin = await seedPlayer();
        const otherAdmin = await seedPlayer();
        const teamId = await createTeam(owner);
        await addMember(teamId, owner, admin, "Admin");
        await addMember(teamId, owner, otherAdmin, "Admin");

        await asUser(admin, "user", (query) =>
          query(
            "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2",
            [teamId, otherAdmin],
          ),
        );

        expect((await rosterRow(teamId, otherAdmin))?.role).toBe("Member");
      });

      it("lets a roster Admin rename the team", async () => {
        const owner = await seedPlayer();
        const admin = await seedPlayer();
        const teamId = await createTeam(owner);
        await addMember(teamId, owner, admin, "Admin");

        await asUser(admin, "user", (query) =>
          query(
            "UPDATE teams SET name = 'Renamed', short_name = 'RNM', owner_steam_id = $1 WHERE id = $2",
            [owner, teamId],
          ),
        );

        const [team] = await postgres.query<Array<{ name: string }>>(
          "SELECT name FROM teams WHERE id = $1",
          [teamId],
        );
        expect(team.name).toBe("Renamed");
        expect(await getTeamOwner(teamId)).toBe(owner);
      });

      it("lets roles change on a roster that is already over the starter cap", async () => {
        const owner = await seedPlayer();
        const teamId = await createTeam(owner);
        const starters = await fx.players(5);
        await asUser(owner, "admin", async (query) => {
          await query(
            "SELECT set_config('fivestack.rebalancing', 'true', true)",
          );
          for (const steamId of starters) {
            await query(
              "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Starter')",
              [teamId, steamId],
            );
          }
        });

        await asUser(owner, "user", (query) =>
          query(
            "UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2",
            [teamId, starters[0]],
          ),
        );

        expect((await rosterRow(teamId, starters[0]))?.role).toBe("Admin");
      });

      it("backfills owners demoted before the guard existed back to Admin", async () => {
        const owner = await seedPlayer();
        const member = await seedPlayer();
        const teamId = await createTeam(owner);
        await addMember(teamId, owner, member);
        await postgres.transaction(async (client) => {
          await client.query(
            "ALTER TABLE team_roster DISABLE TRIGGER tbu_team_roster",
          );
          await client.query(
            "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2",
            [teamId, owner],
          );
          await client.query(
            "ALTER TABLE team_roster ENABLE TRIGGER tbu_team_roster",
          );
        });
        expect((await rosterRow(teamId, owner))?.role).toBe("Member");

        await postgres.query(
          readFileSync(
            join(
              __dirname,
              "../hasura/migrations/default/1888000000000_team_owner_roster_admin/up.sql",
            ),
            "utf8",
          ),
        );

        expect((await rosterRow(teamId, owner))?.role).toBe("Admin");
        expect((await rosterRow(teamId, member))?.role).toBe("Member");
      });

      it("puts owners who left before the guard existed back on the roster as a benched Admin", async () => {
        const runRejoin = async () =>
          postgres.query(
            readFileSync(
              join(
                __dirname,
                "../hasura/migrations/default/1889000000200_team_owner_roster_rejoin/up.sql",
              ),
              "utf8",
            ),
          );
        const rosterManagers = async (teamId: string, steam: string) =>
          postgres.query<Array<unknown>>(
            "SELECT 1 FROM team_roster WHERE team_id = $1 AND player_steam_id = $2 AND role = 'Admin'",
            [teamId, steam],
          );
        const statusCounts = async (teamId: string) =>
          postgres.query<Array<{ status: string; count: number }>>(
            "SELECT status, COUNT(*)::int AS count FROM team_roster WHERE team_id = $1 GROUP BY status ORDER BY status",
            [teamId],
          );

        const owner = await seedPlayer();
        const teamId = await createTeam(owner);
        await postgres.transaction(async (client) => {
          await client.query(
            "ALTER TABLE team_roster DISABLE TRIGGER tbd_team_roster",
          );
          await client.query(
            "DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
            [teamId, owner],
          );
          await client.query(
            "ALTER TABLE team_roster ENABLE TRIGGER tbd_team_roster",
          );
        });
        const players = await fx.players(7);
        await asUser(players[0], "admin", async (query) => {
          await query(
            "SELECT set_config('fivestack.rebalancing', 'true', true)",
          );
          for (const [index, steamId] of players.entries()) {
            await query(
              "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, $3)",
              [teamId, steamId, index < 5 ? "Starter" : "Substitute"],
            );
          }
        });

        const otherOwner = await seedPlayer();
        const otherTeamId = await createTeam(otherOwner);

        expect(await rosterManagers(teamId, owner)).toHaveLength(0);

        await runRejoin();
        await runRejoin();

        const [rejoined] = await postgres.query<
          Array<{ role: string; status: string; coach: boolean }>
        >(
          "SELECT role, status, coach FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
          [teamId, owner],
        );
        expect(rejoined).toEqual({
          role: "Admin",
          status: "Benched",
          coach: false,
        });
        expect(await statusCounts(teamId)).toEqual([
          { status: "Benched", count: 1 },
          { status: "Starter", count: 5 },
          { status: "Substitute", count: 2 },
        ]);
        expect(await statusCounts(otherTeamId)).toEqual([
          { status: "Starter", count: 1 },
        ]);
      });
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
