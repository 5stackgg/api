import { UtilityRendersController } from "./utility-renders.controller";

// Cancelling the last render of a map must take the practice server (and any
// filming pod) down with it -- a booked GPU server idling until the batch
// job's next tick was invisible money on fire.
describe("cancelUtilityLineupRender", () => {
  const USER = { steam_id: "1", role: "administrator" } as any;

  function make() {
    const renders = {
      cancel: jest.fn().mockResolvedValue({
        cancelled: true,
        mapName: "de_mirage",
        sessionId: "session-1",
      }),
      inFlightForMap: jest.fn().mockResolvedValue([]),
    };
    const gameStreamer = { killNadeRenderPod: jest.fn() };
    const practice = { endRenderSession: jest.fn() };
    const controller = new UtilityRendersController(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      renders as any,
      {} as any,
      gameStreamer as any,
      practice as any,
    );
    return { controller, renders, gameStreamer, practice };
  }

  it("tears down the pod and the practice server with the last render", async () => {
    const { controller, gameStreamer, practice } = make();

    const result = await controller.cancelUtilityLineupRender({
      user: USER,
      render_id: "render-1",
    });

    expect(result).toEqual({ success: true });
    expect(gameStreamer.killNadeRenderPod).toHaveBeenCalledWith("de_mirage");
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });

  it("leaves the server alone while other renders still need it", async () => {
    const { controller, renders, gameStreamer, practice } = make();
    renders.inFlightForMap.mockResolvedValueOnce([{ id: "render-2" }]);

    await controller.cancelUtilityLineupRender({
      user: USER,
      render_id: "render-1",
    });

    expect(gameStreamer.killNadeRenderPod).not.toHaveBeenCalled();
    expect(practice.endRenderSession).not.toHaveBeenCalled();
  });

  it("does nothing extra when the render was already terminal", async () => {
    const { controller, renders, gameStreamer, practice } = make();
    renders.cancel.mockResolvedValueOnce({
      cancelled: false,
      mapName: null,
      sessionId: null,
    });

    const result = await controller.cancelUtilityLineupRender({
      user: USER,
      render_id: "render-1",
    });

    expect(result).toEqual({ success: false });
    expect(renders.inFlightForMap).not.toHaveBeenCalled();
    expect(gameStreamer.killNadeRenderPod).not.toHaveBeenCalled();
    expect(practice.endRenderSession).not.toHaveBeenCalled();
  });

  it("still ends the session when no pod was ever dispatched", async () => {
    const { controller, gameStreamer, practice } = make();

    await controller.cancelUtilityLineupRender({
      user: USER,
      render_id: "render-1",
    });

    // killNadeRenderPod deletes by name and swallows a missing job — safe to
    // call whether or not a pod exists.
    expect(gameStreamer.killNadeRenderPod).toHaveBeenCalled();
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });
});
