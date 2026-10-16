import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("foreign keys on a match's delete path", () => {
  let db: SqlTestDb;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchDeleteFkIndexesTest");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  // Every table whose rows go when a match does, then every foreign key into
  // one of them. Deleting a parent row checks each such key with
  // "WHERE <fk columns> = $1" on the child, so the child needs an index that
  // starts with those columns or the check reads the whole table.
  // match_options is a root of its own: tad_matches deletes the match's options
  // row once nothing else uses it, which no foreign key cascade shows.
  const deletePath = async () =>
    db.postgres.query<
      Array<{
        child: string;
        columns: string;
        parent: string;
        indexed: boolean;
      }>
    >(`
      WITH RECURSIVE fks AS (
        SELECT conrelid, confrelid, conkey, confdeltype
          FROM pg_constraint
         WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      ), reached(relid) AS (
        VALUES ('public.matches'::regclass::oid), ('public.match_options'::regclass::oid)
        UNION
        SELECT fks.conrelid
          FROM fks
          JOIN reached ON fks.confrelid = reached.relid
         WHERE fks.confdeltype = 'c'
      )
      SELECT fks.conrelid::regclass::text AS child,
             (SELECT string_agg(a.attname, ',' ORDER BY k.n)
                FROM unnest(fks.conkey) WITH ORDINALITY AS k(attnum, n)
                JOIN pg_attribute a ON a.attrelid = fks.conrelid AND a.attnum = k.attnum
             ) AS columns,
             fks.confrelid::regclass::text AS parent,
             EXISTS (
               SELECT 1
                 FROM pg_index i
                WHERE i.indrelid = fks.conrelid
                  AND i.indpred IS NULL
                  AND (i.indkey::int2[])[0:cardinality(fks.conkey) - 1] @> fks.conkey
                  AND (i.indkey::int2[])[0:cardinality(fks.conkey) - 1] <@ fks.conkey
             ) AS indexed
        FROM fks
       WHERE fks.confrelid IN (SELECT relid FROM reached)
       ORDER BY 3, 1, 2
    `);

  it("indexes the child side of every key a match delete checks", async () => {
    const keys = await deletePath();

    expect(keys.map(({ child }) => child)).toEqual(
      expect.arrayContaining([
        "match_maps",
        "player_damages",
        "utility_demo_throws",
        "player_round_inventory",
      ]),
    );
    expect(
      keys
        .filter(({ indexed }) => !indexed)
        .map(
          ({ child, columns, parent }) => `${child}(${columns}) -> ${parent}`,
        ),
    ).toEqual([]);
  });

  it("finds a veto reset's match_maps children through an index", async () => {
    const nodes = await db.postgres.transaction(async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");

      const plans: Array<Record<string, any>> = [];
      for (const table of ["utility_demo_throws", "player_match_map_stats"]) {
        const { rows } = await client.query(
          `EXPLAIN (FORMAT JSON) SELECT 1 FROM ONLY public.${table} x WHERE match_map_id = $1 FOR KEY SHARE OF x`,
          ["00000000-0000-0000-0000-000000000000"],
        );
        const walk = (node: Record<string, any>) => {
          plans.push(node);
          for (const child of node.Plans ?? []) {
            walk(child);
          }
        };
        walk(rows[0]["QUERY PLAN"][0].Plan);
      }

      return plans;
    });

    expect(nodes.map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(nodes.map((node) => node["Index Name"])).toEqual(
      expect.arrayContaining([
        "utility_demo_throws_match_map_id_idx",
        "player_match_map_stats_match_map_id_idx",
      ]),
    );
  });
});
