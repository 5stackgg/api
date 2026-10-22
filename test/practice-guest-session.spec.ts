import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  HasuraPermissions,
  PermissionSession,
} from "./utils/hasura-permissions";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The web finds "my practice session" -- the one a reload has to pick back up,
// and the one the top bar follows -- with a filter on utility_practice_sessions.
// It used to reach a guest through session.match.lineup_1.lineup_players, but
// Hasura applies each related table's own select permission inside a
// relationship filter, and every role's matches filter hides practice matches.
// is_member reads the roster directly, so it finds the guest.
describe("a practice guest finding their own session (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let permissions: HasuraPermissions;
  let poolId: string;

  const STATUSES = ["Starting", "Ready"];

  beforeAll(async () => {
    db = await bootMigratedDb("PracticeGuestSessionTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199740000000n);
    await fx.region();
    poolId = (await fx.mapPool(1)).poolId;
    permissions = new HasuraPermissions(postgres);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function practice(source = "practice"): Promise<{
    host: string;
    guest: string;
    sessionId: string;
    matchId: string;
  }> {
    const host = await fx.player();
    const guest = await fx.player();
    const match = await fx.match({ bestOf: 1, mapPoolId: poolId });
    await postgres.query(
      `UPDATE matches
          SET status = 'Live', source = $2, organizer_steam_id = $3::bigint
        WHERE id = $1::uuid`,
      [match.id, source, host],
    );
    await fx.lineupPlayer(match.lineup_1_id, host);
    await fx.lineupPlayer(match.lineup_1_id, guest);
    const [session] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_practice_sessions
         (host_steam_id, map_name, region, status, match_id)
       VALUES ($1::bigint, 'de_mirage', 'TestA', 'Ready', $2::uuid)
       RETURNING id::text AS id`,
      [host, match.id],
    );
    return { host, guest, sessionId: session.id, matchId: match.id };
  }

  const as = (steamId: string): PermissionSession => ({
    role: "user",
    userId: steamId,
  });

  async function foundByMembership(steamId: string): Promise<Array<string>> {
    const params: Array<unknown> = [];
    const sql = await permissions.select(
      "utility_practice_sessions",
      "s",
      as(steamId),
      {
        fields: ["id"],
        where: {
          _or: [
            { host_steam_id: { _eq: steamId } },
            { is_member: { _eq: true } },
          ],
          status: { _in: STATUSES },
        },
      },
      params,
    );
    const rows = await postgres.query<Array<{ id: string }>>(
      sql,
      params as Array<string>,
    );
    return rows.map(({ id }) => id);
  }

  // The old filter, compiled the way the engine runs it: each table the
  // relationship walks through brings its own select permission for the role.
  // The helper's relationship compile adds only the caller's filter, so the
  // related tables' permissions are ANDed on by hand.
  async function foundThroughMatch(
    steamId: string,
    { withMatchPermission = true } = {},
  ): Promise<Array<string>> {
    const params: Array<unknown> = [steamId, STATUSES];
    const session = as(steamId);
    const sessions = await permissions.where(
      "utility_practice_sessions",
      "select",
      "s",
      session,
      params,
    );
    const matches = withMatchPermission
      ? await permissions.where("matches", "select", "m", session, params)
      : "true";
    const lineups = await permissions.where(
      "match_lineups",
      "select",
      "l",
      session,
      params,
    );
    const players = await permissions.where(
      "match_lineup_players",
      "select",
      "p",
      session,
      params,
    );
    const rows = await postgres.query<Array<{ id: string }>>(
      `SELECT s.id::text AS id
         FROM utility_practice_sessions s
        WHERE ${sessions}
          AND s.status::text = ANY ($2::text[])
          AND (
            s.host_steam_id = $1::bigint
            OR EXISTS (
              SELECT 1 FROM matches m
               WHERE m.id = s.match_id
                 AND ${matches}
                 AND EXISTS (
                   SELECT 1 FROM match_lineups l
                    WHERE l.id = m.lineup_1_id
                      AND ${lineups}
                      AND EXISTS (
                        SELECT 1 FROM match_lineup_players p
                         WHERE p.match_lineup_id = l.id
                           AND ${players}
                           AND p.steam_id = $1::bigint
                      )
                 )
            )
          )`,
      params as Array<string>,
    );
    return rows.map(({ id }) => id);
  }

  it("finds a guest by is_member, which the match relationship never does", async () => {
    const { guest, sessionId } = await practice();

    expect(await foundByMembership(guest)).toEqual([sessionId]);
    expect(await foundThroughMatch(guest)).toEqual([]);
  });

  it("loses the guest to the matches filter alone", async () => {
    const { guest, sessionId, matchId } = await practice();

    expect(
      await foundThroughMatch(guest, { withMatchPermission: false }),
    ).toEqual([sessionId]);

    const params: Array<unknown> = [matchId];
    const filter = await permissions.where(
      "matches",
      "select",
      "m",
      as(guest),
      params,
    );
    const visible = await postgres.query<Array<{ id: string }>>(
      `SELECT m.id FROM matches m WHERE m.id = $1::uuid AND ${filter}`,
      params as Array<string>,
    );
    expect(visible).toEqual([]);

    const { guest: otherGuest, sessionId: otherSession } =
      await practice("5stack");
    expect(await foundThroughMatch(otherGuest)).toEqual([otherSession]);
  });

  it("still finds the host either way", async () => {
    const { host, sessionId } = await practice();

    expect(await foundByMembership(host)).toEqual([sessionId]);
    expect(await foundThroughMatch(host)).toEqual([sessionId]);
  });

  it("does not find a session for someone who is not on it", async () => {
    await practice();
    const stranger = await fx.player();

    expect(await foundByMembership(stranger)).toEqual([]);
  });

  it("stops finding the guest once they leave the roster", async () => {
    const { guest, matchId } = await practice();
    await postgres.query(
      `DELETE FROM match_lineup_players
        WHERE steam_id = $1::bigint
          AND match_lineup_id = (SELECT lineup_1_id FROM matches WHERE id = $2::uuid)`,
      [guest, matchId],
    );

    expect(await foundByMembership(guest)).toEqual([]);
  });

  it("only offers sessions that are starting or ready", async () => {
    const { guest, sessionId } = await practice();
    await postgres.query(
      "UPDATE utility_practice_sessions SET status = 'Ended' WHERE id = $1::uuid",
      [sessionId],
    );

    expect(await foundByMembership(guest)).toEqual([]);
  });
});
