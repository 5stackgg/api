import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { PostgresService } from "./../src/postgres/postgres.service";

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
