import {
  STATUS_LABELS,
  STATUS_COLORS,
  DISCORD_COLORS,
  NOTIFIABLE_STATUSES,
} from "./constants";

describe("notification constants", () => {
  describe("STATUS_LABELS", () => {
    it("has a label for every defined status", () => {
      expect(STATUS_LABELS.Live).toBe("Live");
      expect(STATUS_LABELS.PickingPlayers).toBe("Picking Players");
      expect(STATUS_LABELS.WaitingForCheckIn).toBe("Waiting for Check-In");
    });

    it("has human-readable labels with spaces where needed", () => {
      expect(STATUS_LABELS.PickingPlayers).toContain(" ");
      expect(STATUS_LABELS.WaitingForCheckIn).toContain(" ");
      expect(STATUS_LABELS.WaitingForServer).toContain(" ");
    });
  });

  describe("STATUS_COLORS", () => {
    it("maps Live to green", () => {
      expect(STATUS_COLORS.Live).toBe(DISCORD_COLORS.GREEN);
    });

    it("maps Canceled to red", () => {
      expect(STATUS_COLORS.Canceled).toBe(DISCORD_COLORS.RED);
    });

    it("has valid hex color values", () => {
      for (const color of Object.values(STATUS_COLORS)) {
        expect(color).toBeGreaterThanOrEqual(0);
        expect(color).toBeLessThanOrEqual(0xffffff);
      }
    });
  });

  describe("DISCORD_COLORS", () => {
    it("defines GREEN, RED, and GRAY", () => {
      expect(DISCORD_COLORS.GREEN).toBe(0x2d6644);
      expect(DISCORD_COLORS.RED).toBe(0xd7463d);
      expect(DISCORD_COLORS.GRAY).toBe(0x95a5a6);
    });
  });

  describe("NOTIFIABLE_STATUSES", () => {
    it("includes Live and Finished", () => {
      expect(NOTIFIABLE_STATUSES.has("Live")).toBe(true);
      expect(NOTIFIABLE_STATUSES.has("Finished")).toBe(true);
    });

    it("excludes non-notifiable statuses", () => {
      expect(NOTIFIABLE_STATUSES.has("Scheduled")).toBe(false);
      expect(NOTIFIABLE_STATUSES.has("PickingPlayers")).toBe(false);
    });
  });
});
