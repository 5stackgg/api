import { PostgresService } from "./../src/postgres/postgres.service";
import { GPU_NODE_PROFILE_SQL } from "./../src/matches/game-streamer/game-streamer.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The resolver's one read, run against the migrated schema: gpu_vendor from
// migration 1889000001250 and the PCI address of gpu_info element 0.
describe("GPU node profile read (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("GpuNodeProfileTest");
    postgres = db.postgres;
    await postgres.query(
      `INSERT INTO server_regions (value, description) VALUES ('GpuProfileRegion', 'GpuProfileRegion')
       ON CONFLICT (value) DO NOTHING`,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const insertGpuNode = (
    id: string,
    gpuVendor: string | null,
    gpuInfo: string | null,
  ) =>
    postgres.query(
      `INSERT INTO game_server_nodes (id, region, status, enabled, label, gpu, gpu_vendor, gpu_info)
       VALUES ($1, 'GpuProfileRegion', 'Online', true, $1, true, $2, $3::jsonb)`,
      [id, gpuVendor, gpuInfo],
    );

  const readProfile = (id: string) =>
    postgres.query<
      Array<{ gpu_vendor: string | null; pci_address: string | null }>
    >(GPU_NODE_PROFILE_SQL, [id]);

  it("returns gpu_vendor and the pci_bus_id of gpu_info element 0", async () => {
    await insertGpuNode(
      "gpu-profile-amd",
      "amd",
      '[{"index":0,"name":"Radeon 8060S","pci_bus_id":"0000:c4:00.0"}]',
    );
    await expect(readProfile("gpu-profile-amd")).resolves.toEqual([
      { gpu_vendor: "amd", pci_address: "0000:c4:00.0" },
    ]);
  });

  it("returns a null pci_address when gpu_info is null", async () => {
    await insertGpuNode("gpu-profile-no-info", "amd", null);
    await expect(readProfile("gpu-profile-no-info")).resolves.toEqual([
      { gpu_vendor: "amd", pci_address: null },
    ]);
  });

  it("rejects gpu_vendor intel through the CHECK constraint", async () => {
    await expect(
      insertGpuNode("gpu-profile-intel", "intel", null),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
