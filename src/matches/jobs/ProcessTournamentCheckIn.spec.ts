import { ProcessTournamentCheckIn } from "./ProcessTournamentCheckIn";

// The job is four SQL passes and a notification fan-out, so the mock routes on
// the statement rather than the call order -- reordering the passes should not
// rewrite the test.
type Rows = Array<Record<string, unknown>>;

describe("ProcessTournamentCheckIn", () => {
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const postgres = {
    query: jest.fn(),
  };
  const notifications = {
    notifyPlayers: jest.fn(),
  };

  let job: ProcessTournamentCheckIn;
  let opened: Rows;
  let closing: Rows;
  let closed: Rows;
  let released: Rows;
  let recipients: Rows;
  let statements: Array<string>;

  const tournament = (overrides: Record<string, unknown> = {}) => ({
    id: "tournament-1",
    name: "Cup",
    banner: null as string | null,
    logo: null as string | null,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    opened = [];
    closing = [];
    closed = [];
    released = [];
    recipients = [{ steam_id: "1" }, { steam_id: "2" }];
    statements = [];

    postgres.query.mockImplementation(async (sql: string) => {
      statements.push(sql);

      if (sql.includes('SET check_in_ends_at = t."start"')) {
        return opened;
      }
      if (sql.includes("SET check_in_closing_notified_for")) {
        return closing;
      }
      if (sql.includes("UPDATE tournament_free_agents")) {
        return [];
      }
      if (sql.includes("THEN 'CheckInReview'")) {
        return closed;
      }
      if (sql.includes("t.status = 'CheckInReview'")) {
        return released;
      }
      if (sql.includes("tournament_pending_check_in_recipients")) {
        return recipients;
      }

      throw new Error(`unexpected query: ${sql}`);
    });

    job = new ProcessTournamentCheckIn(
      logger as any,
      postgres as any,
      notifications as any,
    );
  });

  describe("open pass", () => {
    it("announces a window it just opened to everyone who has not checked in", async () => {
      opened = [tournament({ notify: true })];

      await expect(job.process()).resolves.toBe(1);

      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "TournamentCheckInOpen",
        expect.objectContaining({
          entity_id: "tournament-1",
          steamIds: ["1", "2"],
        }),
      );
    });

    it("only opens a RegistrationOpen tournament whose window has never opened", async () => {
      await job.process();

      const open = statements.find((sql) =>
        sql.includes('SET check_in_ends_at = t."start"'),
      );
      expect(open).toContain("t.check_in_required");
      expect(open).toContain("t.status = 'RegistrationOpen'");
      expect(open).toContain("t.check_in_ends_at IS NULL");
    });

    it("stamps but stays quiet when the whole window already elapsed", async () => {
      opened = [tournament({ notify: false })];

      await expect(job.process()).resolves.toBe(1);

      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });

    it("sends nothing when nobody is outstanding", async () => {
      opened = [tournament({ notify: true })];
      recipients = [];

      await job.process();

      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });
  });

  describe("closing reminder", () => {
    // Claimed by stamping the deadline, not by looking for the notification it
    // wrote: notifyPlayers writes no row at all when every recipient has the
    // type muted, and a dedup keyed on one would re-run the whole fan-out every
    // tick for the entire lead-in. Stamping the deadline rather than a flag is
    // what earns a fresh reminder after an extension.
    it("claims the deadline it reminded for", async () => {
      closing = [tournament({ entity_id: "tournament-1:closing:1700000000" })];

      await job.process();

      const reminder = statements.find((sql) =>
        sql.includes("SET check_in_closing_notified_for"),
      );
      expect(reminder).toContain(
        "t.check_in_closing_notified_for IS DISTINCT FROM t.check_in_ends_at",
      );
      expect(reminder).not.toContain("FROM notifications");

      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "TournamentCheckInClosing",
        expect.objectContaining({
          entity_id: "tournament-1:closing:1700000000",
        }),
      );
    });
  });

  describe("close pass", () => {
    it("waitlists free agent no-shows before the status flip runs the draft", async () => {
      closed = [tournament({ status: "RegistrationClosed" })];

      await job.process();

      const waitlist = statements.findIndex((sql) =>
        sql.includes("UPDATE tournament_free_agents"),
      );
      const flip = statements.findIndex((sql) =>
        sql.includes("THEN 'CheckInReview'"),
      );

      expect(waitlist).toBeGreaterThanOrEqual(0);
      expect(waitlist).toBeLessThan(flip);
    });

    it("claims the tournament in the same statement that flips it", async () => {
      await job.process();

      const flip = statements.find((sql) =>
        sql.includes("THEN 'CheckInReview'"),
      );
      expect(flip).toContain("t.check_in_closed_for IS DISTINCT FROM");
      expect(flip).toContain("check_in_closed_for = t.check_in_ends_at");
      expect(flip).toContain("RETURNING");
    });

    // An organizer extending the window leaves the tournament held in
    // CheckInReview -- that hold is what keeps registration shut -- so the
    // extended deadline has to be closed from there. What stops the pass from
    // firing again on a tournament that is merely sitting in review is the
    // stamped deadline, not the status.
    it("closes an extended window from the review hold", async () => {
      await job.process();

      for (const sql of statements.filter(
        (statement) =>
          statement.includes("THEN 'CheckInReview'") ||
          statement.includes("UPDATE tournament_free_agents"),
      )) {
        expect(sql).toContain(
          "t.status IN ('RegistrationOpen', 'CheckInReview')",
        );
        expect(sql).toContain("t.check_in_closed_for IS DISTINCT FROM");
      }
    });

    it("says nothing when every team checked in", async () => {
      closed = [tournament({ status: "RegistrationClosed" })];

      await expect(job.process()).resolves.toBe(1);

      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });

    it("tells the missing teams and the organizer when it lands in review", async () => {
      closed = [
        tournament({ status: "CheckInReview", organizer_steam_id: "99" }),
      ];

      await job.process();

      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "TournamentCheckInMissed",
        expect.objectContaining({
          steamIds: ["1", "2", "99"],
        }),
      );
    });
  });

  describe("safety net", () => {
    it("continues a tournament still held at its own start time", async () => {
      released = [{ id: "tournament-1" }];

      await expect(job.process()).resolves.toBe(1);

      const release = statements.find(
        (sql) =>
          sql.includes("t.status = 'CheckInReview'") &&
          sql.includes("SET status = 'RegistrationClosed'"),
      );
      expect(release).toContain('now() >= t."start"');
    });
  });

  it("counts every tournament it acted on", async () => {
    opened = [tournament({ notify: true })];
    closing = [tournament({ entity_id: "tournament-1:closing:1" })];
    closed = [tournament({ status: "RegistrationClosed" })];
    released = [{ id: "tournament-2" }];

    await expect(job.process()).resolves.toBe(4);
  });
});
