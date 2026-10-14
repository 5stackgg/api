import { PlaybackBlob } from "../demos/demo-metadata.service";
import { UtilityArtifactsService } from "./utility-artifacts.service";
import {
  UtilityMiningRequest,
  UtilityMiningService,
} from "./utility-mining.service";

const LINEUP = "11111111-1111-1111-1111-111111111111";
const MATCH = "22222222-2222-2222-2222-222222222222";
const MATCH_MAP = "33333333-3333-3333-3333-333333333333";
const THROWER = "76561198000000001";
const GID = 7;
const TICK_RATE = 64;
const THROW_TICK = 1000;

// The demo's own row for the smoke, exactly as the playback blob carries it.
const VOXELS = {
  gid: GID,
  round: 3,
  start_tick: THROW_TICK + 96,
  end_tick: THROW_TICK + 1500,
  ox: -640,
  oy: -720,
  oz: 96,
  vs: 16,
  dx: 12,
  dy: 10,
  dz: 6,
  arr: "/////w==",
};

// One grenade on a real parabola, thrown standing still, enough for the
// derivation to recover the throw.
function blobWith(
  options: { type?: string; smokeVoxels?: Array<unknown> } = {},
): PlaybackBlob {
  const type = options.type ?? "Smoke";
  const spawn = { x: -1912, y: 922, z: -103 };
  const release = { x: -540, y: 520, z: 160 };
  const grenade = {
    round: 3,
    grenade_id: GID,
    thrower_steam_id: THROWER,
    thrower_team: "t",
    type,
  };

  const pts = [0, 2, 4, 6].map((ticks) => {
    const seconds = ticks / TICK_RATE;
    return {
      t: THROW_TICK + ticks,
      x: spawn.x + release.x * seconds,
      y: spawn.y + release.y * seconds,
      z: spawn.z + release.z * seconds - 160 * seconds * seconds,
    };
  });

  return {
    tick_rate: TICK_RATE,
    map_name: "de_mirage",
    positions: [],
    grenade_throws: [
      { ...grenade, tick: THROW_TICK, phase: "thrown", ...spawn },
      {
        ...grenade,
        tick: THROW_TICK + 96,
        phase: "detonated",
        x: -560,
        y: 320,
        z: -140,
      },
    ],
    grenade_trajectories: [{ gid: GID, pts }],
    smoke_volumes: [],
    ...(options.smokeVoxels ? { smoke_voxels: options.smokeVoxels } : {}),
  } as unknown as PlaybackBlob;
}

describe("UtilityMiningService smoke voxels", () => {
  it("carries the demo's own smoke for a smoke", () => {
    const mined = UtilityMiningService.mine(
      blobWith({ smokeVoxels: [{ ...VOXELS, gid: 99 }, VOXELS] }),
      GID,
      "de_mirage",
    );

    expect(mined.smokeVoxels).toEqual(VOXELS);
  });

  it("carries none for a grenade that is not a smoke", () => {
    const mined = UtilityMiningService.mine(
      blobWith({ type: "Flash", smokeVoxels: [VOXELS] }),
      GID,
      "de_mirage",
    );

    expect(mined.smokeVoxels).toBeNull();
  });

  it("carries none from a blob from before demos had them", () => {
    expect(
      UtilityMiningService.mine(blobWith(), GID, "de_mirage").smokeVoxels,
    ).toBeNull();
  });

  describe("saveFromDemo", () => {
    let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
    let postgres: { query: jest.Mock };

    const request: UtilityMiningRequest = {
      user: { steam_id: THROWER, role: "user" } as any,
      match_id: MATCH,
      match_map_id: MATCH_MAP,
      grenade_id: GID,
      name: "Window from mid",
    };

    function make(blob: PlaybackBlob, artifacts: unknown) {
      return new UtilityMiningService(
        logger as any,
        postgres as any,
        {
          query: jest.fn(async () => ({
            matches: [
              {
                id: MATCH,
                match_maps: [{ id: MATCH_MAP, map: { name: "de_mirage" } }],
              },
            ],
          })),
        } as any,
        { readPlaybackBlob: jest.fn(async () => blob) } as any,
        artifacts as any,
        {
          isLibraryEnabled: jest.fn(async () => true),
          assertDailyLineupLimit: jest.fn(async (): Promise<void> => undefined),
        } as any,
        { autoName: jest.fn(async () => "Window") } as any,
      );
    }

    function artifactsStub() {
      return {
        uploadTrajectory: jest.fn(async () => "utility/test.json.gz"),
        storeSmokeVoxelRow: jest.fn(async () => true),
      };
    }

    beforeEach(() => {
      logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      postgres = {
        query: jest.fn(async (sql: string) => {
          if (sql.includes("FROM public.match_map_demos")) {
            return [{ playback_file: "demos/x/playback.json.gz" }];
          }
          if (sql.includes("INSERT INTO public.utility_lineups")) {
            return [{ id: LINEUP }];
          }
          return [];
        }),
      };
    });

    it("stores the demo's smoke on the lineup it mined", async () => {
      const artifacts = artifactsStub();

      await expect(
        make(blobWith({ smokeVoxels: [VOXELS] }), artifacts).saveFromDemo(
          request,
        ),
      ).resolves.toEqual({ id: LINEUP });
      expect(artifacts.storeSmokeVoxelRow).toHaveBeenCalledWith(LINEUP, VOXELS);
    });

    it("stores nothing for a grenade that is not a smoke", async () => {
      const artifacts = artifactsStub();

      await make(
        blobWith({ type: "Flash", smokeVoxels: [VOXELS] }),
        artifacts,
      ).saveFromDemo(request);

      expect(artifacts.storeSmokeVoxelRow).not.toHaveBeenCalled();
    });

    it("stores nothing from a blob without smoke voxels", async () => {
      const artifacts = artifactsStub();

      await make(blobWith(), artifacts).saveFromDemo(request);

      expect(artifacts.storeSmokeVoxelRow).not.toHaveBeenCalled();
    });

    it("saves the lineup when its smoke cannot be stored", async () => {
      const artifacts = new UtilityArtifactsService(
        logger as any,
        {
          put: jest.fn(async () => {
            throw new Error("bucket down");
          }),
        } as any,
        { query: jest.fn() } as any,
        {} as any,
      );
      jest
        .spyOn(artifacts, "uploadTrajectory")
        .mockResolvedValue("utility/test.json.gz");

      await expect(
        make(blobWith({ smokeVoxels: [VOXELS] }), artifacts).saveFromDemo(
          request,
        ),
      ).resolves.toEqual({ id: LINEUP });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[utility-smoke-voxels]"),
      );
    });
  });
});
