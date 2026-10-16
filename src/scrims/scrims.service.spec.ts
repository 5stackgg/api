import { ScrimsService } from "./scrims.service";

describe("ScrimsService", () => {
  describe("scrim match options", () => {
    // Hasura returns rows unordered; a rotated-out seed pool can come first.
    const pools = [
      { id: "retired-seed", type: "Competitive", seed: true, enabled: false },
      { id: "custom", type: "Custom", seed: false, enabled: true },
      { id: "non-seed", type: "Competitive", seed: false, enabled: true },
      { id: "live-seed", type: "Competitive", seed: true, enabled: true },
    ];

    const poolsMatching = (where: Record<string, { _eq: unknown }>) => {
      return pools.filter((pool) => {
        return Object.entries(where).every(([column, condition]) => {
          return pool[column as keyof typeof pool] === condition._eq;
        });
      });
    };

    it("vetoes from the enabled seed pool, not a retired one", async () => {
      const hasura = {
        query: jest.fn(async (request: any) => {
          return {
            map_pools: poolsMatching(request.map_pools.__args.where),
          };
        }),
      };

      const service = new ScrimsService(
        hasura as any,
        {} as any,
        {} as any,
        {} as any,
        { get: jest.fn(() => ({})) } as any,
        {} as any,
      );

      const options = await service["scrimMatchOptionsInput"](1);

      expect(options.map_pool_id).toBe("live-seed");
    });
  });
});
