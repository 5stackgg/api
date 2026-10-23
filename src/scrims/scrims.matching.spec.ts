import { ScrimsService } from "./scrims.service";

describe("ScrimsService matching", () => {
  const service = (postgres: { query: jest.Mock }) =>
    new ScrimsService(
      {} as any,
      postgres as any,
      {} as any,
      {} as any,
      { get: jest.fn(() => ({})) } as any,
      { debug: jest.fn() } as any,
    );

  describe("window openings", () => {
    // Tuesday 2026-10-20 18:00 UTC.
    const from = new Date("2026-10-20T18:00:00.000Z");
    const until = new Date("2026-10-20T20:00:00.000Z");

    it("finds a weekly window that opens this evening, from any week it was saved in", () => {
      const starts = ScrimsService.windowStartsBetween(
        [
          {
            starts_at: "2026-09-01T19:00:00.000Z",
            ends_at: "2026-09-01T21:00:00.000Z",
            recurring_weekly: true,
          },
        ],
        from,
        until,
      );

      expect(starts).toEqual([new Date("2026-10-20T19:00:00.000Z")]);
    });

    it("finds a one-off window that opens in range, and not one that opened earlier", () => {
      const starts = ScrimsService.windowStartsBetween(
        [
          {
            starts_at: "2026-10-20T19:30:00.000Z",
            ends_at: "2026-10-20T21:00:00.000Z",
            recurring_weekly: false,
          },
          {
            starts_at: "2026-10-20T17:00:00.000Z",
            ends_at: "2026-10-20T21:00:00.000Z",
            recurring_weekly: false,
          },
        ],
        from,
        until,
      );

      expect(starts).toEqual([new Date("2026-10-20T19:30:00.000Z")]);
    });

    it("counts back-to-back weekly windows as one opening", () => {
      const starts = ScrimsService.windowStartsBetween(
        [
          {
            starts_at: "2026-10-13T18:30:00.000Z",
            ends_at: "2026-10-13T19:00:00.000Z",
            recurring_weekly: true,
          },
          {
            starts_at: "2026-10-13T19:00:00.000Z",
            ends_at: "2026-10-13T20:00:00.000Z",
            recurring_weekly: true,
          },
        ],
        from,
        until,
      );

      expect(starts).toEqual([new Date("2026-10-20T18:30:00.000Z")]);
    });

    it("finds a window that wraps past the end of the week", () => {
      const starts = ScrimsService.windowStartsBetween(
        [
          {
            starts_at: "2026-10-17T23:00:00.000Z",
            ends_at: "2026-10-18T01:00:00.000Z",
            recurring_weekly: true,
          },
        ],
        new Date("2026-10-24T22:00:00.000Z"),
        new Date("2026-10-25T00:00:00.000Z"),
      );

      expect(starts).toEqual([new Date("2026-10-24T23:00:00.000Z")]);
    });
  });

  describe("pairing", () => {
    const team = (id: string) => ({
      team_id: id,
      enabled: true,
      regions: ["TestA"],
      elo_min: null as number | null,
      elo_max: null as number | null,
      owner_steam_id: `7656119800000000${id}`,
      avg_elo: null as number | null,
      avg_faceit_level: null as number | null,
      avg_premier: null as number | null,
    });

    const allWeek = (id: string) => ({
      team_id: id,
      starts_at: "2026-10-18T00:00:00.000Z",
      ends_at: "2026-10-24T23:59:00.000Z",
      recurring_weekly: true,
    });

    const run = async (teamIds?: Array<string>) => {
      const ids = ["1", "2", "3", "4"];
      const postgres = {
        query: jest.fn(async (sql: string) => {
          if (/FROM team_scrim_settings s/.test(sql)) {
            return ids.map(team);
          }
          if (/FROM team_scrim_availability/.test(sql)) {
            return ids.map(allWeek);
          }
          return [];
        }),
      };
      const scrims = service(postgres);
      const proposed = jest
        .spyOn(scrims, "createScrimRequest")
        .mockResolvedValue(undefined as any);

      await scrims.matchTeams(teamIds);

      return proposed.mock.calls
        .map(([request]) => [request.fromTeamId, request.toTeamId].join("-"))
        .sort();
    };

    it("pairs everyone with everyone on the hourly pass", async () => {
      expect(await run()).toEqual(["1-2", "1-3", "1-4", "2-3", "2-4", "3-4"]);
    });

    it("pairs only the team that changed against the field", async () => {
      expect(await run(["3"])).toEqual(["1-3", "2-3", "3-4"]);
    });
  });

  describe("LAN regions", () => {
    const lanRegions = ["Lan", "Lan2"];
    const listing = (regions: Array<string>) => ({ regions }) as any;
    const offLan = { role: "user" as const, lanRegions: [] as Array<string> };

    it("leaves a LAN out when one team lists any region", () => {
      expect(
        ScrimsService.regionsOverlap(
          listing([]),
          listing(["Lan", "US East"]),
          lanRegions,
        ),
      ).toEqual(["US East"]);
      expect(
        ScrimsService.regionsOverlap(listing(["Lan"]), listing([]), lanRegions),
      ).toEqual([]);
    });

    it("keeps a LAN both teams name", () => {
      expect(
        ScrimsService.regionsOverlap(
          listing(["Lan", "US East"]),
          listing(["US East", "Lan"]),
          lanRegions,
        ),
      ).toEqual(["Lan", "US East"]);
    });

    it("puts the scrim on the LAN for a manager the probe placed on it", () => {
      expect(
        ScrimsService.scrimRegion(["Lan", "US East"], lanRegions, {
          role: "user",
          lanRegions: ["Lan"],
        }),
      ).toBe("Lan");
    });

    it("books a LAN under its own spelling", () => {
      expect(
        ScrimsService.scrimRegion(["lan"], lanRegions, {
          role: "user",
          lanRegions: ["Lan"],
        }),
      ).toBe("Lan");
    });

    it("falls back to an online region the teams share for a manager off the LAN", () => {
      expect(
        ScrimsService.scrimRegion(["lan", "US East"], lanRegions, offLan),
      ).toBe("US East");
    });

    it("refuses a manager off the LAN when the teams share only a LAN", () => {
      expect(() =>
        ScrimsService.scrimRegion(["Lan"], lanRegions, offLan),
      ).toThrow("You must be on the LAN to play in a LAN region");
    });

    it("lets a match organizer off the LAN keep the LAN", () => {
      expect(
        ScrimsService.scrimRegion(["Lan"], lanRegions, {
          role: "match_organizer",
          lanRegions: [],
        }),
      ).toBe("Lan");
    });

    it("leaves a scrim with no shared region to any region", () => {
      expect(ScrimsService.scrimRegion([], lanRegions, offLan)).toBeUndefined();
    });
  });
});
