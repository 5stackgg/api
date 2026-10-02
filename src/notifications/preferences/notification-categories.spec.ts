import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import {
  PUSH_CATEGORIES,
  PUSH_KEYS,
  IN_APP_KEYS,
  pushCategoryForType,
  inAppKeyForType,
  isKnownKey,
  bellControlForType,
  typesForCategory,
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

// The bell may mute any notice about the player except their own name-change
// decisions, sanctions and warnings.
const ACCOUNT_AND_SAFETY = [
  "NameChangeApproved",
  "NameChangeDenied",
  "PlayerSanctioned",
  "PlayerWarning",
];

const NEVER_IN_THE_BELL = [
  "MatchFound",
  "AdminCall",
  "ChatMessage",
  "MatchChatMessage",
];

const staffTypes = () =>
  new Set<string>(
    PUSH_KEYS.filter((entry) => entry.adminOnly).flatMap(
      (entry) => PUSH_CATEGORIES[entry.key],
    ),
  );

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

  it("offers no in-app toggle for chat, which never reaches the bell", () => {
    expect(inAppKeyForType("ChatMessage")).toBeNull();
    expect(inAppKeyForType("MatchChatMessage")).toBeNull();
  });

  it("gives banned teammates their own push category, on by default, after account", () => {
    expect(pushCategoryForType("TeammateBanned")).toEqual({
      key: "teammate_bans",
      defaultEnabled: true,
    });

    const keys = PUSH_KEYS.map((entry) => entry.key);
    expect(keys.indexOf("teammate_bans")).toBe(keys.indexOf("account") + 1);
  });

  it("keeps a player's own sanction under account", () => {
    expect(pushCategoryForType("PlayerSanctioned")?.key).toBe("account");
  });

  it("lets the bell mute banned teammates, on by default", () => {
    expect(inAppKeyForType("TeammateBanned")).toEqual({
      key: "TeammateBanned",
      defaultEnabled: true,
    });
  });

  it("resolves in-app keys back to their own type", () => {
    for (const entry of IN_APP_KEYS) {
      expect(inAppKeyForType(entry.key)).toEqual(entry);
    }

    expect(inAppKeyForType("GameUpdate")).toBeNull();
  });

  it("gives every per-player type a bell switch except a player's own account and safety notices", () => {
    const staff = staffTypes();
    const perPlayer = types.filter(
      (type) =>
        !staff.has(type) &&
        !ACCOUNT_AND_SAFETY.includes(type) &&
        !NEVER_IN_THE_BELL.includes(type),
    );

    expect(IN_APP_KEYS.map((entry) => entry.key).sort()).toEqual(
      perPlayer.sort(),
    );
  });

  it("refuses a bell preference for a locked or push-only type", () => {
    for (const type of [...ACCOUNT_AND_SAFETY, ...NEVER_IN_THE_BELL]) {
      expect(isKnownKey("in_app", type)).toBe(false);
    }

    expect(isKnownKey("in_app", "ScrimRequestReceived")).toBe(true);
    expect(isKnownKey("in_app", "MatchStatusChange")).toBe(true);
  });
});

describe("bell control", () => {
  const types = notificationTypesInTree();

  it("classifies every notification type", () => {
    const unclassified = types.filter((type) => !bellControlForType(type));

    expect(unclassified).toEqual([]);
  });

  it("locks exactly a player's own account and safety notices", () => {
    const staff = staffTypes();
    const locked = types.filter(
      (type) => !staff.has(type) && bellControlForType(type) === "locked",
    );

    expect(locked.sort()).toEqual([...ACCOUNT_AND_SAFETY].sort());
  });

  it("locks staff broadcasts, which have no recipient list to filter", () => {
    const unlocked = [...staffTypes()].filter(
      (type) => bellControlForType(type) !== "locked",
    );

    expect(unlocked).toEqual([]);
  });

  it("keeps the rings and chat out of the bell", () => {
    expect(NEVER_IN_THE_BELL.map(bellControlForType)).toEqual([
      "push_only",
      "push_only",
      "push_only",
      "push_only",
    ]);
  });

  it("toggles exactly the in-app keys", () => {
    const toggles = types.filter(
      (type) => bellControlForType(type) === "toggle",
    );

    expect(toggles.sort()).toEqual(
      IN_APP_KEYS.map((entry) => entry.key).sort(),
    );
  });
});

describe("category catalog", () => {
  const types = notificationTypesInTree();

  it("lists a category's types in order, with how the bell treats each", () => {
    expect(typesForCategory("account")).toEqual([
      { type: "NameChangeApproved", bell: "locked", ignoresQuietHours: false },
      { type: "NameChangeDenied", bell: "locked", ignoresQuietHours: false },
      { type: "PlayerSanctioned", bell: "locked", ignoresQuietHours: false },
      { type: "PlayerWarning", bell: "locked", ignoresQuietHours: false },
      { type: "AwardGranted", bell: "toggle", ignoresQuietHours: false },
    ]);
  });

  it("says which types ring through quiet hours", () => {
    expect(typesForCategory("match_found")).toEqual([
      { type: "MatchFound", bell: "push_only", ignoresQuietHours: true },
    ]);
    expect(typesForCategory("admin_call")).toEqual([
      { type: "AdminCall", bell: "push_only", ignoresQuietHours: true },
    ]);
  });

  it("lists every type exactly once across the push categories", () => {
    const listed = PUSH_KEYS.flatMap((entry) =>
      typesForCategory(entry.key).map(({ type }) => type),
    );

    expect([...listed].sort()).toEqual([...types].sort());
  });

  it("lists nothing for a category that does not exist", () => {
    expect(typesForCategory("nope")).toEqual([]);
  });
});
