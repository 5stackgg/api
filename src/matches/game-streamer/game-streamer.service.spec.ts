jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient() {
      return {};
    }
  },
}));

import { GameStreamerService } from "./game-streamer.service";

describe("GameStreamerService.validateDemoSessionAuth", () => {
  const SESSION_ID = "11111111-1111-1111-1111-111111111111";
  const TOKEN = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  function buildService(rowToken: string | null) {
    const hasura = {
      query: jest.fn().mockResolvedValue({
        match_demo_sessions:
          rowToken == null
            ? []
            : [
                {
                  id: SESSION_ID,
                  match_id: "match-1",
                  match_map_id: "map-1",
                  session_token: rowToken,
                },
              ],
      }),
    };
    const config = { get: jest.fn(() => ({})) };
    return {
      service: new GameStreamerService(
        { error: jest.fn(), warn: jest.fn(), log: jest.fn() } as any,
        config as any,
        hasura as any,
        {} as any,
      ),
      hasura,
    };
  }

  it("rejects missing or non-string headers", async () => {
    const { service, hasura } = buildService(TOKEN);
    expect(
      await service.validateDemoSessionAuth(SESSION_ID, undefined),
    ).toBeNull();
    expect(
      await service.validateDemoSessionAuth(SESSION_ID, 42 as any),
    ).toBeNull();
    expect(await service.validateDemoSessionAuth(SESSION_ID, "")).toBeNull();
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("rejects malformed headers (no colon)", async () => {
    const { service, hasura } = buildService(TOKEN);
    expect(
      await service.validateDemoSessionAuth(SESSION_ID, "no-colon-here"),
    ).toBeNull();
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("rejects when session id in header doesn't match", async () => {
    const { service, hasura } = buildService(TOKEN);
    const wrongId = "22222222-2222-2222-2222-222222222222";
    expect(
      await service.validateDemoSessionAuth(SESSION_ID, `${wrongId}:${TOKEN}`),
    ).toBeNull();
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("rejects when row is missing", async () => {
    const { service } = buildService(null);
    expect(
      await service.validateDemoSessionAuth(
        SESSION_ID,
        `${SESSION_ID}:${TOKEN}`,
      ),
    ).toBeNull();
  });

  it("rejects when token doesn't match the row", async () => {
    const { service } = buildService(TOKEN);
    expect(
      await service.validateDemoSessionAuth(
        SESSION_ID,
        `${SESSION_ID}:wrong-token-of-different-length`,
      ),
    ).toBeNull();
    expect(
      await service.validateDemoSessionAuth(
        SESSION_ID,
        // Same length, different bytes — exercises the constant-time path.
        `${SESSION_ID}:${"a".repeat(TOKEN.length)}`,
      ),
    ).toBeNull();
  });

  it("returns the session when id + token match", async () => {
    const { service } = buildService(TOKEN);
    expect(
      await service.validateDemoSessionAuth(
        SESSION_ID,
        `${SESSION_ID}:${TOKEN}`,
      ),
    ).toEqual({
      id: SESSION_ID,
      match_id: "match-1",
      match_map_id: "map-1",
    });
  });
});
