jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import MatchMapStatusEvent from "./MatchMapStatusEvent";

function createEvent(data: Record<string, any>) {
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({
      update_match_maps_by_pk: { id: "map-1", match: { current_match_map_id: null } },
    }),
  };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = { sendServerMatchId: jest.fn().mockResolvedValue(undefined) };
  const chat = {};
  const notifications = { sendMatchMapPauseNotification: jest.fn().mockResolvedValue(undefined) };
  const event = new MatchMapStatusEvent(
    logger as any,
    hasura as any,
    matchAssistant as any,
    chat as any,
    notifications as any,
  );
  event.setData("match-1", data as any);
  return { event, hasura, matchAssistant, notifications };
}

describe("MatchMapStatusEvent", () => {
  it("returns early when match has no current_match_map_id", async () => {
    const { event, hasura } = createEvent({ status: "Live" });
    hasura.query.mockResolvedValueOnce({ matches_by_pk: { current_match_map_id: null } });

    await event.process();

    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("updates match map status", async () => {
    const { event, hasura } = createEvent({ status: "Live" });
    hasura.query.mockResolvedValueOnce({ matches_by_pk: { current_match_map_id: "map-1" } });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_match_maps_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({ status: "Live" }),
          }),
        }),
      }),
    );
  });

  it("includes winning_lineup_id when provided", async () => {
    const { event, hasura } = createEvent({ status: "Finished", winning_lineup_id: "lineup-1" });
    hasura.query.mockResolvedValueOnce({ matches_by_pk: { current_match_map_id: "map-1" } });

    await event.process();

    const call = hasura.mutation.mock.calls[0][0];
    expect(call.update_match_maps_by_pk.__args._set.winning_lineup_id).toBe("lineup-1");
  });

  it("does not include winning_lineup_id when not provided", async () => {
    const { event, hasura } = createEvent({ status: "Live" });
    hasura.query.mockResolvedValueOnce({ matches_by_pk: { current_match_map_id: "map-1" } });

    await event.process();

    const call = hasura.mutation.mock.calls[0][0];
    expect(call.update_match_maps_by_pk.__args._set).not.toHaveProperty("winning_lineup_id");
  });

  it("sends pause notification when status is Paused", async () => {
    const { event, hasura, notifications } = createEvent({ status: "Paused" });
    hasura.query.mockResolvedValueOnce({ matches_by_pk: { current_match_map_id: "map-1" } });

    await event.process();

    expect(notifications.sendMatchMapPauseNotification).toHaveBeenCalledWith("match-1");
  });

  it("calls sendServerMatchId when map finished but more maps remain", async () => {
    const { event, hasura, matchAssistant } = createEvent({ status: "Finished" });
    hasura.query.mockResolvedValueOnce({ matches_by_pk: { current_match_map_id: "map-1" } });
    hasura.mutation.mockResolvedValueOnce({
      update_match_maps_by_pk: { id: "map-1", match: { current_match_map_id: "map-2" } },
    });

    await event.process();

    expect(matchAssistant.sendServerMatchId).toHaveBeenCalledWith("match-1");
  });

  it("does not call sendServerMatchId when no more maps remain", async () => {
    const { event, hasura, matchAssistant } = createEvent({ status: "Finished" });
    hasura.query.mockResolvedValueOnce({ matches_by_pk: { current_match_map_id: "map-1" } });
    hasura.mutation.mockResolvedValueOnce({
      update_match_maps_by_pk: { id: "map-1", match: { current_match_map_id: null } },
    });

    await event.process();

    expect(matchAssistant.sendServerMatchId).not.toHaveBeenCalled();
  });

  it("does not send pause notification for non-Paused status", async () => {
    const { event, hasura, notifications } = createEvent({ status: "Live" });
    hasura.query.mockResolvedValueOnce({ matches_by_pk: { current_match_map_id: "map-1" } });

    await event.process();

    expect(notifications.sendMatchMapPauseNotification).not.toHaveBeenCalled();
  });
});
