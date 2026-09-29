import { TypeSenseService } from "./type-sense.service";

describe("TypeSenseService player sanctions count", () => {
  let hasura: { query: jest.Mock };
  let upsert: jest.Mock;
  let service: TypeSenseService;

  beforeEach(() => {
    hasura = { query: jest.fn() };
    upsert = jest.fn().mockResolvedValue({});

    service = new TypeSenseService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { get: jest.fn() } as any,
      hasura as any,
      { sendServerMatchId: jest.fn() } as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
      { query: jest.fn() } as any,
      {} as any,
    );

    (service as any).client = {
      collections: jest.fn(() => ({
        documents: jest.fn(() => ({ upsert })),
      })),
    };

    hasura.query
      .mockResolvedValueOnce({
        players_by_pk: {
          elo: {},
          name: "Player",
          role: "user",
          country: null,
          avatar_url: null,
          custom_avatar_url: null,
          roster_image_url: null,
          profile_url: null,
          is_banned: false,
          is_gagged: false,
          is_muted: false,
          teams: [],
          last_sign_in_at: null,
          wins: 0,
          losses: 0,
          total_matches: 0,
          stats: { kills: 0, deaths: 0 },
          sanctions_aggregate: { aggregate: { count: 2 } },
        },
      })
      .mockResolvedValueOnce({ match_lineup_players: [] });
  });

  it("counts only the enforced sanction types, never warnings", async () => {
    await service.updatePlayer("76561198000000000");

    const { sanctions_aggregate } = hasura.query.mock.calls[0][0].players_by_pk;

    expect(sanctions_aggregate.__args?.where).toEqual({
      type: { _in: ["ban", "mute", "gag", "silence"] },
    });
    expect(JSON.stringify(sanctions_aggregate)).not.toContain("warning");
    expect(upsert.mock.calls[0][0]).toEqual(
      expect.objectContaining({ sanctions: 2 }),
    );
  });
});
