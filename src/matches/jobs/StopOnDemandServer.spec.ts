jest.mock("@nestjs/bullmq", () => ({
  WorkerHost: class {},
}));

jest.mock("../../utilities/QueueProcessors", () => ({
  UseQueue: () => () => {},
}));

jest.mock("../match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

import { StopOnDemandServer } from "./StopOnDemandServer";

function createProcessor() {
  const matchAssistant = {
    stopOnDemandServer: jest.fn().mockResolvedValue(undefined),
  };

  const processor = new StopOnDemandServer(matchAssistant as any);

  return { processor, matchAssistant };
}

describe("StopOnDemandServer", () => {
  it("delegates to matchAssistant.stopOnDemandServer with matchId", async () => {
    const { processor, matchAssistant } = createProcessor();

    await processor.process({ data: { matchId: "match-42" } } as any);

    expect(matchAssistant.stopOnDemandServer).toHaveBeenCalledWith("match-42");
  });
});
