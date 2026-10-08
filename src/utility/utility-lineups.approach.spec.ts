import {
  UtilityLineupsService,
  UtilityServerContext,
} from "./utility-lineups.service";

// Byte for byte the array UtilityWireTests pins on the plugin side
// (game-server apps/utility-sw/test/UtilityWireTests.cs). If the two drift, the
// physics-seed bug comes back: a field the plugin sends and the api drops.
const PLUGIN_APPROACH =
  '[{"t":-16,"x":10,"y":20,"z":30,"vx":250,"vy":-12.5,"vz":0,' +
  '"pitch":-3.5,"yaw":90,"buttons":1024,"on_ground":true,"ducked":false},' +
  '{"t":0,"x":14,"y":20,"z":31.5,"vx":240,"vy":0,"vz":301,' +
  '"pitch":-4,"yaw":91.5,"buttons":1026,"on_ground":false,"ducked":true}]';

const AUTHOR = "76561198000000001";

const CONTEXT: UtilityServerContext = {
  serverId: "22222222-2222-2222-2222-222222222222",
  matchId: "33333333-3333-3333-3333-333333333333",
  mapName: "de_mirage",
  lineupSteamIds: [AUTHOR],
};

function pluginBody(approach: string | null): Record<string, unknown> {
  return JSON.parse(
    `{"author_steam_id":"${AUTHOR}","utility_type":"Smoke","side":"TERRORIST",` +
      '"technique":"RunJump","throw_strength":"Full","jump_throw_bind":true,' +
      '"origin_x":100,"origin_y":200,"origin_z":300,"eye_z":364,' +
      '"view_yaw":90,"view_pitch":-12.5,"land_x":-500,"land_y":-600,"land_z":128,' +
      '"flight_time_ms":1500,"name":"A site window smoke","tick_rate":64,' +
      '"path":[{"tick":10,"x":1,"y":2,"z":3},{"tick":12,"x":4,"y":5,"z":6}]' +
      (approach === null ? "" : `,"approach":${approach}`) +
      "}",
  );
}

describe("UtilityLineupsService ingest: approach", () => {
  let postgres: { query: jest.Mock };
  let logger: { warn: jest.Mock; log: jest.Mock; error: jest.Mock };
  let service: UtilityLineupsService;

  beforeEach(() => {
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
          return [{ id: "11111111-1111-1111-1111-111111111111" }];
        }
        return [];
      }),
    };
    logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

    service = new UtilityLineupsService(
      logger as any,
      postgres as any,
      { uploadTrajectory: jest.fn(async () => "utility/test.json.gz") } as any,
      {
        get: jest.fn(async (_key: string, fallback?: unknown) => fallback),
        put: jest.fn(async () => true),
      } as any,
      {} as any,
      { autoName: jest.fn(async () => "Window") } as any,
    );
  });

  function insertedApproach(): unknown {
    const insert = postgres.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.utility_lineups"),
    );
    const sql = String(insert[0]);
    const columns = sql
      .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
      .split(",")
      .map((column) => column.trim());

    expect(columns.at(-1)).toBe("approach");
    expect(sql).toContain("$30::jsonb");

    const value = insert[1][29];
    return value === null ? null : JSON.parse(value);
  }

  it("persists the run-up exactly as the plugin sends it", async () => {
    await service.ingest(CONTEXT, pluginBody(PLUGIN_APPROACH));

    expect(insertedApproach()).toEqual(JSON.parse(PLUGIN_APPROACH));
  });

  it("stores no run-up for a throw made standing still", async () => {
    await service.ingest(CONTEXT, pluginBody(null));

    expect(insertedApproach()).toBeNull();
  });

  it("saves the lineup without a run-up that is not one", async () => {
    await expect(
      service.ingest(CONTEXT, pluginBody('[{"t":0,"x":"left"}]')),
    ).resolves.toMatchObject({ id: "11111111-1111-1111-1111-111111111111" });

    expect(insertedApproach()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped the run-up"),
    );
  });
});

describe("UtilityLineupsService.parseApproach", () => {
  const sample = (overrides: Record<string, unknown> = {}) => ({
    ...JSON.parse(PLUGIN_APPROACH)[1],
    ...overrides,
  });

  it("calls an empty run-up no run-up", () => {
    expect(UtilityLineupsService.parseApproach([])).toBeNull();
    expect(UtilityLineupsService.parseApproach(undefined)).toBeNull();
    expect(UtilityLineupsService.parseApproach(null)).toBeNull();
  });

  it("keeps only the fields it knows", () => {
    const [kept] = UtilityLineupsService.parseApproach([
      sample({ injected: "x".repeat(1000) }),
    ]);

    expect(kept).not.toHaveProperty("injected");
    expect(Object.keys(kept).sort()).toEqual(
      [
        "t",
        "x",
        "y",
        "z",
        "vx",
        "vy",
        "vz",
        "pitch",
        "yaw",
        "buttons",
        "on_ground",
        "ducked",
      ].sort(),
    );
  });

  // Number(null) is 0, so a lenient read would turn a hole into a sample at
  // the world origin.
  it("refuses a missing coordinate rather than reading it as zero", () => {
    expect(() =>
      UtilityLineupsService.parseApproach([sample({ x: null })]),
    ).toThrow(/approach\[0\]\.x is not a finite number/);
  });

  it("refuses more samples than the plugin keeps", () => {
    const samples = Array.from(
      { length: UtilityLineupsService.MAX_APPROACH_POINTS + 1 },
      (_, index) =>
        sample({ t: index - UtilityLineupsService.MAX_APPROACH_POINTS }),
    );

    expect(() => UtilityLineupsService.parseApproach(samples)).toThrow(
      /too many samples/,
    );
  });

  it("refuses a sample after the release", () => {
    expect(() =>
      UtilityLineupsService.parseApproach([sample({ t: 16 })]),
    ).toThrow(/t is out of range/);
  });

  it("refuses samples out of order", () => {
    expect(() =>
      UtilityLineupsService.parseApproach([
        sample({ t: 0 }),
        sample({ t: -16 }),
      ]),
    ).toThrow(/out of order/);
  });

  it("refuses a position outside the map", () => {
    expect(() =>
      UtilityLineupsService.parseApproach([sample({ z: 99999 })]),
    ).toThrow(/outside the map/);
  });

  it("refuses a speed the engine cannot reach", () => {
    expect(() =>
      UtilityLineupsService.parseApproach([
        sample({ vx: UtilityLineupsService.MAX_VELOCITY + 1 }),
      ]),
    ).toThrow(/faster than the engine allows/);
  });

  it("refuses a button mask that is not one", () => {
    expect(() =>
      UtilityLineupsService.parseApproach([sample({ buttons: -1 })]),
    ).toThrow(/not a button mask/);
    expect(() =>
      UtilityLineupsService.parseApproach([sample({ buttons: 1.5 })]),
    ).toThrow(/not a button mask/);
  });

  it("refuses a sample without its ground and duck state", () => {
    expect(() =>
      UtilityLineupsService.parseApproach([sample({ on_ground: 1 })]),
    ).toThrow(/on_ground or ducked/);
  });
});
