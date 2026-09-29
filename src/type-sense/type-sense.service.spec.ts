import { CollectionFieldSchema } from "typesense/lib/Typesense/Collection";
import { TypeSenseService } from "./type-sense.service";
import { RefreshAllPlayersJob } from "./jobs/RefreshAllPlayers";

describe("TypeSenseService player role rank", () => {
  const roleRankField = {
    name: "role_rank",
    type: "int32",
    optional: true,
    sort: true,
    index: true,
  };

  let hasura: { query: jest.Mock };
  let matchAssistant: { sendServerMatchId: jest.Mock };
  let reindexQueue: { add: jest.Mock };
  let cache: { get: jest.Mock; put: jest.Mock; forget: jest.Mock };
  let service: TypeSenseService;

  beforeEach(() => {
    hasura = { query: jest.fn() };
    matchAssistant = { sendServerMatchId: jest.fn() };
    reindexQueue = { add: jest.fn().mockResolvedValue({}) };
    cache = {
      get: jest.fn().mockResolvedValue(undefined),
      put: jest.fn().mockResolvedValue(true),
      forget: jest.fn().mockResolvedValue(undefined),
    };

    service = new TypeSenseService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { get: jest.fn() } as any,
      hasura as any,
      matchAssistant as any,
      reindexQueue as any,
      { add: jest.fn() } as any,
      { query: jest.fn() } as any,
      cache as any,
    );
  });

  function playersCollection(
    existingFields: Array<Record<string, unknown>> | null,
  ) {
    const players = {
      exists: jest.fn().mockResolvedValue(existingFields !== null),
      retrieve: jest.fn().mockResolvedValue({ fields: existingFields }),
      update: jest.fn().mockResolvedValue({}),
    };
    const create = jest.fn().mockResolvedValue({});

    (service as any).client = {
      collections: jest.fn((name?: string) => {
        return name === "players" ? players : { create };
      }),
    };

    return { players, create };
  }

  async function declaredFields(): Promise<Array<CollectionFieldSchema>> {
    const { create } = playersCollection(null);

    await service.createPlayerCollection();

    reindexQueue.add.mockClear();

    return create.mock.calls[0][0].fields;
  }

  function asTypesenseReturnsIt(field: CollectionFieldSchema) {
    const index = field.index ?? true;
    const sortableByDefault = ["int32", "int64", "float", "bool"].includes(
      field.type,
    );

    return {
      ...field,
      index,
      optional: field.optional ?? false,
      sort: field.sort ?? (index && sortableByDefault),
    };
  }

  function expectPlayerRefreshQueued() {
    expect(reindexQueue.add).toHaveBeenCalledWith(
      RefreshAllPlayersJob.name,
      {},
      expect.objectContaining({ jobId: RefreshAllPlayersJob.name }),
    );
  }

  it("declares a sortable role_rank beside the role string", async () => {
    const fields = await declaredFields();

    expect(fields).toContainEqual(roleRankField);
    expect(fields.find((field) => field.name === "role")).toEqual({
      name: "role",
      type: "string",
      optional: true,
      index: true,
    });
  });

  it("adds role_rank to an existing collection and queues a player refresh without dropping role", async () => {
    const existing = (await declaredFields())
      .filter((field) => field.name !== "role_rank")
      .map(asTypesenseReturnsIt);
    const { players, create } = playersCollection(existing);

    await service.createPlayerCollection();

    expect(create).not.toHaveBeenCalled();
    expect(players.update).toHaveBeenCalledTimes(1);
    expect(players.update).toHaveBeenCalledWith({ fields: [roleRankField] });
    expect(reindexQueue.add).toHaveBeenCalledTimes(1);
    expectPlayerRefreshQueued();
  });

  it("re-queues the player refresh on a later boot when the one queued with role_rank never finished", async () => {
    const existing = (await declaredFields()).map(asTypesenseReturnsIt);
    const { players } = playersCollection(existing);

    await service.createPlayerCollection();

    expect(players.update).not.toHaveBeenCalled();
    expect(reindexQueue.add).toHaveBeenCalledTimes(1);
    expectPlayerRefreshQueued();
  });

  it("forgets the indexed schema whenever it queues a refresh", async () => {
    const existing = (await declaredFields()).map(asTypesenseReturnsIt);
    playersCollection(existing);
    cache.get.mockResolvedValue("an older schema");

    await service.createPlayerCollection();

    expect(cache.forget).toHaveBeenCalledWith(
      "typesense:players:indexed-schema",
    );
    expect(cache.forget.mock.invocationCallOrder[0]).toBeLessThan(
      reindexQueue.add.mock.invocationCallOrder[0],
    );
  });

  it("records the current schema once a refresh finishes", async () => {
    await service.markPlayersIndexed();

    expect(cache.put).toHaveBeenCalledWith(
      "typesense:players:indexed-schema",
      TypeSenseService.playerSchemaVersion(),
    );
  });

  it("leaves a collection that already has role_rank alone", async () => {
    const existing = (await declaredFields()).map(asTypesenseReturnsIt);
    const { players } = playersCollection(existing);
    cache.get.mockResolvedValue(TypeSenseService.playerSchemaVersion());

    await service.createPlayerCollection();

    expect(players.update).not.toHaveBeenCalled();
    expect(reindexQueue.add).not.toHaveBeenCalled();
  });

  it.each([
    ["administrator", 6],
    ["moderator", 3],
    ["user", 0],
    [null, 0],
  ])("upserts role %s with role_rank %i", async (role, expected) => {
    const upsert = jest.fn().mockResolvedValue({});

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
          role,
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
          sanctions_aggregate: { aggregate: { count: 0 } },
        },
      })
      .mockResolvedValueOnce({ match_lineup_players: [] });

    await service.updatePlayer("76561198000000000");

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toEqual(
      expect.objectContaining({ role, role_rank: expected }),
    );
  });
});
