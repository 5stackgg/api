import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import {
  PUSH_CATEGORIES,
  PUSH_KEYS,
  IN_APP_KEYS,
  pushCategoryForType,
  inAppKeyForType,
} from "./notification-categories";

const HASURA_DIR = join(__dirname, "../../../hasura");

// Notification types come from two places, and missing the second is how
// MatchImported ended up live but absent from the enum seed file.
const notificationTypesInTree = (): string[] => {
  const sources = [join(HASURA_DIR, "enums/notification-types.sql")];

  const migrations = join(HASURA_DIR, "migrations/default");
  for (const dir of readdirSync(migrations)) {
    const up = join(migrations, dir, "up.sql");
    if (existsSync(up)) {
      sources.push(up);
    }
  }

  const types = new Set<string>();
  for (const source of sources) {
    const sql = readFileSync(source, "utf8");
    if (!sql.includes("e_notification_types")) {
      continue;
    }
    for (const [, value] of sql.matchAll(/\('([A-Za-z]+)',\s*'/g)) {
      types.add(value);
    }
  }

  return [...types].sort();
};

describe("notification categories", () => {
  const types = notificationTypesInTree();

  it("finds the notification types declared in the tree", () => {
    // Guards the parser itself -- a regex that silently matched nothing would
    // make every assertion below vacuously pass.
    expect(types.length).toBeGreaterThan(30);
    expect(types).toContain("ChatMessage");
    expect(types).toContain("MatchImported");
  });

  it("maps every notification type to a push category", () => {
    const unmapped = types.filter((type) => !pushCategoryForType(type));

    expect(unmapped).toEqual([]);
  });

  it("does not map types that do not exist", () => {
    const known = new Set(types);
    const phantom = Object.values(PUSH_CATEGORIES)
      .flat()
      .filter((type) => !known.has(type));

    expect(phantom).toEqual([]);
  });

  it("assigns each type to exactly one push category", () => {
    const seen = new Map<string, string>();
    const duplicated: string[] = [];

    for (const [category, categoryTypes] of Object.entries(PUSH_CATEGORIES)) {
      for (const type of categoryTypes) {
        if (seen.has(type)) {
          duplicated.push(`${type} (${seen.get(type)} + ${category})`);
        }
        seen.set(type, category);
      }
    }

    expect(duplicated).toEqual([]);
  });

  it("declares a preference key for every push category", () => {
    expect(Object.keys(PUSH_CATEGORIES).sort()).toEqual(
      PUSH_KEYS.map((entry) => entry.key).sort(),
    );
  });

  it("only exposes real notification types as in-app keys", () => {
    const known = new Set(types);
    const phantom = IN_APP_KEYS.filter((entry) => !known.has(entry.key));

    expect(phantom).toEqual([]);
  });

  it("only exposes per-player types as in-app keys", () => {
    // In-app preferences are enforced at insert time against a known recipient
    // list. A role-broadcast type has no such list, so a toggle for one would
    // silently do nothing.
    const roleBroadcastOnly = [
      "GameUpdate",
      "GameNodeStatus",
      "DedicatedServerStatus",
      "DedicatedServerRconStatus",
      "StorageScan",
      "EloRecompute",
      "PlayerReindex",
      "MatchSupport",
      "MatchAbandoned",
      "NameChangeRequest",
    ];

    const offenders = IN_APP_KEYS.filter((entry) =>
      roleBroadcastOnly.includes(entry.key),
    );

    expect(offenders).toEqual([]);
  });

  it("resolves in-app keys back to their own type", () => {
    for (const entry of IN_APP_KEYS) {
      expect(inAppKeyForType(entry.key)).toEqual(entry);
    }

    expect(inAppKeyForType("GameUpdate")).toBeNull();
  });
});
