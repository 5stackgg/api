import { SteamSerializer } from "./SteamSerializer";
import { HasuraService } from "../../hasura/hasura.service";
import { CacheService } from "../../cache/cache.service";
import { User } from "../types/User";

const STEAM_ID = "76561198000000001";

function makeSerializer(databaseRole: string | undefined) {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (...keys: Array<string>) => {
      keys.forEach((key) => store.delete(key));
      return keys.length;
    }),
  };
  const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  const cache = new CacheService(
    { getConnection: () => redis } as any,
    logger as any,
  );
  const hasura = new HasuraService(
    logger as any,
    cache,
    { get: () => ({}) } as any,
    {} as any,
  );
  const query = jest
    .spyOn(hasura, "query")
    .mockImplementation(async () =>
      databaseRole === undefined
        ? ({ players_by_pk: null } as any)
        : ({ players_by_pk: { role: databaseRole } } as any),
    );

  const serializer = new SteamSerializer();
  Object.assign(serializer, { logger, cache, hasura });

  return { serializer, store, query, logger };
}

function deserialize(serializer: SteamSerializer, user: User) {
  return new Promise<{ error: unknown; user: User | false }>((resolve) => {
    void serializer.deserializeUser(user, (error: unknown, result: User) =>
      resolve({ error, user: result }),
    );
  });
}

const sessionUser = (): User => ({
  steam_id: STEAM_ID,
  name: "Luke",
  role: "administrator",
});

describe("SteamSerializer.deserializeUser", () => {
  it("drops the role a demoted player signed in with", async () => {
    const { serializer, store } = makeSerializer("user");
    store.set(HasuraService.PLAYER_ROLE_CACHE_KEY(STEAM_ID), '"user"');

    const { error, user } = await deserialize(serializer, sessionUser());

    expect(error).toBeNull();
    expect(user && user.role).toBe("user");
  });

  it("reads a cached role without going to the database", async () => {
    const { serializer, store, query } = makeSerializer("administrator");
    store.set(HasuraService.PLAYER_ROLE_CACHE_KEY(STEAM_ID), '"moderator"');

    const { user } = await deserialize(serializer, sessionUser());

    expect(user && user.role).toBe("moderator");
    expect(query).not.toHaveBeenCalled();
  });

  it("loads the role once and caches it when nothing is cached", async () => {
    const { serializer, store, query } = makeSerializer("moderator");

    const first = await deserialize(serializer, sessionUser());
    const second = await deserialize(serializer, sessionUser());

    expect(first.user && first.user.role).toBe("moderator");
    expect(second.user && second.user.role).toBe("moderator");
    expect(query).toHaveBeenCalledTimes(1);
    expect(store.get(HasuraService.PLAYER_ROLE_CACHE_KEY(STEAM_ID))).toBe(
      '"moderator"',
    );
  });

  it("keeps a change made to the user, so a session save still persists it", async () => {
    const { serializer } = makeSerializer("user");
    const stored = sessionUser();

    const { user } = await deserialize(serializer, stored);

    expect(user).toBe(stored);
    expect(stored.role).toBe("user");
  });

  it("signs out a session whose player no longer exists", async () => {
    const { serializer } = makeSerializer(undefined);

    const { error, user } = await deserialize(serializer, sessionUser());

    expect(error).toBeNull();
    expect(user).toBe(false);
  });

  it("fails the request, without signing out or trusting the session role, when the role cannot be read", async () => {
    const { serializer, query } = makeSerializer("user");
    query.mockRejectedValue(new Error("hasura is down"));

    const { error, user } = await deserialize(serializer, sessionUser());

    expect(error).toBeInstanceOf(Error);
    expect(user).toBeUndefined();
  });
});
