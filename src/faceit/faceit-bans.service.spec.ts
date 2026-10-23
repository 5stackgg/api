import { FaceitBansService } from "./faceit-bans.service";

describe("FaceitBansService.activeCheatingBan", () => {
  const now = Date.parse("2026-10-23T00:00:00Z");

  it("ignores bans that are not for cheating", () => {
    expect(
      FaceitBansService.activeCheatingBan(
        [
          {
            reason: "multiple accounts",
            starts_at: "2018-02-07T12:20:33.751Z",
            ends_at: null,
          },
          { reason: "toxic behavior", starts_at: "2026-10-01T00:00:00Z" },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("ignores a cheating ban that has ended", () => {
    expect(
      FaceitBansService.activeCheatingBan(
        [
          {
            reason: "cheating",
            starts_at: "2023-01-01T00:00:00Z",
            ends_at: "2025-01-01T00:00:00Z",
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("matches the reason in any case", () => {
    expect(
      FaceitBansService.activeCheatingBan(
        [{ reason: "Cheating", starts_at: "2026-01-01T00:00:00Z" }],
        now,
      ),
    ).toEqual({ startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: null });
  });

  it("dates overlapping cheating bans from the newest, to the latest end", () => {
    expect(
      FaceitBansService.activeCheatingBan(
        [
          {
            reason: "cheating",
            starts_at: "2025-06-01T00:00:00Z",
            ends_at: "2027-06-01T00:00:00Z",
          },
          {
            reason: "cheating",
            starts_at: "2026-03-01T00:00:00Z",
            ends_at: "2028-03-01T00:00:00Z",
          },
        ],
        now,
      ),
    ).toEqual({
      startsAt: new Date("2026-03-01T00:00:00Z"),
      endsAt: new Date("2028-03-01T00:00:00Z"),
    });
  });

  it("never ends while any cheating ban is permanent", () => {
    expect(
      FaceitBansService.activeCheatingBan(
        [
          { reason: "cheating", starts_at: "2024-01-01T00:00:00Z" },
          {
            reason: "cheating",
            starts_at: "2026-03-01T00:00:00Z",
            ends_at: "2028-03-01T00:00:00Z",
          },
        ],
        now,
      )?.endsAt,
    ).toBeNull();
  });

  it("skips a ban with no start date", () => {
    expect(
      FaceitBansService.activeCheatingBan([{ reason: "cheating" }], now),
    ).toBeNull();
  });

  it("keeps a cheating ban with an unreadable end as never ending", () => {
    expect(
      FaceitBansService.activeCheatingBan(
        [
          {
            reason: "cheating",
            starts_at: "2026-01-01T00:00:00Z",
            ends_at: "not a date",
          },
        ],
        now,
      ),
    ).toEqual({ startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: null });
  });
});

describe("FaceitBansService.enqueueChecks", () => {
  const queueWith = (priority: number) => {
    const changePriority = jest.fn(async (): Promise<void> => undefined);
    return {
      changePriority,
      queue: {
        addBulk: jest.fn(async (): Promise<Array<unknown>> => []),
        getJob: jest.fn(async () => ({ priority, changePriority })),
      },
    };
  };

  it("moves a sign-in ahead of a sweep job already waiting for the player", async () => {
    const { queue, changePriority } = queueWith(10);

    await FaceitBansService.enqueueChecks(queue as any, ["76561198000000001"]);

    expect(queue.getJob).toHaveBeenCalledWith(
      "check-faceit-bans.76561198000000001",
    );
    expect(changePriority).toHaveBeenCalledWith({ priority: 0 });
  });

  it("leaves the order alone for the sweep itself", async () => {
    const { queue } = queueWith(10);

    await FaceitBansService.enqueueChecks(
      queue as any,
      ["76561198000000001"],
      10,
    );

    expect(queue.getJob).not.toHaveBeenCalled();
  });
});
