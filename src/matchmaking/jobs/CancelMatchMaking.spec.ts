jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import { CancelMatchMaking } from "./CancelMatchMaking";

function createProcessor() {
  const matchmaking = {
    cancelMatchMaking: jest.fn().mockResolvedValue(undefined),
  };

  const processor = new CancelMatchMaking(matchmaking as any);

  return { processor, matchmaking };
}

describe("CancelMatchMaking", () => {
  it("calls cancelMatchMaking with confirmationId from job data", async () => {
    const { processor, matchmaking } = createProcessor();

    await processor.process({ data: { confirmationId: "conf-123" } } as any);

    expect(matchmaking.cancelMatchMaking).toHaveBeenCalledWith("conf-123");
  });

  it("passes through different confirmationIds", async () => {
    const { processor, matchmaking } = createProcessor();

    await processor.process({
      data: { confirmationId: "another-id" },
    } as any);

    expect(matchmaking.cancelMatchMaking).toHaveBeenCalledWith("another-id");
  });
});
