import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the Hasura permission functions — the layer that decides what a
// session may do. These run as plain SELECTs with an explicit session JSON,
// exactly how Hasura evaluates them.
describe("permission functions (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("PermissionsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199960000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM draft_games");
    await postgres.query("DELETE FROM lobbies");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const session = (steamId: string, role = "user") =>
    JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId });

  const boolFn = async (
    fn: string,
    table: string,
    rowId: string,
    idColumn: string,
    sessionJson: string,
  ) => {
    const [row] = await postgres.query<Array<{ allowed: boolean | null }>>(
      `SELECT ${fn}(t, $2::json) AS allowed FROM ${table} t WHERE ${idColumn} = $1`,
      [rowId, sessionJson],
    );
    // Hasura treats NULL as denied; collapse for assertions.
    return row.allowed === true;
  };

  describe("can_check_in", () => {
    const setup = async (checkInSetting = "Players") => {
      const match = await fx.match({ type: "Wingman", mr: 8, mapVeto: true });
      await postgres.query(
        "UPDATE match_options SET check_in_setting = $2 WHERE id = $1",
        [match.options_id, checkInSetting],
      );
      const captain = await fx.lineupPlayer(match.lineup_1_id);
      const mate = await fx.lineupPlayer(match.lineup_1_id);
      await postgres.query(
        "UPDATE matches SET status = 'WaitingForCheckIn' WHERE id = $1",
        [match.id],
      );
      return { match, captain, mate };
    };

    it("lineup members may check in during the window; outsiders never", async () => {
      const { match, captain } = await setup();
      expect(
        await boolFn("can_check_in", "matches", match.id, "id", session(captain)),
      ).toBe(true);

      const outsider = await fx.player();
      expect(
        await boolFn("can_check_in", "matches", match.id, "id", session(outsider)),
      ).toBe(false);
    });

    it("outside the check-in window nobody checks in", async () => {
      const { match, captain } = await setup();
      await postgres.query(
        "UPDATE matches SET status = 'PickingPlayers' WHERE id = $1",
        [match.id],
      );
      expect(
        await boolFn("can_check_in", "matches", match.id, "id", session(captain)),
      ).toBe(false);
    });

    it("the Captains setting restricts check-in to lineup captains", async () => {
      const { match, captain, mate } = await setup("Captains");
      expect(
        await boolFn("can_check_in", "matches", match.id, "id", session(captain)),
      ).toBe(true);
      expect(
        await boolFn("can_check_in", "matches", match.id, "id", session(mate)),
      ).toBe(false);
    });
  });

  describe("can_start_match and can_cancel_match", () => {
    const duelWithPlayers = async (organizer?: string) => {
      const match = await fx.match({ type: "Duel" });
      const p1 = await fx.lineupPlayer(match.lineup_1_id);
      const p2 = await fx.lineupPlayer(match.lineup_2_id);
      if (organizer) {
        await postgres.query(
          "UPDATE matches SET organizer_steam_id = $2 WHERE id = $1",
          [match.id, organizer],
        );
      }
      return { match, p1, p2 };
    };

    it("organizers may start a filled match; empty lineups block everyone", async () => {
      const organizer = await fx.player();
      const { match } = await duelWithPlayers(organizer);
      expect(
        await boolFn(
          "can_start_match",
          "matches",
          match.id,
          "id",
          session(organizer, "match_organizer"),
        ),
      ).toBe(true);

      const empty = await fx.match({ type: "Duel" });
      await postgres.query(
        "UPDATE matches SET organizer_steam_id = $2 WHERE id = $1",
        [empty.id, organizer],
      );
      expect(
        await boolFn(
          "can_start_match",
          "matches",
          empty.id,
          "id",
          session(organizer, "match_organizer"),
        ),
      ).toBe(false);
    });

    it("without an organizer both lineups must be checked in", async () => {
      const { match, p1, p2 } = await duelWithPlayers();
      expect(
        await boolFn("can_start_match", "matches", match.id, "id", session(p1)),
      ).toBe(false);

      await postgres.query(
        "UPDATE match_lineup_players SET checked_in = true WHERE steam_id IN ($1, $2)",
        [p1, p2],
      );
      expect(
        await boolFn("can_start_match", "matches", match.id, "id", session(p1)),
      ).toBe(true);
    });

    it("only the organizer cancels, and never after the match decided", async () => {
      const organizer = await fx.player();
      const { match, p1 } = await duelWithPlayers(organizer);

      expect(
        await boolFn(
          "can_cancel_match",
          "matches",
          match.id,
          "id",
          session(organizer, "match_organizer"),
        ),
      ).toBe(true);
      expect(
        await boolFn("can_cancel_match", "matches", match.id, "id", session(p1)),
      ).toBe(false);

      await postgres.query(
        "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
        [match.id],
      );
      expect(
        await boolFn(
          "can_cancel_match",
          "matches",
          match.id,
          "id",
          session(organizer, "match_organizer"),
        ),
      ).toBe(false);
    });
  });

  describe("matchmaking guards", () => {
    const playerFn = async (fn: string, steam: string) => {
      const [row] = await postgres.query<Array<{ v: boolean }>>(
        `SELECT ${fn}(p) AS v FROM players p WHERE steam_id = $1`,
        [steam],
      );
      return row.v;
    };

    it("is_in_another_match tracks live and imminent matches only", async () => {
      const match = await fx.match({ type: "Duel" });
      const player = await fx.lineupPlayer(match.lineup_1_id);
      await fx.lineupPlayer(match.lineup_2_id);

      // PickingPlayers doesn't tie the player up.
      expect(await playerFn("is_in_another_match", player)).toBe(false);

      // A far-out scheduled match doesn't either...
      await postgres.query(
        `UPDATE matches SET status = 'Scheduled', scheduled_at = now() + interval '3 hours' WHERE id = $1`,
        [match.id],
      );
      expect(await playerFn("is_in_another_match", player)).toBe(false);

      // ...but one within the hour does.
      await postgres.query(
        `UPDATE matches SET scheduled_at = now() + interval '30 minutes' WHERE id = $1`,
        [match.id],
      );
      expect(await playerFn("is_in_another_match", player)).toBe(true);
    });

    it("is_in_lobby and is_in_draft reflect current membership", async () => {
      const player = await fx.player();
      expect(await playerFn("is_in_lobby", player)).toBe(false);
      expect(await playerFn("is_in_draft", player)).toBe(false);

      const host = await fx.player();
      const [draft] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO draft_games (host_steam_id, type) VALUES ($1, 'Wingman') RETURNING id`,
        [host],
      );
      await postgres.query(
        `INSERT INTO draft_game_players (draft_game_id, steam_id, status) VALUES ($1, $2, 'Accepted')`,
        [draft.id, player],
      );
      expect(await playerFn("is_in_draft", player)).toBe(true);

      // Completed drafts release the player.
      await postgres.query(
        "UPDATE draft_games SET status = 'Canceled' WHERE id = $1",
        [draft.id],
      );
      expect(await playerFn("is_in_draft", player)).toBe(false);
    });

    it("abandoning matches escalates the matchmaking cooldown", async () => {
      const player = await fx.player();
      const cooldown = async () => {
        const [row] = await postgres.query<Array<{ v: Date | null }>>(
          `SELECT get_player_matchmaking_cooldown(p, $2::json) AS v
           FROM players p WHERE steam_id = $1`,
          [player, session(player)],
        );
        return row.v;
      };

      expect(await cooldown()).toBeNull();

      // First abandon: 10 minutes.
      await postgres.query(
        "INSERT INTO abandoned_matches (steam_id, abandoned_at) VALUES ($1, now())",
        [player],
      );
      const first = await cooldown();
      expect(first).not.toBeNull();
      expect(first!.getTime() - Date.now()).toBeLessThan(11 * 60_000);

      // Second abandon: escalates to an hour.
      await postgres.query(
        "INSERT INTO abandoned_matches (steam_id, abandoned_at) VALUES ($1, now() + interval '1 second')",
        [player],
      );
      const second = await cooldown();
      expect(second!.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);

      // Someone else's session sees nothing.
      const stranger = await fx.player();
      const [other] = await postgres.query<Array<{ v: Date | null }>>(
        `SELECT get_player_matchmaking_cooldown(p, $2::json) AS v
         FROM players p WHERE steam_id = $1`,
        [player, session(stranger)],
      );
      expect(other.v).toBeNull();
    });
  });

  describe("team permissions", () => {
    it("owner and roster admins manage roles; members and outsiders don't", async () => {
      const team = await fx.team(1);
      const [mate] = (
        await postgres.query<Array<{ player_steam_id: string }>>(
          "SELECT player_steam_id FROM team_roster WHERE team_id = $1 AND player_steam_id != $2",
          [team.id, team.owner],
        )
      ).map((r) => r.player_steam_id);

      expect(
        await boolFn("can_change_team_role", "teams", team.id, "id", session(team.owner)),
      ).toBe(true);
      expect(
        await boolFn("can_change_team_role", "teams", team.id, "id", session(mate)),
      ).toBe(false);

      await postgres.query(
        "UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2",
        [team.id, mate],
      );
      expect(
        await boolFn("can_change_team_role", "teams", team.id, "id", session(mate)),
      ).toBe(true);

      const outsider = await fx.player();
      expect(
        await boolFn("can_change_team_role", "teams", team.id, "id", session(outsider)),
      ).toBe(false);
      expect(
        await boolFn(
          "can_change_team_role",
          "teams",
          team.id,
          "id",
          session(outsider, "administrator"),
        ),
      ).toBe(true);
    });
  });
});
