import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";

const METADATA = join(__dirname, "../../hasura/metadata");
const TABLES = join(METADATA, "databases/default/tables");

const HOOK_SECRET = {
  name: "x-5stack-hook-secret",
  value_from_env: "HASURA_GRAPHQL_ADMIN_SECRET",
};

type Header = Record<string, string>;

const load = (file: string) => yaml.load(readFileSync(file, "utf8")) as any;

const actions: Array<{
  name: string;
  definition: { headers?: Array<Header>; request_transform?: unknown };
}> = load(join(METADATA, "actions.yaml")).actions;

const eventTriggers = readdirSync(TABLES)
  .filter((file) => file.endsWith(".yaml") && file !== "tables.yaml")
  .flatMap((file) =>
    ((load(join(TABLES, file))?.event_triggers ?? []) as Array<any>).map(
      (trigger) => ({ ...trigger, file }),
    ),
  );

const cronTriggers: Array<any> =
  load(join(METADATA, "cron_triggers.yaml")) ?? [];

const hookSecrets = (headers: Array<Header> | undefined) =>
  (headers ?? []).filter((header) => header.name === HOOK_SECRET.name);

describe("hook secret in hasura metadata", () => {
  it("finds the actions and event triggers it guards", () => {
    expect(actions.length).toBeGreaterThan(200);
    expect(eventTriggers.length).toBeGreaterThan(30);
  });

  it.each(actions.map((action) => [action.name, action]))(
    "action %s sends the hook secret",
    (_name, action) => {
      expect(hookSecrets(action.definition.headers)).toEqual([HOOK_SECRET]);
    },
  );

  // A transformed request, headers and all, is echoed into the
  // ActionInternalError that clients see while HASURA_GRAPHQL_DEV_MODE is on.
  it.each(actions.map((action) => [action.name, action]))(
    "action %s has no request_transform to leak the secret through",
    (_name, action) => {
      expect(action.definition.request_transform).toBeUndefined();
    },
  );

  it.each(
    eventTriggers.map((trigger) => [
      `${trigger.file} ${trigger.name}`,
      trigger,
    ]),
  )("event trigger %s sends the hook secret", (_name, trigger) => {
    expect(hookSecrets(trigger.headers)).toEqual([HOOK_SECRET]);
  });

  it("every cron trigger sends the hook secret", () => {
    for (const trigger of cronTriggers) {
      expect(hookSecrets(trigger.headers)).toEqual([HOOK_SECRET]);
    }
  });
});
