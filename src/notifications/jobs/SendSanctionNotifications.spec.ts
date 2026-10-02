import { SendSanctionNotifications } from "./SendSanctionNotifications";

describe("SendSanctionNotifications", () => {
  const ban = {
    sanctionId: "sanction-1",
    steamId: "76561198000000001",
    type: "ban",
    reason: "cheating",
  };

  let order: string[];
  let notifications: Record<string, jest.Mock>;
  let logger: { error: jest.Mock };
  let job: SendSanctionNotifications;

  const step = (name: string) =>
    jest.fn(async () => {
      order.push(name);
    });

  beforeEach(() => {
    order = [];
    notifications = {
      notifyBannedPlayer: step("banned player"),
      notifyWarnedPlayer: step("warned player"),
      notifyAdminsOfBan: step("admins"),
      notifyMatchPlayersOfSanction: step("co-players"),
    };
    logger = { error: jest.fn() };
    job = new SendSanctionNotifications(notifications as any, logger as any);
  });

  it("tells the banned player and the admins before the co-player fan-out", async () => {
    await job.process({ data: ban } as any);

    expect(order).toEqual([
      "banned player",
      "warned player",
      "admins",
      "co-players",
    ]);
  });

  it("still alerts the admins when the co-player fan-out throws", async () => {
    notifications.notifyMatchPlayersOfSanction.mockRejectedValue(
      new Error("value 'TeammateBanned' for enum not found"),
    );

    await job.process({ data: ban } as any);

    expect(notifications.notifyAdminsOfBan).toHaveBeenCalledWith(ban);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("still reaches the co-players when an earlier notice throws", async () => {
    notifications.notifyBannedPlayer.mockRejectedValue(new Error("down"));
    notifications.notifyAdminsOfBan.mockRejectedValue(new Error("down"));

    await job.process({ data: ban } as any);

    expect(notifications.notifyWarnedPlayer).toHaveBeenCalledWith(ban);
    expect(notifications.notifyMatchPlayersOfSanction).toHaveBeenCalledWith(
      ban,
    );
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
