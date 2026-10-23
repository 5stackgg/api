jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { AssignWaitingMatch } from "./AssignWaitingMatch";

describe("AssignWaitingMatch", () => {
  let matchAssistant: { assignWaitingMatch: jest.Mock };
  let processor: AssignWaitingMatch;

  beforeEach(() => {
    matchAssistant = { assignWaitingMatch: jest.fn() };
    processor = new AssignWaitingMatch(matchAssistant as any);
  });

  it("hands the region's freed server to its oldest waiting match", async () => {
    await processor.process({ data: { region: "USE" } } as any);

    expect(matchAssistant.assignWaitingMatch).toHaveBeenCalledWith("USE");
  });

  it("fails the job when the assignment throws, so BullMQ retries it", async () => {
    matchAssistant.assignWaitingMatch.mockRejectedValue(
      new Error("hasura down"),
    );

    await expect(
      processor.process({ data: { region: "USE" } } as any),
    ).rejects.toThrow("hasura down");
  });
});
