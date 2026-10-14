import {
  UtilityLineupsService,
  UtilityServerContext,
} from "./utility-lineups.service";

const AUTHOR = "76561198000000001";
const LINEUP = "11111111-1111-1111-1111-111111111111";

const CONTEXT: UtilityServerContext = {
  serverId: "22222222-2222-2222-2222-222222222222",
  matchId: "33333333-3333-3333-3333-333333333333",
  mapName: "de_mirage",
  lineupSteamIds: [AUTHOR],
};

const CAPTURE = {
  log: "AAECAwQ=",
  samples: [
    [3, 100],
    [5, 102],
  ] as Array<[number, number]>,
  detonation: { x: -500, y: -600, z: 128 },
  tick_rate: 64,
};

function pluginBody(overrides: Record<string, unknown> = {}) {
  return {
    author_steam_id: AUTHOR,
    utility_type: "Smoke",
    side: "TERRORIST",
    technique: "Stand",
    throw_strength: "Full",
    origin_x: 100,
    origin_y: 200,
    origin_z: 300,
    view_yaw: 90,
    view_pitch: -12.5,
    land_x: -500,
    land_y: -600,
    land_z: 128,
    name: "A site window smoke",
    tick_rate: 64,
    path: [
      { tick: 10, x: 1, y: 2, z: 3 },
      { tick: 12, x: 4, y: 5, z: 6 },
    ],
    smoke_voxels: CAPTURE,
    ...overrides,
  };
}

describe("UtilityLineupsService smoke voxels", () => {
  let postgres: { query: jest.Mock };
  let artifacts: { uploadTrajectory: jest.Mock; storeSmokeVoxels: jest.Mock };
  let logger: { warn: jest.Mock; log: jest.Mock; error: jest.Mock };
  let service: UtilityLineupsService;
  // What the lineup lookup and the render batch lookup answer.
  let lineup: { utility_type: string } | null;
  let batch: Array<string>;

  beforeEach(() => {
    lineup = { utility_type: "Smoke" };
    batch = [];
    postgres = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("FROM public.players")) {
          return [{ present: true }];
        }
        if (sql.includes("per_server")) {
          return [{ per_server: "0", per_author: "0" }];
        }
        if (sql.includes("COUNT(*) AS count")) {
          return [{ count: "0" }];
        }
        if (sql.includes("INSERT INTO public.utility_lineups")) {
          return [{ id: LINEUP }];
        }
        if (sql.includes("SELECT utility_type\n")) {
          return lineup ? [lineup] : [];
        }
        if (sql.includes("INNER JOIN public.utility_lineup_renders r")) {
          return batch.map((id) => ({ utility_lineup_id: id }));
        }
        return [];
      }),
    };
    artifacts = {
      uploadTrajectory: jest.fn(async () => "utility/test.json.gz"),
      storeSmokeVoxels: jest.fn(async () => true),
    };
    logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

    service = new UtilityLineupsService(
      logger as any,
      postgres as any,
      artifacts as any,
      {
        get: jest.fn(async (_key: string, fallback?: unknown) => fallback),
        put: jest.fn(async () => true),
      } as any,
      {} as any,
      { autoName: jest.fn(async () => "Window") } as any,
    );
  });

  describe("ingest", () => {
    it("stores the smoke the plugin recorded with the lineup", async () => {
      await service.ingest(CONTEXT, pluginBody());

      expect(artifacts.storeSmokeVoxels).toHaveBeenCalledWith(LINEUP, CAPTURE);
    });

    it("saves the lineup when storing its smoke fails", async () => {
      artifacts.storeSmokeVoxels.mockRejectedValueOnce(new Error("s3 down"));

      await expect(service.ingest(CONTEXT, pluginBody())).resolves.toEqual({
        id: LINEUP,
        trajectory_file: "utility/test.json.gz",
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[utility-smoke-voxels]"),
      );
    });

    it("saves the lineup without a recorded smoke that is not one", async () => {
      await expect(
        service.ingest(
          CONTEXT,
          pluginBody({ smoke_voxels: { ...CAPTURE, log: "not base64!" } }),
        ),
      ).resolves.toMatchObject({ id: LINEUP });

      expect(artifacts.storeSmokeVoxels).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped the recorded smoke"),
      );
    });

    it("records no smoke for a grenade that is not one", async () => {
      await service.ingest(CONTEXT, pluginBody({ utility_type: "Flash" }));

      expect(artifacts.storeSmokeVoxels).not.toHaveBeenCalled();
    });

    it("records no smoke when the plugin sent none", async () => {
      await service.ingest(CONTEXT, pluginBody({ smoke_voxels: undefined }));

      expect(artifacts.storeSmokeVoxels).not.toHaveBeenCalled();
    });
  });

  describe("recordRenderSmokeVoxels", () => {
    it("replaces the smoke of a lineup this server is filming", async () => {
      batch = [LINEUP];

      await expect(
        service.recordRenderSmokeVoxels(CONTEXT, LINEUP, CAPTURE),
      ).resolves.toEqual({ stored: true });
      expect(artifacts.storeSmokeVoxels).toHaveBeenCalledWith(LINEUP, CAPTURE);
    });

    it("refuses a server that is not filming that lineup", async () => {
      await expect(
        service.recordRenderSmokeVoxels(CONTEXT, LINEUP, CAPTURE),
      ).rejects.toThrow("not filming that lineup");
      expect(artifacts.storeSmokeVoxels).not.toHaveBeenCalled();
    });

    it("ignores a lineup that is not a smoke", async () => {
      batch = [LINEUP];
      lineup = { utility_type: "Molotov" };

      await expect(
        service.recordRenderSmokeVoxels(CONTEXT, LINEUP, CAPTURE),
      ).resolves.toEqual({ stored: false });
      expect(artifacts.storeSmokeVoxels).not.toHaveBeenCalled();
    });

    it("only looks on the map the server is on", async () => {
      batch = [LINEUP];
      lineup = null;

      await expect(
        service.recordRenderSmokeVoxels(CONTEXT, LINEUP, CAPTURE),
      ).resolves.toEqual({ stored: false });

      const [, bindings] = postgres.query.mock.calls.find(([sql]) =>
        String(sql).includes("SELECT utility_type\n"),
      );
      expect(bindings).toEqual([LINEUP, "de_mirage"]);
    });

    it("refuses a capture that is not one", async () => {
      batch = [LINEUP];

      await expect(
        service.recordRenderSmokeVoxels(CONTEXT, LINEUP, {
          ...CAPTURE,
          samples: [],
        }),
      ).rejects.toThrow("samples");
      await expect(
        service.recordRenderSmokeVoxels(CONTEXT, LINEUP, null),
      ).rejects.toThrow("no smoke voxels");
      await expect(
        service.recordRenderSmokeVoxels(CONTEXT, "not-a-lineup", CAPTURE),
      ).rejects.toThrow("not a lineup id");
      expect(artifacts.storeSmokeVoxels).not.toHaveBeenCalled();
    });
  });
});

