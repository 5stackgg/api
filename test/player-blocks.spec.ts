import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// A block is directional to own but symmetric in effect: either side blocking
// shuts every person-to-person invitation, friend request and DM path in both
// directions, with one error code that never says who did it.
describe("player blocks (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const REGION = "TestBlocks";

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerBlocksTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561192800000000n);
    await fx.region(REGION);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM draft_games");
    await postgres.query("DELETE FROM lobbies");
    await postgres.query("DELETE FROM utility_practice_sessions");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM notifications");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const block = (blocker: string, blocked: string) =>
    runAsUser(postgres, blocker, "user", (query) =>
      query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
         VALUES ($1, $2) RETURNING blocker_steam_id::text`,
        [blocker, blocked],
      ),
    ) as Promise<Array<unknown>>;

  const unblock = (blocker: string, blocked: string) =>
    postgres.query(
      "DELETE FROM player_blocks WHERE blocker_steam_id = $1 AND blocked_steam_id = $2",
      [blocker, blocked],
    );

  const count = async (sql: string, params: Array<string>) => {
    const [row] = await postgres.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM ${sql}`,
      params,
    );
    return row.count;
  };

  const bool = async (sql: string, params: Array<string | null>) => {
    const [row] = await postgres.query<Array<{ value: boolean }>>(
      `SELECT ${sql} AS value`,
      params,
    );
    return row.value;
  };

  const notify = async (type: string, steamId: string, entityId: string) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO notifications (title, message, steam_id, role, type, entity_id)
       VALUES ('t', 'm', $1, 'user', $2, $3) RETURNING id`,
      [steamId, type, entityId],
    );
    return row.id;
  };

  const notificationDeleted = async (id: string) => {
    const [row] = await postgres.query<Array<{ deleted: boolean }>>(
      "SELECT deleted_at IS NOT NULL AS deleted FROM notifications WHERE id = $1",
      [id],
    );
    return row.deleted;
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

  const createLobby = (creator: string, access = "Open") =>
    runAsUser(postgres, creator, "user", async (query) => {
      const [row] = (await query(
        "INSERT INTO lobbies (access) VALUES ($1) RETURNING id",
        [access],
      )) as Array<{ id: string }>;
      return row.id;
    });

  const createDraft = async (host: string) => {
    const [draft] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO draft_games (host_steam_id, type) VALUES ($1, 'Wingman') RETURNING id`,
      [host],
    );
    await runAsUser(postgres, host, "user", (query) =>
      query(
        "INSERT INTO draft_game_players (draft_game_id, steam_id) VALUES ($1, $2)",
        [draft.id, host],
      ),
    );
    return draft.id;
  };

  const inviteToDraft = (draftId: string, steamId: string) =>
    postgres.query(
      `INSERT INTO draft_game_players (draft_game_id, steam_id, status)
       VALUES ($1, $2, 'Invited')`,
      [draftId, steamId],
    );

  const createPracticeSession = async (host: string) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_practice_sessions (host_steam_id, map_name, region, status)
       VALUES ($1, 'de_mirage', $2, 'Ready') RETURNING id::text AS id`,
      [host, REGION],
    );
    return row.id;
  };

  const roomId = (a: string, b: string) =>
    [BigInt(a), BigInt(b)]
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
      .join(":");

  describe("the table", () => {
    it("refuses a block on yourself", async () => {
      const me = await fx.player();
      await expect(block(me, me)).rejects.toThrow(/player_blocks_not_self/);
    });

    it("treats a second block of the same player as a no-op", async () => {
      const [a, b] = await fx.players(2);

      expect(await block(a, b)).toHaveLength(1);
      expect(await block(a, b)).toHaveLength(0);
      expect(
        await count("player_blocks WHERE blocker_steam_id = $1", [a]),
      ).toBe(1);
    });

    it("lets both sides block each other independently", async () => {
      const [a, b] = await fx.players(2);

      await block(a, b);
      await block(b, a);

      expect(
        await count("player_blocks WHERE blocker_steam_id IN ($1, $2)", [a, b]),
      ).toBe(2);
    });

    it("goes away with either player", async () => {
      const [a, b] = await fx.players(2);
      await block(a, b);

      await postgres.query("DELETE FROM players WHERE steam_id = $1", [b]);

      expect(
        await count("player_blocks WHERE blocker_steam_id = $1", [a]),
      ).toBe(0);
    });
  });

  describe("the helper functions", () => {
    it("has_blocked_player is directional", async () => {
      const [a, b] = await fx.players(2);
      await block(a, b);

      expect(await bool("public.has_blocked_player($1, $2)", [a, b])).toBe(
        true,
      );
      expect(await bool("public.has_blocked_player($1, $2)", [b, a])).toBe(
        false,
      );
    });

    it("is_blocked_either_way is symmetric and false for nulls and self", async () => {
      const [a, b, c] = await fx.players(3);
      await block(a, b);

      expect(await bool("public.is_blocked_either_way($1, $2)", [a, b])).toBe(
        true,
      );
      expect(await bool("public.is_blocked_either_way($1, $2)", [b, a])).toBe(
        true,
      );
      expect(await bool("public.is_blocked_either_way($1, $2)", [a, c])).toBe(
        false,
      );
      expect(await bool("public.is_blocked_either_way($1, $2)", [a, a])).toBe(
        false,
      );
      expect(
        await bool("public.is_blocked_either_way($1::bigint, $2::bigint)", [
          null,
          b,
        ]),
      ).toBe(false);
      expect(
        await bool("public.is_blocked_either_way($1::bigint, $2::bigint)", [
          a,
          null,
        ]),
      ).toBe(false);
    });

    it("assert_not_blocked raises the one code whichever side blocked", async () => {
      const [a, b] = await fx.players(2);
      await block(b, a);

      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        await expect(
          postgres.query("SELECT public.assert_not_blocked($1, $2)", [x, y]),
        ).rejects.toThrow(/^player_blocked$/);
      }
    });
  });

  describe("blocking clears what is pending between the pair", () => {
    it("removes the friendship in both directions, and unblocking does not bring it back", async () => {
      const [a, b] = await fx.players(2);
      await postgres.query(
        `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
         VALUES ($1, $2, 'Accepted'), ($2, $1, 'Pending')`,
        [a, b],
      );

      await block(b, a);

      const pair =
        "friends WHERE player_steam_id IN ($1, $2) AND other_player_steam_id IN ($1, $2)";
      expect(await count(pair, [a, b])).toBe(0);

      await unblock(b, a);
      expect(await count(pair, [a, b])).toBe(0);
    });

    it("removes lobby invites either way but leaves other invites and members alone", async () => {
      const [a, b, c] = await fx.players(3);
      const lobbyA = await createLobby(a);
      const lobbyB = await createLobby(b);

      await postgres.query(
        `INSERT INTO lobby_players (lobby_id, steam_id, invited_by_steam_id, status)
         VALUES ($1, $3, $2, 'Invited'), ($1, $4, $2, 'Invited'), ($5, $2, $3, 'Invited')`,
        [lobbyA, a, b, c, lobbyB],
      );

      await block(a, b);

      expect(
        await count(
          "lobby_players WHERE status = 'Invited' AND steam_id IN ($1, $2)",
          [a, b],
        ),
      ).toBe(0);
      expect(
        await count("lobby_players WHERE lobby_id = $1 AND steam_id = $2", [
          lobbyA,
          c,
        ]),
      ).toBe(1);
      expect(
        await count(
          "lobby_players WHERE status = 'Accepted' AND steam_id IN ($1, $2)",
          [a, b],
        ),
      ).toBe(2);
    });

    it("removes team invites and retracts their bell entries", async () => {
      const team = await fx.team();
      const [b, c] = await fx.players(2);

      const [blocked] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO team_invites (team_id, steam_id, invited_by_player_steam_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [team.id, b, team.owner],
      );
      const [kept] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO team_invites (team_id, steam_id, invited_by_player_steam_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [team.id, c, team.owner],
      );
      const blockedBell = await notify("TeamInvite", b, blocked.id);
      const keptBell = await notify("TeamInvite", c, kept.id);

      await block(b, team.owner);

      expect(await count("team_invites WHERE id = $1", [blocked.id])).toBe(0);
      expect(await count("team_invites WHERE id = $1", [kept.id])).toBe(1);
      expect(await notificationDeleted(blockedBell)).toBe(true);
      expect(await notificationDeleted(keptBell)).toBe(false);
    });

    it("removes tournament team invites and tournament invites with their bell entries", async () => {
      const [organizer, b] = await fx.players(2);
      const tournamentId = await createTournament(organizer);
      const tournamentTeamId = await createTournamentTeam(
        tournamentId,
        organizer,
      );

      const [teamInvite] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_team_invites (tournament_team_id, steam_id, invited_by_player_steam_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [tournamentTeamId, b, organizer],
      );
      const [registration] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_invites (tournament_id, steam_id, invited_by_player_steam_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [tournamentId, b, organizer],
      );
      const teamBell = await notify("TournamentTeamInvite", b, teamInvite.id);
      const registrationBell = await notify(
        "TournamentInvite",
        b,
        registration.id,
      );

      await block(organizer, b);

      expect(
        await count("tournament_team_invites WHERE id = $1", [teamInvite.id]),
      ).toBe(0);
      expect(
        await count("tournament_invites WHERE id = $1", [registration.id]),
      ).toBe(0);
      expect(await notificationDeleted(teamBell)).toBe(true);
      expect(await notificationDeleted(registrationBell)).toBe(true);
    });

    it("removes draft invites from the other party's drafts and retracts the bell entry", async () => {
      const [a, b, c] = await fx.players(3);
      const draftA = await createDraft(a);
      await inviteToDraft(draftA, b);
      await inviteToDraft(draftA, c);
      const blockedBell = await notify("DraftInvite", b, draftA);
      const keptBell = await notify("DraftInvite", c, draftA);

      await block(b, a);

      expect(
        await count(
          "draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
          [draftA, b],
        ),
      ).toBe(0);
      expect(
        await count(
          "draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
          [draftA, c],
        ),
      ).toBe(1);
      expect(await notificationDeleted(blockedBell)).toBe(true);
      expect(await notificationDeleted(keptBell)).toBe(false);
    });

    it("clearing an invite from a draft that already started does not tear the draft down", async () => {
      const [a, b] = await fx.players(2);
      const draftA = await createDraft(a);
      await inviteToDraft(draftA, b);
      await postgres.query(
        "UPDATE draft_games SET status = 'Drafting' WHERE id = $1",
        [draftA],
      );

      await block(a, b);

      expect(await count("draft_games WHERE id = $1", [draftA])).toBe(1);
      expect(
        await count(
          "draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
          [draftA, b],
        ),
      ).toBe(0);
    });

    it("removes utility practice invites and retracts the bell entry", async () => {
      const [a, b, c] = await fx.players(3);
      const session = await createPracticeSession(a);
      await postgres.query(
        `INSERT INTO utility_practice_invites (utility_practice_session_id, steam_id, invited_by_steam_id)
         VALUES ($1, $2, $4), ($1, $3, $4)`,
        [session, b, c, a],
      );
      const blockedBell = await notify("UtilityPracticeInvite", b, session);
      const keptBell = await notify("UtilityPracticeInvite", c, session);

      await block(a, b);

      expect(
        await count(
          "utility_practice_invites WHERE utility_practice_session_id = $1",
          [session],
        ),
      ).toBe(1);
      expect(
        await count("utility_practice_invites WHERE steam_id = $1", [c]),
      ).toBe(1);
      expect(await notificationDeleted(blockedBell)).toBe(true);
      expect(await notificationDeleted(keptBell)).toBe(false);
    });

    it("takes the conversation off the blocker's DM rail only", async () => {
      const [a, b] = await fx.players(2);
      const room = roomId(a, b);
      await postgres.query(
        `INSERT INTO direct_conversations (room_id, steam_id, is_open)
         VALUES ($1, $2, true), ($1, $3, true)`,
        [room, a, b],
      );

      await block(b, a);

      const rail = await postgres.query<
        Array<{ steam_id: string; is_open: boolean }>
      >(
        "SELECT steam_id::text, is_open FROM direct_conversations WHERE room_id = $1 ORDER BY steam_id",
        [room],
      );
      expect(
        Object.fromEntries(rail.map((row) => [row.steam_id, row.is_open])),
      ).toEqual({
        [a]: true,
        [b]: false,
      });
    });
  });

  describe("guards refuse new contact either way", () => {
    it("refuses a friend request through v_my_friends from either side", async () => {
      const [a, b] = await fx.players(2);
      await block(a, b);

      for (const [from, to] of [
        [a, b],
        [b, a],
      ]) {
        await expect(
          runAsUser(postgres, from, "user", (query) =>
            query("INSERT INTO v_my_friends (steam_id) VALUES ($1)", [to]),
          ),
        ).rejects.toThrow(/^player_blocked$/);
      }
    });

    it("refuses a raw friends insert, the syncSteamFriends path", async () => {
      const [a, b] = await fx.players(2);
      await block(b, a);

      await expect(
        postgres.query(
          `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
           VALUES ($1, $2, 'Accepted')`,
          [a, b],
        ),
      ).rejects.toThrow(/^player_blocked$/);
    });

    it("refuses a team invite made through team_roster and made directly", async () => {
      const team = await fx.team();
      const b = await fx.player();
      await block(b, team.owner);

      await expect(
        runAsUser(postgres, team.owner, "user", (query) =>
          query(
            "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
            [team.id, b],
          ),
        ),
      ).rejects.toThrow(/^player_blocked$/);

      await expect(
        postgres.query(
          `INSERT INTO team_invites (team_id, steam_id, invited_by_player_steam_id)
           VALUES ($1, $2, $3)`,
          [team.id, b, team.owner],
        ),
      ).rejects.toThrow(/^player_blocked$/);
    });

    it("still lets an administrator add a blocked player straight to a roster", async () => {
      const team = await fx.team();
      const b = await fx.player();
      await block(team.owner, b);

      await runAsUser(postgres, team.owner, "administrator", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
          [team.id, b],
        ),
      );

      expect(
        await count("team_roster WHERE team_id = $1 AND player_steam_id = $2", [
          team.id,
          b,
        ]),
      ).toBe(1);
    });

    it("refuses a tournament team invite made through the roster and made directly", async () => {
      const [organizer, b] = await fx.players(2);
      const tournamentId = await createTournament(organizer);
      const tournamentTeamId = await createTournamentTeam(
        tournamentId,
        organizer,
      );
      await block(b, organizer);

      await expect(
        runAsUser(postgres, organizer, "user", (query) =>
          query(
            `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
             VALUES ($1, $2, $3)`,
            [tournamentTeamId, b, tournamentId],
          ),
        ),
      ).rejects.toThrow(/^player_blocked$/);

      await expect(
        postgres.query(
          `INSERT INTO tournament_team_invites (tournament_team_id, steam_id, invited_by_player_steam_id)
           VALUES ($1, $2, $3)`,
          [tournamentTeamId, b, organizer],
        ),
      ).rejects.toThrow(/^player_blocked$/);
    });

    it("refuses a tournament registration invite from the organizer", async () => {
      const [organizer, b] = await fx.players(2);
      const tournamentId = await createTournament(organizer);
      await block(b, organizer);

      await expect(
        runAsUser(postgres, organizer, "user", (query) =>
          query(
            `INSERT INTO tournament_invites (tournament_id, steam_id, invited_by_player_steam_id)
             VALUES ($1, $2, $3)`,
            [tournamentId, b, organizer],
          ),
        ),
      ).rejects.toThrow(/^player_blocked$/);
    });

    it("refuses a lobby invite but still lets a player join an open lobby themselves", async () => {
      const [a, b] = await fx.players(2);
      const lobbyA = await createLobby(a);
      await block(a, b);

      await expect(
        runAsUser(postgres, a, "user", (query) =>
          query(
            "INSERT INTO lobby_players (lobby_id, steam_id, invited_by_steam_id) VALUES ($1, $2, $3)",
            [lobbyA, b, a],
          ),
        ),
      ).rejects.toThrow(/^player_blocked$/);

      await runAsUser(postgres, b, "user", (query) =>
        query(
          "INSERT INTO lobby_players (lobby_id, steam_id, invited_by_steam_id) VALUES ($1, $2, $2)",
          [lobbyA, b],
        ),
      );
      expect(
        await count("lobby_players WHERE lobby_id = $1 AND steam_id = $2", [
          lobbyA,
          b,
        ]),
      ).toBe(1);
    });

    it("refuses a draft host adding a blocked player, but not a match organizer or a self-join", async () => {
      const [a, b, c] = await fx.players(3);
      const draftA = await createDraft(a);
      await block(b, a);

      await expect(
        runAsUser(postgres, a, "user", (query) =>
          query(
            "INSERT INTO draft_game_players (draft_game_id, steam_id) VALUES ($1, $2)",
            [draftA, b],
          ),
        ),
      ).rejects.toThrow(/^player_blocked$/);

      await runAsUser(postgres, b, "user", (query) =>
        query(
          "INSERT INTO draft_game_players (draft_game_id, steam_id) VALUES ($1, $2)",
          [draftA, b],
        ),
      );
      await postgres.query(
        "DELETE FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
        [draftA, b],
      );

      await block(c, b);
      await runAsUser(postgres, c, "match_organizer", (query) =>
        query(
          "INSERT INTO draft_game_players (draft_game_id, steam_id) VALUES ($1, $2)",
          [draftA, b],
        ),
      );
      expect(
        await count(
          "draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
          [draftA, b],
        ),
      ).toBe(1);
    });

    it("lets everything through again once the block is lifted", async () => {
      const [a, b] = await fx.players(2);
      await block(a, b);
      await unblock(a, b);

      await runAsUser(postgres, a, "user", (query) =>
        query("INSERT INTO v_my_friends (steam_id) VALUES ($1)", [b]),
      );

      expect(
        await count(
          "friends WHERE player_steam_id = $1 AND other_player_steam_id = $2",
          [a, b],
        ),
      ).toBe(1);
    });
  });
});
