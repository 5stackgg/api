import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures, MatchRow } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// A dedicated server is freed when its match ends, an on-demand one once the
// match's pod is gone (its host ports are the server). match_events clears the
// ended match's server_id after the rest of its side effects, so by then the
// server can already be the next match's.
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

  // What the api writes once an ended match's pod is gone.
  const releaseStopped = (serverId: string) =>
    postgres.query(
      "UPDATE servers SET reserved_by_match_id = NULL WHERE id = $1",
      [serverId],
    );

  it("a dedicated server is freed when the match holding it ends", async () => {
    const serverId = await serverOf(true);
    const match = await liveOn(serverId);

    await finish(match.id);

    expect(await reservedBy(serverId)).toBeNull();
  });

  describe("an on-demand server, whose pod holds its ports past the match end", () => {
    it.each([
      ["Finished", "winning_lineup_id = lineup_1_id"],
      ["Forfeit", "status = 'Forfeit', winning_lineup_id = lineup_2_id"],
      [
        "Surrendered",
        "status = 'Surrendered', winning_lineup_id = lineup_2_id",
      ],
      ["Tie", "status = 'Tie'"],
      ["Canceled", "status = 'Canceled'"],
    ])("stays with a match that is %s", async (status, end) => {
      const serverId = await serverOf(false);
      const match = await liveOn(serverId);

      await postgres.query(`UPDATE matches SET ${end} WHERE id = $1`, [
        match.id,
      ]);

      const [ended] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM matches WHERE id = $1",
        [match.id],
      );
      expect(ended.status).toBe(status);
      expect(await reservedBy(serverId)).toBe(match.id);
    });

    it("stays with the ended match when its server_id is cleared", async () => {
      const serverId = await serverOf(false);
      const match = await liveOn(serverId);
      await finish(match.id);

      await postgres.query(
        "UPDATE matches SET server_id = NULL WHERE id = $1",
        [match.id],
      );

      expect(await reservedBy(serverId)).toBe(match.id);
    });

    it("stays with the ended match when its winner is changed", async () => {
      const serverId = await serverOf(false);
      const match = await liveOn(serverId);
      await finish(match.id);

      await finish(match.id, "lineup_2_id");

      expect(await reservedBy(serverId)).toBe(match.id);
    });

    it("is freed when the ended match is played again", async () => {
      const serverId = await serverOf(false);
      const match = await liveOn(serverId);
      await postgres.query(
        "UPDATE matches SET status = 'Canceled' WHERE id = $1",
        [match.id],
      );
      await postgres.query(
        "UPDATE matches SET server_id = NULL WHERE id = $1",
        [match.id],
      );

      await postgres.query(
        "UPDATE matches SET status = 'WaitingForCheckIn' WHERE id = $1",
        [match.id],
      );

      expect(await reservedBy(serverId)).toBeNull();
    });
  });

  describe.each([
    ["an on-demand", false],
    ["a dedicated", true],
  ])("%s server freed after its match ended", (_kind, dedicated) => {
    const endOn = async (serverId: string) => {
      const match = await liveOn(serverId);
      await finish(match.id);
      if (!dedicated) {
        await releaseStopped(serverId);
      }
      return match;
    };

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
      const ended = await endOn(serverId);
      const next = await liveOn(serverId);

      await postgres.query(
        "UPDATE matches SET server_id = NULL WHERE id = $1",
        [ended.id],
      );

      expect(await reservedBy(serverId)).toBe(next.id);
    });

    it("stays with the next match when the ended match is written again", async () => {
      const serverId = await serverOf(dedicated);
      const ended = await endOn(serverId);
      const next = await liveOn(serverId);

      await finish(ended.id, "lineup_2_id");

      expect(await reservedBy(serverId)).toBe(next.id);
    });
  });

  // The match page's "server not available" hint reads is_match_server_available.
  describe("a match's server availability", () => {
    const available = async (matchId: string) => {
      const [row] = await postgres.query<Array<{ available: boolean }>>(
        "SELECT public.is_match_server_available(m) AS available FROM matches m WHERE m.id = $1",
        [matchId],
      );
      return row.available;
    };

    const waitingFor = async (serverId: string) => {
      const match = await fx.match({
        regions: ["Resv"],
        mapPoolId: (await fx.mapPool(1)).poolId,
      });
      await postgres.query("UPDATE matches SET server_id = $1 WHERE id = $2", [
        serverId,
        match.id,
      ]);
      return match;
    };

    it("is available to the match holding it", async () => {
      const match = await liveOn(await serverOf(true));

      expect(await available(match.id)).toBe(true);
    });

    it("is available to a match while nobody holds it", async () => {
      const match = await waitingFor(await serverOf(true));

      expect(await available(match.id)).toBe(true);
    });

    it("is not available to a match while another match holds it", async () => {
      const serverId = await serverOf(true);
      await liveOn(serverId);
      const match = await waitingFor(serverId);

      expect(await available(match.id)).toBe(false);
      await expect(
        postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
          match.id,
        ]),
      ).rejects.toThrow(/server is not available/);
    });

    it("is not available to a match with no server", async () => {
      const match = await fx.match({
        regions: ["Resv"],
        mapPoolId: (await fx.mapPool(1)).poolId,
      });

      expect(await available(match.id)).toBe(false);
    });
  });
});
