import { PostgresService } from "./../src/postgres/postgres.service";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the season-management DB triggers/constraints: numbering, ending
// (auto-create next), start/end edits, overlap prevention, deletion (SET NULL vs
// cascade), and the needs_rebuild flag.
describe("seasons (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let seq = 0;

  beforeAll(async () => {
    db = await bootMigratedDb("SeasonsTest");
    postgres = db.postgres;

    // tbi_match resolves regions on every insert; a fresh install has none, so
    // seedMatch would otherwise fail with 'No regions with attached servers'.
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    // Clean slate. Deleting seasons SET NULLs player_elo.season_id and cascades
    // player_season_stats; deleting matches cascades player_elo.
    await postgres.query("DELETE FROM seasons");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM players");
  });

  const D = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toISOString();
  const nextSteam = () => (76561190000000000n + BigInt(++seq)).toString();

  type SeasonRow = {
    id: string;
    number: number;
    starts_at: string;
    ends_at: string | null;
    needs_rebuild: boolean;
  };

  const createSeason = async (start: string, end: string | null = null) => {
    const [row] = await postgres.query<Array<{ id: string; number: number }>>(
      `INSERT INTO seasons (starts_at, ends_at) VALUES ($1, $2) RETURNING id, number`,
      [start, end],
    );
    return row;
  };

  // pg returns timestamptz columns as Date objects; normalize to ISO strings so
  // they compare cleanly against the D() literals used in assertions.
  const listSeasons = async () => {
    const rows = await postgres.query<
      Array<Omit<SeasonRow, "starts_at" | "ends_at"> & {
        starts_at: Date;
        ends_at: Date | null;
      }>
    >(
      `SELECT id, number, starts_at, ends_at, needs_rebuild
       FROM seasons ORDER BY starts_at ASC`,
    );
    return rows.map((row) => ({
      ...row,
      starts_at: row.starts_at.toISOString(),
      ends_at: row.ends_at?.toISOString() ?? null,
    }));
  };

  const seedPlayer = async () => {
    const steam = nextSteam();
    await postgres.query(
      "INSERT INTO players (steam_id, name) VALUES ($1, $2)",
      [steam, `p${seq}`],
    );
    return steam;
  };

  const seedMatch = async (endedAt: string) => {
    const [l1] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
    );
    const [l2] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
    );
    const [m] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO matches (lineup_1_id, lineup_2_id, source, ended_at)
       VALUES ($1, $2, '5stack', $3) RETURNING id`,
      [l1.id, l2.id, endedAt],
    );
    return m.id;
  };

  const tagElo = async (seasonId: string | null, endedAt: string) => {
    const steam = await seedPlayer();
    const matchId = await seedMatch(endedAt);
    await postgres.query(
      `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
       VALUES ($1, $2, 'Competitive', 5000, 0, $3, $4)`,
      [steam, matchId, endedAt, seasonId],
    );
    return { steam, matchId };
  };

  it("assigns sequential numbers by start date, never null", async () => {
    await createSeason(D("2025-03-01"), D("2025-04-01"));
    await createSeason(D("2025-01-01"), D("2025-02-01"));
    await createSeason(D("2025-05-01"), D("2025-06-01"));

    const seasons = await listSeasons();
    expect(seasons.map((s) => Number(s.number))).toEqual([1, 2, 3]);
    expect(seasons.every((s) => s.number != null)).toBe(true);
  });

  it("inserting an earlier season renumbers the later ones", async () => {
    await createSeason(D("2025-03-01"), D("2025-04-01"));
    await createSeason(D("2025-01-01"), D("2025-02-01"));

    const seasons = await listSeasons();
    expect(seasons.map((s) => [s.starts_at, Number(s.number)])).toEqual([
      [D("2025-01-01"), 1],
      [D("2025-03-01"), 2],
    ]);
  });

  it("rejects overlapping ranges", async () => {
    await createSeason(D("2025-01-01"), D("2025-03-01"));
    await expect(
      createSeason(D("2025-02-01"), D("2025-04-01")),
    ).rejects.toThrow();
  });

  it("allows adjacent (touching) ranges", async () => {
    await createSeason(D("2025-01-01"), D("2025-03-01"));
    await expect(
      createSeason(D("2025-03-01"), D("2025-05-01")),
    ).resolves.toBeDefined();
  });

  it("ending an ongoing season auto-creates the next ongoing season contiguously", async () => {
    const s1 = await createSeason(D("2025-01-01"), null);
    await postgres.query("UPDATE seasons SET ends_at = $1 WHERE id = $2", [
      D("2025-06-01"),
      s1.id,
    ]);

    const seasons = await listSeasons();
    expect(seasons.length).toBe(2);
    expect(seasons[0].ends_at).toBe(D("2025-06-01"));
    expect(seasons[1].starts_at).toBe(D("2025-06-01"));
    expect(seasons[1].ends_at).toBeNull();
    expect(seasons.map((s) => Number(s.number))).toEqual([1, 2]);
  });

  it("ending does not create a duplicate when a later season already exists", async () => {
    const s1 = await createSeason(D("2025-01-01"), D("2025-03-01"));
    await createSeason(D("2025-03-01"), null);

    await postgres.query("UPDATE seasons SET ends_at = $1 WHERE id = $2", [
      D("2025-02-01"),
      s1.id,
    ]);

    expect((await listSeasons()).length).toBe(2);
  });

  it("deleting a season SET NULLs its player_elo but keeps the ELO row", async () => {
    const s1 = await createSeason(D("2025-01-01"), D("2025-06-01"));
    const { steam, matchId } = await tagElo(s1.id, D("2025-02-01"));

    await postgres.query("DELETE FROM seasons WHERE id = $1", [s1.id]);

    const [row] = await postgres.query<Array<{ season_id: string | null }>>(
      `SELECT season_id FROM player_elo WHERE steam_id = $1 AND match_id = $2`,
      [steam, matchId],
    );
    expect(row).toBeDefined();
    expect(row.season_id).toBeNull();
  });

  it("deleting a season cascades its player_season_stats", async () => {
    const s1 = await createSeason(D("2025-01-01"), null);
    const steam = await seedPlayer();
    await postgres.query(
      `INSERT INTO player_season_stats (player_steam_id, season_id, kills)
       VALUES ($1, $2, 5)`,
      [steam, s1.id],
    );

    await postgres.query("DELETE FROM seasons WHERE id = $1", [s1.id]);

    const rows = await postgres.query(
      `SELECT 1 FROM player_season_stats WHERE season_id = $1`,
      [s1.id],
    );
    expect(rows.length).toBe(0);
  });

  it("deleting a middle season renumbers the rest", async () => {
    await createSeason(D("2025-01-01"), D("2025-02-01"));
    const s2 = await createSeason(D("2025-03-01"), D("2025-04-01"));
    await createSeason(D("2025-05-01"), D("2025-06-01"));

    await postgres.query("DELETE FROM seasons WHERE id = $1", [s2.id]);

    expect((await listSeasons()).map((s) => Number(s.number))).toEqual([1, 2]);
  });

  it("flags needs_rebuild only when the season covers a recorded 5stack match", async () => {
    await seedMatch(D("2025-02-15"));
    const covering = await createSeason(D("2025-01-01"), D("2025-03-01"));
    const future = await createSeason(D("2025-06-01"), null);

    const byId = Object.fromEntries(
      (await listSeasons()).map((s) => [s.id, s.needs_rebuild]),
    );
    expect(byId[covering.id]).toBe(true);
    expect(byId[future.id]).toBe(false);
  });

  it("ending a season does not clear a pending rebuild flag", async () => {
    await seedMatch(D("2025-02-15"));
    const s1 = await createSeason(D("2025-01-01"), null);

    expect(
      (await listSeasons()).find((s) => s.id === s1.id)!.needs_rebuild,
    ).toBe(true);

    // End well after the match — excludes no matches, but must not clear the flag.
    await postgres.query("UPDATE seasons SET ends_at = $1 WHERE id = $2", [
      D("2025-12-01"),
      s1.id,
    ]);

    expect(
      (await listSeasons()).find((s) => s.id === s1.id)!.needs_rebuild,
    ).toBe(true);
  });

  it("changing a start updates it and flags a rebuild", async () => {
    const s1 = await createSeason(D("2025-03-01"), D("2025-06-01"));
    await postgres.query(
      "UPDATE seasons SET needs_rebuild = false WHERE id = $1",
      [s1.id],
    );

    await postgres.query("UPDATE seasons SET starts_at = $1 WHERE id = $2", [
      D("2025-02-01"),
      s1.id,
    ]);

    const [row] = await postgres.query<
      Array<{ starts_at: Date; needs_rebuild: boolean }>
    >("SELECT starts_at, needs_rebuild FROM seasons WHERE id = $1", [s1.id]);
    expect(row.starts_at.toISOString()).toBe(D("2025-02-01"));
    expect(row.needs_rebuild).toBe(true);
  });

  it("number cannot be set NULL", async () => {
    const s1 = await createSeason(D("2025-01-01"), null);
    await expect(
      postgres.query("UPDATE seasons SET number = NULL WHERE id = $1", [s1.id]),
    ).rejects.toThrow();
  });
});
