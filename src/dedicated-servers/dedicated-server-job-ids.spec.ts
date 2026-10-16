import { Job } from "bullmq";
import { DedicatedServerMigrationService } from "./dedicated-server-migration.service";
import { DedicatedServersService } from "./dedicated-servers.service";

// BullMQ refuses a custom job id holding a ":" unless it splits into exactly
// three parts, and the queue mocks in the other specs never run that check.
describe("dedicated server job ids", () => {
  const validate = (name: string, jobId: string) =>
    (
      Job.prototype as unknown as {
        validateOptions(this: object, json: { data: string }): void;
      }
    ).validateOptions.call({ name, opts: { jobId } }, { data: "{}" });

  const uuid = "cb4ea228-e697-47b0-9eb6-8249fc530b52";

  it.each([
    ["MigrateDedicatedServer", DedicatedServerMigrationService.jobId(uuid)],
    [
      "CleanupDedicatedServerFiles",
      DedicatedServersService.cleanupFilesJobId(uuid),
    ],
  ])("BullMQ accepts the %s job id", (name, jobId) => {
    expect(() => validate(name, jobId)).not.toThrow();
  });
});
