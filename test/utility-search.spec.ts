import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TypeSenseService } from "./../src/type-sense/type-sense.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Utility lineups in the global search bar. There is exactly one thing here that
// can go badly wrong -- a private or team lineup ending up in an index that
// answers to everybody -- so the filter is tested as SQL against real rows, and
// so is the path that has to REMOVE a lineup once it stops qualifying.
describe("utility lineup search index (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let typeSense: TypeSenseService;

  let upserted: Array<Record<string, unknown>>;
  let deleted: Array<string>;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilitySearchTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199620000000n);
    typeSense = new TypeSenseService(
      new Logger("UtilitySearchTest"),
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      postgres,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    upserted = [];
    deleted = [];
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");

    // setup() is what normally builds the client, and it needs a typesense
    // server. The document calls are what matter here, so they are captured
    // instead.
    (typeSense as unknown as { client: unknown }).client = {
      collections: () => ({
        documents: (id?: string) => ({
          upsert: async (document: Record<string, unknown>) => {
            upserted.push(document);
          },
          delete: async () => {
            deleted.push(String(id));
          },
          import: async (documents: Array<Record<string, unknown>>) => {
            upserted.push(...documents);
          },
        }),
      }),
    };
  });

  async function insertLineup(
    author: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      map_name: "de_mirage",
      utility_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: -560,
      land_y: 320,
      land_z: -140,
      name: "Window from T spawn",
      tags: ["execute", "a-site"],
      visibility: "Public",
      author_steam_id: author,
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

  describe("what is indexable", () => {
    it("takes a public lineup with its author and tags", async () => {
      const author = await fx.player("Smoke Guy");
      const lineupId = await insertLineup(author, { upvotes: 4 });

      const [row] = await typeSense.searchableUtilityLineups();

      expect(row.id).toBe(lineupId);
      expect(TypeSenseService.utilityLineupDocument(row)).toEqual({
        id: lineupId,
        name: "Window from T spawn",
        map_name: "de_mirage",
        utility_type: "Smoke",
        side: "TERRORIST",
        technique: "Jump",
        tags: ["execute", "a-site"],
        author: "Smoke Guy",
        author_steam_id: author,
        upvotes: 4,
        favorites: 0,
        created_at: expect.any(Number),
      });
    });

    it("never takes a private one", async () => {
      const author = await fx.player();
      await insertLineup(author, { visibility: "Private" });

      expect(await typeSense.searchableUtilityLineups()).toEqual([]);
    });

    // A team book is shared with four other people, not with the internet.
    it("never takes a team one", async () => {
      const team = await fx.team(1);
      await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      expect(await typeSense.searchableUtilityLineups()).toEqual([]);
    });

    it("never takes an archived one", async () => {
      const author = await fx.player();
      await insertLineup(author, {
        archived_at: new Date().toISOString(),
      });

      expect(await typeSense.searchableUtilityLineups()).toEqual([]);
    });

    it("pages through the library without repeating itself", async () => {
      const author = await fx.player();
      await insertLineup(author);
      await insertLineup(author);
      await insertLineup(author);

      const first = await typeSense.searchableUtilityLineups({ limit: 2 });
      const second = await typeSense.searchableUtilityLineups({
        limit: 2,
        after: first.at(-1)!.id,
      });

      expect(first).toHaveLength(2);
      expect(second).toHaveLength(1);
      expect(first.map((row) => row.id)).not.toContain(second[0].id);
    });
  });

  describe("keeping the index honest", () => {
    it("indexes a public lineup", async () => {
      const author = await fx.player("Smoke Guy");
      const lineupId = await insertLineup(author);

      await typeSense.updateUtilityLineup(lineupId);

      expect(deleted).toEqual([]);
      expect(upserted.map((document) => document.id)).toEqual([lineupId]);
    });

    // The leak: a lineup that WAS public and is edited down to private has to
    // leave the index, not merely stop being refreshed.
    it("removes a lineup that has just gone private", async () => {
      const author = await fx.player();
      const lineupId = await insertLineup(author);

      await postgres.query(
        "UPDATE utility_lineups SET visibility = 'Private' WHERE id = $1",
        [lineupId],
      );
      await typeSense.updateUtilityLineup(lineupId);

      expect(upserted).toEqual([]);
      expect(deleted).toEqual([lineupId]);
    });

    it("removes a lineup that has just been archived", async () => {
      const author = await fx.player();
      const lineupId = await insertLineup(author);

      await postgres.query(
        "UPDATE utility_lineups SET archived_at = now() WHERE id = $1",
        [lineupId],
      );
      await typeSense.updateUtilityLineup(lineupId);

      expect(upserted).toEqual([]);
      expect(deleted).toEqual([lineupId]);
    });

    it("removes a lineup that no longer exists", async () => {
      const author = await fx.player();
      const lineupId = await insertLineup(author);

      await postgres.query("DELETE FROM utility_lineups WHERE id = $1", [
        lineupId,
      ]);
      await typeSense.updateUtilityLineup(lineupId);

      expect(deleted).toEqual([lineupId]);
    });

    it("rebuilds the whole index from the public lineups only", async () => {
      const author = await fx.player();
      const team = await fx.team(1);
      const first = await insertLineup(author);
      const second = await insertLineup(author);
      await insertLineup(author, { visibility: "Private" });
      await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      const indexed = await typeSense.reindexUtilityLineups();

      expect(indexed).toBe(2);
      expect(upserted.map((document) => document.id).sort()).toEqual(
        [first, second].sort(),
      );
    });
  });
});
