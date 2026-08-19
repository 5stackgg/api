import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";

// Permission blocks list `columns:` and `computed_fields:` separately, and it is
// easy to append a new column into whichever list happens to sit above it in the
// file. Hasura then refuses the whole table with "expecting a computed field;
// but X is a column" -- which only shows up when metadata is applied, long after
// tsc and every test suite have gone green.
describe("hasura table metadata", () => {
  const dir = join(__dirname, "../../hasura/metadata/databases/default/tables");

  const tables = readdirSync(dir)
    .filter((file) => file.startsWith("public_") && file.endsWith(".yaml"))
    .map((file) => ({
      file,
      metadata: yaml.load(readFileSync(join(dir, file), "utf8")) as Record<
        string,
        any
      >,
    }));

  it("finds table metadata to check", () => {
    expect(tables.length).toBeGreaterThan(50);
  });

  it("only grants computed fields the table actually declares", () => {
    const problems: Array<string> = [];

    for (const { file, metadata } of tables) {
      const declared = new Set(
        (metadata?.computed_fields ?? []).map(
          (field: { name: string }) => field.name,
        ),
      );

      for (const permission of metadata?.select_permissions ?? []) {
        for (const granted of permission.permission?.computed_fields ?? []) {
          if (!declared.has(granted)) {
            problems.push(
              `${file}: role "${permission.role}" grants computed field "${granted}", which the table does not declare`,
            );
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it("never lists the same name as both a column and a computed field", () => {
    const problems: Array<string> = [];

    for (const { file, metadata } of tables) {
      for (const permission of metadata?.select_permissions ?? []) {
        const columns: Array<string> = permission.permission?.columns ?? [];
        const computed: Array<string> = permission.permission?.computed_fields ?? [];
        const overlap = columns.filter((column) => computed.includes(column));

        for (const name of overlap) {
          problems.push(
            `${file}: role "${permission.role}" lists "${name}" as both a column and a computed field`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