describe("UtilityLineupsService.parseSmokeVoxels", () => {
  it("calls no capture no capture", () => {
    expect(UtilityLineupsService.parseSmokeVoxels(undefined)).toBeNull();
    expect(UtilityLineupsService.parseSmokeVoxels(null)).toBeNull();
  });

  it("keeps only the fields the parser takes", () => {
    expect(
      UtilityLineupsService.parseSmokeVoxels({
        ...CAPTURE,
        render: true,
        injected: "x",
      }),
    ).toEqual(CAPTURE);
  });

  it("refuses a log that is not base64", () => {
    expect(() =>
      UtilityLineupsService.parseSmokeVoxels({ ...CAPTURE, log: "" }),
    ).toThrow("not base64");
    expect(() =>
      UtilityLineupsService.parseSmokeVoxels({ ...CAPTURE, log: 42 }),
    ).toThrow("not base64");
  });

  it("refuses a log past the cap", () => {
    const log = "A".repeat(
      Math.ceil((UtilityLineupsService.MAX_SMOKE_VOXEL_LOG_BYTES + 3) / 3) * 4,
    );

    expect(() =>
      UtilityLineupsService.parseSmokeVoxels({ ...CAPTURE, log }),
    ).toThrow("too large");
  });

  it("refuses a sample that is not [byteLength, tick]", () => {
    for (const sample of [[1], [1, -2], [1, 2.5], ["1", 2], { 0: 1, 1: 2 }]) {
      expect(() =>
        UtilityLineupsService.parseSmokeVoxels({
          ...CAPTURE,
          samples: [sample],
        }),
      ).toThrow("samples[0]");
    }
  });

  it("refuses a detonation outside the map", () => {
    expect(() =>
      UtilityLineupsService.parseSmokeVoxels({
        ...CAPTURE,
        detonation: { x: 0, y: 0, z: 99999 },
      }),
    ).toThrow("outside the map");
  });

  it("refuses a tick rate that is not one", () => {
    for (const tick_rate of [0, -64, "fast", 100000]) {
      expect(() =>
        UtilityLineupsService.parseSmokeVoxels({ ...CAPTURE, tick_rate }),
      ).toThrow("tick_rate");
    }
  });
});

describe("UtilityLineupsService library progress", () => {
  const OTHER = "44444444-4444-4444-4444-444444444444";
  const SCRATCH = "scratch-1";

  let postgres: { query: jest.Mock };
  let pending: Array<unknown>;
  let rows: Array<{ id: string }>;
  let service: UtilityLineupsService;

  beforeEach(() => {
    pending = [];
    rows = [{ id: LINEUP }, { id: OTHER }];
    postgres = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("FROM public.utility_lineup_progress p")) {
          return [
            {
              utility_lineup_id: LINEUP,
              attempts: 7,
              successes: 4,
              current_streak: 2,
              best_streak: 3,
              mastered_at: null as string | null,
            },
          ];
        }
        if (sql.includes("LIMIT 500")) {
          return rows;
        }
        return [];
      }),
    };

    service = new UtilityLineupsService(
      { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
      postgres as any,
      {} as any,
      {} as any,
      { pending: jest.fn(async () => pending) } as any,
      {} as any,
    );
  });

  function progressQueries() {
    return postgres.query.mock.calls.filter(([sql]) =>
      String(sql).includes("FROM public.utility_lineup_progress p"),
    );
  }

  it("sends each lineup with where the asking player stands on it", async () => {
    const library = await service.library(CONTEXT, AUTHOR);

    expect(library).toEqual([
      {
        id: LINEUP,
        progress: {
          attempts: 7,
          successes: 4,
          current_streak: 2,
          best_streak: 3,
          mastered_at: null,
        },
      },
      { id: OTHER, progress: null },
    ]);
    expect(progressQueries()).toEqual([
      [expect.any(String), [AUTHOR, [LINEUP, OTHER]]],
    ]);
  });

  it("asks for no progress on a lineup that was never saved", async () => {
    rows = [];
    pending = [
      {
        kind: "scratch",
        lineup: { client_id: SCRATCH, map_name: CONTEXT.mapName },
      },
    ];

    const library = await service.library(CONTEXT, AUTHOR);

    expect(library).toEqual([
      expect.objectContaining({ id: SCRATCH, progress: null }),
    ]);
    expect(progressQueries()).toEqual([]);
  });
});
