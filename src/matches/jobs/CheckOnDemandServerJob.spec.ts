jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { DelayedError } from "bullmq";
import { CheckOnDemandServerJob } from "./CheckOnDemandServerJob";
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
