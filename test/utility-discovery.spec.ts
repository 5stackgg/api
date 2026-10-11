import { Logger } from "@nestjs/common";
import { CacheService } from "./../src/cache/cache.service";
import { PostgresService } from "./../src/postgres/postgres.service";
import { User } from "./../src/auth/types/User";
import {
  ParsedDiscoverCandidate,
  ParsedDiscoverResponse,
} from "./../src/demos/demo-parser.service";
import { UtilityTrajectoryInput } from "./../src/utility/utility-artifacts.service";
import { UtilityCalloutsService } from "./../src/utility/utility-callouts.service";
import {
  UtilityDiscoveryInput,
  UtilityDiscoveryOutcome,
  UtilityDiscoveryService,
} from "./../src/utility/utility-discovery.service";
import { UtilityLineupsService } from "./../src/utility/utility-lineups.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

describe("utility lineup discovery (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let uploads: Array<UtilityTrajectoryInput>;
  let queued: Array<string>;
  let commands: Array<string>;
  let serverId: string;
  let smokeVolume: jest.Mock;

  const SMOKE = {
    start_tick: 0,
    ox: -400,
    oy: -500,
    oz: -170,
    vs: 8,
    dx: 30,
    dy: 30,
    dz: 12,
    den: "AAAA",
  };

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityDiscoveryTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199640000000n);
    await seedRegionWithServer(postgres, "TestA");
    const [server] = await postgres.query<Array<{ id: string }>>(
      "SELECT id::text AS id FROM servers WHERE region = 'TestA' LIMIT 1",
    );
    serverId = server.id;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    uploads = [];
    queued = [];
    commands = [];
    await postgres.query("DELETE FROM utility_discoveries");
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM utility_meta_lineups");
    await postgres.query("DELETE FROM utility_practice_sessions");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "DELETE FROM settings WHERE name = 'public.utility_discoveries_per_hour'",
    );
  });

  const user = (steamId: string, role = "user"): User =>
    ({ steam_id: steamId, role, name: "tester" }) as User;

  function memoryCache(): CacheService {
    const store = new Map<string, unknown>();
    return {
      get: jest.fn(async (key: string, fallback?: unknown) =>
        store.has(key) ? store.get(key) : fallback,
      ),
      put: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
        return true;
      }),
      acquireLock: jest.fn(async (key: string) => {
        if (store.has(key)) {
          return false;
        }
        store.set(key, true);
        return true;
      }),
      forget: jest.fn(async (key: string) => store.delete(key)),
    } as unknown as CacheService;
  }

  function candidate(
    over: Partial<ParsedDiscoverCandidate> = {},
  ): ParsedDiscoverCandidate {
    return {
      stand: { x: -300, y: -1200, z: -167.97 },
      eye: { x: -300, y: -1200, z: -104 },
      technique: { direction: "", gait: "", jump_throw: false },
      technique_name: "Stationary",
      measured: true,
      strength: "Full",
      pitch: -20.5,
      yaw: 95.25,
      position: { x: -298, y: -1185, z: -110 },
      velocity: { x: 40, y: 520, z: 280 },
      landing: { x: -280, y: -400, z: -160 },
      distance: 12.5,
      bounces: 1,
      seconds: 2.1,
      spread: 18.4,
      ...over,
    };
  }

  function service(
    options: {
      predicted?: ParsedDiscoverResponse | null;
      status?: number;
      cache?: CacheService;
    } = {},
  ) {
    const predicted =
      options.predicted === undefined
        ? {
            candidates: [candidate()],
            stands: 12,
            flights: 900,
            searched: 12,
            truncated: false,
            revision: "rev-1",
            target: { x: -280, y: -400, z: -168 },
          }
        : options.predicted;

    const lineups = new UtilityLineupsService(
      new Logger("UtilityDiscoveryTest"),
      postgres,
      {
        uploadTrajectory: jest.fn(async (input: UtilityTrajectoryInput) => {
          uploads.push(input);
          return "utility/test/trajectory.json.gz";
        }),
      } as unknown as never,
      memoryCache() as unknown as never,
      {} as unknown as never,
      new UtilityCalloutsService(new Logger("UtilityDiscoveryTest"), postgres),
    );

    return new UtilityDiscoveryService(
      new Logger("UtilityDiscoveryTest"),
      postgres,
      options.cache ?? memoryCache(),
      {
        discover: jest.fn(async () => ({
          data: predicted,
          status: options.status ?? (predicted ? 200 : 500),
          error: predicted ? null : "boom",
        })),
        smokeVolume: (smokeVolume = jest.fn(async () => SMOKE)),
        floor: jest.fn(async (_map: string, point: { z: number }) => ({
          data:
            point.z > 5000 ? { found: false, z: 0 } : { found: true, z: -168 },
          status: 200,
          error: null as string | null,
        })),
      } as unknown as never,
      {
        isEnabled: jest.fn(async () => true),
        canPracticeOn: jest.fn(async () => true),
        renderServerId: jest.fn(async () => serverId),
      } as unknown as never,
      lineups,
      {
        discovery: jest.fn(
          async (_server: string, verb: string, id: string) => {
            commands.push(`${verb} ${id}`);
            return true;
          },
        ),
      } as unknown as never,
      {
        add: jest.fn(async (name: string) => {
          queued.push(name);
        }),
      } as unknown as never,
    );
  }

  const ask = (
    over: Partial<UtilityDiscoveryInput> = {},
  ): UtilityDiscoveryInput => ({
    map_name: "de_mirage",
    target_x: -280,
    target_y: -400,
    target_z: -160,
    radius: 40,
    area: {
      min_x: -400,
      min_y: -1300,
      min_z: -200,
      max_x: -200,
      max_y: -1100,
      max_z: -100,
    },
    techniques: [{ jump_throw: false }],
    strengths: ["Full"],
    ...over,
  });

  // A discovery a server is throwing: its session's match is on serverId.
  async function verifyingDiscovery(service: UtilityDiscoveryService) {
    const steamId = await fx.player();
    const started = await service.start(user(steamId), ask());
    const match = await fx.bareMatch();
    await postgres.query("UPDATE matches SET server_id = $2 WHERE id = $1", [
      match.matchId,
      serverId,
    ]);
    const [session] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_practice_sessions
         (map_name, region, match_id, status, is_render, is_discovery)
       VALUES ('de_mirage', 'TestA', $1::uuid, 'Ready', true, true)
       RETURNING id::text AS id`,
      [match.matchId],
    );
    await service.markVerifying(started.discovery_id!, session.id);
    const [result] = await postgres.query<Array<{ id: string }>>(
      "SELECT id::text AS id FROM utility_discovery_results WHERE discovery_id = $1",
      [started.discovery_id],
    );
    return {
      steamId,
      discoveryId: started.discovery_id!,
      resultId: result.id,
      sessionId: session.id,
    };
  }

  function outcome(
    resultId: string,
    over: Partial<UtilityDiscoveryOutcome> = {},
  ): UtilityDiscoveryOutcome {
    return {
      result_id: resultId,
      status: "verified",
      pitch: -20.4,
      yaw: 95.3,
      initial_position: { x: -298, y: -1185, z: -110 },
      initial_velocity: { x: 41, y: 519, z: 281 },
      landing: { x: -276, y: -404, z: -161 },
      distance: 5.6,
      bounces: 1,
      flight_time_ms: 2100,
      forgiveness: 22,
      grenades: 5,
      path: [
        { x: -298, y: -1185, z: -110 },
        { x: -290, y: -800, z: 40 },
        { x: -276, y: -404, z: -161 },
      ],
      ...over,
    };
  }

  describe("utility_discovery_is_new", () => {
    async function lineup(
      visibility: string,
      origin: [number, number],
      land: [number, number],
    ) {
      const author = await fx.player();
      await postgres.query(
        `INSERT INTO utility_lineups
           (map_name, utility_type, side, technique, origin_x, origin_y, origin_z,
            view_yaw, view_pitch, land_x, land_y, land_z, name, visibility,
            author_steam_id, origin_source)
         VALUES ('de_mirage', 'Smoke', 'TERRORIST', 'Stationary', $1, $2, 0,
                 0, 0, $3, $4, 0, 'known', $5, $6, 'editor')`,
        [origin[0], origin[1], land[0], land[1], visibility, author],
      );
    }

    const isNew = async (stand: [number, number], land: [number, number]) => {
      const [row] = await postgres.query<Array<{ is_new: boolean }>>(
        "SELECT public.utility_discovery_is_new('de_mirage', 'Smoke', $1, $2, $3, $4) AS is_new",
        [stand[0], stand[1], land[0], land[1]],
      );
      return row.is_new;
    };

    it("is not new within 64 units of a public lineup at both ends", async () => {
      await lineup("Public", [0, 0], [1000, 1000]);

      expect(await isNew([40, 0], [1000, 1040])).toBe(false);
      expect(await isNew([100, 0], [1000, 1000])).toBe(true);
      expect(await isNew([0, 0], [1000, 1100])).toBe(true);
    });

    it("ignores private lineups so the badge leaks nothing", async () => {
      await lineup("Private", [0, 0], [1000, 1000]);

      expect(await isNew([0, 0], [1000, 1000])).toBe(true);
    });

    it("is not new where the meta already runs it", async () => {
      await postgres.query(
        `INSERT INTO utility_meta_lineups
           (lineup_bucket, map_name, utility_type, side, technique,
            origin_x, origin_y, origin_z, land_x, land_y, land_z)
         VALUES ('b', 'de_mirage', 'Smoke', 'CT', 'Jump', 0, 0, 0, 1000, 1000, 0)`,
      );

      expect(await isNew([10, 10], [990, 990])).toBe(false);
    });
  });

  describe("start", () => {
    it("keeps the proposals and queues the discovery", async () => {
      const steamId = await fx.player();

      const answer = await service().start(user(steamId), ask());

      expect(answer.status).toBe("Queued");
      expect(answer.predicted).toBe(1);
      expect(queued).toEqual(["RunUtilityDiscovery"]);

      const [discovery] = await postgres.query<Array<any>>(
        "SELECT status, predicted, mesh_revision, target_z FROM utility_discoveries WHERE id = $1",
        [answer.discovery_id],
      );
      expect(discovery).toMatchObject({
        status: "Queued",
        predicted: 1,
        mesh_revision: "rev-1",
        target_z: -168,
      });

      const [result] = await postgres.query<Array<any>>(
        "SELECT status, technique, strength, is_new, pitch, yaw FROM utility_discovery_results WHERE discovery_id = $1",
        [answer.discovery_id],
      );
      expect(result).toMatchObject({
        status: "predicted",
        technique: "Stationary",
        strength: "Full",
        is_new: true,
        pitch: -20.5,
        yaw: 95.25,
      });
    });

    it("keeps a proposal whose spread could not be measured", async () => {
      const steamId = await fx.player();

      const answer = await service({
        predicted: {
          candidates: [candidate({ spread: null })],
          stands: 1,
          flights: 10,
          searched: 1,
          truncated: false,
          revision: "",
          target: { x: -280, y: -400, z: -168 },
        },
      }).start(user(steamId), ask());

      expect(answer.predicted).toBe(1);
    });

    it("finishes with nothing to throw when nothing lands", async () => {
      const steamId = await fx.player();

      const answer = await service({
        predicted: {
          candidates: [],
          stands: 4,
          flights: 300,
          searched: 4,
          truncated: false,
          revision: "rev-1",
          target: { x: -280, y: -400, z: -168 },
        },
      }).start(user(steamId), ask());

      expect(answer.status).toBe("Done");
      expect(answer.message).toMatch(/no throw/);
      expect(queued).toHaveLength(0);
    });

    it("fails and frees the player when the search fails", async () => {
      const steamId = await fx.player();
      const failing = service({ predicted: null, status: 404 });

      const answer = await failing.start(user(steamId), ask());

      expect(answer.status).toBe("Failed");
      expect(answer.message).toMatch(/no map geometry/);
      await expect(
        service().start(user(steamId), ask()),
      ).resolves.toMatchObject({ status: "Queued" });
    });

    it("allows one running discovery per player", async () => {
      const steamId = await fx.player();
      const discoveries = service();

      await discoveries.start(user(steamId), ask());

      await expect(discoveries.start(user(steamId), ask())).rejects.toThrow(
        /already have a discovery running/,
      );
    });

    it("holds a player to the hourly setting", async () => {
      const steamId = await fx.player();
      const cache = memoryCache();
      await postgres.query(
        "INSERT INTO settings (name, value) VALUES ('public.utility_discoveries_per_hour', '1')",
      );

      const first = await service({ cache }).start(user(steamId), ask());
      await service({ cache }).cancel(user(steamId), first.discovery_id!);

      await expect(
        service({ cache }).start(user(steamId), ask()),
      ).rejects.toThrow(/all 1 discoveries/);
    });

    it("lets one of two requests at once through", async () => {
      const steamId = await fx.player();
      const discoveries = service();

      const answers = await Promise.allSettled([
        discoveries.start(user(steamId), ask()),
        discoveries.start(user(steamId), ask()),
      ]);

      expect(answers.filter((a) => a.status === "fulfilled")).toHaveLength(1);
      const [refused] = answers.filter(
        (a) => a.status === "rejected",
      ) as PromiseRejectedResult[];
      expect(refused.reason.message).toMatch(
        /already have a discovery running/,
      );
    });

    it("turns new searches away while the queue is full", async () => {
      for (let i = 0; i < UtilityDiscoveryService.MAX_QUEUED; i++) {
        const other = await fx.player();
        await postgres.query(
          `INSERT INTO utility_discoveries
             (requested_by_steam_id, map_name, target_x, target_y, target_z,
              radius, area, techniques, strengths, status)
           VALUES ($1, 'de_mirage', 0, 0, 0, 40, '{}'::jsonb, '[]'::jsonb,
                   '{Full}', 'Queued')`,
          [other],
        );
      }
      const steamId = await fx.player();

      await expect(service().start(user(steamId), ask())).rejects.toThrow(
        /server is busy/,
      );
    });

    it("refuses a malformed ask before searching", async () => {
      const steamId = await fx.player();

      await expect(
        service().start(user(steamId), ask({ target_x: Number.NaN })),
      ).rejects.toThrow(/points on the map/);
      await expect(
        service().start(
          user(steamId),
          ask({
            area: {
              min_x: 0,
              min_y: 0,
              min_z: 0,
              max_x: 5000,
              max_y: 10,
              max_z: 10,
            },
          }),
        ),
      ).rejects.toThrow(/at most 2048/);
    });
  });

  describe("the server's report", () => {
    it("applies a verified throw once, from the server throwing it", async () => {
      const discoveries = service();
      const { discoveryId, resultId } = await verifyingDiscovery(discoveries);

      expect(
        await discoveries.report(discoveryId, serverId, [outcome(resultId)]),
      ).toBe(1);
      expect(
        await discoveries.report(discoveryId, serverId, [outcome(resultId)]),
      ).toBe(0);

      const [result] = await postgres.query<Array<any>>(
        "SELECT status, land_x, forgiveness, grenades, jsonb_array_length(path) AS points FROM utility_discovery_results WHERE id = $1",
        [resultId],
      );
      expect(result).toMatchObject({
        status: "verified",
        land_x: -276,
        forgiveness: 22,
        grenades: 5,
        points: 3,
      });

      const [discovery] = await postgres.query<Array<any>>(
        "SELECT verified, missed, grenades FROM utility_discoveries WHERE id = $1",
        [discoveryId],
      );
      expect(discovery).toMatchObject({ verified: 1, missed: 0, grenades: 5 });
    });

    it("ignores a server the discovery was not sent to", async () => {
      const discoveries = service();
      const { discoveryId, resultId } = await verifyingDiscovery(discoveries);

      expect(
        await discoveries.report(
          discoveryId,
          "00000000-0000-0000-0000-000000000001",
          [outcome(resultId)],
        ),
      ).toBe(0);
      expect(
        await discoveries.job(
          discoveryId,
          "00000000-0000-0000-0000-000000000001",
        ),
      ).toBeNull();
    });

    it("hands the server the proposals it has to throw", async () => {
      const discoveries = service();
      const { discoveryId, resultId } = await verifyingDiscovery(discoveries);

      const job = await discoveries.job(discoveryId, serverId);

      expect(job).toMatchObject({
        id: discoveryId,
        map: "de_mirage",
        utility_type: "Smoke",
        target: { x: -280, y: -400, z: -168 },
        radius: 40,
        max_grenades: UtilityDiscoveryService.MAX_GRENADES,
      });
      expect(job!.candidates).toEqual([
        {
          result_id: resultId,
          stand: { x: -300, y: -1200, z: -167.97 },
          direction: "",
          gait: "",
          jump_throw: false,
          strength: "Full",
          pitch: -20.5,
          yaw: 95.25,
        },
      ]);
    });

    it("skips a verified outcome with no landing rather than storing zeros", async () => {
      const discoveries = service();
      const { discoveryId, resultId } = await verifyingDiscovery(discoveries);

      expect(
        await discoveries.report(discoveryId, serverId, [
          outcome(resultId, { landing: { x: Number.NaN, y: 0, z: 0 } }),
        ]),
      ).toBe(0);
    });

    it("keeps results that arrive just after the server said it was done", async () => {
      const discoveries = service();
      const { discoveryId, resultId } = await verifyingDiscovery(discoveries);

      expect(await discoveries.done(discoveryId, serverId, null)).toBe(true);
      expect(
        await discoveries.report(discoveryId, serverId, [outcome(resultId)]),
      ).toBe(1);

      await postgres.query(
        "UPDATE utility_discoveries SET finished_at = now() - interval '10 minutes' WHERE id = $1",
        [discoveryId],
      );
      await postgres.query(
        "UPDATE utility_discovery_results SET status = 'predicted' WHERE id = $1",
        [resultId],
      );
      expect(
        await discoveries.report(discoveryId, serverId, [outcome(resultId)]),
      ).toBe(0);
    });

    it("records a miss and finishes when the server says it is done", async () => {
      const discoveries = service();
      const { discoveryId, resultId } = await verifyingDiscovery(discoveries);

      await discoveries.report(discoveryId, serverId, [
        outcome(resultId, { status: "missed", grenades: 9 }),
      ]);
      expect(await discoveries.done(discoveryId, serverId, null)).toBe(true);

      const [discovery] = await postgres.query<Array<any>>(
        "SELECT status, missed, finished_at FROM utility_discoveries WHERE id = $1",
        [discoveryId],
      );
      expect(discovery.status).toBe("Done");
      expect(discovery.missed).toBe(1);
      expect(discovery.finished_at).not.toBeNull();
    });

    it("tells the server to stop when its discovery is cancelled", async () => {
      const discoveries = service();
      const { steamId, discoveryId } = await verifyingDiscovery(discoveries);

      expect(await discoveries.cancel(user(steamId), discoveryId)).toBe(true);
      expect(commands).toEqual([`cancel ${discoveryId}`]);
    });

    it("lets nobody else cancel it", async () => {
      const discoveries = service();
      const { discoveryId } = await verifyingDiscovery(discoveries);
      const other = await fx.player();

      await expect(
        discoveries.cancel(user(other), discoveryId),
      ).rejects.toThrow(/not yours/);
      await expect(
        discoveries.cancel(user(other, "moderator"), discoveryId),
      ).resolves.toBe(true);
    });
  });

  describe("saving a find", () => {
    it("writes an exact private lineup with the server's seed", async () => {
      const discoveries = service();
      const { steamId, discoveryId, resultId } =
        await verifyingDiscovery(discoveries);
      await discoveries.report(discoveryId, serverId, [outcome(resultId)]);

      const lineupId = await discoveries.save(
        user(steamId),
        resultId,
        "Window from ramp",
        "TERRORIST",
      );

      const [lineup] = await postgres.query<Array<any>>(
        `SELECT name, side, technique, throw_strength, visibility, origin_source,
                confidence, author_steam_id::text AS author, initial_vel_y,
                view_pitch, view_yaw, land_x, jsonb_array_length(trajectory_preview) AS preview
           FROM utility_lineups WHERE id = $1`,
        [lineupId],
      );
      expect(lineup).toMatchObject({
        name: "Window from ramp",
        side: "TERRORIST",
        technique: "Stationary",
        throw_strength: "Full",
        visibility: "Private",
        origin_source: "discovery",
        confidence: "exact",
        author: steamId,
        initial_vel_y: 519,
        view_pitch: -20.4,
        view_yaw: 95.3,
        land_x: -276,
        preview: 3,
      });
      expect(uploads).toHaveLength(1);
      expect(uploads[0].path.map((p) => p.tick)).toEqual([0, 4, 134]);

      expect(
        await discoveries.save(user(steamId), resultId, "again", "CT"),
      ).toBe(lineupId);
    });

    it("saves a moving throw as derived, with the keys in words", async () => {
      const discoveries = service({
        predicted: {
          candidates: [
            candidate({
              technique: { direction: "left", gait: "walk", jump_throw: true },
              technique_name: "WalkJump",
              measured: false,
            }),
          ],
          stands: 1,
          flights: 10,
          searched: 1,
          truncated: false,
          revision: "rev-1",
          target: { x: -280, y: -400, z: -168 },
        },
      });
      const { steamId, discoveryId, resultId } =
        await verifyingDiscovery(discoveries);
      await discoveries.report(discoveryId, serverId, [outcome(resultId)]);

      const lineupId = await discoveries.save(
        user(steamId),
        resultId,
        "",
        "CT",
      );

      const [lineup] = await postgres.query<Array<any>>(
        "SELECT technique, confidence, description, jump_throw_bind FROM utility_lineups WHERE id = $1",
        [lineupId],
      );
      expect(lineup).toEqual({
        technique: "WalkJump",
        confidence: "derived",
        description:
          "Hold Shift + A while you throw, with the jump throw bind.",
        jump_throw_bind: true,
      });
    });

    it("saves once when asked twice at once", async () => {
      const discoveries = service();
      const { steamId, discoveryId, resultId } =
        await verifyingDiscovery(discoveries);
      await discoveries.report(discoveryId, serverId, [outcome(resultId)]);

      const answers = await Promise.allSettled([
        discoveries.save(user(steamId), resultId, "one", "CT"),
        discoveries.save(user(steamId), resultId, "two", "CT"),
      ]);

      expect(answers.filter((a) => a.status === "fulfilled")).toHaveLength(1);
      const [{ count }] = await postgres.query<Array<{ count: number }>>(
        "SELECT count(*)::int AS count FROM utility_lineups WHERE origin_source = 'discovery'",
      );
      expect(count).toBe(1);
    });

    it("refuses another player's find and an unverified one", async () => {
      const discoveries = service();
      const { steamId, resultId } = await verifyingDiscovery(discoveries);
      const other = await fx.player();

      await expect(
        discoveries.save(user(other), resultId, "mine", "CT"),
      ).rejects.toThrow(/not one of your discoveries/);
      await expect(
        discoveries.save(user(steamId), resultId, "mine", "CT"),
      ).rejects.toThrow(/only a throw the server has landed/);
    });
  });

  describe("the smoke at a spot", () => {
    it("puts a radar pick on its floor and blooms the smoke just above it", async () => {
      const discoveries = service();

      const preview = await discoveries.smoke(
        "76561198000000001",
        "de_mirage",
        {
          x: -280,
          y: -400,
          z: 0,
        },
      );

      expect(preview).toEqual({
        at: { x: -280, y: -400, z: -168 },
        volume: SMOKE,
      });
      expect(smokeVolume).toHaveBeenCalledWith("de_mirage", {
        x: -280,
        y: -400,
        z: -168 + UtilityDiscoveryService.SMOKE_REST_LIFT,
      });
    });

    it("holds one player to a number of previews a minute", async () => {
      const discoveries = service();
      const at = { x: -280, y: -400, z: 0 };

      for (let i = 0; i < UtilityDiscoveryService.PREVIEWS_PER_MINUTE; i++) {
        await discoveries.smoke("76561198000000001", "de_mirage", at);
      }

      await expect(
        discoveries.smoke("76561198000000001", "de_mirage", at),
      ).rejects.toThrow(/slow down/);
      await expect(
        discoveries.smoke("76561198000000002", "de_mirage", at),
      ).resolves.not.toBeNull();
      expect(smokeVolume).toHaveBeenCalledTimes(1);
    });

    it("answers nothing for a spot with no floor", async () => {
      expect(
        await service().smoke("76561198000000001", "de_mirage", {
          x: 0,
          y: 0,
          z: 9000,
        }),
      ).toBeNull();
      expect(smokeVolume).not.toHaveBeenCalled();
    });
  });

  describe("reaping", () => {
    it("ends a discovery server nothing has used in a while", async () => {
      const discoveries = service();
      const ended: Array<string> = [];
      (discoveries as any).practice.endRenderSession = jest.fn(
        async (id: string) => {
          ended.push(id);
        },
      );
      const { discoveryId, sessionId } = await verifyingDiscovery(discoveries);

      await postgres.query(
        "UPDATE utility_practice_sessions SET created_at = now() - interval '1 hour' WHERE id = $1",
        [sessionId],
      );
      expect(await discoveries.reapSessions()).toBe(0);

      await postgres.query(
        "UPDATE utility_discoveries SET status = 'Done', finished_at = now() - interval '20 minutes' WHERE id = $1",
        [discoveryId],
      );
      expect(await discoveries.reapSessions()).toBe(1);
      expect(ended).toEqual([sessionId]);
    });

    it("fails a discovery stranded while predicting", async () => {
      const steamId = await fx.player();
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_discoveries
           (requested_by_steam_id, map_name, target_x, target_y, target_z,
            radius, area, techniques, strengths, created_at)
         VALUES ($1, 'de_mirage', 0, 0, 0, 40, '{}'::jsonb, '[]'::jsonb,
                 '{Full}', now() - interval '10 minutes')
         RETURNING id`,
        [steamId],
      );

      await service().reconcile();

      const [discovery] = await postgres.query<Array<any>>(
        "SELECT status FROM utility_discoveries WHERE id = $1",
        [row.id],
      );
      expect(discovery.status).toBe("Failed");
    });
  });
});
