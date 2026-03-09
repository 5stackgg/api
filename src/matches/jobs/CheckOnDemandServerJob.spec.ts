jest.mock("@nestjs/bullmq", () => ({
  WorkerHost: class {},
  QueueEventsHost: class {},
  QueueEventsListener: () => () => {},
  OnQueueEvent: () => () => {},
}));

jest.mock("../../utilities/QueueProcessors", () => ({
  UseQueue: () => () => {},
}));

jest.mock("../match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

jest.mock(
  "../../discord-bot/discord-bot-overview/discord-bot-overview.service",
  () => ({
    DiscordBotOverviewService: jest.fn(),
  }),
);

import { CheckOnDemandServerJob } from "./CheckOnDemandServerJob";

function createProcessor(isRunning = true) {
  const matchAssistant = {
    isOnDemandServerRunning: jest.fn().mockResolvedValue(isRunning),
  };
  const discordMatchOverview = {
    updateMatchOverview: jest.fn().mockResolvedValue(undefined),
  };

  const processor = new CheckOnDemandServerJob(
    matchAssistant as any,
    discordMatchOverview as any,
  );

  return { processor, matchAssistant, discordMatchOverview };
}

describe("CheckOnDemandServerJob", () => {
  it("throws when on-demand server is not running", async () => {
    const { processor } = createProcessor(false);

    await expect(
      processor.process({ data: { matchId: "match-1" } } as any),
    ).rejects.toThrow("on demand server is not running");
  });

  it("updates Discord overview when server is running", async () => {
    const { processor, discordMatchOverview } = createProcessor(true);

    await processor.process({ data: { matchId: "match-1" } } as any);

    expect(discordMatchOverview.updateMatchOverview).toHaveBeenCalledWith(
      "match-1",
    );
  });
});
