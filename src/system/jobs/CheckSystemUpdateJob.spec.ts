jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(),
  })),
  CoreV1Api: jest.fn(),
  AppsV1Api: jest.fn(),
  setHeaderOptions: jest.fn(),
  PatchStrategy: { StrategicMergePatch: "strategic-merge-patch" },
}));

import { CheckSystemUpdateJob } from "./CheckSystemUpdateJob";

function createProcessor() {
  const system = {
    setVersions: jest.fn().mockResolvedValue(undefined),
  };

  const processor = new CheckSystemUpdateJob(system as any);

  return { processor, system };
}

describe("CheckSystemUpdateJob", () => {
  it("calls system.setVersions", async () => {
    const { processor, system } = createProcessor();

    await processor.process();

    expect(system.setVersions).toHaveBeenCalled();
  });
});
