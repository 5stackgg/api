import { DiscordStrategy } from "./DiscordStrategy";

const VICTIM = "76561198000000001";

// Each request runs against its own copy of the strategy, the way passport's
// middleware does it, so the outcome callbacks can be observed.
const attempt = (
  strategy: DiscordStrategy,
  request: Record<string, unknown>,
) =>
  new Promise<{ outcome: string; args: unknown[] }>((resolve) => {
    const run = Object.create(strategy);
    for (const outcome of ["success", "fail", "error", "redirect", "pass"]) {
      run[outcome] = (...args: unknown[]) => resolve({ outcome, args });
    }
    run.authenticate(request, {});
  });

describe("DiscordStrategy", () => {
  let strategy: DiscordStrategy;
  let hasura: { mutation: jest.Mock };
  let getOAuthAccessToken: jest.Mock;

  beforeEach(() => {
    hasura = { mutation: jest.fn().mockResolvedValue({}) };
    strategy = new DiscordStrategy(
      {
        get: (key: string) =>
          key === "discord"
            ? { clientId: "client", clientSecret: "secret" }
            : { webDomain: "https://5stack.gg" },
      } as never,
      hasura as never,
    );

    getOAuthAccessToken = jest.fn(
      (
        _code: string,
        _params: unknown,
        callback: (error: unknown, accessToken: string) => void,
      ) => callback(null, "attacker-token"),
    );
    (strategy as any)._oauth2.getOAuthAccessToken = getOAuthAccessToken;
    (strategy as any).userProfile = (
      _token: string,
      done: (error: unknown, profile: unknown) => void,
    ) => done(null, { id: "attacker-discord-id" });
  });

  it("refuses a callback this session never started, so a crafted link cannot link the attacker's Discord", async () => {
    const result = await attempt(strategy, {
      query: { code: "attacker-code" },
      session: {},
      user: { steam_id: VICTIM },
    });

    expect(result.outcome).toBe("fail");
    expect(result.args[1]).toBe(403);
    expect(getOAuthAccessToken).not.toHaveBeenCalled();
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("refuses a callback carrying someone else's state", async () => {
    const session = {};
    await attempt(strategy, {
      query: {},
      session,
      user: { steam_id: VICTIM },
    });

    const result = await attempt(strategy, {
      query: { code: "attacker-code", state: "attacker-state" },
      session,
      user: { steam_id: VICTIM },
    });

    expect(result.outcome).toBe("fail");
    expect(getOAuthAccessToken).not.toHaveBeenCalled();
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("links the player's Discord when the callback answers the request this session sent", async () => {
    const session = {};
    const start = await attempt(strategy, {
      query: {},
      session,
      user: { steam_id: VICTIM },
    });

    expect(start.outcome).toBe("redirect");
    const state = new URL(start.args[0] as string).searchParams.get("state");
    expect(state).toBeTruthy();

    const result = await attempt(strategy, {
      query: { code: "player-code", state },
      session,
      user: { steam_id: VICTIM },
    });

    expect(result.outcome).toBe("success");
    expect(getOAuthAccessToken).toHaveBeenCalled();
    expect(hasura.mutation).toHaveBeenCalled();
  });
});
