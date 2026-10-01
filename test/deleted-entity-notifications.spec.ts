import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// A notification names its match or tournament through a free-text entity_id,
// so deleting the target used to leave a bell entry linking to a 404.
describe("notifications of deleted matches and tournaments (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const REGION = "TestDeletedEntityNotifications";

  beforeAll(async () => {
    db = await bootMigratedDb("DeletedEntityNotificationsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561192900000000n);
    await fx.region(REGION);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM notifications");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const notify = async (type: string, steamId: string, entityId: string) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO notifications (title, message, steam_id, role, type, entity_id)
       VALUES ('t', 'm', $1, 'user', $2, $3) RETURNING id`,
      [steamId, type, entityId],
    );
    return row.id;
  };

  const remaining = async (ids: Array<string>) => {
    const rows = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM notifications WHERE id = ANY($1::uuid[])",
      [ids],
    );
    return rows.map((row) => row.id).sort();
  };

  const createMatch = async () => {
    const { matchId } = await fx.bareMatch();
    const [match] = await postgres.query<
      Array<{ id: string; lineup_1_id: string; lineup_2_id: string }>
    >("SELECT id, lineup_1_id, lineup_2_id FROM matches WHERE id = $1", [
      matchId,
    ]);
    return match;
  };

  const createTournament = async (organizer: string) => {
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       SELECT 8, 1, 'Wingman', id, false, true, $1
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      [`{${REGION}}`],
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup') RETURNING id`,
      [fx.nextName("cup"), organizer, options.id],
    );
    return tournament.id;
  };

  const createTournamentTeam = async (tournamentId: string, owner: string) =>
    runAsUser(postgres, owner, "admin", async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name, owner_steam_id)
         VALUES ($1, NULL, $2, $3) RETURNING id`,
        [tournamentId, fx.nextName("tt"), owner],
      )) as Array<{ id: string }>;
      return row.id;
    });

  describe("deleting a match", () => {
    it("removes every notification about it and nothing about another match", async () => {
      const player = await fx.player();
      const doomed = await createMatch();
      const kept = await createMatch();

      const bells = (match: typeof doomed) =>
        Promise.all([
          notify("MatchStatusChange", player, match.id),
          notify("MatchImported", player, match.id),
          notify("MatchSupport", player, match.id),
          notify("MatchAbandoned", player, match.id),
          notify("MatchStatsReady", player, match.id),
          notify("AdminCall", player, match.id),
          notify("MatchChatMessage", player, `match:${match.id}`),
          notify(
            "MatchChatMessage",
            player,
            `match_team:${match.id}:${match.lineup_1_id}`,
          ),
          notify(
            "MatchChatMessage",
            player,
            `match_team:${match.id}:${match.lineup_2_id}`,
          ),
        ]);

      const doomedBells = await bells(doomed);
      const keptBells = await bells(kept);

      await postgres.query("DELETE FROM matches WHERE id = $1", [doomed.id]);

      expect(await remaining(doomedBells)).toEqual([]);
      expect(await remaining(keptBells)).toEqual([...keptBells].sort());
    });
  });

  describe("deleting a tournament", () => {
    it("removes every notification about it, its invites included, and nothing about another tournament", async () => {
      const [organizer, invitee] = await fx.players(2);

      const bells = async (tournamentId: string) => {
        const tournamentTeamId = await createTournamentTeam(
          tournamentId,
          organizer,
        );
        const [teamInvite] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO tournament_team_invites (tournament_team_id, steam_id, invited_by_player_steam_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [tournamentTeamId, invitee, organizer],
        );
        const [registration] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO tournament_invites (tournament_id, steam_id, invited_by_player_steam_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [tournamentId, invitee, organizer],
        );

        return Promise.all([
          notify("TournamentCreated", invitee, tournamentId),
          notify("TournamentCheckInOpen", invitee, tournamentId),
          notify("TournamentCheckInMissed", invitee, tournamentId),
          notify("TournamentPartySignup", invitee, tournamentId),
          notify("TournamentReminder", invitee, `${tournamentId}:1h`),
          notify(
            "TournamentCheckInClosing",
            invitee,
            `${tournamentId}:closing:1759312800`,
          ),
          notify("ChatMessage", invitee, `tournament:${tournamentId}`),
          notify("TournamentInvite", invitee, registration.id),
          notify("TournamentTeamInvite", invitee, teamInvite.id),
        ]);
      };

      const doomed = await createTournament(organizer);
      const kept = await createTournament(organizer);
      const doomedBells = await bells(doomed);
      const keptBells = await bells(kept);

      await postgres.query("DELETE FROM tournaments WHERE id = $1", [doomed]);

      expect(await remaining(doomedBells)).toEqual([]);
      expect(await remaining(keptBells)).toEqual([...keptBells].sort());
    });
  });

  describe("orphan sweep migration", () => {
    const up = readFileSync(
      join(
        __dirname,
        "../hasura/migrations/default/1889000000900_remove_orphaned_entity_notifications/up.sql",
      ),
      "utf8",
    );

    it("removes notifications whose match or tournament is already gone and keeps live ones", async () => {
      const player = await fx.player();
      const match = await createMatch();
      const tournament = await createTournament(player);
      const goneMatch = randomUUID();
      const goneTournament = randomUUID();

      const orphans = await Promise.all([
        notify("MatchStatusChange", player, goneMatch),
        notify("MatchChatMessage", player, `match:${goneMatch}`),
        notify("MatchChatMessage", player, `match_team:${goneMatch}:x`),
        notify("TournamentCreated", player, goneTournament),
        notify("TournamentReminder", player, `${goneTournament}:1h`),
        notify("ChatMessage", player, `tournament:${goneTournament}`),
      ]);
      const live = await Promise.all([
        notify("MatchStatusChange", player, match.id),
        notify("MatchChatMessage", player, `match:${match.id}`),
        notify(
          "MatchChatMessage",
          player,
          `match_team:${match.id}:${match.lineup_1_id}`,
        ),
        notify("TournamentCreated", player, tournament),
        notify("TournamentReminder", player, `${tournament}:1h`),
        notify("ChatMessage", player, `tournament:${tournament}`),
        notify("ChatMessage", player, `team:${goneTournament}`),
        notify("TournamentInvite", player, randomUUID()),
      ]);

      await postgres.query(up);

      expect(await remaining(orphans)).toEqual([]);
      expect(await remaining(live)).toEqual([...live].sort());
    });
  });
});
