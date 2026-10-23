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
