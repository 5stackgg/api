import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

// Migrations run once, before hasura/enums, functions, views and triggers are
// applied (HasuraService.setup). Two conventions follow from that:
//
// 1. Functions, views and triggers live in their folders, which are re-applied
//    whenever a file changes. A copy in a migration either goes stale or, worse,
//    overwrites the maintained body on an install whose folder digest already
//    matches -- and that overwrite outlives the boot that caused it. When a
//    migration genuinely needs one before the folders run (a column default, a
//    backfill), it seeds it inside a DO block guarded by to_regprocedure, or
//    uses a pg_temp copy.
// 2. DDL is idempotent (IF [NOT] EXISTS), so a migration re-run by hand after a
//    partial failure, or against a database that already has part of it, does
//    not stop the boot.
const MIGRATIONS_DIR = join(__dirname, "../../hasura/migrations/default");

// Postgres has no IF NOT EXISTS for these, so they are not checked:
// ADD CONSTRAINT, RENAME COLUMN, CREATE INDEX without a name.
const UNGUARDED_DDL: Array<[string, RegExp]> = [
  ["ADD COLUMN", /\badd\s+column\s+(?!if\s+not\s+exists\b)/gi],
  [
    "CREATE TABLE",
    /\bcreate\s+(?:unlogged\s+)?table\s+(?!if\s+not\s+exists\b)/gi,
  ],
  [
    "CREATE INDEX",
    /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?!if\s+not\s+exists\b)(?!on\b)/gi,
  ],
  ["CREATE SCHEMA", /\bcreate\s+schema\s+(?!if\s+not\s+exists\b)/gi],
  ["CREATE SEQUENCE", /\bcreate\s+sequence\s+(?!if\s+not\s+exists\b)/gi],
  ["CREATE EXTENSION", /\bcreate\s+extension\s+(?!if\s+not\s+exists\b)/gi],
  ["DROP COLUMN", /\bdrop\s+column\s+(?!if\s+exists\b)/gi],
  ["DROP CONSTRAINT", /\bdrop\s+constraint\s+(?!if\s+exists\b)/gi],
  ["DROP TABLE", /\bdrop\s+table\s+(?!if\s+exists\b)/gi],
  ["DROP INDEX", /\bdrop\s+index\s+(?:concurrently\s+)?(?!if\s+exists\b)/gi],
  ["DROP VIEW", /\bdrop\s+(?:materialized\s+)?view\s+(?!if\s+exists\b)/gi],
  ["DROP FUNCTION", /\bdrop\s+function\s+(?!if\s+exists\b)/gi],
  ["DROP TRIGGER", /\bdrop\s+trigger\s+(?!if\s+exists\b)/gi],
];

const FOLDER_OBJECTS: Array<[string, RegExp]> = [
  [
    "function",
    /\bcreate\s+(?:or\s+replace\s+)?function\s+(?!pg_temp\.)("?[\w.]+"?(?:\."?\w+"?)?)/gi,
  ],
  [
    "view",
    /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?("?[\w.]+"?(?:\."?\w+"?)?)/gi,
  ],
  [
    "trigger",
    /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+("?\w+"?)/gi,
  ],
];

// A plain CREATE in a migration that has to stay one. Each names why, so the
// next one still has to be argued for rather than silently joining the list.
const INTENTIONAL_FOLDER_OBJECTS = new Map<string, string>([
  [
    "1844000000000_steam_account_claims function public.busy_steam_account_ids",
    "repoints the busy set before the migration drops the columns the old body read; identical to the folder copy",
  ],
]);

// Comments and string literals can mention DDL without running it, and a
// dollar-quoted body is either a function's own code or a guarded seed
// (EXECUTE inside DO ... IF to_regprocedure(...) IS NULL).
function executableSql(sql: string) {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/(\$\w*\$)[\s\S]*?\1/g, "$$$$");
}

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((dir) => existsSync(join(MIGRATIONS_DIR, dir, "up.sql")))
  .sort()
  .map((dir) => ({
    dir,
    sql: executableSql(
      readFileSync(join(MIGRATIONS_DIR, dir, "up.sql"), "utf8"),
    ),
  }));

const folderObjects = migrations.flatMap(({ dir, sql }) =>
  FOLDER_OBJECTS.flatMap(([kind, pattern]) =>
    [...sql.matchAll(pattern)].map(
      (match) => `${dir} ${kind} ${match[1].replace(/"/g, "").toLowerCase()}`,
    ),
  ),
);

describe("migration conventions", () => {
  it("finds the migrations", () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("guards DDL with IF [NOT] EXISTS", () => {
    const violations = migrations.flatMap(({ dir, sql }) =>
      UNGUARDED_DDL.filter(([, pattern]) => sql.match(pattern)).map(
        ([statement]) => `${dir}: ${statement}`,
      ),
    );

    expect(violations).toEqual([]);
  });

  it("leaves functions, views and triggers to their folders", () => {
    expect(
      folderObjects.filter((object) => !INTENTIONAL_FOLDER_OBJECTS.has(object)),
    ).toEqual([]);
  });

  it("keeps every exemption current", () => {
    expect(
      [...INTENTIONAL_FOLDER_OBJECTS.keys()].filter(
        (key) => !folderObjects.includes(key),
      ),
    ).toEqual([]);
  });
});
