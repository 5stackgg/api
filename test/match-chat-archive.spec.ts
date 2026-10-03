import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { ChatService } from "./../src/chat/chat.service";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";
import { ChatErrorCode } from "./../src/chat/enums/ChatErrorCode";
import { PlayerBlocksService } from "./../src/player-blocks/player-blocks.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

const SEVEN_DAYS = 60 * 60 * 24 * 7;

// The live rooms expire in an hour and belong to whoever is in the match; the
// archive is what staff review afterwards, and only through the log.
describe("match chat archive (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let chat: ChatService;

  let match: { id: string; lineup_1_id: string; lineup_2_id: string };
  let organizer: string;
  let opponent: string;
  let coach: string;
  let admin: string;
  let player: string;

  // Answers the room access checks from the database, the way the session's
  // own Hasura permissions would.
  const hasura = {
    query: jest.fn(async (query: any, viewer?: string) => {
      if (query.players_by_pk) {
        const [row] = await postgres.query<
          Array<{ steam_id: string; name: string; role: string }>
        >(
          `SELECT steam_id::text AS steam_id, name, role::text AS role
             FROM players WHERE steam_id = $1::bigint`,
          [query.players_by_pk.__args.steam_id],
        );
        return { players_by_pk: row ?? null };
      }

      if (query.matches_by_pk) {
        const [row] = await postgres.query<
          Array<{ in_lineup: boolean; staff: boolean }>
        >(
          `SELECT EXISTS (
                    SELECT 1 FROM match_lineup_players mlp
                     WHERE mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
                       AND mlp.steam_id = $2::bigint
                  ) AS in_lineup,
                  EXISTS (
                    SELECT 1 FROM players p
                     WHERE p.steam_id = $2::bigint
                       AND p.role IN ('match_organizer', 'tournament_organizer',
                                      'administrator')
                  ) AS staff
             FROM matches m WHERE m.id = $1`,
          [query.matches_by_pk.__args.id, viewer],
        );
        return {
          matches_by_pk: row
            ? {
                is_coach: false,
                is_organizer: row.staff || null,
                is_in_lineup: row.in_lineup,
              }
            : null,
        };
      }

      if (query.match_lineups_by_pk) {
        const [row] = await postgres.query<
          Array<{
            match_id: string;
            coach_steam_id: string | null;
            is_on_lineup: boolean;
          }>
        >(
          `SELECT ml.match_id, ml.coach_steam_id::text,
                  EXISTS (
                    SELECT 1 FROM match_lineup_players mlp
                     WHERE mlp.match_lineup_id = ml.id
                       AND mlp.steam_id = $2::bigint
                  ) AS is_on_lineup
             FROM match_lineups ml WHERE ml.id = $1`,
          [query.match_lineups_by_pk.__args.id, viewer],
        );
        return { match_lineups_by_pk: row ?? null };
      }

      return {};
    }),
  };

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });

    db = await bootMigratedDb("MatchChatArchiveTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199660000000n);
    await fx.region();

    chat = new ChatService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {} as any,
      hasura as any,
      postgres,
      { getConnection: () => redis } as any,
      {
        sendChatMessage: jest.fn(async () => {}),
        retractChatMessage: jest.fn(async () => {}),
        editChatMessage: jest.fn(async () => {}),
      } as any,
      new PlayerBlocksService(postgres),
    );
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
    await db?.stop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    ChatService.MATCH_CHAT_ARCHIVE_MAX_ENTRIES = defaults.entries;
    ChatService.MATCH_CHAT_ARCHIVE_MAX_BYTES = defaults.bytes;
  });

  const defaults = {
    entries: ChatService.MATCH_CHAT_ARCHIVE_MAX_ENTRIES,
    bytes: ChatService.MATCH_CHAT_ARCHIVE_MAX_BYTES,
  };

  beforeEach(async () => {
    await redis.flushall();
    await postgres.query("DELETE FROM chat_message_deletions");
    await postgres.query("DELETE FROM chat_message_edits");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");

    organizer = await fx.player("Organizer");
    opponent = await fx.player("Opponent");
    coach = await fx.player("Coach");
    admin = await fx.player("Admin");
    player = await fx.player("Player");

    await setRole(organizer, "match_organizer");
    await setRole(coach, "match_organizer");
    await setRole(admin, "administrator");

    const created = await fx.match({ type: "Duel", substitutes: 2 });
    match = {
      id: created.id,
      lineup_1_id: created.lineup_1_id,
      lineup_2_id: created.lineup_2_id,
    };

    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1`,
      [match.id],
    );
    await fx.lineupPlayer(match.lineup_1_id, organizer);
    await fx.lineupPlayer(match.lineup_1_id, player);
    await fx.lineupPlayer(match.lineup_2_id, opponent);
    await postgres.query(
      "UPDATE match_lineups SET coach_steam_id = $2 WHERE id = $1",
      [match.lineup_2_id, coach],
    );
    await status("Live");
  });

  const setRole = (steamId: string, role: string) =>
    postgres.query("UPDATE players SET role = $2 WHERE steam_id = $1", [
      steamId,
      role,
    ]);

  const status = (value: string) =>
    postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
      match.id,
      value,
    ]);

  const as = (steamId: string, role = "user") =>
    ({ steam_id: steamId, name: `p${steamId.slice(-2)}`, role }) as any;

  const teamRoom = (lineupId: string) => `${match.id}:${lineupId}`;

  const say = async (
    type: ChatLobbyType,
    id: string,
    steamId: string,
    text: string,
    source: "web" | "game" = "game",
  ) => {
    const sent = await chat.sendMessageToChat(
      type,
      id,
      as(steamId),
      text,
      true,
      source,
    );
    return sent.accepted ? sent.messageId : "";
  };

  const archive = async () =>
    Object.entries(await redis.hgetall(`chat:archive:${match.id}`))
      .filter(([field]) => !field.startsWith("~"))
      .map(([, raw]) => JSON.parse(raw));

  const entry = async (id: string) =>
    (await archive()).find((line) => line.id === id);

  const log = (steamId: string, role = "user") =>
    chat.matchChatLog(match.id, as(steamId, role));

  const ids = (lines: Array<{ id: string }>) => lines.map(({ id }) => id);

  const edit = (id: string, text: string, steamId = organizer) =>
    chat.editMessage(ChatLobbyType.Match, match.id, id, as(steamId), text);

  // Any command aimed at an archive key fails, the way it would with redis
  // refusing writes to it; the live rooms are untouched.
  const breakArchive = () => {
    for (const command of ["hset", "hget", "expire", "eval", "hgetall"]) {
      const original = (redis as any)[command].bind(redis);
      jest.spyOn(redis as any, command).mockImplementation((...args: any[]) => {
        const keys =
          command === "eval" ? args.slice(2, 2 + Number(args[1])) : [args[0]];
        if (keys.some((key) => String(key).startsWith("chat:archive:"))) {
          return Promise.reject(new Error("archive unavailable"));
        }
        return original(...args);
      });
    }
  };

  describe("writing", () => {
    it("keeps every line from the match room and both team rooms, from the web and the game", async () => {
      const web = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        "gl hf",
        "web",
      );
      const game = await say(
        ChatLobbyType.MatchTeam,
        teamRoom(match.lineup_2_id),
        opponent,
        "stack A",
      );

      expect(await entry(web)).toMatchObject({
        room: "match",
        source: "web",
        message: "gl hf",
        from: { steam_id: organizer },
      });
      expect(typeof (await entry(web)).from.name).toBe("string");
      expect(await entry(game)).toMatchObject({
        room: match.lineup_2_id,
        source: "game",
        message: "stack A",
        from: { steam_id: opponent },
      });
      expect(typeof (await entry(game)).timestamp).toBe("string");
    });

    it("keeps a draft's lines once they move into the match room", async () => {
      const id = "7f1d0c2e-8b1a-4c6e-9f00-000000000001";
      await redis.hset(
        `chat_${ChatLobbyType.Draft}_draft-1`,
        id,
        JSON.stringify({
          id,
          message: "pick me",
          timestamp: new Date().toISOString(),
          source: "web",
          from: { role: "user", name: "Player", steam_id: player },
        }),
      );

      await chat.migrateLobbyMessages(
        ChatLobbyType.Draft,
        "draft-1",
        ChatLobbyType.Match,
        match.id,
      );

      expect(await entry(id)).toMatchObject({
        room: "match",
        message: "pick me",
        from: { steam_id: player },
      });
    });

    it("archives only the draft's lines, keeping what the room already had", async () => {
      const kept = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        "typo",
        "web",
      );
      await edit(kept, "fixed");

      const moved = "7f1d0c2e-8b1a-4c6e-9f00-000000000002";
      const editedAt = new Date().toISOString();
      await redis.hset(
        `chat_${ChatLobbyType.Draft}_draft-2`,
        moved,
        JSON.stringify({
          id: moved,
          message: "pick me now",
          timestamp: new Date().toISOString(),
          edited_at: editedAt,
          source: "web",
          from: { role: "user", name: "Player", steam_id: player },
        }),
      );

      await chat.migrateLobbyMessages(
        ChatLobbyType.Draft,
        "draft-2",
        ChatLobbyType.Match,
        match.id,
      );

      expect(await entry(kept)).toMatchObject({
        message: "fixed",
        edits: [{ message: "typo" }],
      });
      expect(await entry(moved)).toMatchObject({
        message: "pick me now",
        edited_at: editedAt,
      });
    });

    it("stops at its cap and says it was cut short", async () => {
      ChatService.MATCH_CHAT_ARCHIVE_MAX_ENTRIES = 2;

      const first = await say(ChatLobbyType.Match, match.id, organizer, "1");
      const second = await say(ChatLobbyType.Match, match.id, organizer, "2");
      await say(ChatLobbyType.Match, match.id, organizer, "3");
      await status("Finished");

      const read = await log(admin, "administrator");

      expect(ids(read!.match).sort()).toEqual([first, second].sort());
      expect(read!.archive_truncated).toBe(true);
    });

    it("stops at its byte cap too", async () => {
      ChatService.MATCH_CHAT_ARCHIVE_MAX_BYTES = 600;

      await say(ChatLobbyType.Match, match.id, organizer, "a".repeat(200));
      await say(ChatLobbyType.Match, match.id, organizer, "b".repeat(200));
      await say(ChatLobbyType.Match, match.id, organizer, "c".repeat(200));
      await status("Finished");

      const read = await log(admin, "administrator");

      expect(read!.match.length).toBeLessThan(3);
      expect(read!.archive_truncated).toBe(true);
    });

    it("says nothing was cut when nothing was", async () => {
      await say(ChatLobbyType.Match, match.id, organizer, "gg");
      await status("Finished");

      expect((await log(admin, "administrator"))!.archive_truncated).toBe(
        false,
      );
    });

    it("stops moving its expiry once the match has ended", async () => {
      await say(ChatLobbyType.Match, match.id, organizer, "gg");
      await chat.anchorMatchArchive(match.id);
      await redis.expire(`chat:archive:${match.id}`, 100);

      await say(ChatLobbyType.Match, match.id, opponent, "wp");

      expect(await redis.ttl(`chat:archive:${match.id}`)).toBeLessThanOrEqual(
        100,
      );
    });

    it("anchors a week from the end, even with nothing said yet", async () => {
      await chat.anchorMatchArchive(match.id);

      const ttl = await redis.ttl(`chat:archive:${match.id}`);
      expect(ttl).toBeGreaterThan(SEVEN_DAYS - 60);

      await redis.expire(`chat:archive:${match.id}`, 100);
      await say(ChatLobbyType.Match, match.id, opponent, "wp");

      expect(await redis.ttl(`chat:archive:${match.id}`)).toBeLessThanOrEqual(
        100,
      );
    });

    it("moves its expiry again when the match is restarted", async () => {
      await chat.anchorMatchArchive(match.id);
      await redis.expire(`chat:archive:${match.id}`, 100);
      await chat.reopenMatchArchive(match.id);

      await say(ChatLobbyType.Match, match.id, opponent, "again");

      expect(await redis.ttl(`chat:archive:${match.id}`)).toBeGreaterThan(
        SEVEN_DAYS - 60,
      );
    });

    it("goes with its match", async () => {
      await say(ChatLobbyType.Match, match.id, organizer, "gg");

      await chat.removeMatchArchive(match.id);

      expect(await redis.exists(`chat:archive:${match.id}`)).toBe(0);
    });

    describe("when the archive cannot be written", () => {
      beforeEach(breakArchive);

      it("still delivers a line from the web and from the game", async () => {
        const web = await chat.sendMessageToChat(
          ChatLobbyType.Match,
          match.id,
          as(organizer),
          "from the site",
          true,
          "web",
        );
        const game = await chat.sendMessageToChat(
          ChatLobbyType.MatchTeam,
          teamRoom(match.lineup_1_id),
          as(player),
          "from the game",
          true,
          "game",
        );

        expect(web).toMatchObject({ accepted: true });
        expect(game).toMatchObject({ accepted: true });
        expect(
          await redis.hlen(`chat_${ChatLobbyType.Match}_${match.id}`),
        ).toBe(1);
      });

      it("still edits and deletes", async () => {
        const typo = await say(
          ChatLobbyType.Match,
          match.id,
          organizer,
          "typo",
          "web",
        );
        const nasty = await say(
          ChatLobbyType.Match,
          match.id,
          organizer,
          "nasty",
          "web",
        );

        await expect(edit(typo, "fixed")).resolves.toMatchObject({
          edited: true,
        });
        await expect(
          chat.deleteMessage(ChatLobbyType.Match, match.id, nasty, as(admin)),
        ).resolves.toEqual({ deleted: true });
      });

      it("still moves a finished draft's chat into the match", async () => {
        const id = "7f1d0c2e-8b1a-4c6e-9f00-000000000003";
        await redis.hset(
          `chat_${ChatLobbyType.Draft}_draft-3`,
          id,
          JSON.stringify({
            id,
            message: "moving",
            timestamp: new Date().toISOString(),
            source: "web",
            from: { role: "user", name: "Player", steam_id: player },
          }),
        );

        await chat.migrateLobbyMessages(
          ChatLobbyType.Draft,
          "draft-3",
          ChatLobbyType.Match,
          match.id,
        );

        expect(
          await redis.hexists(`chat_${ChatLobbyType.Match}_${match.id}`, id),
        ).toBe(1);
      });
    });

    it("leaves other rooms out", async () => {
      await chat.sendMessageToChat(
        ChatLobbyType.Organizer,
        "organizers",
        as(admin),
        "staff only",
        true,
        "game",
      );

      expect(await archive()).toEqual([]);
    });

    it("outlives the live room by a week, and leaves the room's hour alone", async () => {
      const id = await say(ChatLobbyType.Match, match.id, organizer, "gg");

      const archiveTtl = await redis.ttl(`chat:archive:${match.id}`);
      expect(archiveTtl).toBeGreaterThan(SEVEN_DAYS - 60);
      expect(archiveTtl).toBeLessThanOrEqual(SEVEN_DAYS);

      const [roomTtl] = (await redis.call(
        "HTTL",
        `chat_${ChatLobbyType.Match}_${match.id}`,
        "FIELDS",
        1,
        id,
      )) as number[];
      expect(roomTtl).toBeGreaterThan(60 * 60 - 60);
      expect(roomTtl).toBeLessThanOrEqual(60 * 60);
    });

    it("keeps an edited line's earlier text", async () => {
      const id = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        "typo",
        "web",
      );

      await expect(
        chat.editMessage(
          ChatLobbyType.Match,
          match.id,
          id,
          as(organizer),
          "fixed",
        ),
      ).resolves.toMatchObject({ edited: true });

      expect(await entry(id)).toMatchObject({
        message: "fixed",
        edits: [{ message: "typo" }],
      });
      expect(typeof (await entry(id)).edited_at).toBe("string");
    });

    it("rate limits edits the way it limits sends", async () => {
      const id = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        "typo",
        "web",
      );

      const results = [];
      for (
        let attempt = 0;
        attempt < ChatService.MESSAGE_RATE_LIMIT + 1;
        attempt++
      ) {
        results.push(await edit(id, `fix ${attempt}`));
      }

      expect(results.at(-1)).toEqual({
        edited: false,
        code: ChatErrorCode.RateLimited,
      });
      expect(results.slice(0, -1).every(({ edited }) => edited)).toBe(true);
    });

    it("keeps the original text and the last four edits, no more", async () => {
      const id = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        "original",
        "web",
      );

      for (let attempt = 1; attempt <= 7; attempt++) {
        await redis.del(`chat:edit-rate:${organizer}`);
        await edit(id, `edit ${attempt}`);
      }

      const { message, edits } = await entry(id);

      expect(message).toBe("edit 7");
      expect(edits.map((each: { message: string }) => each.message)).toEqual([
        "original",
        "edit 3",
        "edit 4",
        "edit 5",
        "edit 6",
      ]);
    });

    it("keeps an entry under its size cap however long the edits", async () => {
      const long = (letter: string) => letter.repeat(2000);
      const id = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        long("原"),
        "web",
      );

      for (const letter of ["一", "二", "三", "四", "五"]) {
        await redis.del(`chat:edit-rate:${organizer}`);
        await edit(id, long(letter));
      }

      const raw = await redis.hget(`chat:archive:${match.id}`, id);
      const { message, edits } = JSON.parse(raw!);

      expect(Buffer.byteLength(raw!)).toBeLessThanOrEqual(
        ChatService.MATCH_CHAT_ARCHIVE_MAX_ENTRY_BYTES,
      );
      expect(message).toBe(long("五"));
      expect(edits[0].message).toBe(long("原"));
    });

    it("never loses a moderator's delete to an edit landing at the same time", async () => {
      const id = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        "typo",
        "web",
      );

      const remove = () =>
        chat.deleteMessage(ChatLobbyType.Match, match.id, id, as(admin));

      let deletedDuring = false;
      const read = redis.hget.bind(redis);
      jest.spyOn(redis, "hget").mockImplementation((async (
        key: string,
        field: string,
      ) => {
        const value = await read(key, field);
        if (key.startsWith("chat:archive:") && !deletedDuring) {
          deletedDuring = true;
          await remove();
        }
        return value;
      }) as any);

      await edit(id, "fixed");

      if (!deletedDuring) {
        jest.restoreAllMocks();
        await remove();
      }

      expect(await entry(id)).toMatchObject({ message: "fixed" });
      expect(typeof (await entry(id)).deleted_at).toBe("string");
    });

    it("keeps a deleted line, marked", async () => {
      const id = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        "something nasty",
        "web",
      );

      await expect(
        chat.deleteMessage(ChatLobbyType.Match, match.id, id, as(organizer)),
      ).resolves.toEqual({ deleted: true });

      expect(
        await redis.hget(`chat_${ChatLobbyType.Match}_${match.id}`, id),
      ).toBeNull();
      expect(await entry(id)).toMatchObject({
        message: "something nasty",
        deleted_by: { steam_id: organizer, name: "Organizer" },
      });
      expect(typeof (await entry(id)).deleted_at).toBe("string");
    });
  });

  describe("reading", () => {
    let all: string;
    let l1: string;
    let l2: string;

    beforeEach(async () => {
      all = await say(ChatLobbyType.Match, match.id, opponent, "gl");
      l1 = await say(
        ChatLobbyType.MatchTeam,
        teamRoom(match.lineup_1_id),
        player,
        "default",
      );
      l2 = await say(
        ChatLobbyType.MatchTeam,
        teamRoom(match.lineup_2_id),
        opponent,
        "rush B",
      );
    });

    it.each(["Finished", "Tie", "Canceled", "Forfeit", "Surrendered"])(
      "gives staff who took no part every room once the match is %s",
      async (ended) => {
        await status(ended);

        const read = await log(admin, "administrator");

        expect(ids(read!.match)).toEqual([all]);
        expect(
          read!.teams.map(({ lineup_id, messages }) => [
            lineup_id,
            ids(messages),
          ]),
        ).toEqual([
          [match.lineup_1_id, [l1]],
          [match.lineup_2_id, [l2]],
        ]);
        expect(read!.team_chat_withheld).toBe(false);
      },
    );

    it("is closed while the match is being played", async () => {
      expect(await log(admin, "administrator")).toBeNull();
    });

    it("opens at match organizer for someone who took no part", async () => {
      const staff = await fx.player("Staff");
      await setRole(staff, "match_organizer");
      await status("Finished");

      const read = await log(staff, "match_organizer");

      expect(read!.teams).toHaveLength(2);
      expect(read!.team_chat_withheld).toBe(false);
    });

    it("is closed to a moderator, the role just below", async () => {
      const staff = await fx.player("Staff");
      await setRole(staff, "moderator");
      await status("Finished");

      expect(await log(staff, "moderator")).toBeNull();
    });

    it("is closed to a match organizer demoted to moderator", async () => {
      const staff = await fx.player("Staff");
      await setRole(staff, "moderator");
      await status("Finished");

      expect(await log(staff, "match_organizer")).toBeNull();
    });

    it("is closed below match organizer, organizer of the match or not", async () => {
      await postgres.query(
        "UPDATE matches SET organizer_steam_id = $2 WHERE id = $1",
        [match.id, player],
      );
      await status("Finished");

      expect(await log(player, "user")).toBeNull();
    });

    it("goes by the role held now, not the one the session was signed in with", async () => {
      await status("Finished");
      await setRole(admin, "user");

      expect(await log(admin, "administrator")).toBeNull();
    });

    it("gives someone on a lineup all chat only", async () => {
      await status("Finished");

      const read = await log(organizer, "match_organizer");

      expect(ids(read!.match)).toEqual([all]);
      expect(read!.teams).toEqual([]);
      expect(read!.team_chat_withheld).toBe(true);
    });

    it("gives a coach all chat only", async () => {
      await status("Finished");

      expect((await log(coach, "match_organizer"))!.teams).toEqual([]);
    });

    it("gives someone who wrote in a team room all chat only, even off the lineup now", async () => {
      await say(
        ChatLobbyType.MatchTeam,
        teamRoom(match.lineup_1_id),
        organizer,
        "smoke mid",
      );
      await postgres.query(
        "DELETE FROM match_lineup_players WHERE steam_id = $1",
        [organizer],
      );
      await status("Finished");

      const read = await log(organizer, "match_organizer");

      expect(read!.teams).toEqual([]);
      expect(read!.team_chat_withheld).toBe(true);
    });

    it("shows deleted and edited lines with what happened to them", async () => {
      const typo = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        "typo",
        "web",
      );
      const nasty = await say(
        ChatLobbyType.Match,
        match.id,
        organizer,
        "nasty",
        "web",
      );
      await chat.editMessage(
        ChatLobbyType.Match,
        match.id,
        typo,
        as(organizer),
        "fixed",
      );
      await chat.deleteMessage(
        ChatLobbyType.Match,
        match.id,
        nasty,
        as(organizer),
      );
      await status("Finished");

      const read = await log(admin, "administrator");
      const line = (id: string) => read!.match.find((each) => each.id === id);

      expect(line(typo)).toMatchObject({ message: "fixed" });
      expect(typeof line(typo)!.edited_at).toBe("string");
      expect(line(nasty)).toMatchObject({ message: "nasty" });
      expect(typeof line(nasty)!.deleted_at).toBe("string");
    });

    it("says when the archive goes", async () => {
      await status("Finished");

      const read = await log(admin, "administrator");
      const left = new Date(read!.expires_at!).getTime() - Date.now();

      expect(left).toBeGreaterThan((SEVEN_DAYS - 60) * 1000);
      expect(left).toBeLessThanOrEqual(SEVEN_DAYS * 1000);
    });

    it("still has every line after the live rooms have expired", async () => {
      await redis.del(
        `chat_${ChatLobbyType.Match}_${match.id}`,
        `chat_${ChatLobbyType.MatchTeam}_${teamRoom(match.lineup_1_id)}`,
        `chat_${ChatLobbyType.MatchTeam}_${teamRoom(match.lineup_2_id)}`,
      );
      await status("Finished");

      const read = await log(admin, "administrator");

      expect(ids(read!.match)).toEqual([all]);
      expect(read!.teams.flatMap(({ messages }) => ids(messages))).toEqual([
        l1,
        l2,
      ]);
    });
  });

  describe("the websocket", () => {
    const join = async (type: string, id: string, steamId: string) => {
      const socket = {
        id: `client-${steamId}-${type}`,
        user: as(steamId),
        send: jest.fn(),
        on: jest.fn(),
      };

      await chat.joinMatchLobby(socket as any, type as any, id);

      return socket.send.mock.calls
        .map(([payload]: [string]) => JSON.parse(payload))
        .filter(({ event }) => event.endsWith(":messages"))
        .flatMap(({ data }) => data.messages);
    };

    it("never hands out an archived line once its live room has gone", async () => {
      await setRole(admin, "administrator");
      const all = await say(ChatLobbyType.Match, match.id, opponent, "gl");
      const team = await say(
        ChatLobbyType.MatchTeam,
        teamRoom(match.lineup_2_id),
        opponent,
        "rush B",
      );
      await redis.del(
        `chat_${ChatLobbyType.Match}_${match.id}`,
        `chat_${ChatLobbyType.MatchTeam}_${teamRoom(match.lineup_2_id)}`,
      );

      expect(ids(await archive())).toEqual(expect.arrayContaining([all, team]));

      const served = [
        ...(await join(ChatLobbyType.Match, match.id, organizer)),
        ...(await join(ChatLobbyType.Match, match.id, admin)),
        ...(await join(
          ChatLobbyType.MatchTeam,
          teamRoom(match.lineup_2_id),
          opponent,
        )),
        ...(await join("archive", match.id, admin)),
      ];

      expect(ids(served)).not.toContain(all);
      expect(ids(served)).not.toContain(team);
    });
  });
});
