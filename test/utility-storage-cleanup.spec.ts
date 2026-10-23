import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { S3ScanService } from "./../src/s3-scan/s3-scan.service";
import { UtilityArtifactsService } from "./../src/utility/utility-artifacts.service";
import { UtilityLineupsService } from "./../src/utility/utility-lineups.service";
import { UtilityImportService } from "./../src/utility/utility-import.service";
import { User } from "./../src/auth/types/User";
import { UtilityCalloutsService } from "./../src/utility/utility-callouts.service";
import { UtilityPendingLineup } from "./../src/utility/utility-load.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// A lineup's preview clip, thumbnail, stills, recorded smoke and trajectory
// are S3 objects only its own row (and its render rows) name. The scan has to
// know every one of them, or "Delete all orphaned" takes down the library's
// live previews; and deleting a lineup has to take every one of them with it.
describe("utility lineup storage (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let author: string;

  let bucket: Map<string, number>;
  let report: Buffer | null;
  let refused: Set<string>;
  let swept: Array<string>;
  let refuseSweep: (prefix: string) => boolean;
  let duringSweep: () => Promise<void>;

  const s3 = {
    bucketName: "5stack",
    listStream: async function* () {
      for (const [name, size] of bucket) {
        yield { name, size };
      }
    },
    put: async (_key: string, body: Buffer) => {
      report = body;
    },
    has: async () => report !== null,
    get: async () => [report],
    removeKeys: async (keys: Array<string>) =>
      keys.filter((key) => {
        if (refused.has(key)) {
          return false;
        }
        bucket.delete(key);
        return true;
      }),
    removePrefixStrictly: async (prefix: string) => {
      if (refuseSweep(prefix)) {
        throw new Error("AccessDenied");
      }
      await duringSweep();
      swept.push(prefix);
      for (const key of [...bucket.keys()]) {
        if (key.startsWith(prefix)) {
          bucket.delete(key);
        }
      }
      return 0;
    },
  };

  const scanner = () =>
    new S3ScanService(
      new Logger("UtilityStorageTest"),
      s3 as unknown as never,
      postgres,
      { send: jest.fn() } as unknown as never,
    );

  const artifacts = () =>
    new UtilityArtifactsService(
      new Logger("UtilityStorageTest"),
      s3 as unknown as never,
      postgres,
      {} as unknown as never,
    );

  const lineups = () =>
    new UtilityLineupsService(
      new Logger("UtilityStorageTest"),
      postgres,
      artifacts(),
      {
        get: jest.fn(async (_key: string, fallback?: unknown) => fallback),
        put: jest.fn(async (): Promise<boolean> => true),
        forget: jest.fn(async (): Promise<boolean> => true),
      } as unknown as never,
      {
        pending: jest.fn(async (): Promise<Array<UtilityPendingLineup>> => []),
      } as unknown as never,
      new UtilityCalloutsService(new Logger("UtilityStorageTest"), postgres),
    );

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityStorageTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199720000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    bucket = new Map();
    report = null;
    refused = new Set();
    swept = [];
    refuseSweep = () => false;
    duringSweep = async () => undefined;
    await postgres.query("DELETE FROM utility_lineup_renders");
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM players");
    author = await fx.player();
  });

  async function lineup(source = "plugin") {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_lineups
         (map_name, utility_type, side, technique,
          origin_x, origin_y, origin_z, view_yaw, view_pitch,
          land_x, land_y, land_z, name, author_steam_id, visibility,
          origin_source)
       VALUES ('de_mirage', 'Smoke', 'TERRORIST', 'Jump',
               1, 2, 3, 90, -20, 10, 20, 30, 'A main deep', $1::bigint, 'Public',
               $2)
       RETURNING id::text AS id`,
      [author, source],
    );
    return row.id;
  }

  async function render(lineupId: string, status: string) {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_lineup_renders
         (utility_lineup_id, map_name, session_token, spec, status)
       VALUES ($1::uuid, 'de_mirage', 'tok', '{}'::jsonb, $2)
       RETURNING id::text AS id`,
      [lineupId, status],
    );
    return row.id;
  }

  // A lineup on show in the library: filmed by `live`, smoke recorded, flown.
  async function filmed(id: string, live: string) {
    await postgres.query(
      `UPDATE utility_lineups
          SET preview_file = $2,
              preview_thumbnail = $3,
              preview_stills = $4::jsonb,
              smoke_voxels_file = $5,
              trajectory_file = $6
        WHERE id = $1::uuid`,
      [
        id,
        `clips/utility/${id}/${live}.mp4`,
        `clips/utility/${id}/${live}.jpg`,
        JSON.stringify({ aim: `clips/utility/${id}/${live}/aim.webp` }),
        `clips/utility/${id}.smoke.2.json`,
        `utility/${id}/trajectory.v3.2.json.gz`,
      ],
    );
    return [
      `clips/utility/${id}/${live}.mp4`,
      `clips/utility/${id}/${live}.jpg`,
      `clips/utility/${id}/${live}/aim.webp`,
      `clips/utility/${id}.smoke.2.json`,
      `utility/${id}/trajectory.v3.2.json.gz`,
    ];
  }

  const store = (...keys: Array<string>) => {
    for (const key of keys) {
      bucket.set(key, 1000);
    }
  };

  describe("the orphaned uploads scan", () => {
    it("counts a filmed lineup's files, and a render still in flight, as tracked", async () => {
      const id = await lineup();
      const live = await render(id, "done");
      const filming = await render(id, "rendering");
      const showing = await filmed(id, live);
      store(...showing, `clips/utility/${id}/${filming}/stance.webp`);

      const result = await scanner().scan();

      expect(result.orphans).toEqual([]);
      expect(result.tracked_objects).toBe(showing.length + 1);
    });

    it("keeps a failed render's files until its row is cleared", async () => {
      const id = await lineup();
      const failed = await render(id, "error");
      store(`clips/utility/${id}/${failed}/aim.webp`);

      expect((await scanner().scan()).orphans).toEqual([]);
    });

    it("keeps a live preview whose render row the queue already cleared", async () => {
      const id = await lineup();
      store(...(await filmed(id, "0b1d3f5e-0000-4000-8000-000000000001")));

      expect((await scanner().scan()).orphans).toEqual([]);
    });

    it("finds the files of a lineup that is gone, and the ones a re-render replaced", async () => {
      const id = await lineup();
      const live = await render(id, "done");
      store(...(await filmed(id, live)));

      const gone = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
      const replaced = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
      const orphans = [
        `clips/utility/${gone}/${replaced}.mp4`,
        `clips/utility/${gone}/${replaced}/landing.webp`,
        `clips/utility/${gone}.smoke.1.json`,
        `utility/${gone}/trajectory.v3.1.json.gz`,
        `clips/utility/${id}/${replaced}.mp4`,
        `clips/utility/${id}.smoke.1.json`,
        `clips/utility/${id}.mp4`,
      ];
      store(...orphans);

      const result = await scanner().scan();

      expect(result.orphans.map((orphan) => orphan.key).sort()).toEqual(
        [...orphans].sort(),
      );
    });

    it("never deletes a file a lineup took up after the scan", async () => {
      const id = await lineup();
      store(`clips/utility/${id}.smoke.1.json`);
      const scan = scanner();
      await scan.scan();

      await postgres.query(
        "UPDATE utility_lineups SET smoke_voxels_file = $2 WHERE id = $1::uuid",
        [id, `clips/utility/${id}.smoke.1.json`],
      );
      const deleted = await scan.deleteOrphans();

      expect(deleted.deleted).toBe(0);
      expect(bucket.has(`clips/utility/${id}.smoke.1.json`)).toBe(true);
    });

    it("keeps reporting an orphan the store refused to delete", async () => {
      const gone = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
      store(`clips/utility/${gone}.mp4`, `clips/utility/${gone}.jpg`);
      refused.add(`clips/utility/${gone}.jpg`);
      const scan = scanner();
      await scan.scan();

      const deleted = await scan.deleteOrphans();

      expect(deleted).toEqual({
        deleted: 1,
        bytes_freed: 1000,
        remaining_orphans: 1,
      });
      expect((await scan.getResult())?.orphans).toEqual([
        { key: `clips/utility/${gone}.jpg`, size: 1000 },
      ]);
    });
  });

  describe("deleting a lineup", () => {
    it("takes every file the lineup and its renders put in S3", async () => {
      const id = await lineup();
      const live = await render(id, "done");
      const failed = await render(id, "error");
      store(
        ...(await filmed(id, live)),
        `clips/utility/${id}/${failed}/aim.webp`,
        `clips/utility/${id}.smoke.1.json`,
      );

      await lineups().deleteLineup(id, author);

      expect(bucket.size).toBe(0);
      const rows = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM utility_lineups WHERE id = $1::uuid",
        [id],
      );
      expect(rows).toEqual([]);
    });

    it("keeps the lineup when its files could not be removed", async () => {
      const id = await lineup();
      const live = await render(id, "done");
      store(...(await filmed(id, live)));
      refuseSweep = () => true;

      await expect(lineups().deleteLineup(id, author)).rejects.toThrow(
        /AccessDenied/,
      );

      const rows = await postgres.query<Array<{ preview_file: string }>>(
        "SELECT preview_file FROM utility_lineups WHERE id = $1::uuid",
        [id],
      );
      expect(rows).toEqual([
        { preview_file: `clips/utility/${id}/${live}.mp4` },
      ]);
    });

    it("sweeps the lineup's own id, however the caller spelled it", async () => {
      const id = await lineup();
      const live = await render(id, "done");
      store(...(await filmed(id, live)));

      await lineups().deleteLineup(id.toUpperCase(), author);

      expect(bucket.size).toBe(0);
    });

    it("lets a moderator delete somebody else's lineup, and nobody else", async () => {
      const id = await lineup();
      const stranger = await fx.player();

      await expect(lineups().deleteLineup(id, stranger)).rejects.toThrow(
        /did not author/,
      );
      expect(swept).toEqual([]);

      await lineups().deleteLineup(id, stranger, true);

      expect(swept).toEqual([`utility/${id}/`, `clips/utility/${id}`]);
    });
  });

  describe("purging a source", () => {
    const purge = async () => {
      await postgres.query(
        "UPDATE settings SET value = 'true' WHERE name = 'public.utility_import_enabled'",
      );
      const admin = await fx.player("op", "administrator");
      return new UtilityImportService(
        new Logger("UtilityStorageTest"),
        postgres,
        artifacts(),
      ).purgeSource({ steam_id: admin, role: "administrator" } as User, {
        origin_source: "editor",
      });
    };

    it("takes the files of every lineup it deletes, rendering or not", async () => {
      const filmedOne = await lineup("editor");
      const filming = await lineup("editor");
      const seeded = await lineup("editor");
      const live = await render(filmedOne, "done");
      const inFlight = await render(filming, "rendering");
      store(
        ...(await filmed(filmedOne, live)),
        `clips/utility/${filming}/${inFlight}/stance.webp`,
      );

      await purge();

      expect(bucket.size).toBe(0);
      expect(swept).not.toContain(`clips/utility/${seeded}`);
      const rows = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM utility_lineups WHERE origin_source = 'editor'",
      );
      expect(rows).toEqual([]);
    });

    it("leaves a lineup that took on a file mid-purge, rather than its file", async () => {
      const filmedOne = await lineup("editor");
      const late = await lineup("editor");
      store(...(await filmed(filmedOne, await render(filmedOne, "done"))));
      duringSweep = async () => {
        await postgres.query(
          "UPDATE utility_lineups SET trajectory_file = $2 WHERE id = $1::uuid",
          [late, `utility/${late}/trajectory.v3.1.json.gz`],
        );
        store(`utility/${late}/trajectory.v3.1.json.gz`);
      };

      await purge();

      const left = await postgres.query<Array<{ id: string }>>(
        "SELECT id::text AS id FROM utility_lineups WHERE origin_source = 'editor'",
      );
      expect(left).toEqual([{ id: late }]);
      expect([...bucket.keys()]).toEqual([
        `utility/${late}/trajectory.v3.1.json.gz`,
      ]);
    });

    it("never leaves a lineup without its files, or files without their lineup", async () => {
      const other = await lineup("editor");
      const refused = await lineup("editor");
      store(...(await filmed(other, await render(other, "done"))));
      store(...(await filmed(refused, await render(refused, "done"))));
      refuseSweep = (prefix) => prefix === `utility/${refused}/`;

      await expect(purge()).rejects.toThrow(/AccessDenied/);

      const left = (
        await postgres.query<Array<{ id: string }>>(
          "SELECT id::text AS id FROM utility_lineups WHERE origin_source = 'editor'",
        )
      ).map((row) => row.id);
      expect(left).toContain(refused);
      for (const id of [refused, other]) {
        const files = [...bucket.keys()].filter((key) => key.includes(id));
        expect(files).toHaveLength(left.includes(id) ? 5 : 0);
      }
    });
  });
});
