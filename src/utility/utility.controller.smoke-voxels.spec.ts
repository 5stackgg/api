import { UtilityController } from "./utility.controller";
import { UtilityLineupsService } from "./utility-lineups.service";

const LINEUP = "11111111-1111-1111-1111-111111111111";

const CAPTURE = {
  log: "AAECAwQ=",
  samples: [[3, 100]] as Array<[number, number]>,
  detonation: { x: -500, y: -600, z: 128 },
  tick_rate: 64,
};

describe("UtilityController smoke voxels", () => {
  const context = {
    serverId: "server",
    matchId: "match",
    mapName: "de_mirage",
  };

  function make() {
    const lineups = {
      isLibraryEnabled: jest.fn().mockResolvedValue(true),
      serverContext: jest.fn().mockResolvedValue(context),
      ingest: jest.fn().mockResolvedValue({ id: LINEUP }),
      recordSmokeVoxels: jest.fn().mockResolvedValue({ stored: true }),
    };
    const controller = new UtilityController(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {} as any,
      lineups as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { controller, lineups };
  }

  const request = { utilityServerId: "server" } as any;

  // A voxel log alone can outweigh the lineup cap; it is capped on its own.
  it("leaves the recorded smoke out of the lineup's size cap", async () => {
    const { controller, lineups } = make();
    const body = {
      utility_type: "Smoke",
      smoke_voxels: {
        ...CAPTURE,
        log: "A".repeat(UtilityLineupsService.MAX_PAYLOAD_BYTES * 2),
      },
    };

    await expect(controller.ingest(request, body)).resolves.toEqual({
      id: LINEUP,
    });
    expect(lineups.ingest).toHaveBeenCalledWith(context, body);
  });

  it("still refuses a lineup past the cap", async () => {
    const { controller, lineups } = make();

    await expect(
      controller.ingest(request, {
        name: "x".repeat(UtilityLineupsService.MAX_PAYLOAD_BYTES * 2),
      }),
    ).rejects.toThrow("payload too large");
    expect(lineups.ingest).not.toHaveBeenCalled();
  });

  it("hands a throw's smoke to the lineup it was thrown from", async () => {
    const { controller, lineups } = make();
    const body = { ...CAPTURE, render: true };

    await expect(
      controller.smokeVoxels(request, LINEUP, body),
    ).resolves.toEqual({ stored: true });
    expect(lineups.recordSmokeVoxels).toHaveBeenCalledWith(
      context,
      LINEUP,
      body,
    );
  });

  it("answers a capture that is not one with a 400", async () => {
    const { controller, lineups } = make();
    lineups.recordSmokeVoxels.mockRejectedValueOnce(
      new Error("smoke_voxels.samples is empty"),
    );

    await expect(
      controller.smokeVoxels(request, LINEUP, { ...CAPTURE, samples: [] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
