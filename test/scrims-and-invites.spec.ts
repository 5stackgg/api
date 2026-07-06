import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the team-invite guard, the one-open-scrim-per-pair constraint,
// scrim notification cleanup on terminal statuses, and the match-deletion
// hook that cancels a matched scrim while snapshotting reputation data.
describe("scrim requests and team invites (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("ScrimsInvitesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199600000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM team_scrim_requests");
    await postgres.query("DELETE FROM notifications");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  describe("team invites", () => {
    it("rejects inviting a player who is already on the roster", async () => {
      const team = await fx.team(0);
      await expect(
        postgres.query(
          `INSERT INTO team_invites (team_id, steam_id, invited_by_player_steam_id)
           VALUES ($1, $2, $2)`,
          [team.id, team.owner],
        ),
      ).rejects.toThrow(/already on team/i);
    });

    it("allows inviting an outsider", async () => {
      const team = await fx.team(0);
      const outsider = await fx.player();
      await postgres.query(
        `INSERT INTO team_invites (team_id, steam_id, invited_by_player_steam_id)
         VALUES ($1, $2, $3)`,
        [team.id, outsider, team.owner],
      );
      const invites = await postgres.query<Array<unknown>>(
        "SELECT 1 FROM team_invites WHERE team_id = $1 AND steam_id = $2",
        [team.id, outsider],
      );
      expect(invites.length).toBe(1);
    });
  });

  describe("scrim requests", () => {
    const createRequest = async (
      fromTeam: { id: string; owner: string },
      toTeam: { id: string; owner: string },
      status = "Pending",
    ) => {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO team_scrim_requests
           (from_team_id, to_team_id, status, requested_by_steam_id, awaiting_team_id,
            proposed_scheduled_at, expires_at)
         VALUES ($1, $2, $3, $4, $2, now() + interval '1 day', now() + interval '12 hours')
         RETURNING id`,
        [fromTeam.id, toTeam.id, status, fromTeam.owner],
      );
      return row.id;
    };

    it("allows only one open request per team pair, in either direction", async () => {
      const teamA = await fx.team(0);
      const teamB = await fx.team(0);
      await createRequest(teamA, teamB);

      // Same pair, reversed direction: still blocked while one is open.
      await expect(createRequest(teamB, teamA)).rejects.toThrow(
        /duplicate key|uq_scrim_req_open/i,
      );
    });

    it("permits a new request once the previous one is resolved", async () => {
      const teamA = await fx.team(0);
      const teamB = await fx.team(0);
      const first = await createRequest(teamA, teamB);
      await postgres.query(
        "UPDATE team_scrim_requests SET status = 'Declined' WHERE id = $1",
        [first],
      );

      await expect(createRequest(teamB, teamA)).resolves.toBeDefined();
    });

    it("resolving to a terminal status clears the actionable notifications", async () => {
      const teamA = await fx.team(0);
      const teamB = await fx.team(0);
      const request = await createRequest(teamA, teamB);

      const seedNotification = (type: string) =>
        postgres.query(
          `INSERT INTO notifications (title, message, steam_id, role, type, entity_id)
           VALUES ($1, $1, $2, 'user', $1, $3)`,
          [type, teamB.owner, request],
        );
      await seedNotification("ScrimRequestReceived");
      await seedNotification("ScrimMatchScheduled");
      // Outcome notifications survive the cleanup.
      await seedNotification("ScrimMatchCanceled");

      await postgres.query(
        "UPDATE team_scrim_requests SET status = 'Declined' WHERE id = $1",
        [request],
      );

      const remaining = await postgres.query<Array<{ type: string }>>(
        "SELECT type FROM notifications WHERE entity_id = $1",
        [request],
      );
      expect(remaining.map((n) => n.type)).toEqual(["ScrimMatchCanceled"]);
    });

    it("deleting a matched scrim's match cancels the request and freezes check-in state", async () => {
      // Two Wingman teams; attaching them to the lineups auto-fills the
      // lineups from each team's roster (tau_match_lineups).
      const teamA = await fx.team(1);
      const teamB = await fx.team(1);
      const match = await fx.match({ type: "Wingman", mr: 8, mapVeto: true });
      await postgres.query(
        "UPDATE match_lineups SET team_id = $1 WHERE id = $2",
        [teamA.id, match.lineup_1_id],
      );
      await postgres.query(
        "UPDATE match_lineups SET team_id = $1 WHERE id = $2",
        [teamB.id, match.lineup_2_id],
      );
      // Only team A checked in — the classic no-show scenario.
      await postgres.query(
        `UPDATE match_lineup_players SET checked_in = true
         WHERE match_lineup_id = $1 AND steam_id = $2`,
        [match.lineup_1_id, teamA.owner],
      );

      const request = await createRequest(teamA, teamB, "Matched");
      await postgres.query(
        "UPDATE team_scrim_requests SET match_id = $1 WHERE id = $2",
        [match.id, request],
      );

      await postgres.query("DELETE FROM matches WHERE id = $1", [match.id]);

      const [after] = await postgres.query<
        Array<{
          status: string;
          match_outcome: string | null;
          from_team_checked_in: boolean | null;
          to_team_checked_in: boolean | null;
          responded_at: Date | null;
        }>
      >(
        `SELECT status, match_outcome, from_team_checked_in, to_team_checked_in, responded_at
         FROM team_scrim_requests WHERE id = $1`,
        [request],
      );
      expect(after.status).toBe("Cancelled");
      expect(after.match_outcome).toBe("PickingPlayers");
      expect(after.from_team_checked_in).toBe(true);
      expect(after.to_team_checked_in).toBe(false);
      expect(after.responded_at).not.toBeNull();
    });
  });
});
