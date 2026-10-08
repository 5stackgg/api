import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  UtilityLineupsService,
  UtilityServerContext,
} from "./../src/utility/utility-lineups.service";
import { UtilityRendersService } from "./../src/utility/utility-renders.service";
import { UtilityCalloutsService } from "./../src/utility/utility-callouts.service";
import { UtilityPendingLineup } from "./../src/utility/utility-load.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

describe("utility lineup approach (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const APPROACH = [
    {
      t: -31,
      x: -1950.5,
      y: 921.25,
      z: -167.96875,
      vx: 250,
      vy: -12.5,
      vz: 0,
      pitch: -12.4,
      yaw: 133.7,
      buttons: 1024,
      on_ground: true,
      ducked: false,
    },
    {
      t: -16,
      x: -1946.5,
      y: 921.25,
      z: -167.96875,
      vx: 250,
      vy: -12.5,
      vz: 0,
      pitch: -12.4,
      yaw: 133.7,
      buttons: 1026,
      on_ground: true,
      ducked: false,
    },
    {
      t: 0,
      x: -1942.5,
      y: 921.25,
      z: -163.5,
      vx: 245,
      vy: -12,
      vz: 301,
      pitch: -12.4,
      yaw: 133.7,
      buttons: 1026,
      on_ground: false,
      ducked: true,
    },
  ];

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityApproachTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199930000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM utility_lineup_renders");
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");
  });

  function makeService(): UtilityLineupsService {
    return new UtilityLineupsService(
      new Logger("UtilityApproachTest"),
      postgres,
      {
        uploadTrajectory: jest.fn(async (): Promise<string> => "utility/t.gz"),
        removeTrajectories: jest.fn(async (): Promise<void> => undefined),
      } as unknown as never,
      {
        get: jest.fn(async (_key: string, fallback?: unknown) => fallback),
        put: jest.fn(async (): Promise<boolean> => true),
      } as unknown as never,
      {
        pending: jest.fn(async (): Promise<Array<UtilityPendingLineup>> => []),
      } as unknown as never,
      new UtilityCalloutsService(new Logger("UtilityApproachTest"), postgres),
    );
  }

  async function context(): Promise<{
    ctx: UtilityServerContext;
    author: string;
  }> {
    const author = await fx.player();
    const match = await fx.match();

    return {
      author,
      ctx: {
        serverId: randomUUID(),
        matchId: match.id,
        mapName: "de_mirage",
        lineupSteamIds: [author],
      },
    };
  }

  function payload(author: string, overrides: Record<string, unknown> = {}) {
    return {
      author_steam_id: author,
      utility_type: "Smoke",
      side: "TERRORIST",
      technique: "RunJump",
      throw_strength: "Full",
      jump_throw_bind: true,
      origin_x: -1942,
      origin_y: 921,
      origin_z: -167,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: -560,
      land_y: 320,
      land_z: -140,
      flight_time_ms: 1800,
      name: "Window from T spawn",
      path: [
        { tick: 0, x: -1942, y: 921, z: -100 },
        { tick: 64, x: -560, y: 320, z: -140 },
      ],
      ...overrides,
    };
  }

  async function stored(lineupId: string): Promise<unknown> {
    const [row] = await postgres.query<Array<{ approach: unknown }>>(
      "SELECT approach FROM utility_lineups WHERE id = $1::uuid",
      [lineupId],
    );
    return row.approach;
  }

  it("round-trips every field of every sample", async () => {
    const { ctx, author } = await context();

    const { id } = await makeService().ingest(
      ctx,
      payload(author, { approach: APPROACH }),
    );

    expect(await stored(id)).toEqual(APPROACH);
  });

  it("stores null for a throw made standing still", async () => {
    const { ctx, author } = await context();

    const { id } = await makeService().ingest(ctx, payload(author));

    expect(await stored(id)).toBeNull();
  });

  it("keeps the lineup and drops a run-up that is not one", async () => {
    const { ctx, author } = await context();

    const { id } = await makeService().ingest(
      ctx,
      payload(author, { approach: [{ ...APPROACH[0], t: 5 }] }),
    );

    expect(await stored(id)).toBeNull();
  });

  it("gives the run-up to a render session's library and to nobody else", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    const { id } = await service.ingest(
      ctx,
      payload(author, { approach: APPROACH }),
    );

    const [player] = await service.library(ctx, author);
    expect(player.approach).toBeNull();

    const [session] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_practice_sessions (host_steam_id, map_name, is_render, match_id)
       VALUES (NULL, 'de_mirage', true, $1::uuid)
       RETURNING id::text AS id`,
      [ctx.matchId],
    );
    await postgres.query(
      `INSERT INTO utility_lineup_renders
         (utility_lineup_id, requested_by_steam_id, map_name, session_token,
          spec, status, utility_practice_session_id)
       VALUES ($1::uuid, $2::bigint, 'de_mirage', 'tok', '{}'::jsonb, 'queued', $3::uuid)`,
      [id, author, session.id],
    );

    const [render] = await service.library(ctx, author);
    expect(render.approach).toEqual(APPROACH);
  });

  it("carries the run-up onto a fork", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    const { id } = await service.ingest(
      ctx,
      payload(author, { approach: APPROACH }),
    );
    const { id: forkId } = await service.fork(
      { steam_id: author, role: "user", name: "author" } as User,
      { utility_lineup_id: id },
    );

    expect(await stored(forkId)).toEqual(APPROACH);
  });

  it("puts the run-up in the render spec", async () => {
    const { ctx, author } = await context();

    const { id } = await makeService().ingest(
      ctx,
      payload(author, { approach: APPROACH }),
    );
    await postgres.query(
      "UPDATE utility_lineups SET visibility = 'Public' WHERE id = $1::uuid",
      [id],
    );

    const renders = new UtilityRendersService(
      new Logger("UtilityApproachTest"),
      postgres,
      {} as unknown as never,
      {
        add: jest.fn(async (): Promise<void> => undefined),
      } as unknown as never,
    );

    await renders.enqueue(id, { requestedBySteamId: author });

    const [render] = await postgres.query<
      Array<{ spec: { approach: unknown } }>
    >(
      "SELECT spec FROM utility_lineup_renders WHERE utility_lineup_id = $1::uuid",
      [id],
    );

    expect(render.spec.approach).toEqual(APPROACH);
  });
});
