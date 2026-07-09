import AntiWallhackStatusEvent from "./AntiWallhackStatusEvent";

describe("AntiWallhackStatusEvent", () => {
  const buildProcessor = (hasura: any) => {
    const processor = new AntiWallhackStatusEvent(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      hasura,
      {} as any,
      {} as any,
      {} as any,
    );
    return processor;
  };

  it("writes anti_wallhack_active to the current match map", async () => {
    const hasura = {
      query: jest.fn().mockResolvedValue({
        matches_by_pk: { current_match_map_id: "map-1" },
      }),
      mutation: jest.fn().mockResolvedValue({}),
    };

    const processor = buildProcessor(hasura);
    processor.setData("match-1", { active: true });
    await processor.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      update_match_maps_by_pk: {
        __args: {
          pk_columns: { id: "map-1" },
          _set: { anti_wallhack_active: true },
        },
        id: true,
      },
    });
  });

  it("coerces non-boolean payloads to false", async () => {
    const hasura = {
      query: jest.fn().mockResolvedValue({
        matches_by_pk: { current_match_map_id: "map-1" },
      }),
      mutation: jest.fn().mockResolvedValue({}),
    };

    const processor = buildProcessor(hasura);
    processor.setData("match-1", { active: "yes" } as any);
    await processor.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_match_maps_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { anti_wallhack_active: false },
          }),
        }),
      }),
    );
  });

  it("does nothing when the match has no current map", async () => {
    const hasura = {
      query: jest.fn().mockResolvedValue({
        matches_by_pk: { current_match_map_id: null },
      }),
      mutation: jest.fn(),
    };

    const processor = buildProcessor(hasura);
    processor.setData("match-1", { active: true });
    await processor.process();

    expect(hasura.mutation).not.toHaveBeenCalled();
  });
});
