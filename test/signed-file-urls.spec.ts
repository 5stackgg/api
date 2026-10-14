import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Readable, Writable } from "stream";
import { PostgresService } from "../src/postgres/postgres.service";
import { ClipDownloadController } from "../src/matches/clips/clip-download.controller";
import { FileUrlSigningService } from "../src/matches/clips/file-url-signing.service";
import { Fixtures } from "./utils/fixtures";
import { HasuraPermissions } from "./utils/hasura-permissions";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

const S3_SECRET = "bucket-secret";
const SIX_HOURS = 6 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

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

  async function clip(visibility: "public" | "private" | "match") {
    const { mapId } = await fx.bareMatch();
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
    // always has at least a bucket left to run.
    it("lets a public clip's link run a week or two", async () => {
      const { download } = await links((await clip("public")).id);

      expect(Number(signatureOf(download!).exp) % SEVEN_DAYS).toBe(0);
      expect(expiresIn(download!)).toBeGreaterThan(SEVEN_DAYS);
      expect(expiresIn(download!)).toBeLessThanOrEqual(2 * SEVEN_DAYS);
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

    it("is only minted for clips the role can read", async () => {
      const shown = await clip("public");
      const hidden = await clip("private");
      const params: Array<unknown> = [];
      const guest = await new HasuraPermissions(postgres).where(
        "match_clips",
        "select",
        "c",
        { role: "guest", userId: "" },
        params,
      );

      const rows = await postgres.query<Array<{ id: string; url: string }>>(
        `SELECT c.id, public.clip_download_url(c) AS url
           FROM match_clips c
          WHERE c.id = ANY($${params.length + 1}::uuid[]) AND ${guest}`,
        [...(params as Array<string>), [shown.id, hidden.id]],
      );

      expect(rows.map((row) => row.id)).toEqual([shown.id]);
    });

    it("is not given out before the api has stored the key", async () => {
      const row = await clip("public");
      await postgres.query("DELETE FROM private.file_url_signing_key");
      try {
        expect(await links(row.id)).toEqual({
          download: null,
          thumbnail: null,
        });
      } finally {
        await signing.storeKey();
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
