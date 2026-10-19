import { Logger } from "@nestjs/common";
import { MatchAssistantService } from "./../src/matches/match-assistant/match-assistant.service";
import { PostgresService } from "./../src/postgres/postgres.service";
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
  let nodeSeq = 0;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityRenderNodesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199710000000n);
    await postgres.query(
      `INSERT INTO server_regions (value, description, is_lan)
       VALUES ('RenderRegion', 'RenderRegion', false), ('RenderLan', 'RenderLan', true)
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
         (id, public_ip, lan_ip, start_port_range, end_port_range, region, status, enabled, label, gpu)
       VALUES ($1, '203.0.113.1', '10.0.0.1', 27015, 27025, $2, 'Online', true, $1, true)`,
      [id, region],
    );
    return id;
  };

  const gpuOnlyNode = async () => {
    const id = `render-node-${++nodeSeq}`;
    await postgres.query(
      `INSERT INTO game_server_nodes
         (id, public_ip, region, status, enabled, label, gpu, enabled_for_match_making)
       VALUES ($1, '203.0.113.2', NULL, 'Online', true, $1, true, false)`,
      [id],
    );
    return id;
  };

  const ids = async () => (await service.renderNodes()).map((node) => node.id);

  it("lists a GPU-only node's slot first, then GPU nodes in any region, LAN included", async () => {
    const lan = await matchNode("RenderLan");
    const online = await matchNode("RenderRegion");
    const gpuOnly = await gpuOnlyNode();

    expect(await service.renderNodes()).toEqual([
      { id: gpuOnly, region: null, gpu_only: true, supported: true },
      { id: lan, region: "RenderLan", gpu_only: false, supported: true },
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
});
