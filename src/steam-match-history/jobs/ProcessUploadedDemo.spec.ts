import { UnrecoverableError } from "bullmq";
import { ProcessUploadedDemo } from "./ProcessUploadedDemo";

const ROOM = "1-c0d53305-38d8-4d84-9f40-cd0a6032e5bd";

describe("ProcessUploadedDemo", () => {
  function make({
    serverName = "FACEIT.com register to play here",
    imported = { matchId: "match-1" } as {
      matchId: string | null;
      skipped?: string;
    },
  } = {}) {
    const demoParser = {
      parseFromS3Key: jest.fn(async () => ({ server_name: serverName })),
    };
    const matchImport = {
      importExternalDemo: jest.fn(async () => imported),
    };
    const s3 = { remove: jest.fn(async () => true) };
    const job = new ProcessUploadedDemo(
      { log: jest.fn(), warn: jest.fn() } as never,
      demoParser as never,
      matchImport as never,
      s3 as never,
    );
    return { job, matchImport, s3 };
  }

  const updateData = jest.fn(async (): Promise<void> => undefined);

  const run = (job: ProcessUploadedDemo, data: Record<string, unknown>) =>
    job.process({
      data: { key: "demo-uploads/7656/a.dem", steam_id: "7656", ...data },
      attemptsMade: 0,
      opts: { attempts: 3 },
      updateData,
    } as never);

  beforeEach(() => {
    updateData.mockClear();
  });

  it("files an extension import under its own external id as a FACEIT match", async () => {
    const { job, matchImport, s3 } = make();

    await run(job, {
      file_name: `${ROOM}.2.dem`,
      external_id: `${ROOM}.2`,
      source: "faceit",
      match_start_time: "2026-10-05T23:17:49.000Z",
    });

    expect(matchImport.importExternalDemo).toHaveBeenCalledWith(
      expect.anything(),
      "faceit",
      `${ROOM}.2`,
      expect.objectContaining({
        externalId: `${ROOM}.2`,
        matchStartTime: "2026-10-05T23:17:49.000Z",
        sourceObjectKey: "demo-uploads/7656/a.dem",
      }),
    );
    expect(s3.remove).toHaveBeenCalledTimes(1);
    expect(updateData).toHaveBeenCalledWith(
      expect.objectContaining({ match_id: "match-1" }),
    );
  });

  it("reports a skipped demo as the job's failure, not a success", async () => {
    const { job, s3 } = make({
      imported: { matchId: null, skipped: "faceit wingman not supported" },
    });

    await expect(
      run(job, { file_name: "x.dem", external_id: ROOM, source: "faceit" }),
    ).rejects.toThrow(new UnrecoverableError("faceit wingman not supported"));
    expect(s3.remove).toHaveBeenCalledTimes(1);
  });

  it("still completes an admin upload that was skipped", async () => {
    const { job, s3 } = make({
      serverName: "Valve CS2 server",
      imported: { matchId: null, skipped: "no players in demo" },
    });

    await expect(run(job, { file_name: "x.dem" })).resolves.toBeUndefined();
    expect(s3.remove).toHaveBeenCalledTimes(1);
    expect(updateData).not.toHaveBeenCalled();
  });

  it("keeps an admin upload's filename dedupe and valve source", async () => {
    const { job, matchImport } = make({ serverName: "Valve CS2 server" });

    await run(job, { file_name: "match730_0031.dem" });

    expect(matchImport.importExternalDemo).toHaveBeenCalledWith(
      expect.anything(),
      "valve",
      "match730_0031",
      expect.objectContaining({ matchStartTime: null }),
    );
  });
});
