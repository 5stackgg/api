import { createHmac } from "crypto";
import { HasuraMaintenanceJob } from "./HasuraMaintenanceJob";
import { FileUrlSigningService } from "../file-url-signing.service";

// A restore from a backup taken before the signing key was stored drops it,
// and every clip link goes out unsigned until it is back.
describe("HasuraMaintenanceJob", () => {
  it("puts the file link signing key back every run", async () => {
    const postgres = { query: jest.fn().mockResolvedValue([]) };
    const logger = { log: jest.fn(), warn: jest.fn() };
    const job = new HasuraMaintenanceJob(
      logger as any,
      postgres as any,
      new FileUrlSigningService(
        logger as any,
        { get: () => ({ secret: "bucket-secret" }) } as any,
        postgres as any,
      ),
    );

    await job.process();

    const stored = postgres.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO private.file_url_signing_key"),
    );
    expect(stored).toBeDefined();
    expect(
      Buffer.from(stored![1][0]).equals(
        createHmac("sha256", "bucket-secret")
          .update("5stack-file-url-v1")
          .digest(),
      ),
    ).toBe(true);
  });
});
