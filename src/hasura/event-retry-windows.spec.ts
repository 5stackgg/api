import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";

// A handler marked `retry` only gets its retries if the trigger's retry_conf
// asks Hasura for them, and Hasura gives up on an unreachable api once that
// runs out. Ten minutes rides out an api crash and restart.
const MIN_RETRY_WINDOW_SEC = 10 * 60;

const tablesDir = join(
  __dirname,
  "../../hasura/metadata/databases/default/tables",
);

type EventTrigger = {
  name: string;
  retry_conf: { interval_sec: number; num_retries: number };
};

const triggers = new Map<string, EventTrigger>();
for (const file of readdirSync(tablesDir)) {
  const table = yaml.load(readFileSync(join(tablesDir, file), "utf8")) as {
    event_triggers?: Array<EventTrigger>;
  };
  for (const trigger of table?.event_triggers ?? []) {
    triggers.set(trigger.name, trigger);
  }
}

function sourceFiles(dir: string): Array<string> {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith(".ts") && !path.endsWith(".spec.ts") ? [path] : [];
  });
}

const retried = sourceFiles(join(__dirname, "..")).flatMap((path) =>
  [
    ...readFileSync(path, "utf8").matchAll(
      /@HasuraEvent\(\{\s*retry:\s*true\s*\}\)\s*public\s+async\s+(\w+)\(/g,
    ),
  ].map((match) => match[1]),
);

describe("retried hasura events", () => {
  it("finds the handlers marked to retry", () => {
    expect(retried.length).toBeGreaterThan(0);
  });

  it.each(retried)(
    "%s keeps retrying long enough to outlast an api restart",
    (name) => {
      const trigger = triggers.get(name);

      expect(trigger).toBeDefined();
      expect(
        trigger.retry_conf.interval_sec * trigger.retry_conf.num_retries,
      ).toBeGreaterThanOrEqual(MIN_RETRY_WINDOW_SEC);
    },
  );
});
