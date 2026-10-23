import { UtilityPracticeController } from "./utility-practice.controller";
import { HasuraService } from "../hasura/hasura.service";

describe("UtilityPracticeController starting practice in a LAN region", () => {
  const user = { name: "Player", role: "user", steam_id: "100" } as any;

  let practice: { start: jest.Mock };
  let controller: UtilityPracticeController;

  beforeEach(() => {
    practice = { start: jest.fn().mockResolvedValue({ id: "session-1" }) };
    const hasura = {
      query: jest.fn(async () => ({ server_regions: [{ value: "Lan" }] })),
      assertLanRegionsReachable: (
        ...args: Parameters<HasuraService["assertLanRegionsReachable"]>
      ) =>
        HasuraService.prototype.assertLanRegionsReachable.apply(hasura, args),
    };
    controller = new UtilityPracticeController(
      practice as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      hasura as any,
    );
  });

  const start = (region: string | undefined, lanRegions: Array<string>) =>
    controller.startUtilityPractice({
      user,
      map_name: "de_mirage",
      region,
      lanRegions: async () => lanRegions,
    });

  it("refuses a player off the LAN", async () => {
    await expect(start("Lan", [])).rejects.toThrow(
      "You must be on the LAN to play in a LAN region",
    );
    expect(practice.start).not.toHaveBeenCalled();
  });

  it("starts one for a player the probe placed on the LAN", async () => {
    await start("Lan", ["Lan"]);
    expect(practice.start).toHaveBeenCalled();
  });

  it("leaves online and unnamed regions alone", async () => {
    await start("US East", []);
    await start(undefined, []);
    expect(practice.start).toHaveBeenCalledTimes(2);
  });
});
