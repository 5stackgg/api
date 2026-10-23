import { readFileSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";

// The servers event has one handler, and it removes and recreates the
// dedicated server's deployment. Its update columns are therefore the list of
// changes that restart a running server.
describe("what restarts a dedicated server", () => {
  const table = yaml.load(
    readFileSync(
      join(
        __dirname,
        "../../hasura/metadata/databases/default/tables/public_servers.yaml",
      ),
      "utf8",
    ),
  ) as {
    event_triggers: Array<{
      name: string;
      definition: { update: { columns: Array<string> } };
    }>;
  };
  const columns = table.event_triggers.find(
    (trigger) => trigger.name === "servers",
  ).definition.update.columns;

  it("a region change does: the pod takes its Steam relay setting from the region", () => {
    expect(columns).toContain("region");
  });

  it("a connect password change does: the pod only gets it at launch, as sv_password and tv_password", () => {
    expect(columns).toContain("connect_password");
  });

  it("switching GOTV does: the pod's config is what turns it on", () => {
    expect(columns).toContain("tv_enabled");
  });

  it("an address change does not: the pod never reads it, and the node's heartbeat writes it with a match in play", () => {
    expect(columns).not.toContain("host");
  });
});
