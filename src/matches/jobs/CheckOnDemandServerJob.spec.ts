jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { DelayedError } from "bullmq";
import {
  CheckOnDemandServerJob,
  CheckOnDemandServerJobEvents,
} from "./CheckOnDemandServerJob";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";

describe("CheckOnDemandServerJob", () => {
  let matchAssistant: {
    monitorOnDemandServerBoot: jest.Mock;
  };
  let discordMatchOverview: {
    updateMatchOverview: jest.Mock;
  };
  let jobProcessor: CheckOnDemandServerJob;

  beforeEach(() => {
    matchAssistant = {
      monitorOnDemandServerBoot: jest.fn(),
    };
    discordMatchOverview = {
      updateMatchOverview: jest.fn(),
    };

    jobProcessor = new CheckOnDemandServerJob(
      matchAssistant as any,
      discordMatchOverview as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("delays pending boot checks without failing the job", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    matchAssistant.monitorOnDemandServerBoot.mockResolvedValue("pending");

    const job = {
      data: {
        matchId: "match-1",
      },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
      token: "token-1",
    };

    await expect(jobProcessor.process(job as any)).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      1000 + MatchAssistantService.ON_DEMAND_SERVER_BOOT_CHECK_DELAY_MS,
      "token-1",
    );
    expect(discordMatchOverview.updateMatchOverview).not.toHaveBeenCalled();
  });

  it("updates the match overview once the server is ready", async () => {
    matchAssistant.monitorOnDemandServerBoot.mockResolvedValue("ready");

    await expect(
      jobProcessor.process({
        data: {
          matchId: "match-1",
        },
      } as any),
    ).resolves.toBeUndefined();

    expect(discordMatchOverview.updateMatchOverview).toHaveBeenCalledWith(
      "match-1",
    );
  });

  it("stops quietly when monitoring no longer applies", async () => {
    matchAssistant.monitorOnDemandServerBoot.mockResolvedValue("stopped");

    await expect(
      jobProcessor.process({
        data: {
          matchId: "match-1",
        },
      } as any),
    ).resolves.toBeUndefined();

    expect(discordMatchOverview.updateMatchOverview).not.toHaveBeenCalled();
  });
});

describe("CheckOnDemandServerJobEvents", () => {
  let matchAssistant: { delayCheckOnDemandServer: jest.Mock };
  let events: CheckOnDemandServerJobEvents;

  beforeEach(() => {
    matchAssistant = { delayCheckOnDemandServer: jest.fn() };
    events = new CheckOnDemandServerJobEvents(matchAssistant as any);
  });

  // QueueEvents hands the listener the job's id and failure, not the job.
  it("re-arms the boot check that failed", async () => {
    await events.onFailed({
      jobId: "match.0b6f3c9e-4a57-4d2f-9f0e-3c2b1a0d9e8f.server",
      failedReason: "hasura unavailable",
    });

    expect(matchAssistant.delayCheckOnDemandServer).toHaveBeenCalledWith(
      "0b6f3c9e-4a57-4d2f-9f0e-3c2b1a0d9e8f",
    );
  });

  it("leaves any other failed job on the queue alone", async () => {
    await events.onFailed({ jobId: "42", failedReason: "boom" });

    expect(matchAssistant.delayCheckOnDemandServer).not.toHaveBeenCalled();
  });
});
