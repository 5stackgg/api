import { ValidateGamedata } from "./ValidateGamedata";

describe("ValidateGamedata", () => {
  let gameServerNodeService: { validateGamedata: jest.Mock };
  let mapAssets: { queueBuild: jest.Mock };
  let job: ValidateGamedata;

  beforeEach(() => {
    gameServerNodeService = {
      validateGamedata: jest
        .fn()
        .mockResolvedValue({ status: "pass", broken: [] }),
    };
    mapAssets = { queueBuild: jest.fn().mockResolvedValue(true) };
    job = new ValidateGamedata(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { send: jest.fn() } as any,
      gameServerNodeService as any,
      mapAssets as any,
    );
  });

  const run = (data: Record<string, unknown>) =>
    job.process({
      data: { gameServerNodeId: "node-1", buildId: 25537370, ...data },
    } as any);

  it("starts the chained map-assets build once validation finishes", async () => {
    const order: Array<string> = [];
    gameServerNodeService.validateGamedata.mockImplementation(async () => {
      order.push("validate");
      return { status: "pass", broken: [] };
    });
    mapAssets.queueBuild.mockImplementation(async () => {
      order.push("map-assets");
      return true;
    });

    await run({ buildMapAssets: true });

    expect(order).toEqual(["validate", "map-assets"]);
    expect(mapAssets.queueBuild).toHaveBeenCalledWith("node-1", 25537370);
  });

  it("still starts it when validation fails outright", async () => {
    gameServerNodeService.validateGamedata.mockRejectedValue(
      new Error("k8s down"),
    );

    await expect(run({ buildMapAssets: true })).rejects.toThrow("k8s down");
    expect(mapAssets.queueBuild).toHaveBeenCalledWith("node-1", 25537370);
  });

  it("leaves map assets alone for a validation nobody chained to", async () => {
    await run({});

    expect(mapAssets.queueBuild).not.toHaveBeenCalled();
  });
});
