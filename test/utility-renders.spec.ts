import { Logger } from "@nestjs/common";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  UTILITY_RENDER_VERSION,
  UtilityRendersService,
} from "./../src/utility/utility-renders.service";

// The render queue's two hard guarantees are schema-level, not code-level, so
// they are asserted against a real database: approving twice cannot book two
// renders, and the finished clip lives on the lineup rather than behind the
// job row that produced it.
describe("utility lineup renders (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let author: string;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityRendersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199640000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM utility_lineup_renders");
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM players");
    author = await fx.player();
  });

  async function lineup(overrides: Record<string, unknown> = {}) {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_lineups
         (map_name, utility_type, side, technique,
          origin_x, origin_y, origin_z, view_yaw, view_pitch,
          land_x, land_y, land_z, name, author_steam_id, visibility)
       VALUES ('de_mirage', 'Smoke', 'TERRORIST', 'Jump',
               1, 2, 3, 90, -20, 10, 20, 30, $1, $2::bigint, $3)
       RETURNING id::text AS id`,
      [
        (overrides.name as string) ?? "A main deep",
        author,
        (overrides.visibility as string) ?? "Public",
      ],
    );
    return row.id;
  }

  async function queueRender(lineupId: string, status = "queued") {
    return postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_lineup_renders
         (utility_lineup_id, requested_by_steam_id, map_name, session_token,
          spec, status)
       VALUES ($1::uuid, $2::bigint, 'de_mirage', 'tok', '{}'::jsonb, $3)
       ON CONFLICT ("utility_lineup_id")
         WHERE "status" IN ('queued', 'rendering', 'uploading')
         DO NOTHING
       RETURNING id::text AS id`,
      [lineupId, author, status],
    );
  }

  it("refuses a second in-flight render for the same lineup", async () => {
    const id = await lineup();

    expect(await queueRender(id)).toHaveLength(1);
    expect(await queueRender(id)).toHaveLength(0);
    expect(await queueRender(id, "rendering")).toHaveLength(0);
  });

  it("lets a lineup be re-rendered once the previous one is finished", async () => {
    const id = await lineup();

    const [first] = await queueRender(id);
    await postgres.query(
      "UPDATE utility_lineup_renders SET status = 'done' WHERE id = $1::uuid",
      [first.id],
    );

    expect(await queueRender(id)).toHaveLength(1);
  });

  it("scopes the guard to one lineup at a time", async () => {
    const a = await lineup({ name: "A main deep" });
    const b = await lineup({ name: "Jungle from T spawn" });

    expect(await queueRender(a)).toHaveLength(1);
    expect(await queueRender(b)).toHaveLength(1);
  });

  it("rejects a status the pod would never post", async () => {
    const id = await lineup();

    await expect(queueRender(id, "exploded")).rejects.toThrow(
      /utility_lineup_renders_status_chk/,
    );
  });

  it("rejects a progress outside 0..1", async () => {
    const id = await lineup();
    const [render] = await queueRender(id);

    await expect(
      postgres.query(
        "UPDATE utility_lineup_renders SET progress = 1.5 WHERE id = $1::uuid",
        [render.id],
      ),
    ).rejects.toThrow(/utility_lineup_renders_progress_chk/);
  });

  it("drops a lineup's render history with the lineup", async () => {
    const id = await lineup();
    await queueRender(id);

    await postgres.query("DELETE FROM utility_lineups WHERE id = $1::uuid", [
      id,
    ]);

    const rows = await postgres.query<Array<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM utility_lineup_renders",
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("keeps the finished clip on the lineup, so clearing the queue cannot lose it", async () => {
    const id = await lineup();
    const [render] = await queueRender(id);

    await postgres.query(
      `UPDATE utility_lineups
          SET preview_file = $2,
              preview_thumbnail = $3,
              preview_duration_ms = 4200,
              preview_rendered_at = now()
        WHERE id = $1::uuid`,
      [id, `clips/utility/${id}.mp4`, `clips/utility/${id}.jpg`],
    );
    await postgres.query(
      "DELETE FROM utility_lineup_renders WHERE id = $1::uuid",
      [render.id],
    );

    const [row] = await postgres.query<
      Array<{ preview_file: string; preview_duration_ms: number }>
    >(
      "SELECT preview_file, preview_duration_ms FROM utility_lineups WHERE id = $1::uuid",
      [id],
    );
    expect(row.preview_file).toBe(`clips/utility/${id}.mp4`);
    expect(Number(row.preview_duration_ms)).toBe(4200);
  });

  describe("preview url computed fields", () => {
    beforeEach(async () => {
      await postgres.query(
        `INSERT INTO settings (name, value)
         VALUES ('cloudflare_worker_url', 'https://demo-dl.5stack.gg')
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      );
    });

    it("is null until the lineup has been filmed", async () => {
      const id = await lineup();

      const [row] = await postgres.query<Array<{ url: string | null }>>(
        "SELECT public.utility_lineup_preview_url(l) AS url FROM utility_lineups l WHERE l.id = $1::uuid",
        [id],
      );
      expect(row.url).toBeNull();
    });

    it("busts its own cache on a re-render", async () => {
      const id = await lineup();

      await postgres.query(
        `UPDATE utility_lineups
            SET preview_file = $2, preview_thumbnail = $3,
                preview_rendered_at = to_timestamp(1000000)
          WHERE id = $1::uuid`,
        [id, `clips/utility/${id}.mp4`, `clips/utility/${id}.jpg`],
      );

      const [first] = await postgres.query<
        Array<{ url: string; thumb: string }>
      >(
        `SELECT public.utility_lineup_preview_url(l) AS url,
                public.utility_lineup_preview_thumbnail_url(l) AS thumb
           FROM utility_lineups l WHERE l.id = $1::uuid`,
        [id],
      );
      expect(first.url).toBe(
        `https://demo-dl.5stack.gg/clips/utility/${id}.mp4?v=1000000`,
      );
      expect(first.thumb).toBe(
        `https://demo-dl.5stack.gg/clips/utility/${id}.jpg?v=1000000`,
      );

      await postgres.query(
        "UPDATE utility_lineups SET preview_rendered_at = to_timestamp(2000000) WHERE id = $1::uuid",
        [id],
      );
      const [second] = await postgres.query<Array<{ url: string }>>(
        "SELECT public.utility_lineup_preview_url(l) AS url FROM utility_lineups l WHERE l.id = $1::uuid",
        [id],
      );
      expect(second.url).toBe(
        `https://demo-dl.5stack.gg/clips/utility/${id}.mp4?v=2000000`,
      );
    });
  });

  describe("preview stills url", () => {
    beforeEach(async () => {
      await postgres.query(
        `INSERT INTO settings (name, value)
         VALUES ('cloudflare_worker_url', 'https://demo-dl.5stack.gg')
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      );
    });

    const stillsUrl = async (id: string) => {
      const [row] = await postgres.query<Array<{ urls: Record<string, string> | null }>>(
        "SELECT public.utility_lineup_preview_stills_url(l) AS urls FROM utility_lineups l WHERE l.id = $1::uuid",
        [id],
      );
      return row.urls;
    };

    it("is null until a render filmed stills", async () => {
      expect(await stillsUrl(await lineup())).toBeNull();
    });

    it("serves every still on the clip's own cache-buster", async () => {
      const id = await lineup();
      await postgres.query(
        `UPDATE utility_lineups
            SET preview_stills = $2::jsonb,
                preview_rendered_at = to_timestamp(1000000)
          WHERE id = $1::uuid`,
        [
          id,
          JSON.stringify({
            aim: `clips/utility/${id}/aim.jpg`,
            landing: `clips/utility/${id}/landing.jpg`,
          }),
        ],
      );

      expect(await stillsUrl(id)).toEqual({
        aim: `https://demo-dl.5stack.gg/clips/utility/${id}/aim.jpg?v=1000000`,
        landing: `https://demo-dl.5stack.gg/clips/utility/${id}/landing.jpg?v=1000000`,
      });
    });
  });

  describe("render GPU claim", () => {
    const GPU_NODE = "render-gpu-node";
    const CPU_NODE = "render-cpu-node";

    beforeEach(async () => {
      await postgres.query(
        "DELETE FROM game_server_nodes WHERE id = ANY($1::text[])",
        [[GPU_NODE, CPU_NODE]],
      );
      const region = await fx.region("RenderRegion");
      await postgres.query(
        `INSERT INTO game_server_nodes (id, status, enabled, region, gpu)
         VALUES ($1, 'Online', true, $3, true), ($2, 'Online', true, $3, false)`,
        [GPU_NODE, CPU_NODE, region],
      );
    });

    const claim = async (nodeId: string) => {
      const [row] = await postgres.query<Array<{ id: string | null }>>(
        "SELECT public.claim_gpu_node_for_render($1) AS id",
        [nodeId],
      );
      return row.id;
    };

    it("takes the practice server's own node when its GPU is free", async () => {
      expect(await claim(GPU_NODE)).toBe(GPU_NODE);
    });

    it("never hands out a node without a GPU", async () => {
      expect(await claim(CPU_NODE)).toBeNull();
    });

    it("holds the node for an in-flight render against every other GPU claim", async () => {
      const id = await lineup();
      const [render] = await queueRender(id, "rendering");
      await postgres.query(
        "UPDATE utility_lineup_renders SET game_server_node_id = $2 WHERE id = $1::uuid",
        [render.id, GPU_NODE],
      );

      expect(await claim(GPU_NODE)).toBeNull();
      const [live] = await postgres.query<Array<{ id: string | null }>>(
        "SELECT public.claim_free_gpu_node() AS id",
      );
      expect(live.id).not.toBe(GPU_NODE);
    });

    it("lets go of a node once the render on it has gone quiet", async () => {
      const id = await lineup();
      const [render] = await queueRender(id, "rendering");
      await postgres.query(
        `UPDATE utility_lineup_renders
            SET game_server_node_id = $2,
                last_status_at = now() - interval '16 minutes'
          WHERE id = $1::uuid`,
        [render.id, GPU_NODE],
      );

      expect(await claim(GPU_NODE)).toBe(GPU_NODE);
    });

    // One pod films the whole queue and stays up between lineups: while its
    // server changes map, and for a moment after the last one. Nothing is in
    // flight then, and the GPU it is sitting on is not free. The session holds
    // it, from the pod being started until it stops asking what is next.
    describe("a render pod between lineups", () => {
      async function renderSession(options: {
        status?: string;
        pod?: string | null;
        seenMinutesAgo?: number;
      }) {
        const { matchId } = await fx.bareMatch();
        const [server] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO servers
             (host, label, rcon_password, port, enabled, region, type,
              is_dedicated, game_server_node_id)
           VALUES ('127.0.0.1', 'render-server', $1, 27990, true,
                   'RenderRegion', 'Ranked', false, $2)
           RETURNING id::text AS id`,
          [Buffer.from("password"), GPU_NODE],
        );
        await postgres.query(
          "UPDATE matches SET server_id = $2::uuid WHERE id = $1::uuid",
          [matchId, server.id],
        );
        const [session] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO utility_practice_sessions
             (map_name, is_render, status, match_id, render_job_name,
              render_seen_at)
           VALUES ('de_mirage', true, $1, $2::uuid, $3,
                   now() - make_interval(mins => $4))
           RETURNING id::text AS id`,
          [
            options.status ?? "Ready",
            matchId,
            options.pod === undefined ? "gs-nades-queue" : options.pod,
            options.seenMinutesAgo ?? 0,
          ],
        );
        return session.id;
      }

      afterEach(async () => {
        await postgres.query("DELETE FROM utility_practice_sessions");
        await postgres.query(
          "UPDATE matches SET server_id = NULL WHERE server_id IS NOT NULL",
        );
        await postgres.query(
          "DELETE FROM servers WHERE label = 'render-server'",
        );
      });

      it("keeps its GPU while its session is up, with nothing in flight", async () => {
        await renderSession({});

        expect(await claim(GPU_NODE)).toBeNull();
        const [live] = await postgres.query<Array<{ id: string | null }>>(
          "SELECT public.claim_free_gpu_node() AS id",
        );
        expect(live.id).not.toBe(GPU_NODE);
      });

      // The session is booked on the node before any pod exists; counting it
      // then would refuse the pod the very GPU it was booked for.
      it("does not hold the GPU before a pod has been started on it", async () => {
        await renderSession({ pod: null });

        expect(await claim(GPU_NODE)).toBe(GPU_NODE);
      });

      it("gives the GPU back when the session ends", async () => {
        await renderSession({ status: "Ended" });

        expect(await claim(GPU_NODE)).toBe(GPU_NODE);
      });

      it("lets go of a pod that has stopped asking what is next", async () => {
        await renderSession({ seenMinutesAgo: 16 });

        expect(await claim(GPU_NODE)).toBe(GPU_NODE);
      });

      // Rows are deleted as lineups are re-rendered and the queue is cleared.
      // The hold used to be read off them, and went with them.
      it("does not depend on any render row still existing", async () => {
        await renderSession({});
        await postgres.query("DELETE FROM utility_lineup_renders");

        expect(await claim(GPU_NODE)).toBeNull();
      });
    });
  });

  // The queue's own SQL, against a real database: these are the statements
  // that decide whether a lineup is filmed once, twice or never.
  describe("the queue", () => {
    let renders: UtilityRendersService;
    let sessionId: string;

    const seeded = async (overrides: Record<string, unknown> = {}) => {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_lineups
           (map_name, utility_type, side, technique,
            origin_x, origin_y, origin_z, view_yaw, view_pitch,
            land_x, land_y, land_z, name, author_steam_id, visibility,
            confidence,
            initial_pos_x, initial_pos_y, initial_pos_z,
            initial_vel_x, initial_vel_y, initial_vel_z,
            preview_file, preview_version, archived_at)
         VALUES ($1, 'Smoke', 'TERRORIST', 'Jump',
                 1, 2, 3, 90, -20, 10, 20, 30, $2, $3::bigint, $4,
                 'exact', 1, 2, 3, 100, 0, 50, $5, $6, $7)
         RETURNING id::text AS id`,
        [
          (overrides.map_name as string) ?? "de_mirage",
          (overrides.name as string) ?? "A lineup",
          author,
          (overrides.visibility as string) ?? "Public",
          (overrides.preview_file as string) ?? null,
          (overrides.preview_version as number) ?? null,
          overrides.archived ? new Date() : null,
        ],
      );
      return row.id;
    };

    beforeEach(async () => {
      await postgres.query("DELETE FROM utility_practice_sessions");
      renders = new UtilityRendersService(
        new Logger("UtilityRendersSqlTest"),
        postgres,
        { removePrefix: jest.fn(), has: jest.fn() } as never,
        { add: jest.fn() } as never,
      );
      const [session] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_practice_sessions (map_name, is_render, status)
         VALUES ('de_mirage', true, 'Ready')
         RETURNING id::text AS id`,
      );
      sessionId = session.id;
    });

    const pod = (jobName: string) => ({
      sessionId,
      jobName,
      nodeId: null as string | null,
    });

    describe("handing a lineup to a pod", () => {
      it("gives a queued lineup to the first pod that asks, and to nobody after", async () => {
        const [render] = await queueRender(await seeded());

        const first = await renders.handToPod(render.id, pod("gs-nades-queue"));
        const second = await renders.handToPod(render.id, pod("gs-nades-other"));

        expect(first).toMatchObject({
          id: render.id,
          k8s_job_name: "gs-nades-queue",
          utility_practice_session_id: sessionId,
        });
        expect(second).toBeNull();

        const [row] = await postgres.query<Array<{ k8s_job_name: string }>>(
          "SELECT k8s_job_name FROM utility_lineup_renders WHERE id = $1::uuid",
          [render.id],
        );
        expect(row.k8s_job_name).toBe("gs-nades-queue");
      });

      it("does not hand over a lineup that is paused, cancelled or already filming", async () => {
        const [paused] = await queueRender(await seeded({ name: "paused" }));
        await postgres.query(
          "UPDATE utility_lineup_renders SET paused = true WHERE id = $1::uuid",
          [paused.id],
        );
        const [cancelled] = await queueRender(
          await seeded({ name: "cancelled" }),
          "cancelled",
        );
        const [rendering] = await queueRender(
          await seeded({ name: "rendering" }),
          "rendering",
        );

        for (const render of [paused, cancelled, rendering]) {
          expect(
            await renders.handToPod(render.id, pod("gs-nades-queue")),
          ).toBeNull();
        }
      });
    });

    // The pod asks for more only once it has nothing in hand, so a lineup it
    // holds and has not started never reached it.
    describe("a lineup handed over that never started", () => {
      it("is found on its own pod and session, and only while it is still queued", async () => {
        const [stranded] = await queueRender(await seeded({ name: "stranded" }));
        const [filming] = await queueRender(await seeded({ name: "filming" }));
        const [elsewhere] = await queueRender(
          await seeded({ name: "elsewhere" }),
        );
        const [untouched] = await queueRender(
          await seeded({ name: "untouched" }),
        );
        await renders.handToPod(stranded.id, pod("gs-nades-queue"));
        await renders.handToPod(filming.id, pod("gs-nades-queue"));
        await renders.handToPod(elsewhere.id, pod("gs-nades-other"));
        await postgres.query(
          "UPDATE utility_lineup_renders SET status = 'rendering' WHERE id = $1::uuid",
          [filming.id],
        );

        expect(await renders.strandedOnPod(sessionId, "gs-nades-queue")).toEqual(
          [stranded.id],
        );
        expect(untouched.id).toBeDefined();
      });

      it("can be handed over again once it is back in the queue", async () => {
        const [render] = await queueRender(await seeded());
        await renders.handToPod(render.id, pod("gs-nades-queue"));

        await renders.releaseFromPod([render.id]);

        expect(await renders.strandedOnPod(sessionId, "gs-nades-queue")).toEqual(
          [],
        );
        expect(
          await renders.handToPod(render.id, pod("gs-nades-queue")),
        ).toMatchObject({ id: render.id, k8s_job_name: "gs-nades-queue" });
      });

      it("is not taken back from a pod that has started filming it", async () => {
        const [render] = await queueRender(await seeded());
        await renders.handToPod(render.id, pod("gs-nades-queue"));
        await postgres.query(
          "UPDATE utility_lineup_renders SET status = 'rendering' WHERE id = $1::uuid",
          [render.id],
        );

        await renders.releaseFromPod([render.id]);

        const [row] = await postgres.query<Array<{ k8s_job_name: string }>>(
          "SELECT k8s_job_name FROM utility_lineup_renders WHERE id = $1::uuid",
          [render.id],
        );
        expect(row.k8s_job_name).toBe("gs-nades-queue");
      });
    });

    it("reads the whole queue with who has each lineup, in filming order", async () => {
      const [late] = await queueRender(await seeded({ name: "late" }));
      const [early] = await queueRender(
        await seeded({ name: "early", map_name: "de_inferno" }),
      );
      await postgres.query(
        `UPDATE utility_lineup_renders
            SET sort_index = -1, map_name = 'de_inferno'
          WHERE id = $1::uuid`,
        [early.id],
      );
      await queueRender(await seeded({ name: "done" }), "done");
      await renders.handToPod(late.id, pod("gs-nades-queue"));

      const queue = await renders.inFlight();

      expect(
        queue.map((row) => [row.id, row.map_name, row.k8s_job_name]),
      ).toEqual([
        [early.id, "de_inferno", null],
        [late.id, "de_mirage", "gs-nades-queue"],
      ]);
    });

    describe("what the library is missing", () => {
      // A map disabled since its lineups were recorded: the lineup is still
      // there, and no practice server can be booked on it.
      const DISABLED_MAP = "de_inferno";

      const setEnabled = (enabled: boolean) =>
        postgres.query(
          "UPDATE maps SET enabled = $2 WHERE name = $1 AND type = 'Competitive'",
          [DISABLED_MAP, enabled],
        );

      afterEach(async () => {
        await setEnabled(true);
      });

      it("counts only public, unarchived lineups, and says what each needs", async () => {
        await seeded({
          name: "current",
          preview_file: "clips/utility/a.mp4",
          preview_version: UTILITY_RENDER_VERSION,
        });
        const missing = await seeded({ name: "missing" });
        const outdated = await seeded({
          name: "outdated",
          preview_file: "clips/utility/b.mp4",
          preview_version: UTILITY_RENDER_VERSION - 1,
        });
        const nowhere = await seeded({
          name: "nowhere",
          map_name: DISABLED_MAP,
        });
        await setEnabled(false);
        await queueRender(await seeded({ name: "rendering" }));
        await seeded({ name: "private", visibility: "Private" });
        await seeded({ name: "archived", archived: true });

        const coverage = await renders.coverage();

        expect(coverage).toMatchObject({
          version: UTILITY_RENDER_VERSION,
          pipeline_version: null,
          total: 5,
          current: 1,
          missing: 1,
          outdated: 1,
          queued: 1,
          unrenderable: 1,
        });
        expect(
          coverage.lineups.map((gap) => [gap.id, gap.state]).sort(),
        ).toEqual(
          [
            [missing, "missing"],
            [outdated, "outdated"],
            [nowhere, "unrenderable"],
          ].sort(),
        );
        expect((await renders.coverage(DISABLED_MAP)).total).toBe(1);
      });

      it("reports what the last finished render said filmed it", async () => {
        const [older] = await queueRender(await seeded({ name: "a" }), "done");
        const [newer] = await queueRender(await seeded({ name: "b" }), "done");
        await queueRender(await seeded({ name: "c" }), "done");
        await postgres.query(
          `UPDATE utility_lineup_renders
              SET render_version = 2, last_status_at = now() - interval '1 hour'
            WHERE id = $1::uuid`,
          [older.id],
        );
        await postgres.query(
          `UPDATE utility_lineup_renders
              SET render_version = 0, last_status_at = now()
            WHERE id = $1::uuid`,
          [newer.id],
        );

        expect((await renders.coverage()).pipeline_version).toBe(0);
      });
    });
  });

  describe("render practice sessions", () => {
    it("does not count against the host's one-live-session limit", async () => {
      const host = await fx.player();

      await postgres.query(
        `INSERT INTO utility_practice_sessions (host_steam_id, map_name, is_render)
         VALUES ($1::bigint, 'de_mirage', true)`,
        [host],
      );

      // A render session running for this player must not stop them starting
      // their own; the pod is not them.
      await expect(
        postgres.query(
          `INSERT INTO utility_practice_sessions (host_steam_id, map_name, is_render)
           VALUES ($1::bigint, 'de_mirage', false)`,
          [host],
        ),
      ).resolves.toBeDefined();
    });

    it("still allows only one live session a player started themselves", async () => {
      const host = await fx.player();

      await postgres.query(
        `INSERT INTO utility_practice_sessions (host_steam_id, map_name)
         VALUES ($1::bigint, 'de_mirage')`,
        [host],
      );

      await expect(
        postgres.query(
          `INSERT INTO utility_practice_sessions (host_steam_id, map_name)
           VALUES ($1::bigint, 'de_dust2')`,
          [host],
        ),
      ).rejects.toThrow(/one_live_per_host/);
    });
  });
});
