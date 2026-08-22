import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  DemoParserService,
  ParsedOneWayRequest,
  ParsedSightlineRequest,
  ParsedSightlineResult,
} from "./../src/demos/demo-parser.service";
import { UtilityAnalysisService } from "./../src/utility/utility-analysis.service";
import { UtilityArtifactsService } from "./../src/utility/utility-artifacts.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The analysis surface is the one place a lineup's geometry leaves the library
// on demand, so these pin the two things that make it safe to expose: a lineup
// you cannot see cannot be analysed, and the shared parser cannot be made to
// flood a hundred smoke volumes because somebody moved a crosshair.
describe("utility analysis (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  let sightlineCalls: Array<ParsedSightlineRequest>;
  let oneWayCalls: Array<ParsedOneWayRequest>;
  let volumeCalls: Array<{ map: string; x: number; y: number; z: number }>;
  let artifactCalls: Array<string>;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityAnalysisTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199640000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    sightlineCalls = [];
    oneWayCalls = [];
    volumeCalls = [];
    artifactCalls = [];
    await postgres.query("DELETE FROM utility_playbooks");
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM players");
  });

  const user = (steamId: string, role = "user"): User =>
    ({ steam_id: steamId, role, name: "tester" }) as User;

  function cacheStub() {
    const store = new Map<string, unknown>();
    return {
      store,
      service: {
        get: jest.fn(async (key: string) => store.get(key)),
        put: jest.fn(async (key: string, value: unknown) => {
          store.set(key, value);
          return true;
        }),
        forget: jest.fn(async (key: string) => {
          store.delete(key);
          return true;
        }),
      },
    };
  }

  function parserStub(
    overrides: {
      sightlines?: Array<ParsedSightlineResult>;
      threshold?: number;
      oneWay?: Array<Record<string, unknown>>;
      down?: boolean;
      volume?: Record<string, unknown> | null;
    } = {},
  ) {
    const failure = {
      data: null as null,
      status: null as number | null,
      error: "demo-parser unreachable",
    };

    return {
      sightlines: jest.fn(async (request: ParsedSightlineRequest) => {
        sightlineCalls.push(request);
        if (overrides.down) {
          return failure;
        }
        return {
          data: {
            threshold: overrides.threshold ?? 3,
            results: overrides.sightlines ?? [],
          },
          status: 200,
          error: null as string | null,
        };
      }),
      oneWay: jest.fn(async (request: ParsedOneWayRequest) => {
        oneWayCalls.push(request);
        if (overrides.down) {
          return failure;
        }
        return {
          data: { threshold: 3, results: overrides.oneWay ?? [] },
          status: 200,
          error: null as string | null,
        };
      }),
      smokeVolume: jest.fn(
        async (
          map: string,
          point: { x: number; y: number; z: number },
        ): Promise<Record<string, unknown> | null> => {
          volumeCalls.push({ map, ...point });
          return overrides.volume === undefined
            ? { ox: 0, oy: 0, oz: 0, vs: 16, dx: 4, dy: 4, dz: 4, den: "AA" }
            : overrides.volume;
        },
      ),
    } as unknown as DemoParserService;
  }

  function artifactsStub(volume: Record<string, unknown> | null = null) {
    return {
      readSmokeVolume: jest.fn(async (key: string) => {
        artifactCalls.push(key);
        return volume;
      }),
    } as unknown as UtilityArtifactsService;
  }

  function service(
    parser: DemoParserService,
    options: {
      cache?: ReturnType<typeof cacheStub>;
      artifacts?: UtilityArtifactsService;
    } = {},
  ) {
    return new UtilityAnalysisService(
      new Logger("UtilityAnalysisTest"),
      postgres,
      (options.cache ?? cacheStub()).service as never,
      options.artifacts ?? artifactsStub(),
      parser,
    );
  }

  async function insertLineup(
    author: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      map_name: "de_mirage",
      utility_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: 0,
      land_y: 0,
      land_z: 0,
      name: "Window",
      visibility: "Public",
      author_steam_id: author,
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row),
    );
    return inserted.id;
  }

  const pair = () => [
    { from_x: -500, from_y: 0, from_z: 0, to_x: 500, to_y: 0, to_z: 0 },
  ];

  describe("visibility", () => {
    it("refuses to analyse a lineup the caller cannot see", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      const lineupId = await insertLineup(author, { visibility: "Private" });
      const parser = parserStub();

      await expect(
        service(parser).sightlines(user(stranger), {
          lineup_id: lineupId,
          pairs: pair(),
        }),
      ).rejects.toThrow("lineup not found");

      // The point of the gate: the private geometry never left the database.
      expect(sightlineCalls).toHaveLength(0);
    });

    it("refuses one-way analysis of a lineup the caller cannot see", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      const lineupId = await insertLineup(author, { visibility: "Private" });

      await expect(
        service(parserStub()).oneWay(user(stranger), {
          lineup_id: lineupId,
          pairs: pair(),
        }),
      ).rejects.toThrow("lineup not found");

      expect(oneWayCalls).toHaveLength(0);
    });

    it("lets the author analyse their own private lineup", async () => {
      const author = await fx.player();
      const lineupId = await insertLineup(author, { visibility: "Private" });

      const answer = await service(
        parserStub({
          sightlines: [
            {
              blocked: true,
              blocked_by: "smoke",
              world_blocked: false,
              depth: 5.5,
              transmittance: 0.004,
              distance: 1000,
            },
          ],
        }),
      ).sightlines(user(author), { lineup_id: lineupId, pairs: pair() });

      expect(answer.results).toEqual([
        {
          index: 0,
          blocked: true,
          blocked_by: "smoke",
          depth: 5.5,
          transmittance: 0.004,
          world_blocked: false,
        },
      ]);
      expect(answer.degraded).toBe(false);
    });

    it("hides a lineup behind an id that is not a uuid", async () => {
      const author = await fx.player();
      await insertLineup(author);

      await expect(
        service(parserStub()).sightlines(user(author), {
          lineup_id: "not-a-uuid",
          pairs: pair(),
        }),
      ).rejects.toThrow("lineup not found");
    });
  });

  describe("degradation", () => {
    it("answers a degraded sightline result when the parser is down", async () => {
      const author = await fx.player();
      const lineupId = await insertLineup(author);

      const answer = await service(parserStub({ down: true })).sightlines(
        user(author),
        { lineup_id: lineupId, pairs: pair() },
      );

      expect(answer.degraded).toBe(true);
      expect(answer.results).toEqual([]);
      expect(answer.message).toBe("demo-parser unreachable");
      expect(answer.threshold).toBe(UtilityAnalysisService.DEFAULT_THRESHOLD);
    });

    it("answers a degraded one-way result when the parser is down", async () => {
      const author = await fx.player();
      const lineupId = await insertLineup(author);

      const answer = await service(parserStub({ down: true })).oneWay(
        user(author),
        { lineup_id: lineupId, pairs: pair() },
      );

      expect(answer.degraded).toBe(true);
      expect(answer.results).toEqual([]);
    });

    it("answers a degraded blocking search when the parser is down", async () => {
      const author = await fx.player();
      await insertLineup(author);

      const answer = await service(parserStub({ down: true })).findBlocking(
        user(author),
        {
          map_name: "de_mirage",
          from_x: -500,
          from_y: 0,
          from_z: 0,
          to_x: 500,
          to_y: 0,
          to_z: 0,
        },
      );

      expect(answer.degraded).toBe(true);
      expect(answer.results).toEqual([]);
    });
  });

  describe("one-way", () => {
    it("tells the parser the pairs are feet, not eyes", async () => {
      const author = await fx.player();
      const lineupId = await insertLineup(author);

      const answer = await service(
        parserStub({
          oneWay: [
            {
              one_way: true,
              favors: "a",
              cause: "smoke",
              confidence: "likely",
              contested: false,
            },
          ],
        }),
      ).oneWay(user(author), { lineup_id: lineupId, pairs: pair() });

      expect(oneWayCalls[0].positions).toBe("feet");
      expect(answer.results[0]).toEqual({
        index: 0,
        one_way: true,
        favors: "a",
        cause: "smoke",
        confidence: "likely",
        contested: false,
      });
    });
  });

  describe("the blocking search", () => {
    const line = {
      map_name: "de_mirage",
      from_x: -1000,
      from_y: 0,
      from_z: 0,
      to_x: 1000,
      to_y: 0,
      to_z: 0,
    };

    const clear = (count: number): Array<ParsedSightlineResult> => [
      {
        blocked: false,
        world_blocked: false,
        depth: 0,
        transmittance: 1,
        distance: 2000,
        per_smoke: Array.from({ length: count }, (_, i) => 10 - i),
      },
    ];

    it("only considers smokes near the segment", async () => {
      const author = await fx.player();
      // Beside the middle of the line: a smoke a long way from either end can
      // still be the one closing it.
      const near = await insertLineup(author, {
        land_x: 0,
        land_y: 40,
        land_z: 0,
        name: "near",
      });
      await insertLineup(author, {
        land_x: 0,
        land_y: 4000,
        land_z: 0,
        name: "far",
      });
      // Behind the shooter rather than on the line.
      await insertLineup(author, {
        land_x: -4000,
        land_y: 0,
        land_z: 0,
        name: "behind",
      });
      await insertLineup(author, {
        utility_type: "Flash",
        land_x: 0,
        land_y: 0,
        land_z: 0,
        name: "flash",
      });
      await insertLineup(author, {
        map_name: "de_nuke",
        land_x: 0,
        land_y: 0,
        land_z: 0,
        name: "other map",
      });

      const answer = await service(
        parserStub({ sightlines: clear(1) }),
      ).findBlocking(user(author), line);

      expect(sightlineCalls).toHaveLength(1);
      expect(sightlineCalls[0].smokes).toHaveLength(1);
      expect(answer.results.map((result) => result.utility_lineup_id)).toEqual([
        near,
      ]);
    });

    it("never evaluates more candidates than the parser accepts clouds", async () => {
      const author = await fx.player();

      for (let i = 0; i < 25; i++) {
        await insertLineup(author, {
          land_x: -400 + i * 20,
          land_y: 0,
          land_z: 0,
          name: `smoke ${i}`,
        });
      }

      const answer = await service(
        parserStub({ sightlines: clear(UtilityAnalysisService.CANDIDATE_CAP) }),
      ).findBlocking(user(author), { ...line, limit: 50 });

      expect(sightlineCalls).toHaveLength(1);
      expect(sightlineCalls[0].smokes).toHaveLength(
        UtilityAnalysisService.CANDIDATE_CAP,
      );
      expect(answer.results).toHaveLength(UtilityAnalysisService.CANDIDATE_CAP);
    });

    it("leaves out a lineup the caller cannot see", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      await insertLineup(author, {
        visibility: "Private",
        land_x: 0,
        land_y: 0,
        land_z: 0,
      });
      const shared = await insertLineup(author, {
        land_x: 0,
        land_y: 20,
        land_z: 0,
      });

      const answer = await service(
        parserStub({ sightlines: clear(1) }),
      ).findBlocking(user(stranger), line);

      expect(sightlineCalls[0].smokes).toHaveLength(1);
      expect(answer.results.map((result) => result.utility_lineup_id)).toEqual([
        shared,
      ]);
    });

    it("ranks by how much smoke each candidate puts on the line", async () => {
      const author = await fx.player();
      const first = await insertLineup(author, {
        land_x: 0,
        land_y: 10,
        land_z: 0,
      });
      const second = await insertLineup(author, {
        land_x: 0,
        land_y: 20,
        land_z: 0,
      });

      const answer = await service(
        parserStub({
          sightlines: [
            {
              blocked: false,
              world_blocked: false,
              depth: 5,
              transmittance: 0.006,
              distance: 2000,
              per_smoke: [0.5, 4.5],
            },
          ],
        }),
      ).findBlocking(user(author), line);

      expect(answer.results.map((result) => result.utility_lineup_id)).toEqual([
        second,
        first,
      ]);
      expect(answer.results[0].blocked).toBe(true);
      expect(answer.results[1].blocked).toBe(false);
      expect(answer.results[1].transmittance).toBeCloseTo(Math.exp(-0.5), 6);
    });

    it("does not credit a smoke for a line the map already blocks", async () => {
      const author = await fx.player();
      await insertLineup(author, { land_x: 0, land_y: 0, land_z: 0 });

      const answer = await service(
        parserStub({
          sightlines: [
            {
              blocked: true,
              blocked_by: "world",
              world_blocked: true,
              depth: 9,
              transmittance: 0.0001,
              distance: 2000,
              per_smoke: [9],
            },
          ],
        }),
      ).findBlocking(user(author), line);

      expect(answer.results).toEqual([]);
      expect(answer.degraded).toBe(false);
      expect(answer.message).toMatch(/already blocks/);
    });

    it("asks the parser for a volume once and reuses the memo", async () => {
      const author = await fx.player();
      await insertLineup(author, { land_x: 0, land_y: 0, land_z: 0 });
      const cache = cacheStub();

      const first = service(parserStub({ sightlines: clear(1) }), { cache });
      await first.findBlocking(user(author), line);

      // A different caller, so the memoized ANSWER cannot be reused -- only the
      // volume can.
      const other = await fx.player();
      const second = service(parserStub({ sightlines: clear(1) }), { cache });
      await second.findBlocking(user(other), line);

      expect(volumeCalls).toHaveLength(1);
    });

    it("prefers the bloom the artifact already carries", async () => {
      const author = await fx.player();
      await insertLineup(author, {
        land_x: 0,
        land_y: 0,
        land_z: 0,
        trajectory_file: "utility/abc/trajectory.json.gz",
      });

      await service(parserStub({ sightlines: clear(1) }), {
        artifacts: artifactsStub({
          ox: 1,
          oy: 2,
          oz: 3,
          vs: 16,
          dx: 4,
          dy: 4,
          dz: 4,
        }),
      }).findBlocking(user(author), line);

      expect(artifactCalls).toEqual(["utility/abc/trajectory.json.gz"]);
      expect(volumeCalls).toHaveLength(0);
      expect(sightlineCalls[0].smokes?.[0].volume).toMatchObject({ ox: 1 });
    });

    it("falls back to blooming the landing point inside the request", async () => {
      const author = await fx.player();
      await insertLineup(author, { land_x: 7, land_y: 8, land_z: 9 });

      await service(
        parserStub({ sightlines: clear(1), volume: null }),
      ).findBlocking(user(author), line);

      expect(sightlineCalls[0].smokes?.[0].at).toEqual({ x: 7, y: 8, z: 9 });
    });

    it("answers nothing rather than calling the parser with no candidates", async () => {
      const author = await fx.player();

      const answer = await service(
        parserStub({ sightlines: clear(0) }),
      ).findBlocking(user(author), line);

      expect(answer.results).toEqual([]);
      expect(sightlineCalls).toHaveLength(0);
    });
  });

  // "Your A execute leaves CT-cross open." The book's smokes are evaluated
  // together in one request, and the answer has to be honest about the two ways
  // it can be incomplete: a parser that is not there, and a book with more
  // smokes than one request carries.
  describe("playbook coverage", () => {
    async function insertPlaybook(
      owner: string,
      lineupIds: Array<string>,
    ): Promise<string> {
      const [playbook] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_playbooks (name, map_name, side, owner_steam_id, visibility)
         VALUES ('A execute', 'de_mirage', 'TERRORIST', $1, 'Private')
         RETURNING id`,
        [owner],
      );

      for (const [order, lineupId] of lineupIds.entries()) {
        await postgres.query(
          `INSERT INTO utility_playbook_steps (playbook_id, utility_lineup_id, step_order, offset_ms)
           VALUES ($1, $2, $3, $4)`,
          [playbook.id, lineupId, order, order * 500],
        );
      }

      return playbook.id;
    }

    const twoPairs = () => [
      { from_x: -500, from_y: 0, from_z: 0, to_x: 500, to_y: 0, to_z: 0 },
      { from_x: -400, from_y: 40, from_z: 0, to_x: 400, to_y: 40, to_z: 0 },
    ];

    it("sends every smoke in the book in one request", async () => {
      const author = await fx.player();
      const first = await insertLineup(author, { land_x: 10 });
      const second = await insertLineup(author, { land_x: 20 });
      const flash = await insertLineup(author, {
        utility_type: "Flash",
        land_x: 30,
      });
      const playbook = await insertPlaybook(author, [first, second, flash]);

      await service(
        parserStub({
          sightlines: [
            {
              blocked: true,
              world_blocked: false,
              depth: 6,
              transmittance: 0.1,
              per_smoke: [1, 6],
              distance: 1000,
            },
            {
              blocked: false,
              world_blocked: false,
              depth: 0.2,
              transmittance: 0.8,
              per_smoke: [0.1, 0.1],
              distance: 900,
            },
          ],
        }),
      ).playbookCoverage(user(author), {
        playbook_id: playbook,
        pairs: twoPairs(),
      });

      expect(sightlineCalls).toHaveLength(1);
      // The flash is absent: a flash puts no density on a sightline, so asking
      // the parser to bloom one would be asking it to answer nothing.
      expect(sightlineCalls[0].smokes).toHaveLength(2);
      expect(sightlineCalls[0].pairs).toHaveLength(2);
      expect(sightlineCalls[0].map).toBe("de_mirage");
    });

    it("names the step that closes an angle and leaves the rest open", async () => {
      const author = await fx.player();
      const first = await insertLineup(author, { land_x: 10 });
      const second = await insertLineup(author, { land_x: 20 });
      const playbook = await insertPlaybook(author, [first, second]);

      const answer = await service(
        parserStub({
          sightlines: [
            {
              blocked: true,
              world_blocked: false,
              depth: 6,
              transmittance: 0.1,
              per_smoke: [0.4, 6],
              distance: 1000,
            },
            {
              blocked: false,
              world_blocked: false,
              depth: 0.3,
              transmittance: 0.7,
              per_smoke: [0.2, 0.1],
              distance: 900,
            },
          ],
        }),
      ).playbookCoverage(user(author), {
        playbook_id: playbook,
        pairs: twoPairs(),
      });

      expect(answer.degraded).toBe(false);
      expect(answer.results).toEqual([
        {
          index: 0,
          covered: true,
          by_step: 1,
          depth: 6,
          transmittance: 0.1,
        },
        {
          index: 1,
          covered: false,
          by_step: null,
          depth: 0.3,
          transmittance: 0.7,
        },
      ]);
    });

    // The one answer this must never give: silence from the parser reading as
    // "that angle is open".
    it("comes back degraded rather than open when the parser is down", async () => {
      const author = await fx.player();
      const smoke = await insertLineup(author);
      const playbook = await insertPlaybook(author, [smoke]);

      const answer = await service(parserStub({ down: true })).playbookCoverage(
        user(author),
        { playbook_id: playbook, pairs: twoPairs() },
      );

      expect(answer.degraded).toBe(true);
      expect(answer.message).toBe("demo-parser unreachable");
      expect(answer.results).toEqual([]);
    });

    it("degrades when the book holds more smokes than one request carries", async () => {
      const author = await fx.player();
      const lineupIds: Array<string> = [];

      for (let index = 0; index <= UtilityAnalysisService.CANDIDATE_CAP; index++) {
        lineupIds.push(await insertLineup(author, { land_x: index * 10 }));
      }

      const answer = await service(
        parserStub({
          sightlines: [
            {
              blocked: false,
              world_blocked: false,
              depth: 0,
              transmittance: 1,
              per_smoke: [],
              distance: 1000,
            },
          ],
        }),
      ).playbookCoverage(user(author), {
        playbook_id: await insertPlaybook(author, lineupIds),
        pairs: [twoPairs()[0]],
      });

      expect(sightlineCalls[0].smokes).toHaveLength(
        UtilityAnalysisService.CANDIDATE_CAP,
      );
      expect(answer.degraded).toBe(true);
      expect(answer.message).toContain("first 16 smokes");
      expect(answer.results[0].covered).toBe(false);
    });

    it("says a book with no smokes covers nothing, without asking", async () => {
      const author = await fx.player();
      const flash = await insertLineup(author, { utility_type: "Flash" });
      const playbook = await insertPlaybook(author, [flash]);

      const answer = await service(parserStub()).playbookCoverage(
        user(author),
        { playbook_id: playbook, pairs: twoPairs() },
      );

      expect(sightlineCalls).toHaveLength(0);
      expect(answer.degraded).toBe(false);
      expect(answer.message).toBe("this playbook has no smoke steps");
      expect(answer.results.map((result) => result.covered)).toEqual([
        false,
        false,
      ]);
    });

    it("refuses a playbook the caller cannot see", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      const smoke = await insertLineup(author);
      const playbook = await insertPlaybook(author, [smoke]);

      await expect(
        service(parserStub()).playbookCoverage(user(stranger), {
          playbook_id: playbook,
          pairs: twoPairs(),
        }),
      ).rejects.toThrow("playbook not found");

      expect(sightlineCalls).toHaveLength(0);
    });
  });
});
