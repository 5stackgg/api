import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// An AMD GPU node differs from an NVIDIA one only in gpu_vendor. The GPU claim
// functions and v_gpu_pool_status select on gpu, enabled, status and the
// workload toggles, so they must hand out and count an AMD node like any other.
describe("game server node gpu_vendor (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  type Toggle =
    | "gpu_streaming_enabled"
    | "gpu_demos_enabled"
    | "gpu_rendering_enabled";

  const allToggles: Array<Toggle> = [
    "gpu_streaming_enabled",
    "gpu_demos_enabled",
    "gpu_rendering_enabled",
  ];

  beforeAll(async () => {
    db = await bootMigratedDb("GpuVendorTest");
    postgres = db.postgres;
    await postgres.query(
      `INSERT INTO server_regions (value, description) VALUES ('GpuRegion', 'GpuRegion')
       ON CONFLICT (value) DO NOTHING`,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM servers");
    await postgres.query("DELETE FROM game_server_nodes");
  });

  // No port range, so the node trigger populates no servers.
  const createNode = (
    gpuVendor: string | null,
    {
      enabled = true,
      toggles = allToggles,
    }: { enabled?: boolean; toggles?: Array<Toggle> } = {},
  ) =>
    postgres.query(
      `INSERT INTO game_server_nodes
              (id, region, status, enabled, label, gpu, gpu_vendor,
               gpu_streaming_enabled, gpu_demos_enabled, gpu_rendering_enabled)
       VALUES ('gpu-node', 'GpuRegion', 'Online', $1, 'gpu-node', true, $2, $3, $4, $5)`,
      [
        enabled,
        gpuVendor,
        toggles.includes("gpu_streaming_enabled"),
        toggles.includes("gpu_demos_enabled"),
        toggles.includes("gpu_rendering_enabled"),
      ],
    );

  describe("the vendor CHECK", () => {
    it.each(["intel", "AMD"])("rejects %p", async (gpuVendor) => {
      await expect(createNode(gpuVendor)).rejects.toMatchObject({
        code: "23514",
        constraint: "game_server_nodes_gpu_vendor_check",
      });
    });

    it.each(["nvidia", "amd", null])("accepts %p", async (gpuVendor) => {
      await createNode(gpuVendor);

      const [row] = await postgres.query<Array<{ gpu_vendor: string | null }>>(
        "SELECT gpu_vendor FROM game_server_nodes WHERE id = 'gpu-node'",
      );
      expect(row.gpu_vendor).toBe(gpuVendor);
    });
  });

  describe.each([
    ["claim_free_gpu_node", "gpu_streaming_enabled"],
    ["claim_free_gpu_node_for_demo", "gpu_demos_enabled"],
    ["claim_free_gpu_node_for_batch", "gpu_rendering_enabled"],
  ] as Array<[string, Toggle]>)("%s", (claim, toggle) => {
    const claimed = async () =>
      (
        await postgres.query<Array<{ id: string | null }>>(
          `SELECT ${claim}() AS id`,
        )
      )[0].id;

    it(`returns the AMD node when only ${toggle} is on`, async () => {
      await createNode("amd", { toggles: [toggle] });

      expect(await claimed()).toBe("gpu-node");
    });

    it(`returns nothing when ${toggle} is off`, async () => {
      await createNode("amd", {
        toggles: allToggles.filter((other) => other !== toggle),
      });

      expect(await claimed()).toBeNull();
    });

    it("returns nothing when the node is disabled", async () => {
      await createNode("amd", { enabled: false });

      expect(await claimed()).toBeNull();
    });
  });

  it("counts the AMD node as registered and usable in v_gpu_pool_status", async () => {
    await createNode("amd");

    const [pool] = await postgres.query<Array<Record<string, unknown>>>(
      "SELECT * FROM v_gpu_pool_status",
    );
    expect(pool).toMatchObject({
      registered_gpu_nodes: 1,
      total_gpu_nodes: 1,
      free_gpu_nodes: 1,
      free_gpu_nodes_for_batch: 1,
      streaming_total_gpu_nodes: 1,
      streaming_free_gpu_nodes: 1,
      demo_total_gpu_nodes: 1,
      demo_free_gpu_nodes: 1,
      rendering_total_gpu_nodes: 1,
    });
  });
});
