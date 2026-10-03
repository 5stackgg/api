import { readFileSync } from "fs";
import { join } from "path";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
import { PlayerBlocksService } from "./../src/player-blocks/player-blocks.service";
import { ChatErrorCode } from "./../src/chat/enums/ChatErrorCode";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";

const REGION = "TestChatWindow";

// Who belongs in the room is chat.service.spec's subject; this is about when a
// finished tournament's room closes, which the database decides.
describe("finished tournament chat (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let chat: ChatService;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const hasura = {
    query: jest.fn(async (query: any) => {
      if (query.players_by_pk) {
        const [player] = await postgres.query<
          Array<{ steam_id: string; name: string; role: string }>
        >(
          `SELECT steam_id::text AS steam_id, name, role::text AS role
             FROM players WHERE steam_id = $1::bigint`,
          [query.players_by_pk.__args.steam_id],
        );
        return { players_by_pk: player ?? null };
      }

      if (query.tournaments) {
        return { tournaments: [{ id: query.tournaments.__args.where.id._eq }] };
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

    db = await bootMigratedDb("TournamentChatWindowTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199620000000n);
    await fx.region(REGION);

    chat = new ChatService(
      logger as any,
      {} as any,
      hasura as any,
      postgres,
      { getConnection: () => redis } as any,
      { sendChatMessage: jest.fn(async () => {}) } as any,
      new PlayerBlocksService(postgres),
      {
        claim: jest.fn(),
        expireMessage: jest.fn(async () => {}),
        markDeleted: jest.fn(async () => {}),
        moveRoom: jest.fn(async () => {}),
      } as any,
      { enabled: jest.fn(async () => false) } as any,
    );
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
    await db?.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await redis.flushall();
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");
  });

  const liveTournament = async (status = "Live") => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       SELECT 8, 1, 'Wingman', id, false, true, $1
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      [`{${REGION}}`],
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now() - interval '1 day', $2, $3, $4) RETURNING id`,
      [fx.nextName("cup"), organizer, options.id, status],
    );
    return { id: tournament.id, organizer };
  };

  const finish = async (id: string, organizer: string) =>
    runAsUser(postgres, organizer, "administrator", (query) =>
      query("UPDATE tournaments SET status = 'Finished' WHERE id = $1", [id]),
    );

  const finishedAt = async (id: string) =>
    (
      await postgres.query<Array<{ finished_at: Date | null }>>(
        "SELECT finished_at FROM tournaments WHERE id = $1",
        [id],
      )
    )[0].finished_at;

  const age = (id: string, interval: string) =>
    postgres.query(
      `UPDATE tournaments SET finished_at = now() - $2::interval WHERE id = $1`,
      [id, interval],
    );

  const member = async () => {
    const steamId = await fx.player("Member");
    return { steam_id: steamId, name: "Member", role: "user" } as any;
  };

  const client = (user: any) =>
    ({
      id: `client-${user.steam_id}`,
      user,
      send: jest.fn(),
      on: jest.fn(),
    }) as any;

  const joins = async (tournamentId: string, user: any) => {
    const socket = client(user);
    await chat.joinMatchLobby(socket, ChatLobbyType.Tournament, tournamentId);
    return socket.send.mock.calls.some(([payload]: [string]) =>
      JSON.parse(payload).event.endsWith(":messages"),
    );
  };

  const sends = (tournamentId: string, user: any) =>
    chat.sendMessageToChat(
      ChatLobbyType.Tournament,
      tournamentId,
      user,
      "gg everyone",
    );

  describe("finished_at", () => {
    it("is stamped the moment the tournament finishes", async () => {
      const { id, organizer } = await liveTournament();

      expect(await finishedAt(id)).toBeNull();

      const before = Date.now();
      await finish(id, organizer);

      const stamped = await finishedAt(id);
      expect(stamped).not.toBeNull();
      expect(stamped!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
      expect(stamped!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    });

    it("is left alone by an update that does not change the status", async () => {
      const { id, organizer } = await liveTournament();
      await finish(id, organizer);
      await age(id, "2 days");
      const stamped = await finishedAt(id);

      await postgres.query(
        "UPDATE tournaments SET description = 'recap' WHERE id = $1",
        [id],
      );

      expect(await finishedAt(id)).toEqual(stamped);
    });

    it("is filled in from the last match for a tournament finished before it existed", async () => {
      const { id, organizer } = await liveTournament("Setup");
      const [stage] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
         VALUES ($1, 'SingleElimination', 1, 4, 8) RETURNING id`,
        [id],
      );
      for (const endedAt of ["2026-09-20T18:00:00Z", "2026-09-21T20:30:00Z"]) {
        const { matchId } = await fx.bareMatch(endedAt);
        await postgres.query(
          `INSERT INTO tournament_brackets (tournament_stage_id, match_id, round)
           VALUES ($1, $2, 1)`,
          [stage.id, matchId],
        );
      }
      await finish(id, organizer);
      await postgres.query(
        "UPDATE tournaments SET finished_at = NULL WHERE id = $1",
        [id],
      );

      await postgres.query(
        readFileSync(
          join(
            __dirname,
            "../hasura/migrations/default/1890000000310_tournament_chat_seven_days/up.sql",
          ),
          "utf8",
        ),
      );

      expect(await finishedAt(id)).toEqual(new Date("2026-09-21T20:30:00Z"));
    });

    it("is cleared when the tournament is no longer finished", async () => {
      const { id, organizer } = await liveTournament();
      await finish(id, organizer);

      await runAsUser(postgres, organizer, "administrator", (query) =>
        query("UPDATE tournaments SET status = 'Live' WHERE id = $1", [id]),
      );

      expect(await finishedAt(id)).toBeNull();
    });
  });

  describe("the room", () => {
    it("stays open and writable for seven days after it finishes", async () => {
      const { id, organizer } = await liveTournament();
      const user = await member();
      await finish(id, organizer);
      await age(id, "6 days 23 hours");

      expect(await joins(id, user)).toBe(true);
      expect(await sends(id, user)).toMatchObject({ accepted: true });
    });

    it("closes once the seven days are up", async () => {
      const { id, organizer } = await liveTournament();
      const user = await member();
      await finish(id, organizer);

      expect(await joins(id, user)).toBe(true);

      await age(id, "7 days 1 minute");

      expect(await sends(id, user)).toEqual({
        accepted: false,
        code: ChatErrorCode.NotAllowed,
      });
      expect(await joins(id, user)).toBe(false);
    });

    it("is closed for a tournament that finished before it was stamped", async () => {
      const { id, organizer } = await liveTournament();
      const user = await member();
      await finish(id, organizer);
      await postgres.query(
        "UPDATE tournaments SET finished_at = NULL WHERE id = $1",
        [id],
      );

      expect(await joins(id, user)).toBe(false);
    });

    it("is open while the tournament is live", async () => {
      const { id } = await liveTournament();
      const user = await member();

      expect(await joins(id, user)).toBe(true);
      expect(await sends(id, user)).toMatchObject({ accepted: true });
    });
  });
});

