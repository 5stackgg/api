import {
  SanctionPolicy,
  SanctionPolicyService,
} from "./sanction-policy.service";

// The ladder / threshold arithmetic, exercised without a database. The SQL that
// actually runs in production lives in
// hasura/functions/sanctions/sanction_policy.sql and is covered against a real
// Postgres by test/sanctions-policy.spec.ts; this suite pins the shape of the
// rule itself.
describe("SanctionPolicyService", () => {
  const policy = (over: Partial<SanctionPolicy> = {}): SanctionPolicy => ({
    source: "match_abandon",
    enabled: true,
    threshold: 1,
    windowDays: 7,
    durations: [10, 60, 120, 240, 480, 960, 1920],
    scope: "matchmaking",
    writesPlatformBan: false,
    ...over,
  });

  const last = new Date("2026-01-01T00:00:00.000Z");

  const minutesAfter = (expiry: Date | number | null) =>
    expiry instanceof Date
      ? (expiry.getTime() - last.getTime()) / 60000
      : expiry;

  describe("settingName", () => {
    it("builds the public.-prefixed name the settings ACL keys off", () => {
      expect(
        SanctionPolicyService.settingName("match_abandon", "enabled"),
      ).toBe("public.sanction_match_abandon_enabled");
      expect(
        SanctionPolicyService.settingName("tournament_no_show", "window_days"),
      ).toBe("public.sanction_tournament_no_show_window_days");
    });
  });

  describe("resolveExpiry", () => {
    it("reproduces the hardcoded leaver ladder for every rung", () => {
      const shipped = policy();

      expect(
        [1, 2, 3, 4, 5, 6, 7].map((count) =>
          minutesAfter(
            SanctionPolicyService.resolveExpiry(shipped, count, last),
          ),
        ),
      ).toEqual([10, 60, 120, 240, 480, 960, 1920]);
    });

    it("clamps past the end of the ladder rather than escalating forever", () => {
      const shipped = policy();

      expect(
        minutesAfter(SanctionPolicyService.resolveExpiry(shipped, 40, last)),
      ).toBe(1920);
    });

    it("runs the clock from the last occurrence, not from now", () => {
      const expiry = SanctionPolicyService.resolveExpiry(policy(), 1, last);

      expect(expiry).toEqual(new Date("2026-01-01T00:10:00.000Z"));
    });

    it("never fires while the count is below the threshold", () => {
      const noShow = policy({
        source: "tournament_no_show",
        threshold: 3,
        windowDays: 30,
        durations: [10080],
        scope: "tournaments",
      });

      expect(SanctionPolicyService.resolveExpiry(noShow, 1, last)).toBeNull();
      expect(SanctionPolicyService.resolveExpiry(noShow, 2, last)).toBeNull();
      expect(
        minutesAfter(SanctionPolicyService.resolveExpiry(noShow, 3, last)),
      ).toBe(10080);
    });

    it("never fires when the source is disabled, however many occurrences", () => {
      const off = policy({ enabled: false });

      expect(SanctionPolicyService.resolveExpiry(off, 1, last)).toBeNull();
      expect(SanctionPolicyService.resolveExpiry(off, 99, last)).toBeNull();
    });

    it("treats a zero duration as a sanction with no end", () => {
      const vac = policy({
        source: "vac_ban",
        windowDays: 0,
        durations: [0],
        scope: "both",
        writesPlatformBan: true,
      });

      expect(SanctionPolicyService.resolveExpiry(vac, 1, last)).toBe(Infinity);
    });

    it("does not fire on zero or negative occurrence counts", () => {
      expect(SanctionPolicyService.resolveExpiry(policy(), 0, last)).toBeNull();
      expect(
        SanctionPolicyService.resolveExpiry(policy(), -1, last),
      ).toBeNull();
    });

    it("does not fire on an empty ladder", () => {
      expect(
        SanctionPolicyService.resolveExpiry(policy({ durations: [] }), 5, last),
      ).toBeNull();
    });
  });

  describe("covers", () => {
    it("matches only the scope it was given, or both", () => {
      expect(
        SanctionPolicyService.covers(
          policy({ scope: "matchmaking" }),
          "matchmaking",
        ),
      ).toBe(true);
      expect(
        SanctionPolicyService.covers(
          policy({ scope: "matchmaking" }),
          "tournaments",
        ),
      ).toBe(false);
      expect(
        SanctionPolicyService.covers(policy({ scope: "both" }), "tournaments"),
      ).toBe(true);
      expect(
        SanctionPolicyService.covers(
          policy({ scope: "tournaments" }),
          "matchmaking",
        ),
      ).toBe(false);
    });
  });
});
