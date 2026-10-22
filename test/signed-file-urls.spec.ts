import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { readdirSync, readFileSync } from "fs";
import * as yaml from "js-yaml";
import { join } from "path";
import { Readable, Writable } from "stream";
import { PostgresService } from "../src/postgres/postgres.service";
import { ClipDownloadController } from "../src/matches/clips/clip-download.controller";
import { FileUrlSigningService } from "../src/hasura/file-url-signing.service";
import { Fixtures } from "./utils/fixtures";
import { HasuraPermissions } from "./utils/hasura-permissions";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

const S3_SECRET = "bucket-secret";
const SIX_HOURS = 6 * 60 * 60;
const ONE_YEAR = 365 * 24 * 60 * 60;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What the Cloudflare worker derives from the same bucket secret.
const SIGNING_KEY = createHmac("sha256", S3_SECRET)
  .update("5stack-file-url-v1")
  .digest();

// A clip's file and thumbnail are fetched from the public demos domain or the
// Cloudflare worker, neither of which knows who is asking. The link carries
// the grant instead: the computed fields sign it for rows the viewer can read.
describe("signed clip and lineup file links", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let signing: FileUrlSigningService;

  beforeAll(async () => {
    db = await bootMigratedDb("SignedFileUrlsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199650000000n);
    await seedRegionWithServer(postgres, "TestA");
    signing = new FileUrlSigningService(
      new Logger("SignedFileUrlsTest"),
      new ConfigService({ s3: { secret: S3_SECRET } }),
      postgres,
    );
    await signing.storeKey();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM match_clips");
    await postgres.query(
      `INSERT INTO settings (name, value)
       VALUES ('cloudflare_worker_url', 'https://cf.example.test')
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
    );
  });

  async function clip(
    visibility: "public" | "private" | "match",
    mapId?: string,
  ) {
    mapId ??= (await fx.bareMatch()).mapId;
    const owner = await fx.player();
    const [row] = await postgres.query<
      Array<{ id: string; file: string; thumbnail: string }>
    >(
      `INSERT INTO match_clips
         (user_steam_id, match_map_id, title, visibility, file, thumbnail_url)
       VALUES ($1::bigint, $2, 'Ace on B', $3,
               'clips/' || $4 || '/' || gen_random_uuid() || '.mp4',
               'clips/' || $4 || '/' || gen_random_uuid() || '.jpg')
       RETURNING id, file, thumbnail_url AS thumbnail`,
      [owner, mapId, visibility, owner],
    );
    return row;
  }

  async function links(id: string) {
    const [row] = await postgres.query<
      Array<{ download: string | null; thumbnail: string | null }>
    >(
      `SELECT public.clip_download_url(c) AS download,
              public.clip_thumbnail_download_url(c) AS thumbnail
         FROM match_clips c WHERE c.id = $1`,
      [id],
    );
    return row;
  }

  function signatureOf(url: string) {
    const link = new URL(url);
    return {
      exp: link.searchParams.get("exp")!,
      sig: link.searchParams.get("sig")!,
    };
  }

  function expiresIn(url: string) {
    return Number(signatureOf(url).exp) - Math.floor(Date.now() / 1000);
  }

  describe("the signing key", () => {
    it("is the one the worker derives from the bucket secret", async () => {
      const [row] = await postgres.query<Array<{ key: Buffer }>>(
        "SELECT key FROM private.file_url_signing_key",
      );

      expect(row.key.equals(SIGNING_KEY)).toBe(true);
    });

    it("is written once however often the api boots", async () => {
      await signing.storeKey();
      await signing.storeKey();

      const rows = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*) AS count FROM private.file_url_signing_key",
      );
      expect(Number(rows[0].count)).toBe(1);
    });

    // Only what Hasura tracks reaches a role, and an admin can list every
    // setting, so it is neither tracked nor a setting.
    it("is out of reach of every Hasura role", async () => {
      const metadata = join(
        process.cwd(),
        "hasura",
        "metadata",
        "databases",
        "default",
      );
      for (const dir of ["tables", "functions"]) {
        for (const file of readdirSync(join(metadata, dir))) {
          const yaml = readFileSync(join(metadata, dir, file), "utf8");
          expect(yaml).not.toMatch(/schema:\s*private\b/);
          expect(yaml).not.toMatch(/file_url_signing_key|file_url_signature/);
        }
      }

      const settings = await postgres.query<Array<{ name: string }>>(
        "SELECT name FROM settings WHERE value LIKE '%' || $1 || '%' OR value LIKE '%' || $2 || '%'",
        [SIGNING_KEY.toString("hex"), SIGNING_KEY.toString("base64")],
      );
      expect(settings).toEqual([]);
    });
  });

  describe("the signature", () => {
    const KEYS = [
      "clips/76561198000000001/0b6e1b6a-6f0e-4d0e-9a52-1f5c8b1f3e2a.mp4",
      "clips/utility/ffe58c95-4581-4320-a14e-f2efb95ccebe/still-land.jpg",
      "clips/ünïcødé/ファイル name+with/slashes=.mp4",
      `clips/${"x".repeat(500)}.mp4`,
      "",
    ];

    function expected(key: string, now: number, bucket: number) {
      const exp = (Math.floor(now / bucket) + 2) * bucket;
      const sig = createHmac("sha256", SIGNING_KEY)
        .update(`${key}\n${exp}`)
        .digest("base64url");
      return `exp=${exp}&sig=${sig}`;
    }

    it("is the one the worker checks, for a public and a private file", async () => {
      const rows = await postgres.query<
        Array<{
          key: string;
          now: string;
          public_file: string;
          private_file: string;
        }>
      >(
        `SELECT key, extract(epoch FROM now())::text AS now,
                public.file_url_signature(key, true) AS public_file,
                public.file_url_signature(key, false) AS private_file
           FROM unnest($1::text[]) AS key`,
        [KEYS],
      );

      expect(rows).toHaveLength(KEYS.length);
      for (const row of rows) {
        expect(row.public_file).toBe(
          expected(row.key, Number(row.now), ONE_YEAR),
        );
        expect(row.private_file).toBe(
          expected(row.key, Number(row.now), SIX_HOURS),
        );
      }
    });

    // The body file_url_signature had as a sql function, whose links are
    // already out there: a private file's must not change.
    it("signs a private file byte for byte as it did before", async () => {
      const rows = await postgres.transaction(async (client) => {
        await client.query(`
          CREATE FUNCTION pg_temp.file_url_signature_before(file_key text, public_file boolean)
              RETURNS text
              LANGUAGE sql STABLE
              AS $$
              SELECT CONCAT(
                  'exp=', expiry.exp,
                  '&sig=', rtrim(translate(encode(
                      hmac(convert_to(file_key || E'\\n' || expiry.exp, 'UTF8'), signing.key, 'sha256'),
                      'base64'
                  ), '+/', '-_'), '=')
              )
              FROM private.file_url_signing_key signing,
                   LATERAL (
                       SELECT (floor(extract(epoch FROM now()) / bucket.seconds)::bigint + 2) * bucket.seconds AS exp
                       FROM (SELECT CASE WHEN public_file THEN 604800 ELSE 21600 END::bigint AS seconds) bucket
                   ) expiry
              WHERE file_key IS NOT NULL;
          $$`);
        const { rows } = await client.query<{
          after: string | null;
          before: string | null;
        }>(
          `SELECT public.file_url_signature(key, public_file) AS after,
                  pg_temp.file_url_signature_before(key, public_file) AS before
             FROM unnest($1::text[]) AS key,
                  unnest(ARRAY[false, NULL]::boolean[]) AS public_file`,
          [[...KEYS, null]],
        );
        await client.query(
          "DROP FUNCTION pg_temp.file_url_signature_before(text, boolean)",
        );
        return rows;
      });

      expect(rows).toHaveLength(2 * (KEYS.length + 1));
      for (const row of rows) {
        expect(row.after).toBe(row.before);
      }
      expect(rows.filter(({ after }) => after !== null)).toHaveLength(
        2 * KEYS.length,
      );
    });

    it("is null for a missing file, and for every file until the api has stored the key", async () => {
      const signatures = () =>
        postgres.query<Array<{ signature: string | null }>>(
          `SELECT public.file_url_signature(key, public_file) AS signature
             FROM unnest(ARRAY['clips/a.mp4', NULL]::text[]) AS key,
                  unnest(ARRAY[true, false]) AS public_file
            ORDER BY key NULLS LAST, public_file`,
        );

      expect((await signatures()).map(({ signature }) => signature)).toEqual([
        expect.stringMatching(/^exp=\d+&sig=[A-Za-z0-9_-]{43}$/),
        expect.stringMatching(/^exp=\d+&sig=[A-Za-z0-9_-]{43}$/),
        null,
        null,
      ]);

      await postgres.query("DELETE FROM private.file_url_signing_key");
      try {
        expect((await signatures()).map(({ signature }) => signature)).toEqual([
          null,
          null,
          null,
          null,
        ]);
      } finally {
        await signing.storeKey();
      }
    });
  });

  describe("a clip's links", () => {
    it.each(["public", "private", "match"] as const)(
      "verify for the %s clip's own file and thumbnail with the derived key",
      async (visibility) => {
        const row = await clip(visibility);
        const { download, thumbnail } = await links(row.id);

        expect(download).toMatch(
          new RegExp(
            `^https://cf\\.example\\.test/${escape(row.file)}\\?name=Ace-on-B\\.mp4&v=\\d+&exp=\\d+&sig=[A-Za-z0-9_-]{43}$`,
          ),
        );
        expect(thumbnail).toMatch(
          new RegExp(
            `^https://cf\\.example\\.test/${escape(row.thumbnail)}\\?v=\\d+&exp=\\d+&sig=[A-Za-z0-9_-]{43}$`,
          ),
        );

        const fileLink = signatureOf(download!);
        expect(
          createHmac("sha256", SIGNING_KEY)
            .update(`${row.file}\n${fileLink.exp}`)
            .digest("base64url"),
        ).toBe(fileLink.sig);
        expect(signing.verify(row.file, fileLink.exp, fileLink.sig)).toBe(true);

        const thumbnailLink = signatureOf(thumbnail!);
        expect(
          signing.verify(row.thumbnail, thumbnailLink.exp, thumbnailLink.sig),
        ).toBe(true);
        expect(
          signing.verify(row.file, thumbnailLink.exp, thumbnailLink.sig),
        ).toBe(false);
      },
    );

    // Bucketed, so a link stays the same for a whole bucket and caches, and
    // always has at least a bucket left to run. A year, so a link already
    // embedded on Discord or Twitter keeps working.
    it("lets a public clip's link run a year or two", async () => {
      const { download, thumbnail } = await links((await clip("public")).id);

      for (const url of [download!, thumbnail!]) {
        expect(Number(signatureOf(url).exp) % ONE_YEAR).toBe(0);
        expect(expiresIn(url)).toBeGreaterThan(ONE_YEAR);
        expect(expiresIn(url)).toBeLessThanOrEqual(2 * ONE_YEAR);
      }
    });

    it.each(["private", "match"] as const)(
      "lets a %s clip's link run only six to twelve hours",
      async (visibility) => {
        const { download, thumbnail } = await links(
          (await clip(visibility)).id,
        );

        for (const url of [download!, thumbnail!]) {
          expect(Number(signatureOf(url).exp) % SIX_HOURS).toBe(0);
          expect(expiresIn(url)).toBeGreaterThan(SIX_HOURS);
          expect(expiresIn(url)).toBeLessThanOrEqual(2 * SIX_HOURS);
        }
      },
    );

    it("reaches a match clip's players through Hasura, and no other signed-in player", async () => {
      const { matchId, mapId } = await fx.bareMatch();
      const player = await fx.player();
      const stranger = await fx.player();
      await postgres.query(
        `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
         SELECT lineup_1_id, $2::bigint FROM matches WHERE id = $1`,
        [matchId, player],
      );
      const row = await clip("match", mapId);

      const linksAs = async (steamId: string) => {
        const params: Array<unknown> = [];
        const filter = await new HasuraPermissions(postgres).where(
          "match_clips",
          "select",
          "c",
          { role: "user", userId: steamId },
          params,
        );
        const rows = await postgres.query<Array<{ url: string }>>(
          `SELECT public.clip_download_url(c) AS url
             FROM match_clips c
            WHERE c.id = $${params.length + 1} AND ${filter}`,
          [...(params as Array<string>), row.id],
        );
        return rows.map(({ url }) => url);
      };

      const [link] = await linksAs(player);
      const { exp, sig } = signatureOf(link);
      expect(signing.verify(row.file, exp, sig)).toBe(true);
      expect(expiresIn(link)).toBeLessThanOrEqual(2 * SIX_HOURS);

      expect(await linksAs(stranger)).toEqual([]);
    });

    // Hasura evaluates a computed field only on the rows a role's filter lets
    // through, on every path to the table: relationships and aggregate nodes
    // apply the same filter. So a link can only escape through a role whose
    // filter does not check who may see the file, or through SQL that calls
    // the link functions outside a computed field.
    it("is minted only by the link fields, behind filters that check who may see the file", async () => {
      const metadata = join(
        process.cwd(),
        "hasura",
        "metadata",
        "databases",
        "default",
      );
      const LINK_FIELDS: Record<string, Array<string>> = {
        match_clips: ["download_url", "thumbnail_download_url"],
        utility_lineups: [
          "preview_url",
          "preview_thumbnail_url",
          "preview_stills_url",
          "smoke_voxels_url",
        ],
      };
      const LINK_FUNCTIONS = [
        "clip_download_url",
        "clip_thumbnail_download_url",
        "utility_lineup_preview_url",
        "utility_lineup_preview_thumbnail_url",
        "utility_lineup_preview_stills_url",
        "utility_lineup_smoke_voxels_url",
        "_utility_lineup_preview_stills_url",
        "_utility_lineup_versioned_file_url",
        "_utility_lineup_file_url",
        "file_url_signature",
      ];

      for (const file of readdirSync(join(metadata, "tables"))) {
        const table = yaml.load(
          readFileSync(join(metadata, "tables", file), "utf8"),
        ) as {
          table?: { name: string };
          computed_fields?: Array<{
            name: string;
            definition: { function: { name: string } };
          }>;
          select_permissions?: Array<{
            role: string;
            permission: { filter: unknown; computed_fields?: Array<string> };
          }>;
        };
        const name = table?.table?.name ?? "";
        for (const field of table?.computed_fields ?? []) {
          if (LINK_FUNCTIONS.includes(field.definition.function.name)) {
            expect(LINK_FIELDS[name] ?? []).toContain(field.name);
          }
        }
        for (const { role, permission } of table?.select_permissions ?? []) {
          const exposed = (permission.computed_fields ?? []).filter((field) =>
            LINK_FIELDS[name]?.includes(field),
          );
          if (exposed.length > 0 && role !== "administrator") {
            expect([name, role, JSON.stringify(permission.filter)]).toEqual([
              name,
              role,
              expect.stringMatching(/visibility|can_view/),
            ]);
          }
        }
      }
      for (const file of readdirSync(join(metadata, "functions"))) {
        const tracked = readFileSync(join(metadata, "functions", file), "utf8");
        for (const fn of LINK_FUNCTIONS) {
          expect(tracked).not.toMatch(new RegExp(`\\b${fn}\\b`));
        }
      }

      const callers = await postgres.query<Array<{ name: string }>>(
        `SELECT p.proname AS name
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND p.prosrc ~ ('\\m(' || array_to_string($1::text[], '|') || ')\\s*\\(')
          ORDER BY 1`,
        [LINK_FUNCTIONS],
      );
      expect(callers.map(({ name }) => name)).toEqual([
        "_utility_lineup_file_url",
        "_utility_lineup_preview_stills_url",
        "_utility_lineup_versioned_file_url",
        "clip_download_url",
        "clip_thumbnail_download_url",
        "utility_lineup_preview_stills_url",
        "utility_lineup_preview_thumbnail_url",
        "utility_lineup_preview_url",
        "utility_lineup_smoke_voxels_url",
      ]);
      const views = await postgres.query<Array<{ name: string }>>(
        `SELECT schemaname || '.' || viewname AS name
           FROM pg_views
          WHERE definition ~ ('\\m(' || array_to_string($1::text[], '|') || ')\\s*\\(')
         UNION ALL
         SELECT schemaname || '.' || matviewname
           FROM pg_matviews
          WHERE definition ~ ('\\m(' || array_to_string($1::text[], '|') || ')\\s*\\(')`,
        [LINK_FUNCTIONS],
      );
      expect(views).toEqual([]);
    });

    // Hasura's migrations container applies these functions and cannot derive
    // the key, so a rollout reaches them before the api has stored it.
    it("goes out unsigned, rather than not at all, until the api has stored the key", async () => {
      const row = await clip("private");
      await postgres.query("DELETE FROM private.file_url_signing_key");
      try {
        const { download, thumbnail } = await links(row.id);
        expect(download).toMatch(
          new RegExp(
            `^https://cf\\.example\\.test/${escape(row.file)}\\?name=Ace-on-B\\.mp4&v=\\d+$`,
          ),
        );
        expect(thumbnail).toMatch(
          new RegExp(
            `^https://cf\\.example\\.test/${escape(row.thumbnail)}\\?v=\\d+$`,
          ),
        );
      } finally {
        await signing.storeKey();
      }

      const { download } = await links(row.id);
      const { exp, sig } = signatureOf(download!);
      expect(signing.verify(row.file, exp, sig)).toBe(true);
    });
  });

  describe("a lineup's links", () => {
    async function lineupLinks(visibility: "Public" | "Private") {
      const author = await fx.player();
      const [{ id }] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_lineups
           (map_name, utility_type, side, technique,
            origin_x, origin_y, origin_z, view_yaw, view_pitch,
            land_x, land_y, land_z, name, author_steam_id, visibility,
            preview_file, preview_thumbnail, preview_stills,
            preview_rendered_at, smoke_voxels_file, smoke_voxels_at)
         VALUES ('de_mirage', 'Smoke', 'TERRORIST', 'Jump',
                 1, 2, 3, 90, -20, 10, 20, 30, 'A main deep', $1::bigint, $2,
                 'clips/utility/l/preview.mp4', 'clips/utility/l/preview.jpg',
                 '{"land": "clips/utility/l/land.jpg"}'::jsonb, now(),
                 'clips/utility/l/smoke.json', now())
         RETURNING id::text AS id`,
        [author, visibility],
      );
      const [row] = await postgres.query<
        Array<{
          preview: string;
          thumbnail: string;
          stills: Record<string, string>;
          smoke: string;
        }>
      >(
        `SELECT public.utility_lineup_preview_url(l) AS preview,
                public.utility_lineup_preview_thumbnail_url(l) AS thumbnail,
                public.utility_lineup_preview_stills_url(l) AS stills,
                public.utility_lineup_smoke_voxels_url(l) AS smoke
           FROM utility_lineups l WHERE l.id = $1::uuid`,
        [id],
      );
      const urls = [row.preview, row.thumbnail, row.stills.land, row.smoke];
      for (const url of urls) {
        const link = new URL(url);
        const { exp, sig } = signatureOf(url);
        expect(link.origin).toBe("https://cf.example.test");
        expect(signing.verify(link.pathname.slice(1), exp, sig)).toBe(true);
      }
      return urls;
    }

    it("lets a public lineup's files run a year or two", async () => {
      for (const url of await lineupLinks("Public")) {
        expect(Number(signatureOf(url).exp) % ONE_YEAR).toBe(0);
        expect(expiresIn(url)).toBeGreaterThan(ONE_YEAR);
        expect(expiresIn(url)).toBeLessThanOrEqual(2 * ONE_YEAR);
      }
    });

    it("lets a private lineup's files run only six to twelve hours", async () => {
      for (const url of await lineupLinks("Private")) {
        expect(Number(signatureOf(url).exp) % SIX_HOURS).toBe(0);
        expect(expiresIn(url)).toBeGreaterThan(SIX_HOURS);
        expect(expiresIn(url)).toBeLessThanOrEqual(2 * SIX_HOURS);
      }
    });
  });

  // A panel without the worker serves the same links from the api on the
  // demos domain, by the clip's id, and checks the same signature.
  describe("without a Cloudflare worker", () => {
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

    function api() {
      const s3 = {
        stat: jest.fn().mockResolvedValue({ size: 4 }),
        get: jest.fn(async () => Readable.from([Buffer.alloc(4)])),
      };
      const hasura = {
        query: async (request: {
          match_clips_by_pk: { __args: { id: string } };
        }) => {
          const [row] = await postgres.query<
            Array<{ file: string; thumbnail_url: string }>
          >("SELECT file, thumbnail_url FROM match_clips WHERE id = $1", [
            request.match_clips_by_pk.__args.id,
          ]);
          return { match_clips_by_pk: row ?? null };
        },
      };
      const controller = new ClipDownloadController(
        s3 as never,
        hasura as never,
        postgres,
        null as never,
        signing,
        new Logger("SignedFileUrlsTest"),
      );

      const send = async (url: string) => {
        const link = new URL(url);
        const [, , clipId, part] = link.pathname.split("/");
        const response: any = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        response.statusCode = 200;
        response.setHeader = jest.fn();
        response.getHeader = jest.fn();
        response.status = (code: number) => {
          response.statusCode = code;
          return response;
        };
        response.json = () => response.end();
        const finished = new Promise((resolve) =>
          response.on("finish", resolve),
        );
        const request = {
          method: "GET",
          query: Object.fromEntries(link.searchParams),
          headers: { "user-agent": "Discordbot/2.0" },
        } as never;
        const exp = link.searchParams.get("exp") ?? undefined;
        const sig = link.searchParams.get("sig") ?? undefined;

        if (part === "thumbnail") {
          await controller.thumbnail(clipId, exp, sig, request, response);
        } else {
          await controller.download(
            clipId,
            undefined,
            undefined,
            exp,
            sig,
            request,
            response,
          );
        }
        await finished;
        return response.statusCode;
      };

      return { s3, send };
    }

    it("serves a private clip on the links its computed fields signed, and on nothing less", async () => {
      const row = await clip("private");
      const { download, thumbnail } = await links(row.id);
      const { s3, send } = api();

      expect(download).toMatch(
        new RegExp(`^https://demos\\.example\\.test/clips/${row.id}\\?`),
      );
      expect(thumbnail).toMatch(
        new RegExp(
          `^https://demos\\.example\\.test/clips/${row.id}/thumbnail\\?`,
        ),
      );

      expect(await send(download!)).toBe(200);
      expect(await send(thumbnail!)).toBe(200);
      expect(s3.stat.mock.calls.map(([key]) => key)).toEqual([
        row.file,
        row.thumbnail,
      ]);

      s3.stat.mockClear();
      const bare = (url: string) => {
        const link = new URL(url);
        link.searchParams.delete("exp");
        link.searchParams.delete("sig");
        return link.toString();
      };
      expect(await send(bare(download!))).toBe(403);
      expect(await send(bare(thumbnail!))).toBe(403);
      const { exp, sig } = signatureOf(download!);
      expect(
        await send(
          `https://demos.example.test/clips/${row.id}/thumbnail?exp=${exp}&sig=${sig}`,
        ),
      ).toBe(403);
      expect(s3.stat).not.toHaveBeenCalled();
    });
  });
});
