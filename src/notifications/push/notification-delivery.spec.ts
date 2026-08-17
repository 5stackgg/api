import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import {
  DELIVERY_POLICIES,
  deliveryPolicyForType,
  threadKeyFor,
} from "./notification-delivery";

const HASURA_DIR = join(__dirname, "../../../hasura");

// Same two sources as notification-categories.spec.ts -- the enum seed file
// alone misses the types that only ever existed in a migration.
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

describe("notification delivery policies", () => {
  const types = notificationTypesInTree();

  it("finds the notification types declared in the tree", () => {
    expect(types.length).toBeGreaterThan(30);
    expect(types).toContain("ChatMessage");
  });

  it("assigns a delivery policy to every notification type", () => {
    const unmapped = types.filter((type) => !deliveryPolicyForType(type));

    expect(unmapped).toEqual([]);
  });

  it("does not map types that do not exist", () => {
    const known = new Set(types);
    const phantom = Object.values(DELIVERY_POLICIES)
      .flat()
      .filter((type) => !known.has(type));

    expect(phantom).toEqual([]);
  });

  it("assigns each type to exactly one policy", () => {
    const seen = new Map<string, string>();
    const duplicated: string[] = [];

    for (const [name, policyTypes] of Object.entries(DELIVERY_POLICIES)) {
      for (const type of policyTypes) {
        if (seen.has(type)) {
          duplicated.push(`${type} (${seen.get(type)} + ${name})`);
        }
        seen.set(type, name);
      }
    }

    expect(duplicated).toEqual([]);
  });

  it("bundles chat and leaves invites instant", () => {
    expect(deliveryPolicyForType("ChatMessage")).toEqual({
      bundleSeconds: 15,
      requireUnseen: true,
    });

    expect(deliveryPolicyForType("TeamInvite")).toEqual({
      bundleSeconds: 0,
      requireUnseen: true,
    });
  });

  describe("threadKeyFor", () => {
    it("keys on type and entity", () => {
      expect(
        threadKeyFor({ type: "ChatMessage", entity_id: "direct:1:2" }),
      ).toEqual("ChatMessage:direct:1:2");
    });

    it("is stable when a notification carries no entity", () => {
      expect(threadKeyFor({ type: "GameUpdate" })).toEqual("GameUpdate:");
      expect(threadKeyFor({ type: "GameUpdate", entity_id: null })).toEqual(
        "GameUpdate:",
      );
    });

    it("prefers an explicit thread key", () => {
      expect(
        threadKeyFor({
          type: "ChatMessage",
          entity_id: "direct:1:2",
          data: { threadKey: "chat:direct:1:2" },
        }),
      ).toEqual("chat:direct:1:2");
    });
  });
});
