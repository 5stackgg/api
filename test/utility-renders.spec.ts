import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Readable, Writable } from "stream";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { PostgresService } from "./../src/postgres/postgres.service";
import { ClipDownloadController } from "./../src/matches/clips/clip-download.controller";
import { FileUrlSigningService } from "./../src/hasura/file-url-signing.service";
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
  let signing: FileUrlSigningService;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityRendersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199640000000n);
    signing = new FileUrlSigningService(
      new Logger("UtilityRendersTest"),
      new ConfigService({ s3: { secret: "bucket-secret" } }),
      postgres,
    );
    await signing.storeKey();
  }, 600_000);

  // The link as it was before links were signed, once its signature checks
  // out for the file it names.
  function unsigned(url: string | null, key: string) {
    const link = new URL(url!);
    expect(
      signing.verify(
        key,
        link.searchParams.get("exp"),
        link.searchParams.get("sig"),
      ),
    ).toBe(true);
    link.searchParams.delete("exp");
    link.searchParams.delete("sig");
    return link.toString();
  }

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
      expect(unsigned(first.url, `clips/utility/${id}.mp4`)).toBe(
        `https://demo-dl.5stack.gg/clips/utility/${id}.mp4?v=1000000`,
      );
      expect(unsigned(first.thumb, `clips/utility/${id}.jpg`)).toBe(
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
      expect(unsigned(second.url, `clips/utility/${id}.mp4`)).toBe(
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

      const urls = await stillsUrl(id);
      expect(Object.keys(urls!).sort()).toEqual(["aim", "landing"]);
      expect(unsigned(urls!.aim, `clips/utility/${id}/aim.jpg`)).toBe(
        `https://demo-dl.5stack.gg/clips/utility/${id}/aim.jpg?v=1000000`,
      );
      expect(unsigned(urls!.landing, `clips/utility/${id}/landing.jpg`)).toBe(
        `https://demo-dl.5stack.gg/clips/utility/${id}/landing.jpg?v=1000000`,
      );
    });
  });

  // A panel that never set up the Cloudflare worker has no
  // cloudflare_worker_url. A filmed lineup had no preview url at all there, so
  // its render read "done" and the lineup showed nothing.
  describe("without a Cloudflare worker", () => {
    const RENDER = "560035c5-ea95-41f4-bcb9-6f0d5985be94";

    beforeEach(async () => {
      await postgres.query(
        "DELETE FROM settings WHERE name = 'cloudflare_worker_url'",
      );
      await postgres.query(
        `INSERT INTO settings (name, value)
         VALUES ('demos_domain', 'https://demos.example.test')
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      );
    });

    async function filmed(overrides: Record<string, unknown> = {}) {
      const id = await lineup(overrides);
      const files = {
        clip: `clips/utility/${id}/${RENDER}.mp4`,
        thumbnail: `clips/utility/${id}/${RENDER}.jpg`,
        aim: `clips/utility/${id}/${RENDER}/aim.webp`,
        smoke: `clips/utility/${id}.smoke.1700000000000.json`,
      };
      await postgres.query(
        `UPDATE utility_lineups
            SET preview_file = $2,
                preview_thumbnail = $3,
                preview_stills = $4::jsonb,
                preview_rendered_at = to_timestamp(1000000),
                smoke_voxels_file = $5,
                smoke_voxels_at = to_timestamp(2000000)
          WHERE id = $1::uuid`,
        [
          id,
          files.clip,
          files.thumbnail,
          JSON.stringify({ aim: files.aim }),
          files.smoke,
        ],
      );
      return { id, files };
    }

    const urls = async (id: string) => {
      const [row] = await postgres.query<
        Array<{
          url: string | null;
          thumb: string | null;
          stills: Record<string, string> | null;
          smoke: string | null;
        }>
      >(
        `SELECT public.utility_lineup_preview_url(l) AS url,
                public.utility_lineup_preview_thumbnail_url(l) AS thumb,
                public.utility_lineup_preview_stills_url(l) AS stills,
                public.utility_lineup_smoke_voxels_url(l) AS smoke
           FROM utility_lineups l WHERE l.id = $1::uuid`,
        [id],
      );
      return row;
    };

    const archive = (id: string) =>
      postgres.query(
        "UPDATE utility_lineups SET archived_at = now() WHERE id = $1::uuid",
        [id],
      );

    function api() {
      const s3 = {
        stat: jest.fn().mockResolvedValue({ size: 4 }),
        get: jest.fn(async () => Readable.from([Buffer.alloc(4)])),
      };
      // As HasuraService does: the player's role today, whatever their
      // session says.
      const hasura = {
        getHasuraHeaders: async (steamId: string) => {
          const [player] = await postgres.query<Array<{ role: string }>>(
            "SELECT role FROM players WHERE steam_id = $1::bigint",
            [steamId],
          );
          return { "x-hasura-role": player?.role, "x-hasura-user-id": steamId };
        },
      };
      const controller = new ClipDownloadController(
        s3 as never,
        hasura as never,
        postgres,
        null as never,
        signing,
        new Logger("UtilityRendersTest"),
      );

      const fetch = async (
        key: string,
        viewer?: { steam_id: string; role: string },
        link: { exp?: string | null; sig?: string | null } = {},
      ) => {
        const response: any = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        const headers: Record<string, unknown> = {};
        response.setHeader = (name: string, value: unknown) => {
          headers[name.toLowerCase()] = value;
        };
        response.status = (code: number) => {
          response.statusCode = code;
          return response;
        };
        response.json = () => response.end();
        const finished = new Promise((resolve) =>
          response.on("finish", resolve),
        );

        await controller.utilityLineupFile(
          key.replace("clips/utility/", "").split("/"),
          undefined,
          undefined,
          link.exp ?? undefined,
          link.sig ?? undefined,
          { headers: {}, user: viewer } as never,
          response,
        );
        await finished;
        return {
          status: response.statusCode,
          type: headers["content-type"],
          cache: headers["cache-control"],
        };
      };

      return { s3, fetch };
    }

    it("serves a filmed lineup's files from the demos domain", async () => {
      const { id, files } = await filmed();

      const row = await urls(id);

      expect(unsigned(row.url, files.clip)).toBe(
        `https://demos.example.test/${files.clip}?v=1000000`,
      );
      expect(unsigned(row.thumb, files.thumbnail)).toBe(
        `https://demos.example.test/${files.thumbnail}?v=1000000`,
      );
      expect(Object.keys(row.stills!)).toEqual(["aim"]);
      expect(unsigned(row.stills!.aim, files.aim)).toBe(
        `https://demos.example.test/${files.aim}?v=1000000`,
      );
      expect(unsigned(row.smoke, files.smoke)).toBe(
        `https://demos.example.test/${files.smoke}?v=2000000`,
      );
    });

    it("answers at those paths with only the files the lineup points at", async () => {
      const { id, files } = await filmed();
      const { s3, fetch } = api();

      const kept = "private, max-age=2592000, immutable";
      expect(await fetch(files.clip)).toEqual({
        status: 200,
        type: "video/mp4",
        cache: kept,
      });
      expect(await fetch(files.thumbnail)).toEqual({
        status: 200,
        type: "image/jpeg",
        cache: kept,
      });
      expect(await fetch(files.aim)).toEqual({
        status: 200,
        type: "image/webp",
        cache: kept,
      });
      expect(await fetch(files.smoke)).toEqual({
        status: 200,
        type: "application/json",
        cache: kept,
      });
      expect(s3.stat.mock.calls.map(([key]) => key)).toEqual([
        files.clip,
        files.thumbnail,
        files.aim,
        files.smoke,
      ]);

      s3.stat.mockClear();
      const other = await lineup({ name: "Jungle from T spawn" });
      for (const key of [
        `clips/utility/${id}/11111111-1111-1111-1111-111111111111.mp4`,
        `clips/utility/${id}/${RENDER}/landing.webp`,
        `clips/utility/${other}/${RENDER}.mp4`,
        `clips/utility/22222222-2222-2222-2222-222222222222/${RENDER}.mp4`,
      ]) {
        expect((await fetch(key)).status).toBe(404);
      }
      expect(s3.stat).not.toHaveBeenCalled();
    });

    // A lineup is only filmed while it is public, and keeps what was filmed
    // when its author takes it back or archives it. The session cookie reaches
    // the demos domain, so the API can tell who may still see it.
    describe.each([
      ["made private", { visibility: "Private" }, false],
      ["archived", {}, true],
    ])("a filmed lineup that is then %s", (_label, overrides, archived) => {
      async function unpublished() {
        const lineup = await filmed(overrides);
        if (archived) {
          await archive(lineup.id);
        }
        return lineup;
      }

      it("keeps its urls", async () => {
        const { id, files } = await unpublished();

        const row = await urls(id);
        expect({
          url: unsigned(row.url, files.clip),
          thumb: unsigned(row.thumb, files.thumbnail),
          stills: { aim: unsigned(row.stills!.aim, files.aim) },
          smoke: unsigned(row.smoke, files.smoke),
        }).toEqual({
          url: `https://demos.example.test/${files.clip}?v=1000000`,
          thumb: `https://demos.example.test/${files.thumbnail}?v=1000000`,
          stills: {
            aim: `https://demos.example.test/${files.aim}?v=1000000`,
          },
          smoke: `https://demos.example.test/${files.smoke}?v=2000000`,
        });
      });

      // Whoever was handed the link could see the lineup when it was signed;
      // that is the grant, for as long as the link runs.
      it("is served on the link its computed field signed", async () => {
        const { id, files } = await unpublished();
        const row = await urls(id);
        const { fetch } = api();

        const link = new URL(row.url!);
        expect(
          await fetch(files.clip, undefined, {
            exp: link.searchParams.get("exp"),
            sig: link.searchParams.get("sig"),
          }),
        ).toEqual({
          status: 200,
          type: "video/mp4",
          cache: "private, max-age=0, must-revalidate",
        });
        expect(
          (
            await fetch(files.thumbnail, undefined, {
              exp: link.searchParams.get("exp"),
              sig: link.searchParams.get("sig"),
            })
          ).status,
        ).toBe(404);
      });

      it("is served to nobody who cannot see the lineup", async () => {
        const { files } = await unpublished();
        const stranger = await fx.player();
        const { s3, fetch } = api();

        // The last one was a moderator when they signed in and is not now.
        for (const viewer of [
          undefined,
          { steam_id: stranger, role: "user" },
          { steam_id: stranger, role: "moderator" },
        ]) {
          for (const key of Object.values(files)) {
            expect((await fetch(key, viewer)).status).toBe(404);
          }
        }
        expect(s3.stat).not.toHaveBeenCalled();
      });

      it("is served to its author and to a moderator, asked for again each time", async () => {
        const { files } = await unpublished();
        const moderator = await fx.player();
        await postgres.query(
          "UPDATE players SET role = 'moderator' WHERE steam_id = $1::bigint",
          [moderator],
        );
        const { fetch } = api();

        for (const viewer of [
          { steam_id: author, role: "user" },
          { steam_id: moderator, role: "moderator" },
        ]) {
          expect(await fetch(files.clip, viewer)).toEqual({
            status: 200,
            type: "video/mp4",
            cache: "private, max-age=0, must-revalidate",
          });
        }
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
