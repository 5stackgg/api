import { DelayedError } from "bullmq";
import { ExpandMatchmaking } from "./ExpandMatchmaking";

describe("ExpandMatchmaking", () => {
  const job = (data: Record<string, unknown>) => ({
    data,
    token: "token-1",
    updateData: jest.fn().mockResolvedValue(undefined),
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // The pass asks for the next one under this job's own id, which the job
  // holds until it finishes, so that request is dropped and only the job
  // itself can carry the search on.
  it("puts itself back in the delayed set when the pass wants another", async () => {
    const matchmaking = {
      matchmake: jest.fn().mockResolvedValue({ delay: 20_000, failures: 2 }),
    };
    const expand = job({ type: "Competitive", region: "us-east", failures: 1 });

    await expect(
      new ExpandMatchmaking(matchmaking as any).process(expand as any),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(matchmaking.matchmake).toHaveBeenCalledWith(
      "Competitive",
      "us-east",
      1,
    );
    expect(expand.updateData).toHaveBeenCalledWith({
      type: "Competitive",
      region: "us-east",
      failures: 2,
    });
    expect(expand.moveToDelayed).toHaveBeenCalledWith(1_020_000, "token-1");
  });

  it("finishes when the pass wants no other", async () => {
    const matchmaking = { matchmake: jest.fn().mockResolvedValue(undefined) };
    const expand = job({ type: "Competitive", region: "us-east" });

    await expect(
      new ExpandMatchmaking(matchmaking as any).process(expand as any),
    ).resolves.toBeUndefined();

    expect(matchmaking.matchmake).toHaveBeenCalledWith(
      "Competitive",
      "us-east",
      0,
    );
    expect(expand.moveToDelayed).not.toHaveBeenCalled();
  });
});
