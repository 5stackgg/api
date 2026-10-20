import { Logger } from "@nestjs/common";
import { readFileSync } from "fs";
import * as yaml from "js-yaml";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { RconService } from "./../src/rcon/rcon.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import { HasuraPermissions } from "./utils/hasura-permissions";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The practice panel's staff console drives RCON on the session's server, and
// the gateway drops a refused command without a reply. So the server id the
// panel reads must reach exactly the viewers canAccessServer lets in: anyone
// else would get a console that never answers.
describe("practice session console access (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let poolId: string;
  let rcon: RconService;
  let permissions: HasuraPermissions;
  let port = 30100;

  beforeAll(async () => {
    db = await bootMigratedDb("PracticeConsoleAccessTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199720000000n);
    await fx.region();
    poolId = (await fx.mapPool(1)).poolId;
    await postgres.query(
      "INSERT INTO game_server_nodes (id, region) VALUES ('console-node', 'TestA')",
    );
    rcon = new RconService(
      {} as never,
      {} as never,
      {} as never,
      new Logger("PracticeConsoleAccessTest"),
      {} as never,
      {} as never,
      {} as never,
      postgres,
    );
    permissions = new HasuraPermissions(postgres);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  type ServerKind = "standing" | "pod";

  async function server(kind: ServerKind, matchId?: string): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      kind === "standing"
        ? `INSERT INTO servers
             (host, label, rcon_password, port, enabled, connected, region, type,
              is_dedicated, reserved_by_match_id)
           VALUES ('127.0.0.1', $1, '\\x00'::bytea, $2, true, true, 'TestA',
                   'Practice', true, $3::uuid)
           RETURNING id::text AS id`
        : `INSERT INTO servers
             (host, label, rcon_password, port, enabled, connected, region, type,
              is_dedicated, reserved_by_match_id, game_server_node_id)
           VALUES ('127.0.0.1', $1, '\\x00'::bytea, $2, true, true, 'TestA',
                   'Ranked', false, $3::uuid, 'console-node')
           RETURNING id::text AS id`,
      [fx.nextName(`${kind}-`), ++port, matchId ?? null],
    );
    return row.id;
  }

  async function match(
    organizer: string,
    source: "practice" | "5stack",
  ): Promise<string> {
    const { id } = await fx.match({ bestOf: 1, mapPoolId: poolId });
    await postgres.query(
      `UPDATE matches
          SET status = 'Live', source = $2, organizer_steam_id = $3::bigint
        WHERE id = $1::uuid`,
      [id, source, organizer],
    );
    return id;
  }

  async function onServer(matchId: string, kind: ServerKind): Promise<string> {
    const serverId = await server(kind, matchId);
    await postgres.query(
      "UPDATE matches SET server_id = $2::uuid WHERE id = $1::uuid",
      [matchId, serverId],
    );
    return serverId;
  }

  async function session(
    host: string,
    matchId: string | null,
  ): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_practice_sessions
         (host_steam_id, map_name, region, status, match_id)
       VALUES ($1::bigint, 'de_mirage', 'TestA', 'Ready', $2::uuid)
       RETURNING id::text AS id`,
      [host, matchId],
    );
    return row.id;
  }

  async function practiceOn(
    kind: ServerKind,
    hostRole = "moderator",
  ): Promise<{
    host: string;
    matchId: string;
    serverId: string;
    sessionId: string;
  }> {
    const host = await fx.player(undefined, hostRole);
    const matchId = await match(host, "practice");
    const serverId = await onServer(matchId, kind);
    return { host, matchId, serverId, sessionId: await session(host, matchId) };
  }

  const viewer = (role: string, steamId = fx.nextSteam()): User =>
    ({ steam_id: steamId, role, name: role }) as User;

  async function consoleServerId(
    sessionId: string,
    user: Pick<User, "role" | "steam_id"> | null,
  ): Promise<string | null> {
    const [row] = await postgres.query<Array<{ server_id: string | null }>>(
      `SELECT public.utility_practice_server_id(s, $2::json)::text AS server_id
         FROM utility_practice_sessions s
        WHERE s.id = $1::uuid`,
      [
        sessionId,
        JSON.stringify(
          user
            ? { "x-hasura-role": user.role, "x-hasura-user-id": user.steam_id }
            : {},
        ),
      ],
    );
    return row.server_id;
  }

  async function matchVisibleTo(
    matchId: string,
    role: string,
    steamId: string,
  ): Promise<boolean> {
    const params: Array<unknown> = [matchId];
    const where = await permissions.where(
      "matches",
      "select",
      "m",
      { role, userId: steamId },
      params,
    );
    const rows = await postgres.query<Array<{ id: string }>>(
      `SELECT m.id FROM matches m WHERE m.id = $1::uuid AND ${where}`,
      params as Array<string>,
    );
    return rows.length > 0;
  }

  describe("the session's server id", () => {
    it("reaches an administrator, which session.match never could", async () => {
      const { host, matchId, serverId, sessionId } = await practiceOn("pod");

      for (const role of ["user", "moderator"]) {
        expect([role, await matchVisibleTo(matchId, role, host)]).toEqual([
          role,
          false,
        ]);
      }

      expect(await consoleServerId(sessionId, viewer("administrator"))).toBe(
        serverId,
      );
      expect(await consoleServerId(sessionId, viewer("admin"))).toBe(serverId);
    });

    it("goes to exactly the viewers RCON lets in, on either kind of server", async () => {
      for (const kind of ["standing", "pod"] as const) {
        const moderatorHosted = await practiceOn(kind);
        const userHosted = await practiceOn(kind, "user");

        const cases: Array<[string, typeof moderatorHosted, User, boolean]> = [
          ["administrator", moderatorHosted, viewer("administrator"), true],
          [
            "tournament_organizer",
            moderatorHosted,
            viewer("tournament_organizer"),
            true,
          ],
          ["match_organizer", moderatorHosted, viewer("match_organizer"), true],
          [
            "moderator host",
            moderatorHosted,
            viewer("moderator", moderatorHosted.host),
            true,
          ],
          [
            "other moderator",
            moderatorHosted,
            viewer("moderator"),
            kind === "standing",
          ],
          ["streamer", moderatorHosted, viewer("streamer"), false],
          ["verified_user", moderatorHosted, viewer("verified_user"), false],
          ["user host", userHosted, viewer("user", userHosted.host), false],
        ];

        for (const [label, { serverId, sessionId }, user, allowed] of cases) {
          expect([
            kind,
            label,
            await rcon.canAccessServer(serverId, user),
          ]).toEqual([kind, label, allowed]);
          expect([kind, label, await consoleServerId(sessionId, user)]).toEqual(
            [kind, label, allowed ? serverId : null],
          );
        }
      }
    });

    it("is withdrawn from the host once the pod's match is over", async () => {
      const { host, matchId, serverId, sessionId } = await practiceOn("pod");
      await postgres.query(
        "UPDATE matches SET status = 'Canceled' WHERE id = $1::uuid",
        [matchId],
      );

      expect(
        await rcon.canAccessServer(serverId, viewer("moderator", host)),
      ).toBe(false);
      expect(
        await consoleServerId(sessionId, viewer("moderator", host)),
      ).toBeNull();
      expect(await consoleServerId(sessionId, viewer("administrator"))).toBe(
        serverId,
      );
    });

    it("is null for a session without a match, without a server, or whose match is gone", async () => {
      const admin = viewer("administrator");

      const matchless = await session(
        await fx.player(undefined, "moderator"),
        null,
      );
      expect(await consoleServerId(matchless, admin)).toBeNull();

      const host = await fx.player(undefined, "moderator");
      const serverless = await session(host, await match(host, "practice"));
      expect(await consoleServerId(serverless, admin)).toBeNull();

      const { matchId, sessionId } = await practiceOn("pod");
      expect(await consoleServerId(sessionId, null)).toBeNull();
      await postgres.query("DELETE FROM matches WHERE id = $1::uuid", [
        matchId,
      ]);
      expect(await consoleServerId(sessionId, admin)).toBeNull();
    });

    it("is selectable by every role that reads sessions, so the shared subscription holds", async () => {
      const table = yaml.load(
        readFileSync(
          join(
            process.cwd(),
            "hasura/metadata/databases/default/tables/public_utility_practice_sessions.yaml",
          ),
          "utf8",
        ),
      ) as {
        computed_fields: Array<{
          name: string;
          definition: {
            function: { name: string; schema: string };
            session_argument?: string;
          };
        }>;
        select_permissions: Array<{
          role: string;
          permission: { computed_fields?: Array<string> };
        }>;
      };

      expect(
        table.computed_fields.find(({ name }) => name === "server_id"),
      ).toEqual({
        name: "server_id",
        definition: {
          function: { name: "utility_practice_server_id", schema: "public" },
          session_argument: "hasura_session",
        },
      });
      expect(
        table.select_permissions.map(({ role, permission }) => [
          role,
          (permission.computed_fields ?? []).includes("server_id"),
        ]),
      ).toEqual([
        ["user", true],
        ["administrator", true],
      ]);

      const [fn] = await postgres.query<
        Array<{ volatility: string; result: string }>
      >(
        `SELECT p.provolatile::text AS volatility,
                pg_get_function_result(p.oid) AS result
           FROM pg_proc p
          WHERE p.oid = 'public.utility_practice_server_id(public.utility_practice_sessions, json)'::regprocedure`,
      );
      expect(fn).toEqual({ volatility: "s", result: "uuid" });
    });
  });

  describe("who may open RCON", () => {
    it("lets moderation roles onto a dedicated server and nobody below them", async () => {
      const [{ id }] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers
           (host, label, rcon_password, port, enabled, connected, region, type, is_dedicated)
         VALUES ('127.0.0.1', 'retakes', '\\x00'::bytea, $1, true, true, 'TestA', 'Retake', true)
         RETURNING id::text AS id`,
        [++port],
      );

      for (const [role, allowed] of [
        ["administrator", true],
        ["tournament_organizer", true],
        ["match_organizer", true],
        ["moderator", true],
        ["streamer", false],
        ["verified_user", false],
        ["user", false],
      ] as const) {
        expect([role, await rcon.canAccessServer(id, viewer(role))]).toEqual([
          role,
          allowed,
        ]);
      }
    });

    it("keeps a match server to its organizers while the match is live", async () => {
      const organizer = await fx.player(undefined, "moderator");
      const matchId = await match(organizer, "5stack");
      const serverId = await onServer(matchId, "pod");

      expect(
        await rcon.canAccessServer(serverId, viewer("moderator", organizer)),
      ).toBe(true);
      expect(await rcon.canAccessServer(serverId, viewer("moderator"))).toBe(
        false,
      );
      expect(
        await rcon.canAccessServer(serverId, viewer("match_organizer")),
      ).toBe(true);
      expect(
        await rcon.canAccessServer(serverId, viewer("user", organizer)),
      ).toBe(false);

      await postgres.query(
        "UPDATE matches SET status = 'Finished' WHERE id = $1::uuid",
        [matchId],
      );

      expect(
        await rcon.canAccessServer(serverId, viewer("moderator", organizer)),
      ).toBe(false);
      expect(
        await rcon.canAccessServer(serverId, viewer("administrator")),
      ).toBe(true);
    });

    it("refuses a server that does not exist, to an administrator too", async () => {
      for (const role of ["administrator", "moderator"]) {
        expect([
          role,
          await rcon.canAccessServer(
            "00000000-0000-0000-0000-000000000000",
            viewer(role),
          ),
        ]).toEqual([role, false]);
      }
    });
  });
});
