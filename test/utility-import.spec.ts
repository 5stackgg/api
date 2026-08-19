import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { UtilityImportService } from "./../src/utility/utility-import.service";
import { UtilityLineupsService } from "./../src/utility/utility-lineups.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Seeding writes lineups nobody on this platform ever threw, so the properties
// worth pinning are the ones that keep an operator in control of that: it is
// off unless switched on, a preview writes nothing, a re-run updates rather
// than duplicates, one unusable row does not take the batch with it, and the
// whole thing comes back out in a single call.
describe("utility lineup seeding (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let removed: Array<string>;

  const ORIGIN = { x: -1912, y: 922, z: -167 };
  const LAND = { x: -560, y: 320, z: -140 };

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityImportTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199670000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    removed = [];
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "UPDATE settings SET value = 'true' WHERE name = 'public.utility_import_enabled'",
    );
  });

  const admin = (steamId: string): User =>
    ({ steam_id: steamId, role: "administrator", name: "op" }) as User;
  const player = (steamId: string): User =>
    ({ steam_id: steamId, role: "user", name: "player" }) as User;

  function service(): UtilityImportService {
    return new UtilityImportService(new Logger("UtilityImportTest"), postgres, {
      removeTrajectories: jest.fn(async (id: string): Promise<void> => {
        removed.push(id);
      }),
    } as unknown as never);
  }

  const entry = (over: Record<string, unknown> = {}) => ({
    id: "a-1",
    map: "de_mirage",
    type: "smoke",
    side: "t",
    technique: "jumpthrow",
    strength: "left",
    origin: ORIGIN,
    land: LAND,
    view_yaw: 133.7,
    view_pitch: -12.4,
    ...over,
  });

  const rows = async () =>
    await postgres.query<
      Array<{
        id: string;
        external_id: string | null;
        origin_source: string;
        confidence: string;
        verified_at: Date | null;
        source_url: string | null;
        name: string;
        map_name: string;
        utility_type: string;
        side: string;
        technique: string;
        throw_strength: string | null;
        visibility: string;
        land_x: number;
        author_steam_id: string;
      }>
    >(
      `SELECT id::text AS id, external_id, origin_source, confidence, verified_at,
              source_url, name, map_name, utility_type, side, technique,
              throw_strength, visibility, land_x,
              author_steam_id::text AS author_steam_id
         FROM utility_lineups ORDER BY external_id`,
    );

  describe("who may run it", () => {
    it("is administrators only", async () => {
      const who = await fx.player();

      await expect(
        service().importLineups(player(who), { payload: [entry()] }),
      ).rejects.toThrow("administrator");
    });

    it("refuses while the setting is off", async () => {
      const op = await fx.player();
      await postgres.query(
        "UPDATE settings SET value = 'false' WHERE name = 'public.utility_import_enabled'",
      );

      await expect(
        service().importLineups(admin(op), { payload: [entry()] }),
      ).rejects.toThrow("disabled");
    });

    // A setting nobody has written is not consent. An install that predates the
    // seed, or one whose row was deleted, must read as off rather than as
    // unconfigured-therefore-allowed.
    it("refuses when the setting has never been written", async () => {
      const op = await fx.player();
      await postgres.query(
        "DELETE FROM settings WHERE name = 'public.utility_import_enabled'",
      );

      await expect(
        service().importLineups(admin(op), { payload: [entry()] }),
      ).rejects.toThrow("disabled");

      await postgres.query(
        "INSERT INTO settings (name, value) VALUES ('public.utility_import_enabled', 'true')",
      );
    });
  });

  describe("what it writes", () => {
    it("maps an entry onto a low-confidence, unverified lineup", async () => {
      const op = await fx.player();

      const result = await service().importLineups(admin(op), {
        payload: [entry()],
      });

      expect(result).toMatchObject({
        dry_run: false,
        total: 1,
        imported: 1,
        updated: 0,
        failed: 0,
        errors: [],
      });

      const [row] = await rows();
      expect(row.external_id).toBe("a-1");
      expect(row.origin_source).toBe("import");
      // No engine seed came with it, so the confidence trigger grades it the
      // weakest claim in the enum. Nothing here fights that.
      expect(row.confidence).toBe("low");
      expect(row.verified_at).toBeNull();
      // Only what the entry actually described. Nothing is invented to fill a
      // column in, so the ones the payload said nothing about stay empty.
      expect(row.source_url).toBeNull();
      expect(row.map_name).toBe("de_mirage");
      expect(row.utility_type).toBe("Smoke");
      expect(row.side).toBe("TERRORIST");
      expect(row.technique).toBe("Jump");
      expect(row.throw_strength).toBe("Full");
      expect(row.visibility).toBe("Public");
      expect(row.author_steam_id).toBe(op);
      expect(row.name).toBe("Smoke de_mirage (a-1)");
    });

    it("takes the visibility the operator asked for", async () => {
      const op = await fx.player();

      await service().importLineups(admin(op), {
        payload: { visibility: "Private", lineups: [entry()] },
      });

      expect((await rows())[0].visibility).toBe("Private");
    });

    it("refuses a visibility with no team behind it", async () => {
      const op = await fx.player();

      await expect(
        service().importLineups(admin(op), {
          payload: { visibility: "Team", lineups: [entry()] },
        }),
      ).rejects.toThrow("Public or Private");
    });

    it("reads the shapes an export can plausibly be in", async () => {
      const op = await fx.player();

      const result = await service().importLineups(admin(op), {
        payload: {
          entries: [
            entry({ id: "vec-array", origin: [ORIGIN.x, ORIGIN.y, ORIGIN.z] }),
            entry({
              id: "flat",
              origin: null,
              origin_x: ORIGIN.x,
              origin_y: ORIGIN.y,
              origin_z: ORIGIN.z,
            }),
            entry({
              id: "grouped-angles",
              view_yaw: null,
              view_pitch: null,
              view: { yaw: 12, pitch: -3 },
            }),
            entry({
              id: "engine-order-angles",
              view_yaw: null,
              view_pitch: null,
              angles: [-3, 12],
            }),
            entry({ id: "aliases", map_name: "de_mirage", grenade: "HE" }),
          ],
        },
      });

      expect(result.failed).toBe(0);
      expect(result.imported).toBe(5);

      const [, , , , grenade] = await rows();
      expect(grenade.external_id).toBe("vec-array");

      const [angles] = await postgres.query<
        Array<{ view_yaw: number; view_pitch: number }>
      >(
        "SELECT view_yaw, view_pitch FROM utility_lineups WHERE external_id = 'engine-order-angles'",
      );
      expect(Number(angles.view_yaw)).toBeCloseTo(12, 5);
      expect(Number(angles.view_pitch)).toBeCloseTo(-3, 5);
    });
  });

  describe("idempotency", () => {
    it("updates on a re-run rather than duplicating", async () => {
      const op = await fx.player();
      const seeder = service();

      await seeder.importLineups(admin(op), { payload: [entry()] });
      const second = await seeder.importLineups(admin(op), {
        payload: [entry({ land: { ...LAND, x: LAND.x + 12 } })],
      });

      expect(second).toMatchObject({ imported: 0, updated: 1, failed: 0 });

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(Number(all[0].land_x)).toBeCloseTo(LAND.x + 12, 5);
    });

    it("refuses two entries in one payload claiming the same id", async () => {
      const op = await fx.player();

      const result = await service().importLineups(admin(op), {
        payload: [entry(), entry({ land: { ...LAND, x: LAND.x + 900 } })],
      });

      expect(result.imported).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({
        index: 1,
        external_id: "a-1",
      });
      expect(result.errors[0].reason).toMatch(/already claims that id/);
      expect(await rows()).toHaveLength(1);
    });
  });

  describe("a preview", () => {
    it("reports what would happen and writes nothing", async () => {
      const op = await fx.player();
      const seeder = service();

      const preview = await seeder.importLineups(admin(op), {
        payload: [entry(), entry({ id: "a-2", map: "de_notamap" })],
        dry_run: true,
      });

      expect(preview).toMatchObject({
        dry_run: true,
        total: 2,
        imported: 1,
        updated: 0,
        failed: 1,
      });
      expect(preview.errors[0].reason).toMatch(/not an installed map/);
      expect(await rows()).toHaveLength(0);
    });

    it("counts a re-run as an update before it writes one", async () => {
      const op = await fx.player();
      const seeder = service();

      await seeder.importLineups(admin(op), { payload: [entry()] });

      const preview = await seeder.importLineups(admin(op), {
        payload: [entry()],
        dry_run: true,
      });

      expect(preview).toMatchObject({ imported: 0, updated: 1 });
    });
  });

  describe("per-entry validation", () => {
    it("reports each bad row and lands the good ones", async () => {
      const op = await fx.player();

      const result = await service().importLineups(admin(op), {
        payload: [
          entry({ id: "ok" }),
          entry({ id: null }),
          entry({ id: "no-map", map: "de_notamap" }),
          entry({ id: "no-type", type: null }),
          entry({ id: "odd-type", type: "banana" }),
          entry({ id: "no-origin", origin: null }),
          entry({ id: "no-pitch", view_pitch: null }),
          entry({ id: "steep", view_pitch: -140 }),
          // The same bounds POST /utility/ingest enforces, shared rather than
          // restated: a coordinate off the map, and a throw further than a
          // grenade travels.
          entry({ id: "off-map", land: { ...LAND, x: 40000 } }),
          entry({ id: "too-far", land: { ...LAND, x: LAND.x + 9000 } }),
          "nonsense",
          entry({ id: "ok-2", land: { ...LAND, x: LAND.x + 800 } }),
        ],
      });

      expect(result.total).toBe(12);
      expect(result.imported).toBe(2);
      expect(result.failed).toBe(10);

      const reasons = Object.fromEntries(
        result.errors.map((error) => [error.external_id ?? "?", error.reason]),
      );

      expect(reasons["?"]).toMatch(/no id|not an object/);
      expect(reasons["no-map"]).toMatch(/not an installed map/);
      expect(reasons["no-type"]).toMatch(/no grenade type/);
      expect(reasons["odd-type"]).toMatch(/not a grenade type/);
      expect(reasons["no-origin"]).toMatch(/no origin/);
      expect(reasons["no-pitch"]).toMatch(/no view_pitch/);
      expect(reasons["steep"]).toMatch(/view_pitch is out of range/);
      expect(reasons["off-map"]).toMatch(/outside the map/);
      expect(reasons["too-far"]).toMatch(
        /further apart than a grenade travels/,
      );

      expect((await rows()).map((row) => row.external_id)).toEqual([
        "ok",
        "ok-2",
      ]);
    });

    it("uses the same coordinate ceiling as the ingest door", async () => {
      const op = await fx.player();

      const result = await service().importLineups(admin(op), {
        payload: [
          entry({
            id: "edge",
            land: { ...LAND, x: UtilityLineupsService.MAX_COORD + 1 },
          }),
        ],
      });

      expect(result.failed).toBe(1);
      expect(await rows()).toHaveLength(0);
    });

    it("refuses a payload that is not a list at all", async () => {
      const op = await fx.player();

      await expect(
        service().importLineups(admin(op), { payload: { nope: true } }),
      ).rejects.toThrow("not a list of lineups");
    });

    it("refuses a payload past the batch ceiling", async () => {
      const op = await fx.player();
      const many = Array.from(
        { length: UtilityImportService.MAX_ENTRIES + 1 },
        (_, index) => entry({ id: `bulk-${index}` }),
      );

      await expect(
        service().importLineups(admin(op), { payload: many }),
      ).rejects.toThrow("split it");
    });
  });

  describe("undoing it", () => {
    async function seeded(op: string) {
      await service().importLineups(admin(op), {
        payload: [entry(), entry({ id: "a-2", land: { ...LAND, x: -1400 } })],
      });

      await postgres.query(
        `INSERT INTO utility_lineups
           (map_name, utility_type, side, technique, origin_x, origin_y, origin_z,
            view_yaw, view_pitch, land_x, land_y, land_z, name,
            author_steam_id, origin_source)
         VALUES ('de_mirage', 'Smoke', 'CT', 'Jump', $1, $2, $3, 10, -5,
                 $4, $5, $6, 'hand made', $7::bigint, 'editor')`,
        [ORIGIN.x, ORIGIN.y, ORIGIN.z, LAND.x, LAND.y, LAND.z, op],
      );
    }

    it("takes a whole source back out in one call", async () => {
      const op = await fx.player();
      await seeded(op);

      const purged = await service().purgeSource(admin(op), {
        origin_source: "import",
      });

      expect(purged).toEqual({
        dry_run: false,
        origin_source: "import",
        lineups: 2,
      });

      const left = await rows();
      expect(left).toHaveLength(1);
      expect(left[0].origin_source).toBe("editor");
    });

    it("counts without deleting on a preview", async () => {
      const op = await fx.player();
      await seeded(op);

      const purged = await service().purgeSource(admin(op), {
        origin_source: "import",
        dry_run: true,
      });

      expect(purged).toEqual({
        dry_run: true,
        origin_source: "import",
        lineups: 2,
      });
      expect(await rows()).toHaveLength(3);
    });

    it("clears the S3 artifacts of a source that has them", async () => {
      const op = await fx.player();
      await seeded(op);
      await postgres.query(
        "UPDATE utility_lineups SET trajectory_file = 'key' WHERE origin_source = 'editor'",
      );

      await service().purgeSource(admin(op), { origin_source: "editor" });

      expect(removed).toHaveLength(1);
      // A seeded lineup never had one, so purging that source touches nothing.
      expect(await rows()).toHaveLength(2);
    });

    it("refuses a source that is not one", async () => {
      const op = await fx.player();

      await expect(
        service().purgeSource(admin(op), { origin_source: "somewhere" }),
      ).rejects.toThrow("not a lineup source");
    });

    it("is administrators only", async () => {
      const who = await fx.player();

      await expect(
        service().purgeSource(player(who), { origin_source: "import" }),
      ).rejects.toThrow("administrator");
    });
  });
});
