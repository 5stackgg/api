import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";

// Roles inherit up a single-parent chain (hasura/metadata/inherited_roles.yaml).
// An explicit block overrides the inherited one rather than merging, so a
// duplicated block is what lets copies drift apart -- tournament_organizer
// silently lost matches.region, and tournament_teams lost its owner_steam_id
// preset, both by editing some copies of a block and not others.
const PERMISSION_SECTIONS = [
  "insert_permissions",
  "select_permissions",
  "update_permissions",
  "delete_permissions",
] as const;

const inheritedRoles = yaml.load(
  readFileSync(
    join(__dirname, "../../hasura/metadata/inherited_roles.yaml"),
    "utf8",
  ),
) as Array<{ role_name: string; role_set: Array<string> }>;

// Only single-parent inheritance has an unambiguous "nearest ancestor". A role
// set with more than one entry is left out rather than guessed at.
const parentOf = new Map<string, string>(
  inheritedRoles
    .filter((entry) => entry.role_set?.length === 1)
    .map((entry) => [entry.role_name, entry.role_set[0]]),
);

// Key order in the yaml is incidental; compare by a stable shape.
function stableShape(value: any): any {
  if (Array.isArray(value)) {
    return value.map(stableShape);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((shape: Record<string, any>, key) => {
        shape[key] = stableShape(value[key]);
        return shape;
      }, {});
  }

  return value;
}

// A higher role narrowing its own column set is usually drift, but not always:
// a role can be a distinct job rather than a strictly larger one. Each exemption
// names why, so the next narrowing still has to be argued for rather than
// silently joining the list.
const INTENTIONAL_NARROWING = new Map<string, string>([
  [
    "public_utility_lineups.yaml update_permissions moderator",
    "moderation is review, not authorship: verify/archive/reclassify without rewriting geometry, per the block's own comment",
  ],
  [
    "public_utility_lineups.yaml update_permissions match_organizer",
    "publishing is gated on the literal role in tbiu_utility_lineups_public (admin/administrator/moderator), so match_organizer is deliberately not a moderator",
  ],
]);

function nearestAncestorWithBlock(
  role: string,
  blocks: Map<string, Record<string, any>>,
): string | null {
  let current = parentOf.get(role);

  while (current) {
    if (blocks.has(current)) {
      return current;
    }
    current = parentOf.get(current);
  }

  return null;
}

// `comment` sits outside `permission`, so comparing bodies already ignores it.
function blocksByRole(
  metadata: Record<string, any>,
  section: string,
): Map<string, Record<string, any>> {
  return new Map(
    (metadata?.[section] ?? []).map((entry: Record<string, any>) => [
      entry.role,
      entry.permission ?? {},
    ]),
  );
}

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
        const computed: Array<string> =
          permission.permission?.computed_fields ?? [];
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

  it("never repeats a block an ancestor role already defines", () => {
    const problems: Array<string> = [];

    for (const { file, metadata } of tables) {
      for (const section of PERMISSION_SECTIONS) {
        const blocks = blocksByRole(metadata, section);

        for (const [role, permission] of blocks) {
          const ancestor = nearestAncestorWithBlock(role, blocks);

          if (
            ancestor &&
            JSON.stringify(stableShape(permission)) ===
              JSON.stringify(stableShape(blocks.get(ancestor)))
          ) {
            problems.push(
              `${file}: ${section} for "${role}" is identical to "${ancestor}", which it already inherits`,
            );
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });

  // A role that defines its own block does not merge with the ancestor's, it
  // replaces it. Granting a higher role strictly fewer columns than the role
  // below therefore takes access away rather than adding it.
  it("never gives a role fewer columns than the role it inherits from", () => {
    const problems: Array<string> = [];
    const narrowings = new Set<string>();

    for (const { file, metadata } of tables) {
      for (const section of PERMISSION_SECTIONS) {
        const blocks = blocksByRole(metadata, section);

        for (const [role, permission] of blocks) {
          const ancestor = nearestAncestorWithBlock(role, blocks);

          if (!ancestor) {
            continue;
          }

          const columns: Array<string> = permission?.columns ?? [];
          const inherited: Array<string> = blocks.get(ancestor)?.columns ?? [];
          const missing = inherited.filter(
            (column) => !columns.includes(column),
          );

          const key = `${file} ${section} ${role}`;
          const narrows = Boolean(
            columns.length && inherited.length && missing.length,
          );

          if (narrows) {
            narrowings.add(key);
          }

          if (narrows && !INTENTIONAL_NARROWING.has(key)) {
            problems.push(
              `${file}: ${section} for "${role}" drops ${missing.join(", ")}, which "${role}" inherits from "${ancestor}"`,
            );
          }
        }
      }
    }

    expect(problems).toEqual([]);
    // An exemption that no longer describes anything is a claim nobody checked.
    expect(
      [...INTENTIONAL_NARROWING.keys()].filter((key) => !narrowings.has(key)),
    ).toEqual([]);
  });

  // Hasura strips a preset column from the input type, so a role with the preset
  // cannot be sent a value for it -- but a sibling role that lists the same
  // column in `columns:` can, and the caller picks the owner. Presets have to be
  // all-or-nothing per table and operation.
  it("never lets one role send a column another role presets from the session", () => {
    const problems: Array<string> = [];

    for (const { file, metadata } of tables) {
      for (const section of PERMISSION_SECTIONS) {
        const blocks = blocksByRole(metadata, section);
        const presets = new Set<string>();

        for (const permission of blocks.values()) {
          for (const column of Object.keys(permission?.set ?? {})) {
            presets.add(column);
          }
        }

        for (const [role, permission] of blocks) {
          const sendable: Array<string> = permission?.columns ?? [];

          for (const column of sendable.filter((name) => presets.has(name))) {
            problems.push(
              `${file}: ${section} lets "${role}" send "${column}", which another role on this table presets from the session`,
            );
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
