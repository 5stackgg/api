jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { StopMatchBroadcast } from "./StopMatchBroadcast";

describe("StopMatchBroadcast", () => {
  let matchAssistant: { hasMatchEnded: jest.Mock };
  let gameStreamer: Record<string, jest.Mock>;
  let matchRelay: { removeBroadcast: jest.Mock };
  let clips: { resumeAllPausedBatches: jest.Mock };
  let job: StopMatchBroadcast;

  beforeEach(() => {
    matchAssistant = { hasMatchEnded: jest.fn(async () => true) };
    gameStreamer = {
      stopLiveIfRunning: jest.fn(async () => true),
      promotePendingLiveStreams: jest.fn(async () => ({
        promoted: [] as string[],
      })),
    };
    matchRelay = { removeBroadcast: jest.fn() };
    clips = { resumeAllPausedBatches: jest.fn() };
    job = new StopMatchBroadcast(
      { log: jest.fn() } as any,
      matchAssistant as any,
      gameStreamer as any,
      matchRelay as any,
      clips as any,
    );
  });

  const run = () => job.process({ data: { matchId: "match-1" } } as any);

  it("stops the stream and drops the relay broadcast once the match is over", async () => {
    await run();

    expect(matchRelay.removeBroadcast).toHaveBeenCalledWith("match-1");
    expect(gameStreamer.stopLiveIfRunning).toHaveBeenCalledWith("match-1");
  });

  it("hands the freed GPU to a waiting stream first", async () => {
    gameStreamer.promotePendingLiveStreams.mockResolvedValue({
      promoted: ["match-2"],
    });

    await run();

    expect(gameStreamer.promotePendingLiveStreams).toHaveBeenCalled();
    expect(clips.resumeAllPausedBatches).not.toHaveBeenCalled();
  });

  it("hands the freed GPU to paused renders when no stream is waiting", async () => {
    await run();

    expect(clips.resumeAllPausedBatches).toHaveBeenCalled();
  });

  it("frees nothing when the stream was already gone", async () => {
    gameStreamer.stopLiveIfRunning.mockResolvedValue(false);

    await run();

    expect(gameStreamer.promotePendingLiveStreams).not.toHaveBeenCalled();
    expect(clips.resumeAllPausedBatches).not.toHaveBeenCalled();
  });

  it("leaves a match that was started again during the delay alone", async () => {
    matchAssistant.hasMatchEnded.mockResolvedValue(false);

    await run();

    expect(matchRelay.removeBroadcast).not.toHaveBeenCalled();
    expect(gameStreamer.stopLiveIfRunning).not.toHaveBeenCalled();
  });
});
