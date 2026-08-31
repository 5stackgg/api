import { CheckForScheduledMatches } from "./CheckForScheduledMatches";

// The only thing this job does is build a where clause, and the clause is what
// broke: tbu_matches forces a pre-start tournament match straight back to
// 'Scheduled', so selecting one produces an affected row for an UPDATE that
// changed nothing -- and "N matches started" every single minute.
describe("CheckForScheduledMatches", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const hasura = { mutation: jest.fn() };

  let job: CheckForScheduledMatches;

  beforeEach(() => {
    jest.clearAllMocks();
    hasura.mutation.mockResolvedValue({ update_matches: { affected_rows: 2 } });
    job = new CheckForScheduledMatches(logger as never, hasura as never);
  });

  const whereClauses = () =>
    hasura.mutation.mock.calls[0][0].update_matches.__args.where._and;

  it("starts due matches but leaves out one whose tournament has not started", async () => {
    await expect(job.process()).resolves.toBe(2);
    expect(logger.log).toHaveBeenCalledWith("2 matches started");

    const clauses = whereClauses();
    expect(clauses).toContainEqual({ status: { _eq: "Scheduled" } });
    expect(hasura.mutation.mock.calls[0][0].update_matches.__args._set).toEqual(
      { status: "WaitingForCheckIn" },
    );

    const excluded = clauses.find(
      (clause: Record<string, unknown>) => clause._not,
    );
    expect(excluded).toBeDefined();

    const tournament = excluded._not.tournament_brackets.stage.tournament;
    expect(tournament.status).toEqual({
      _in: ["RegistrationClosed", "CheckInReview"],
    });
    expect(tournament.start._gt).toBeInstanceOf(Date);
  });
});
