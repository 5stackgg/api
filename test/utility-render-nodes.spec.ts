import { Logger } from "@nestjs/common";
import { MatchAssistantService } from "./../src/matches/match-assistant/match-assistant.service";
import { PostgresService } from "./../src/postgres/postgres.service";
import { UtilityPracticeService } from "./../src/utility/utility-practice.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Where a utility render's practice server can boot. The pod films it over the
// loopback they share, so the answer is "beside a GPU that is free to film",
// whatever the node's region is and whether or not it takes matches.
describe("render nodes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let service: MatchAssistantService;
  let practice: UtilityPracticeService;
  let nodeSeq = 0;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityRenderNodesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199710000000n);
    await postgres.query(
      `INSERT INTO server_regions (value, description, is_lan)
       VALUES ('RenderRegion', 'RenderRegion', false), ('ZRenderLan', 'ZRenderLan', true)
       ON CONFLICT (value) DO NOTHING`,
    );

    service = new MatchAssistantService(
      new Logger("UtilityRenderNodesTest"),
      {} as never,
      {} as never,
      { get: () => ({ namespace: "test" }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        supportsPractice: jest.fn(async (): Promise<boolean> => true),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      postgres,
    );

    practice = new UtilityPracticeService(
      new Logger("UtilityRenderNodesTest"),
      postgres,
      {} as never,
      {} as never,
      {
        renderNodes: () => service.renderNodes(),
        countFreeOnDemandServers: jest.fn(async (): Promise<number> => 10),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn() } as never,
      { getConnection: () => ({}) } as never,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM match_demo_sessions");
    await postgres.query("DELETE FROM servers");
    await postgres.query("DELETE FROM game_server_nodes");
  });

  const matchNode = async (region: string) => {
    const id = `render-node-${++nodeSeq}`;
    await postgres.query(
      `INSERT INTO game_server_nodes
         (id, public_ip, lan_ip, start_port_range, end_port_range, region, status, enabled, label, gpu, build_id)
       VALUES ($1, '203.0.113.1', '10.0.0.1', 27015, 27025, $2, 'Online', true, $1, true, 1)`,
      [id, region],
    );
    return id;
  };

  const gpuOnlyNode = async () => {
    const id = `render-node-${++nodeSeq}`;
    await postgres.query(
      `INSERT INTO game_server_nodes
         (id, public_ip, region, status, enabled, label, gpu, enabled_for_match_making, build_id)
       VALUES ($1, '203.0.113.2', NULL, 'Online', true, $1, true, false, 1)`,
      [id],
    );
    return id;
  };

  const ids = async () => (await service.renderNodes()).map((node) => node.id);

  it("lists a GPU-only node's slot first, then GPU nodes in any region, LAN included", async () => {
    const lan = await matchNode("ZRenderLan");
    const online = await matchNode("RenderRegion");
    const gpuOnly = await gpuOnlyNode();

    expect(await service.renderNodes()).toEqual([
      { id: gpuOnly, region: null, gpu_only: true, supported: true },
      { id: lan, region: "ZRenderLan", gpu_only: false, supported: true },
      { id: online, region: "RenderRegion", gpu_only: false, supported: true },
    ]);
  });

  it("leaves out a node whose GPU is already in use", async () => {
    const gpuOnly = await gpuOnlyNode();
    await fx.region();
    const { matchId, mapId } = await fx.bareMatch();
    await postgres.query(
      `INSERT INTO match_demo_sessions
         (match_map_id, match_id, watcher_steam_id, k8s_job_name, game_server_node_id)
       VALUES ($1, $2, $3, 'job', $4)`,
      [mapId, matchId, await fx.player(), gpuOnly],
    );

    expect(await ids()).toEqual([]);
  });

  // Its slot is made by the booking the first time one is needed, so before
  // that it has none and is still a node to render on.
  it("lists a GPU-only node before its slot is made, and while the slot is free", async () => {
    const gpuOnly = await gpuOnlyNode();
    expect(await ids()).toEqual([gpuOnly]);

    await postgres.query("SELECT ensure_render_server($1, 'RenderRegion')", [
      gpuOnly,
    ]);
    expect(await ids()).toEqual([gpuOnly]);
  });

  it("leaves out a node whose only slot is taken", async () => {
    const gpuOnly = await gpuOnlyNode();
    await postgres.query("SELECT ensure_render_server($1, 'RenderRegion')", [
      gpuOnly,
    ]);
    await fx.region();
    const { matchId } = await fx.bareMatch();
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = $2 WHERE game_server_node_id = $1",
      [gpuOnly, matchId],
    );

    expect(await ids()).toEqual([]);
  });

  it("leaves out a node with rendering switched off, or without a GPU", async () => {
    const off = await gpuOnlyNode();
    await postgres.query(
      "UPDATE game_server_nodes SET gpu_rendering_enabled = false WHERE id = $1",
      [off],
    );
    const noGpu = await matchNode("RenderRegion");
    await postgres.query(
      "UPDATE game_server_nodes SET gpu = false WHERE id = $1",
      [noGpu],
    );

    expect(await ids()).toEqual([]);
  });

  it("leaves out a node that is not taking new matches", async () => {
    const node = await matchNode("RenderRegion");
    await postgres.query(
      "UPDATE game_server_nodes SET status = 'NotAcceptingNewMatches' WHERE id = $1",
      [node],
    );

    expect(await ids()).toEqual([]);
  });
  // A GPU-only node only gets its CS2 server install when a CS2 update ships,
  // and it is tried first: without this a fresh one took every render and
  // timed each one out on a server that could never boot.
  it("leaves out a node without CS2 installed, or one updating it", async () => {
    const fresh = await gpuOnlyNode();
    await postgres.query(
      "UPDATE game_server_nodes SET build_id = NULL WHERE id = $1",
      [fresh],
    );
    const updating = await matchNode("RenderRegion");
    await postgres.query(
      "UPDATE game_server_nodes SET update_status = 'Downloading' WHERE id = $1",
      [updating],
    );

    expect(await ids()).toEqual([]);
  });

  describe("the region a render's match is booked into", () => {
    const renderRegion = (): Promise<string> =>
      (practice as any).renderRegion();

    // Region with the most free servers was the old answer, and LAN regions
    // were never one: the booking then looked for a GPU where there was none.
    it("is the GPU node's own region, a LAN one included", async () => {
      await matchNode("RenderRegion");
      await matchNode("RenderRegion");
      const lan = await matchNode("ZRenderLan");
      await postgres.query(
        "UPDATE game_server_nodes SET gpu = false WHERE id <> $1",
        [lan],
      );

      expect(await renderRegion()).toBe("ZRenderLan");
    });

    // A GPU-only node has no region, and its slot is made in this one: it has
    // to be a region the install already counts, or single-region installs
    // gain a second one.
    it("is a region that already has servers for a GPU-only node", async () => {
      await postgres.query(
        `INSERT INTO server_regions (value, description, is_lan)
         VALUES ('AEmptyRegion', 'AEmptyRegion', false)
         ON CONFLICT (value) DO NOTHING`,
      );
      const matches = await matchNode("RenderRegion");
      await postgres.query(
        "UPDATE game_server_nodes SET gpu = false WHERE id = $1",
        [matches],
      );
      await gpuOnlyNode();

      expect(await renderRegion()).toBe("RenderRegion");
    });
  });

  // A player's practice session can never be booked on a node that takes no
  // matches, so the render slot on one must not pick their region.
  it("leaves a GPU-only node's render slot out of a player's region choice", async () => {
    await postgres.query(
      `INSERT INTO server_regions (value, description, is_lan)
       VALUES ('SlotOnlyRegion', 'SlotOnlyRegion', false)
       ON CONFLICT (value) DO NOTHING`,
    );
    const matches = await matchNode("RenderRegion");
    await postgres.query(
      "UPDATE servers SET enabled = false WHERE game_server_node_id = $1 AND port > 27015",
      [matches],
    );
    for (let i = 0; i < 2; i++) {
      const gpuOnly = await gpuOnlyNode();
      await postgres.query(
        "SELECT ensure_render_server($1, 'SlotOnlyRegion')",
        [gpuOnly],
      );
    }

    expect(await (practice as any).resolveRegion(null)).toBe("RenderRegion");
  });
  // What a waiting render says, one condition at a time: renderNodes() found
  // nothing, and this is the reason the queue page shows on the row.
  describe("why a render is waiting", () => {
    const reason = (): Promise<string> => practice.renderWaitReason();
    const set = (nodeId: string, sql: string) =>
      postgres.query(`UPDATE game_server_nodes SET ${sql} WHERE id = $1`, [
        nodeId,
      ]);

    it("names a missing GPU node, or one switched off for rendering", async () => {
      expect(await reason()).toContain("none is enabled with Rendering on");

      const node = await gpuOnlyNode();
      await set(node, "gpu_rendering_enabled = false");
      expect(await reason()).toContain("none is enabled with Rendering on");
    });

    it("names a GPU node that is offline or not taking new matches", async () => {
      const node = await gpuOnlyNode();

      await set(node, "status = 'Offline'");
      expect(await reason()).toContain("offline");

      await set(node, "status = 'NotAcceptingNewMatches'");
      expect(await reason()).toContain("not accepting new matches");
    });

    it("names a GPU that is busy", async () => {
      const node = await gpuOnlyNode();
      await fx.region();
      const { matchId, mapId } = await fx.bareMatch();
      await postgres.query(
        `INSERT INTO match_demo_sessions
           (match_map_id, match_id, watcher_steam_id, k8s_job_name, game_server_node_id)
         VALUES ($1, $2, $3, 'job', $4)`,
        [mapId, matchId, await fx.player(), node],
      );

      expect(await reason()).toContain("every one is busy");
    });

    it("names a free GPU node without CS2, or one updating it", async () => {
      const node = await gpuOnlyNode();

      await set(node, "build_id = NULL");
      expect(await reason()).toContain("Install CS2");

      await set(node, "update_status = 'Downloading'");
      expect(await reason()).toContain("finish updating CS2");
    });

    it("names a free GPU node with no free server slot", async () => {
      const node = await gpuOnlyNode();
      await postgres.query("SELECT ensure_render_server($1, 'RenderRegion')", [
        node,
      ]);
      await fx.region();
      const { matchId } = await fx.bareMatch();
      await postgres.query(
        "UPDATE servers SET reserved_by_match_id = $2 WHERE game_server_node_id = $1",
        [node, matchId],
      );

      expect(await reason()).toContain("free server slot");
      await expect((practice as any).renderRegion()).rejects.toThrow(
        "free server slot",
      );
    });
  });
});
