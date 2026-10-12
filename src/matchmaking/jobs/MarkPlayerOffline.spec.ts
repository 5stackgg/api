import { MarkPlayerOffline } from "./MarkPlayerOffline";

const STEAM_ID = "76561198000000001";

function build(clientKeys: string[], livePods: string[]) {
  const redis = {
    keys: jest.fn().mockResolvedValue(clientKeys),
    exists: jest.fn(async (key: string) =>
      livePods.some((pod) => key === `sockets:pod:${pod}`) ? 1 : 0,
    ),
  };
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const lobbies = {
    getPlayerLobby: jest.fn().mockResolvedValue({ id: "lobby-1" }),
    removeLobbyFromQueue: jest.fn().mockResolvedValue(true),
  };

  const job = new MarkPlayerOffline(
    hasura as any,
    lobbies as any,
    { getConnection: () => redis } as any,
  );

  return { job, hasura, lobbies };
}

describe("MarkPlayerOffline", () => {
  const run = (job: MarkPlayerOffline) =>
    job.process({ data: { steamId: STEAM_ID } } as any);

  // The job waits a minute; a reload or a hidden tab can be back by then.
  it("leaves a player who has a tab open on a live pod alone", async () => {
    const { job, hasura, lobbies } = build(
      [`clients:${STEAM_ID}:pod-a:client-1`],
      ["pod-a"],
    );

    await run(job);

    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(lobbies.removeLobbyFromQueue).not.toHaveBeenCalled();
  });

  it("takes a player out of their lobby when only a dead pod still lists them", async () => {
    const { job, hasura, lobbies } = build(
      [`clients:${STEAM_ID}:dead-pod:client-1`],
      [],
    );

    await run(job);

    expect(hasura.mutation).toHaveBeenCalledTimes(1);
    expect(lobbies.removeLobbyFromQueue).toHaveBeenCalledWith("lobby-1");
  });
});
