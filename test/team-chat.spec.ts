import { randomUUID } from "crypto";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
import { PlayerBlocksService } from "./../src/player-blocks/player-blocks.service";
import { ChatErrorCode } from "./../src/chat/enums/ChatErrorCode";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";
import { PushNotificationsService } from "./../src/notifications/push/push-notifications.service";

jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));

// A team's permanent room, driven against the real roster triggers, blocks and
// push gate. Who reads it is the roster and the owner, and nobody else: site
// staff get no way in, so nothing they can read may carry it either.
describe("team chat (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let chat: ChatService;
  let push: PushNotificationsService;
  let attachments: Record<string, jest.Mock>;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const hasura = {
    query: jest.fn(async (query: any) => {
      if (query.players_by_pk) {
        const [player] = await postgres.query<Array<Record<string, string>>>(
          `SELECT steam_id::text AS steam_id, name, role::text AS role,
                  avatar_url, profile_url
             FROM players WHERE steam_id = $1::bigint`,
          [String(query.players_by_pk.__args.steam_id)],
        );
        return { players_by_pk: player ?? null };
      }

      if (query.players) {
        const players = await postgres.query<Array<Record<string, string>>>(
          `SELECT steam_id::text AS steam_id, name, avatar_url
             FROM players WHERE steam_id = ANY($1::bigint[])`,
          [query.players.__args.where.steam_id._in.map(String)],
        );
        return { players };
      }

      if (query.teams_by_pk) {
        const [team] = await postgres.query<Array<{ name: string }>>(
          `SELECT name FROM teams WHERE id = $1::uuid`,
          [query.teams_by_pk.__args.id],
        );
        return { teams_by_pk: team ?? null };
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

    db = await bootMigratedDb("TeamChatTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196400000000n);

    push = new PushNotificationsService(
      logger as any,
      postgres,
      {
        get: (key: string) =>
          key === "app"
            ? { webDomain: "https://example.com" }
            : {
                publicKey: "public-key",
                privateKey: "private-key",
                subject: "https://example.com",
              },
      } as any,
      { add: async () => ({}) } as any,
      { getConnection: () => redis } as any,
    );
    await push.loadKeys();

    attachments = {
      claim: jest.fn(),
      expireMessage: jest.fn(async () => {}),
      markDeleted: jest.fn(async () => {}),
      moveRoom: jest.fn(async () => {}),
    };

    chat = new ChatService(
      logger as any,
      {} as any,
      hasura as any,
      postgres,
      { getConnection: () => redis } as any,
      push,
      new PlayerBlocksService(postgres),
      attachments as any,
      { enabled: jest.fn(async () => false) } as any,
    );
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
    await db?.stop();
  });

  type Team = {
    id: string;
    owner: string;
    starter: string;
    substitute: string;
    benched: string;
    invitee: string;
    stranger: string;
    moderator: string;
    administrator: string;
  };

  let team: Team;

  const asAdmin = <T>(
    fn: (query: (sql: string, params?: unknown[]) => Promise<unknown>) => T,
  ) => runAsUser(postgres, team.owner, "admin", async (query) => fn(query));

  const addToRoster = (steamId: string, status = "Starter") =>
    asAdmin((query) =>
      query(
        `INSERT INTO team_roster (team_id, player_steam_id, status)
         VALUES ($1, $2, $3)`,
        [team.id, steamId, status],
      ),
    );

  const removeFromRoster = (steamId: string) =>
    asAdmin((query) =>
      query(
        `DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2`,
        [team.id, steamId],
      ),
    );

  const makeTeamAdmin = (steamId: string) =>
    asAdmin((query) =>
      query(
        `UPDATE team_roster SET role = 'Admin'
          WHERE team_id = $1 AND player_steam_id = $2`,
        [team.id, steamId],
      ),
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    await redis.flushall();
    await postgres.query("DELETE FROM chat_message_deletions");
    await postgres.query("DELETE FROM chat_message_edits");
    await postgres.query("DELETE FROM chat_read_state");
    await postgres.query("DELETE FROM player_blocks");
    await postgres.query("DELETE FROM team_invites");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");

    const { id, owner } = await fx.team();
    team = {
      id,
      owner,
      starter: await fx.player("Starter"),
      substitute: await fx.player("Substitute"),
      benched: await fx.player("Benched"),
      invitee: await fx.player("Invitee"),
      stranger: await fx.player("Stranger"),
      moderator: await fx.player("Moderator", "moderator"),
      administrator: await fx.player("Administrator", "administrator"),
    };

    await addToRoster(team.starter, "Starter");
    await addToRoster(team.substitute, "Substitute");
    await addToRoster(team.benched, "Benched");
    await postgres.query(
      `INSERT INTO team_invites (team_id, steam_id, invited_by_player_steam_id)
       VALUES ($1, $2, $3)`,
      [team.id, team.invitee, team.owner],
    );
  });

  const user = async (steamId: string) => {
    const [row] = await postgres.query<
      Array<{ steam_id: string; name: string; role: string }>
    >(
      `SELECT steam_id::text AS steam_id, name, role::text AS role
         FROM players WHERE steam_id = $1::bigint`,
      [steamId],
    );
    return row as any;
  };

  const client = (steamId: string) => ({
    id: `client-${steamId}-${randomUUID()}`,
    user: { steam_id: steamId },
    send: jest.fn(),
    on: jest.fn(),
  });

  const historyOf = (socket: ReturnType<typeof client>) =>
    socket.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find(({ event }) => event === `lobby:team:${team.id}:messages`)?.data
      ?.messages as Array<{ id: string; message: string }> | undefined;

  const join = async (steamId: string) => {
    const socket = client(steamId);
    await chat.joinMatchLobby(socket as any, ChatLobbyType.Team, team.id);
    return socket;
  };

  const say = async (steamId: string, text: string, mentions?: string[]) =>
    chat.sendMessageToChat(
      ChatLobbyType.Team,
      team.id,
      await user(steamId),
      text,
      false,
      "web",
      undefined,
      mentions,
    );

  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !check(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  describe("who reads it", () => {
    it("admits the roster and the owner, and nobody else", async () => {
      const admitted: string[] = [];

      for (const steamId of [
        team.owner,
        team.starter,
        team.substitute,
        team.benched,
        team.invitee,
        team.stranger,
        team.moderator,
        team.administrator,
      ]) {
        if (historyOf(await join(steamId))) {
          admitted.push(steamId);
        }
      }

      expect(admitted.sort()).toEqual(
        [team.owner, team.starter, team.substitute, team.benched].sort(),
      );
    });

    it("gives a staff role nothing: staff on the roster read as a member, staff off it do not", async () => {
      await addToRoster(team.moderator, "Benched");

      expect(historyOf(await join(team.moderator))).toEqual([]);
      expect(historyOf(await join(team.administrator))).toBeUndefined();
      await expect(
        chat.markThreadRead(
          ChatLobbyType.Team,
          team.id,
          await user(team.administrator),
        ),
      ).resolves.toBeNull();
    });

    it("lets an invite in once it is accepted, and shuts a removed member out at once", async () => {
      expect(historyOf(await join(team.invitee))).toBeUndefined();

      await addToRoster(team.invitee, "Benched");
      await postgres.query(`DELETE FROM team_invites WHERE steam_id = $1`, [
        team.invitee,
      ]);

      expect(historyOf(await join(team.invitee))).toEqual([]);
      await expect(say(team.invitee, "glad to be here")).resolves.toEqual({
        accepted: true,
        messageId: expect.any(String),
      });

      await join(team.starter);
      await removeFromRoster(team.invitee);

      await expect(say(team.invitee, "still here?")).resolves.toEqual({
        accepted: false,
        code: ChatErrorCode.NotAllowed,
      });
      await expect(
        chat.markThreadRead(
          ChatLobbyType.Team,
          team.id,
          await user(team.invitee),
        ),
      ).resolves.toBeNull();
    });

    it("stops live delivery to a member removed while their room is open", async () => {
      await join(team.starter);
      await join(team.substitute);
      await removeFromRoster(team.substitute);

      const publish = jest.spyOn(redis, "publish");

      await say(team.starter, "strat talk");
      await until(() => publish.mock.calls.length > 0);

      const reached = publish.mock.calls
        .map(([, raw]) => JSON.parse(String(raw)))
        .filter(({ event }) => event === `lobby:team:${team.id}:chat`)
        .map(({ steamId }) => steamId);

      expect(reached).toEqual([team.starter]);
    });
  });

  describe("retention", () => {
    const ttlOf = async (messageId: string) =>
      (
        (await redis.call(
          "HTTL",
          `chat_team_${team.id}`,
          "FIELDS",
          1,
          messageId,
        )) as number[]
      )[0];

    it("keeps messages for 30 days by default, and follows the setting", async () => {
      expect(
        ChatService.TTL_SETTINGS.find(
          ({ type }) => type === ChatLobbyType.Team,
        ),
      ).toEqual({
        setting: "public.chat_ttl_team",
        type: ChatLobbyType.Team,
        fallback: 30 * 24 * 60 * 60,
      });

      await join(team.starter);

      const first = await say(team.starter, "scrim at 8");
      expect(first.accepted).toBe(true);
      expect(
        await ttlOf((first as { messageId: string }).messageId),
      ).toBeGreaterThan(30 * 24 * 60 * 60 - 60);

      chat.updateChatMessageTTL(ChatLobbyType.Team, 3600);

      const second = await say(team.starter, "make it 9");
      const ttl = await ttlOf((second as { messageId: string }).messageId);
      expect(ttl).toBeGreaterThan(3500);
      expect(ttl).toBeLessThanOrEqual(3600);

      chat.updateChatMessageTTL(ChatLobbyType.Team, 30 * 24 * 60 * 60);
    });
  });

  describe("deleting", () => {
    const posted = async (author: string, text = "a line") => {
      await join(author);
      await redis.del(`chat:message-rate:${author}`);
      const sent = await say(author, text);
      expect(sent.accepted).toBe(true);
      return (sent as { messageId: string }).messageId;
    };

    const remove = async (steamId: string, messageId: string) =>
      chat.deleteMessage(
        ChatLobbyType.Team,
        team.id,
        messageId,
        await user(steamId),
      );

    it("lets team admins and the owner remove anyone's message, and nobody else", async () => {
      await makeTeamAdmin(team.benched);
      await addToRoster(team.moderator, "Benched");

      for (const steamId of [
        team.substitute,
        team.moderator,
        team.administrator,
        team.stranger,
      ]) {
        const messageId = await posted(team.starter);
        await expect(remove(steamId, messageId)).resolves.toEqual({
          deleted: false,
          code: ChatErrorCode.NotAllowed,
        });
      }

      for (const steamId of [team.benched, team.owner]) {
        const messageId = await posted(team.starter);
        await expect(remove(steamId, messageId)).resolves.toEqual({
          deleted: true,
        });
        expect(await redis.hexists(`chat_team_${team.id}`, messageId)).toBe(0);
      }
    });

    it("lets a member remove their own message", async () => {
      const messageId = await posted(team.substitute);

      await expect(remove(team.substitute, messageId)).resolves.toEqual({
        deleted: true,
      });
    });

    it("leaves no evidence for staff: no deletion or edit audit, and the files go at once", async () => {
      const edited = await posted(team.starter, "first take");
      await expect(
        chat.editMessage(
          ChatLobbyType.Team,
          team.id,
          edited,
          await user(team.starter),
          "second take",
        ),
      ).resolves.toEqual(expect.objectContaining({ edited: true }));

      const removed = await posted(team.starter);
      await expect(remove(team.owner, removed)).resolves.toEqual({
        deleted: true,
      });

      const audits = await postgres.query<Array<{ count: string }>>(
        `SELECT (SELECT count(*) FROM chat_message_deletions)
              + (SELECT count(*) FROM chat_message_edits) AS count`,
      );
      expect(Number(audits[0].count)).toBe(0);
      expect(attachments.markDeleted).not.toHaveBeenCalled();
      expect(attachments.expireMessage).toHaveBeenCalledWith(
        ChatLobbyType.Team,
        team.id,
        removed,
      );
    });
  });

  describe("staff paths", () => {
    it("never copies team chat into the match chat archive staff review", async () => {
      await join(team.starter);
      await expect(say(team.starter, "our side only")).resolves.toEqual(
        expect.objectContaining({ accepted: true }),
      );

      expect(await redis.keys("chat:archive:*")).toEqual([]);
    });

    it("hides a blocked teammate from a moderator on the roster, as from anyone", async () => {
      await addToRoster(team.moderator, "Benched");
      await postgres.query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
         VALUES ($1, $2)`,
        [team.moderator, team.starter],
      );

      await join(team.starter);
      await say(team.starter, "you blocked me");
      await join(team.substitute);
      await say(team.substitute, "still visible");

      expect(
        historyOf(await join(team.moderator))?.map(({ message }) => message),
      ).toEqual(["still visible"]);
    });
  });

  describe("pushes and tags", () => {
    let sent: jest.SpyInstance;

    beforeEach(() => {
      sent = jest.spyOn(push, "sendChatMessage").mockResolvedValue(undefined);
    });

    const calls = () =>
      sent.mock.calls.map(([recipients, payload]) => ({
        recipients: [...recipients].sort(),
        payload,
      }));

    it("pushes a message to the rest of the team only, as chat", async () => {
      await join(team.starter);
      await say(team.starter, "scrim at 8");
      await until(() => sent.mock.calls.length > 0);

      expect(calls()).toEqual([
        {
          recipients: [team.owner, team.substitute, team.benched].sort(),
          payload: expect.objectContaining({
            type: "ChatMessage",
            entityId: `team:${team.id}`,
            threadKey: `chat:team:${team.id}`,
            threadLabel: expect.stringMatching(/^team/),
            blockExemptRoles: [],
          }),
        },
      ]);
    });

    it("lists the team as who can be tagged, and nothing to staff off it", async () => {
      const members = await chat.mentionCandidates(
        ChatLobbyType.Team,
        team.id,
        await user(team.starter),
      );

      expect(members?.map(({ steam_id }) => steam_id).sort()).toEqual(
        [team.owner, team.substitute, team.benched].sort(),
      );

      for (const steamId of [
        team.moderator,
        team.administrator,
        team.invitee,
      ]) {
        await expect(
          chat.mentionCandidates(
            ChatLobbyType.Team,
            team.id,
            await user(steamId),
          ),
        ).resolves.toBeNull();
      }
    });

    it("tags a teammate, but neither someone off the team nor someone who blocked the sender", async () => {
      await postgres.query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
         VALUES ($1, $2)`,
        [team.benched, team.starter],
      );

      await join(team.starter);
      const result = await say(
        team.starter,
        "@Substitute @Benched @Moderator ready?",
        [team.substitute, team.benched, team.moderator],
      );
      expect(result.accepted).toBe(true);
      await until(() => sent.mock.calls.length >= 2);

      const stored = JSON.parse(
        (await redis.hget(
          `chat_team_${team.id}`,
          (result as { messageId: string }).messageId,
        )) as string,
      );
      expect(
        stored.mentions.map(({ steam_id }: { steam_id: string }) => steam_id),
      ).toEqual([team.substitute, team.benched]);

      const tagged = calls().filter(({ payload }) => payload.mention);
      const plain = calls().filter(({ payload }) => !payload.mention);

      expect(tagged).toEqual([
        { recipients: [team.substitute], payload: expect.anything() },
      ]);
      expect(plain).toEqual([
        { recipients: [team.owner], payload: expect.anything() },
      ]);
    });

    it("says 'mentioned you' once per sender in the cooldown, then pushes the room as usual", async () => {
      await join(team.starter);
      await say(team.starter, "@Substitute one", [team.substitute]);
      await until(() => sent.mock.calls.length >= 2);
      await say(team.starter, "@Substitute two", [team.substitute]);
      await until(() => sent.mock.calls.length >= 3);

      const toSubstitute = calls()
        .filter(({ recipients }) => recipients.includes(team.substitute))
        .map(({ payload }) => !!payload.mention);

      expect(toSubstitute).toEqual([true, false]);
    });
  });
});