describe("tournament chat retention default", () => {
  let db: SqlTestDb;

  const migration = join(
    __dirname,
    "../hasura/migrations/default/1890000000310_tournament_chat_seven_days",
  );
  const up = () => readFileSync(join(migration, "up.sql"), "utf8");
  const down = () => readFileSync(join(migration, "down.sql"), "utf8");

  const set = (value: string) =>
    db.postgres.query(
      `INSERT INTO settings (name, value) VALUES ('public.chat_ttl_tournament', $1)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      [value],
    );

  const value = async (name = "public.chat_ttl_tournament") =>
    (
      await db.postgres.query<Array<{ value: string }>>(
        "SELECT value FROM settings WHERE name = $1",
        [name],
      )
    )[0]?.value;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentChatRetentionTest");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("keeps tournament chat seven days on a fresh install", async () => {
    expect(await value()).toBe("604800");
    expect(await value("public.chat_ttl_organizers")).toBe("86400");
  });

  it("moves a stack still on the old one day seed", async () => {
    await set("86400");

    await db.postgres.query(up());

    expect(await value()).toBe("604800");
  });

  it("leaves an operator's own value alone", async () => {
    await set("172800");

    await db.postgres.query(up());

    expect(await value()).toBe("172800");
  });

  it("rolls back to the one day seed", async () => {
    await set("604800");

    await db.postgres.query(down());

    expect(await value()).toBe("86400");
    await db.postgres.query(up());
  });
});
