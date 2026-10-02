import { NotificationPreferencesService } from "./notification-preferences.service";

describe("NotificationPreferencesService.list", () => {
  const STEAM_ID = "76561198000000001";

  const service = (stored: Array<{ key: string; enabled: boolean }>) =>
    new NotificationPreferencesService({
      query: jest.fn().mockResolvedValue(stored),
    } as any);

  it("hands the page every type in each push category", async () => {
    const rows = await service([{ key: "account", enabled: false }]).list(
      STEAM_ID,
      "push",
    );

    expect(rows.find((row) => row.key === "account")).toEqual({
      key: "account",
      defaultEnabled: true,
      enabled: false,
      types: [
        {
          type: "NameChangeApproved",
          bell: "locked",
          ignoresQuietHours: false,
        },
        { type: "NameChangeDenied", bell: "locked", ignoresQuietHours: false },
        { type: "PlayerSanctioned", bell: "locked", ignoresQuietHours: false },
        { type: "PlayerWarning", bell: "locked", ignoresQuietHours: false },
        { type: "AwardGranted", bell: "toggle", ignoresQuietHours: false },
      ],
    });
  });

  it("keeps staff categories flagged so the page can hide them", async () => {
    const rows = await service([]).list(STEAM_ID, "push");

    expect(rows.find((row) => row.key === "staff_moderation")).toEqual(
      expect.objectContaining({
        adminOnly: true,
        types: [
          { type: "MatchSupport", bell: "locked", ignoresQuietHours: false },
          { type: "MatchAbandoned", bell: "locked", ignoresQuietHours: false },
          {
            type: "NameChangeRequest",
            bell: "locked",
            ignoresQuietHours: false,
          },
        ],
      }),
    );
  });

  it("lists only the bell's own switches for in-app", async () => {
    const rows = await service([
      { key: "ScrimRequestReceived", enabled: false },
    ]).list(STEAM_ID, "in_app");

    expect(rows.find((row) => row.key === "ScrimRequestReceived")).toEqual({
      key: "ScrimRequestReceived",
      defaultEnabled: true,
      enabled: false,
    });
    expect(rows.find((row) => row.key === "PlayerWarning")).toBeUndefined();
    expect(rows.find((row) => row.key === "MatchFound")).toBeUndefined();
  });
});
