import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures, MatchRow } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// A match frees its server when it ends (tau_matches), while match_events only
// clears its server_id after the rest of its side effects, so by then the server
// can already be the next match's.
describe("server reservations (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("ServerReservationsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);

    await postgres.query(
      `INSERT INTO server_regions (value, description) VALUES ('Resv', 'Resv')
       ON CONFLICT (value) DO NOTHING`,
    );
    await postgres.query(
      `INSERT INTO game_server_nodes (id, public_ip, start_port_range, end_port_range, region, status, enabled, label)
       VALUES ('resv-node', '203.0.113.7', 30000, 30004, 'Resv', 'Online', true, 'resv-node')`,
    );
    await postgres.query(
      `INSERT INTO servers (host, label, rcon_password, port, region, type, is_dedicated, enabled)
       VALUES ('127.0.0.1', 'resv-dedicated', $1, 27015, 'Resv', 'Ranked', true, true)`,
      [Buffer.from("password")],
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("UPDATE servers SET reserved_by_match_id = NULL");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
  });

  const serverOf = async (dedicated: boolean) => {
    const [server] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM servers WHERE region = 'Resv' AND is_dedicated = $1
        ORDER BY port LIMIT 1`,
      [dedicated],
    );
    return server.id;
  };

  const liveOn = async (serverId: string): Promise<MatchRow> => {
    const match = await fx.match({
      regions: ["Resv"],
      mapPoolId: (await fx.mapPool(1)).poolId,
    });
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
      [match.id, serverId],
    );
    await postgres.query(
      "UPDATE matches SET server_id = $1, status = 'Live' WHERE id = $2",
      [serverId, match.id],
    );
    return match;
  };

  const finish = (matchId: string, lineup = "lineup_1_id") =>
    postgres.query(
      `UPDATE matches SET winning_lineup_id = ${lineup} WHERE id = $1`,
      [matchId],
    );

  const reservedBy = async (serverId: string) => {
    const [server] = await postgres.query<
      Array<{ reserved_by_match_id: string | null }>
    >("SELECT reserved_by_match_id FROM servers WHERE id = $1", [serverId]);
    return server.reserved_by_match_id;
  };

  describe.each([
    ["an on-demand", false],
    ["a dedicated", true],
  ])("%s server", (_kind, dedicated) => {
    it("is freed when the match holding it ends", async () => {
      const serverId = await serverOf(dedicated);
      const match = await liveOn(serverId);

      await finish(match.id);

      expect(await reservedBy(serverId)).toBeNull();
    });

    it("is freed when it is taken from the match holding it", async () => {
      const serverId = await serverOf(dedicated);
      const match = await liveOn(serverId);

      await postgres.query(
        "UPDATE matches SET server_id = NULL WHERE id = $1",
        [match.id],
      );

      expect(await reservedBy(serverId)).toBeNull();
    });

    it("stays with the next match when the ended match's server_id is cleared", async () => {
      const serverId = await serverOf(dedicated);
      const ended = await liveOn(serverId);
      await finish(ended.id);
      const next = await liveOn(serverId);

      await postgres.query(
        "UPDATE matches SET server_id = NULL WHERE id = $1",
        [ended.id],
      );

      expect(await reservedBy(serverId)).toBe(next.id);
    });

    it("stays with the next match when the ended match is written again", async () => {
      const serverId = await serverOf(dedicated);
      const ended = await liveOn(serverId);
      await finish(ended.id);
      const next = await liveOn(serverId);

      await finish(ended.id, "lineup_2_id");

      expect(await reservedBy(serverId)).toBe(next.id);
    });
  });
});
