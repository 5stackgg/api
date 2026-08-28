import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  UtilityLineupForbidden,
  UtilityLineupsService,
} from "./../src/utility/utility-lineups.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { UtilityPendingLineup } from "./../src/utility/utility-load.service";
import { UtilityCalloutsService } from "./../src/utility/utility-callouts.service";

// Editing a lineup in place, which nothing could do before: the only UPDATE on
// the table set name/description/visibility, and the plugin had ingest and
// delete and nothing between them. What these pin is the line between a rename
// and a different throw -- because the id is what every scored attempt hangs
// off, and moving where a smoke lands quietly turns everybody's hit rate into a
// measurement of something they never threw.
describe("utility lineup edits (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let lineups: UtilityLineupsService;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityEditTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199610000000n);
    lineups = new UtilityLineupsService(
      new Logger("UtilityEditTest"),
      postgres,
      {
        uploadTrajectory: jest.fn(async (): Promise<string> => "key"),
        removeTrajectories: jest.fn(async (): Promise<void> => undefined),
      } as unknown as never,
      {
        get: jest.fn(async (_key: string, fallback?: unknown) => fallback),
        put: jest.fn(async (): Promise<boolean> => true),
        forget: jest.fn(async (): Promise<boolean> => true),
      } as unknown as never,
      {
        pending: jest.fn(async (): Promise<Array<UtilityPendingLineup>> => []),
      } as unknown as never,
      new UtilityCalloutsService(new Logger("UtilityEditTest"), postgres),
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM utility_collections");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const user = (steamId: string, role = "user"): User =>
    ({ steam_id: steamId, role, name: "tester" }) as User;

  const SEED = {
    initial_pos_x: -1900,
    initial_pos_y: 930,
    initial_pos_z: -100,
    initial_vel_x: 500,
    initial_vel_y: 200,
    initial_vel_z: 300,
  };

  async function insertLineup(
    author: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      map_name: "de_mirage",
      utility_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      throw_strength: "Full",
      jump_throw_bind: true,
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      eye_z: -103,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: -560,
      land_y: 320,
      land_z: -140,
      flight_time_ms: 1800,
      name: "Window from T spawn",
      description: "one step left of the box",
      tags: ["execute", "a-site"],
      visibility: "Public",
      author_steam_id: author,
      origin_source: "plugin",
      confidence: "exact",
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

  const rowOf = async (lineupId: string) => {
    const [row] = await postgres.query<Array<Record<string, unknown>>>(
      "SELECT * FROM utility_lineups WHERE id = $1",
      [lineupId],
    );
    return row;
  };

  async function practise(lineupId: string, steamId: string) {
    await postgres.query(
      `INSERT INTO utility_lineup_progress
         (utility_lineup_id, steam_id, attempts, successes, current_streak, best_streak)
       VALUES ($1::uuid, $2::bigint, 9, 7, 3, 5)`,
      [lineupId, steamId],
    );
  }

  const progressCount = async (lineupId: string) => {
    const [row] = await postgres.query<Array<{ count: string }>>(
      "SELECT count(*)::text AS count FROM utility_lineup_progress WHERE utility_lineup_id = $1",
      [lineupId],
    );
    return Number(row.count);
  };

  const GEOMETRY = {
    origin_x: -1912,
    origin_y: 922,
    origin_z: -167,
    eye_z: -103,
    view_yaw: 133.7,
    view_pitch: -12.4,
    land_x: -560,
    land_y: 320,
    land_z: -140,
  };


  it("renames a lineup without touching its id or its history", async () => {
    const AUTHOR = await fx.player();
    const id = await insertLineup(AUTHOR);
    await practise(id, AUTHOR);

    const result = await lineups.updateLineup({
      lineupId: id,
      steamId: AUTHOR,
      name: "Window, one step left",
    });

    expect(result.id).toBe(id);
    expect(result.progress_reset).toBe(false);
    expect((await rowOf(id)).name).toBe("Window, one step left");
    expect(await progressCount(id)).toBe(1);
  });

  // The server key proves which server is asking, never which player. Without
  // this anybody on a practice pod could rewrite anybody else's lineup.
  it("refuses to edit somebody else's lineup", async () => {
    const AUTHOR = await fx.player();
    const SOMEBODY_ELSE = await fx.player();
    const id = await insertLineup(AUTHOR);

    await expect(
      lineups.updateLineup({ lineupId: id, steamId: SOMEBODY_ELSE, name: "mine now" }),
    ).rejects.toThrow(/belongs to somebody else/i);
  });

  // `name` is NOT NULL and the sanitizer answers null for anything that is only
  // whitespace or control characters, so a blank field from the plugin used to
  // reach Postgres as `SET name = NULL` and come back as a raw constraint error.
  it("keeps the name it has when the new one sanitizes away to nothing", async () => {
    const AUTHOR = await fx.player();
    const id = await insertLineup(AUTHOR, { name: "Window Smoke" });

    await lineups.updateLineup({ lineupId: id, steamId: AUTHOR, name: "   " });
    expect((await rowOf(id)).name).toBe("Window Smoke");

    await lineups.updateLineup({ lineupId: id, steamId: AUTHOR, name: "\u0007\u0007" });
    expect((await rowOf(id)).name).toBe("Window Smoke");
  });

  // A 'Public' ask from somebody who cannot approve one is a REQUEST. Setting
  // the visibility without stamping the request drops it silently: the row goes
  // Private, the plugin says "saved", and it never reaches the review queue.
  it("records a non-reviewer's public ask as a request for review", async () => {
    const AUTHOR = await fx.player();
    const id = await insertLineup(AUTHOR);

    await lineups.updateLineup({
      lineupId: id,
      steamId: AUTHOR,
      visibility: "Public",
      role: "user",
    });

    const row = await rowOf(id);
    expect(row.visibility).toBe("Private");
    expect(row.public_requested_at).not.toBeNull();
    expect(row.public_reviewed_by).toBeNull();
  });

  it("publishes outright for a reviewer, and records who reviewed it", async () => {
    const AUTHOR = await fx.player();
    const id = await insertLineup(AUTHOR);

    await lineups.updateLineup({
      lineupId: id,
      steamId: AUTHOR,
      visibility: "Public",
      role: "administrator",
    });

    const row = await rowOf(id);
    expect(row.visibility).toBe("Public");
    expect(String(row.public_reviewed_by)).toBe(AUTHOR);
  });

  // The SET clause interpolates column names, so they come off the service's
  // own list and never off the caller's object.
  it("ignores a geometry key that is not a geometry column", async () => {
    const AUTHOR = await fx.player();
    const id = await insertLineup(AUTHOR);

    await lineups.updateLineup({
      lineupId: id,
      steamId: AUTHOR,
      geometry: {
        origin_x: 1,
        origin_y: 2,
        origin_z: 3,
        eye_z: 4,
        view_yaw: 5,
        view_pitch: 6,
        land_x: 7,
        land_y: 8,
        land_z: 9,
        "name = 'pwned', map_name": 0,
      } as never,
    });

    const row = await rowOf(id);
    expect(row.name).not.toBe("pwned");
    expect(Number(row.origin_x)).toBe(1);
  });

  it("hardens text the same way ingest does", async () => {
    const AUTHOR = await fx.player();
    const id = await insertLineup(AUTHOR);

    await lineups.updateLineup({
      lineupId: id,
      steamId: AUTHOR,
      name: `bad\u0007name`,
      description: "x".repeat(2000),
    });

    const row = await rowOf(id);
    expect(String(row.name)).not.toContain("\u0007");
    expect(String(row.description).length).toBeLessThanOrEqual(1000);
  });

  // Moving the landing point is what makes it a different throw. The recorded
  // flight described the old one, so it stops being served as a measurement of
  // this lineup.
  it("drops the recorded flight and the confidence when the geometry moves", async () => {
    const AUTHOR = await fx.player();
    const id = await insertLineup(AUTHOR, { trajectory_file: "utility/x/t.json.gz" });

    await lineups.updateLineup({
      lineupId: id,
      steamId: AUTHOR,
      geometry: { ...GEOMETRY, land_x: 400 },
    });

    const row = await rowOf(id);
    expect(row.trajectory_file).toBeNull();
    expect(row.confidence).toBe("low");
    expect(Number(row.land_x)).toBe(400);
  });

  it("keeps the author's own record when the landing barely moves", async () => {
    const AUTHOR = await fx.player();
    const id = await insertLineup(AUTHOR);
    await practise(id, AUTHOR);

    const result = await lineups.updateLineup({
      lineupId: id,
      steamId: AUTHOR,
      geometry: { ...GEOMETRY, land_x: GEOMETRY.land_x + 4 },
    });

    expect(result.progress_reset).toBe(false);
    expect(await progressCount(id)).toBe(1);
  });

  it("clears the author's own record when the landing really moves", async () => {
    const AUTHOR = await fx.player();
    const id = await insertLineup(AUTHOR);
    await practise(id, AUTHOR);

    const result = await lineups.updateLineup({
      lineupId: id,
      steamId: AUTHOR,
      geometry: { ...GEOMETRY, land_x: GEOMETRY.land_x + 2000 },
    });

    expect(result.progress_reset).toBe(true);
    expect(await progressCount(id)).toBe(0);
  });

  // The one that matters most. Somebody who has drilled this fifty times did
  // not agree to have that turned into a hit rate against a throw they have
  // never made -- so the move is refused and the caller is sent to fork, which
  // is the answer the panel has always given for the same reason.
  it("refuses to move a lineup somebody else has practised", async () => {
    const AUTHOR = await fx.player();
    const SOMEBODY_ELSE = await fx.player();
    const id = await insertLineup(AUTHOR);
    await practise(id, SOMEBODY_ELSE);

    await expect(
      lineups.updateLineup({
        lineupId: id,
        steamId: AUTHOR,
        geometry: { ...GEOMETRY, land_x: GEOMETRY.land_x + 2000 },
      }),
    ).rejects.toThrow(/fork it instead/i);

    expect(await progressCount(id)).toBe(1);
    expect(Number((await rowOf(id)).land_x)).toBe(GEOMETRY.land_x);
  });

  // The plugin shows a different sentence for each refusal, and it should not
  // have to match on our prose to tell them apart.
  it("names each refusal with a stable code", async () => {
    const AUTHOR = await fx.player();
    const SOMEBODY_ELSE = await fx.player();

    const mine = await insertLineup(AUTHOR);

    await expect(
      lineups.updateLineup({ lineupId: mine, steamId: SOMEBODY_ELSE, name: "x" }),
    ).rejects.toMatchObject({ reason: "not_author" });

    const practised = await insertLineup(AUTHOR);
    await practise(practised, SOMEBODY_ELSE);

    await expect(
      lineups.updateLineup({
        lineupId: practised,
        steamId: AUTHOR,
        geometry: { ...GEOMETRY, land_x: GEOMETRY.land_x + 2000 },
      }),
    ).rejects.toMatchObject({ reason: "already_practised" });
  });

  it("marks a refusal as a refusal rather than a bad request", async () => {
    const AUTHOR = await fx.player();
    const SOMEBODY_ELSE = await fx.player();
    const id = await insertLineup(AUTHOR);

    await expect(
      lineups.updateLineup({ lineupId: id, steamId: SOMEBODY_ELSE, name: "x" }),
    ).rejects.toBeInstanceOf(UtilityLineupForbidden);
  });

  it("refuses a lineup that does not exist", async () => {
    const AUTHOR = await fx.player();

    await expect(
      lineups.updateLineup({
        lineupId: "00000000-0000-4000-8000-000000000000",
        steamId: AUTHOR,
        name: "ghost",
      }),
    ).rejects.toThrow(/does not exist/i);
  });
});
