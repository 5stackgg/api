import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { UtilityLineupsService } from "./../src/utility/utility-lineups.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { UtilityPendingLineup } from "./../src/utility/utility-load.service";

// A fork copies somebody else's throw into your own library. The line these
// pin is what crosses and what does not: the geometry and the physics seed do,
// because the copy is exactly as reproducible as the original; the community's
// opinion of it, a moderator's verification and the original's provenance do
// not, because none of those are facts about the copy.
describe("utility lineup forks (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let lineups: UtilityLineupsService;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityForksTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199610000000n);
    lineups = new UtilityLineupsService(
      new Logger("UtilityForksTest"),
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

  describe("what crosses", () => {
    it("copies the geometry, the classification and the seed", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author, SEED);

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      const original = await rowOf(source);
      const fork = await rowOf(id);

      for (const column of [
        "map_name",
        "utility_type",
        "side",
        "technique",
        "throw_strength",
        "jump_throw_bind",
        "origin_x",
        "origin_y",
        "origin_z",
        "eye_z",
        "view_yaw",
        "view_pitch",
        "land_x",
        "land_y",
        "land_z",
        "flight_time_ms",
        "description",
        "tags",
        "initial_pos_x",
        "initial_pos_y",
        "initial_pos_z",
        "initial_vel_x",
        "initial_vel_y",
        "initial_vel_z",
      ]) {
        expect({ [column]: fork[column] }).toEqual({
          [column]: original[column],
        });
      }

      // Same bucket as the original, so the meta still counts them as one
      // lineup rather than two.
      expect(fork.lineup_bucket).toBe(original.lineup_bucket);
    });

    it("lands private, owned by the forker, pointing at its source", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author);

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      const fork = await rowOf(id);

      expect(fork.visibility).toBe("Private");
      expect(String(fork.author_steam_id)).toBe(forker);
      expect(fork.team_id).toBeNull();
      expect(fork.origin_source).toBe("fork");
      expect(String(fork.forked_from_utility_lineup_id)).toBe(source);
    });

    it("takes the source's name unless given one", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author);

      const kept = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });
      const renamed = await lineups.fork(user(forker), {
        utility_lineup_id: source,
        name: "  My window  ",
      });

      expect((await rowOf(kept.id)).name).toBe("Window from T spawn");
      expect((await rowOf(renamed.id)).name).toBe("My window");
    });
  });

  describe("what does not cross", () => {
    it("leaves the votes, favourites and progress behind", async () => {
      const author = await fx.player();
      const voter = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author);

      await postgres.query(
        "INSERT INTO utility_lineup_votes (utility_lineup_id, steam_id, vote) VALUES ($1, $2, 1)",
        [source, voter],
      );
      await postgres.query(
        "INSERT INTO utility_lineup_favorites (utility_lineup_id, steam_id) VALUES ($1, $2)",
        [source, voter],
      );
      await postgres.query(
        `INSERT INTO utility_lineup_progress (utility_lineup_id, steam_id, attempts, successes)
         VALUES ($1, $2, 12, 9)`,
        [source, voter],
      );

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      const original = await rowOf(source);
      const fork = await rowOf(id);

      expect(Number(original.upvotes)).toBe(1);
      expect(Number(original.favorites)).toBe(1);
      expect(Number(fork.upvotes)).toBe(0);
      expect(Number(fork.downvotes)).toBe(0);
      expect(Number(fork.favorites)).toBe(0);

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        `SELECT
           (SELECT COUNT(*) FROM utility_lineup_votes WHERE utility_lineup_id = $1) +
           (SELECT COUNT(*) FROM utility_lineup_favorites WHERE utility_lineup_id = $1) +
           (SELECT COUNT(*) FROM utility_lineup_progress WHERE utility_lineup_id = $1) AS count`,
        [id],
      );
      expect(Number(count)).toBe(0);
    });

    it("does not inherit a moderator's verification", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author, {
        verified_at: new Date().toISOString(),
      });

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      expect((await rowOf(source)).verified_at).not.toBeNull();
      expect((await rowOf(id)).verified_at).toBeNull();
    });

    it("drops the source match, grenade and external id", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author, {
        source_grenade_id: 42,
        source_url: "https://example.test/utility",
        external_id: "abc-123",
        origin_source: "import",
        confidence: "low",
      });

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      const fork = await rowOf(id);

      expect(fork.source_match_id).toBeNull();
      expect(fork.source_match_map_id).toBeNull();
      expect(fork.source_grenade_id).toBeNull();
      expect(fork.source_url).toBeNull();
      expect(fork.external_id).toBeNull();
    });

    it("does not point at the original's trajectory in S3", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author, {
        trajectory_file: "utility/de_mirage/original.json.gz",
        trajectory_size: 4096,
      });

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      const fork = await rowOf(id);

      // The artifact's key is keyed to the original's id and dies with it, so a
      // shared reference would leave the fork holding a 404.
      expect(fork.trajectory_file).toBeNull();
      expect(fork.trajectory_size).toBeNull();
    });

    it("survives the original being deleted", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author, SEED);

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      await postgres.query("DELETE FROM utility_lineups WHERE id = $1", [source]);

      const fork = await rowOf(id);
      expect(fork).toBeTruthy();
      expect(fork.forked_from_utility_lineup_id).toBeNull();
      expect(Number(fork.initial_vel_x)).toBe(SEED.initial_vel_x);
    });
  });

  describe("confidence", () => {
    // The copy is bit-for-bit as replayable as the original, and the seed is
    // what says so.
    it("keeps exact when the source was measured", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author, SEED);

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      expect((await rowOf(id)).confidence).toBe("exact");
    });

    it("does not upgrade a hand-authored source", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author, {
        origin_source: "editor",
        confidence: "low",
      });

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      expect((await rowOf(id)).confidence).toBe("low");
    });

    it("keeps a demo-mined source derived", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author, {
        origin_source: "demo",
        confidence: "derived",
      });

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
      });

      expect((await rowOf(id)).confidence).toBe("derived");
    });
  });

  describe("visibility", () => {
    it("refuses a lineup the caller cannot see", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      const source = await insertLineup(author, { visibility: "Private" });

      await expect(
        lineups.fork(user(stranger), { utility_lineup_id: source }),
      ).rejects.toThrow("lineup not found");

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM utility_lineups WHERE author_steam_id = $1",
        [stranger],
      );
      expect(Number(count)).toBe(0);
    });

    it("lets a team-mate fork the team's book into their own", async () => {
      const team = await fx.team(1);
      const [mate] = await postgres.query<Array<{ steam_id: string }>>(
        `SELECT player_steam_id::text AS steam_id FROM team_roster
          WHERE team_id = $1 AND player_steam_id <> $2::bigint LIMIT 1`,
        [team.id, team.owner],
      );
      const source = await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      const { id } = await lineups.fork(user(mate.steam_id), {
        utility_lineup_id: source,
      });

      const fork = await rowOf(id);
      expect(fork.visibility).toBe("Private");
      expect(fork.team_id).toBeNull();
    });

    it("refuses a lineup id that is not a lineup", async () => {
      const forker = await fx.player();

      await expect(
        lineups.fork(user(forker), { utility_lineup_id: "not-a-uuid" }),
      ).rejects.toThrow("lineup not found");
    });
  });

  describe("collections", () => {
    it("files the fork into a collection the caller owns", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author);
      const [collection] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_collections (name, owner_steam_id)
         VALUES ('My book', $1) RETURNING id`,
        [forker],
      );

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
        collection_id: collection.id,
      });

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM utility_collection_items
          WHERE collection_id = $1 AND utility_lineup_id = $2`,
        [collection.id, id],
      );
      expect(Number(count)).toBe(1);
    });

    it("ignores somebody else's collection rather than writing into it", async () => {
      const author = await fx.player();
      const forker = await fx.player();
      const source = await insertLineup(author);
      const [collection] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_collections (name, owner_steam_id)
         VALUES ('Their book', $1) RETURNING id`,
        [author],
      );

      const { id } = await lineups.fork(user(forker), {
        utility_lineup_id: source,
        collection_id: collection.id,
      });

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM utility_collection_items WHERE collection_id = $1",
        [collection.id],
      );
      expect(Number(count)).toBe(0);
      expect(await rowOf(id)).toBeTruthy();
    });
  });
});
