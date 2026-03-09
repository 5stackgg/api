import { EloCalculation } from "./EloCalculation";

function createProcessor() {
  const postgres = {
    query: jest.fn().mockResolvedValue({ rows: [{ generate_player_elo_for_match: 10 }] }),
  };

  const processor = new EloCalculation(postgres as any);

  return { processor, postgres };
}

describe("EloCalculation", () => {
  it("calls generate_player_elo_for_match with match ID", async () => {
    const { processor, postgres } = createProcessor();

    await processor.process({ data: { matchId: "match-123" } } as any);

    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringContaining("generate_player_elo_for_match"),
      ["match-123"],
    );
  });

  it("passes matchId as parameterized query argument", async () => {
    const { processor, postgres } = createProcessor();

    await processor.process({ data: { matchId: "abc-def" } } as any);

    const [, params] = postgres.query.mock.calls[0];
    expect(params).toEqual(["abc-def"]);
  });

  it("propagates database errors", async () => {
    const { processor, postgres } = createProcessor();
    postgres.query.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(
      processor.process({ data: { matchId: "match-123" } } as any),
    ).rejects.toThrow("DB connection lost");
  });

  it("completes successfully for valid match", async () => {
    const { processor } = createProcessor();

    await expect(
      processor.process({ data: { matchId: "match-ok" } } as any),
    ).resolves.not.toThrow();
  });
});
