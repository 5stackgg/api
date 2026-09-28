import { Logger } from "@nestjs/common";
import { MatchRelayAuthMiddleware } from "./match-relay-auth-middleware";

const MATCH_A = "11111111-1111-1111-1111-111111111111";
const MATCH_B = "22222222-2222-2222-2222-222222222222";

function setup(passwords: Record<string, string>) {
  const hasura = {
    query: jest.fn(async (query: any) => {
      const id = query.matches_by_pk.__args.id;
      return {
        matches_by_pk: passwords[id] ? { password: passwords[id] } : null,
      };
    }),
  };
  const cache = {
    remember: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  };
  const logger = { warn: jest.fn() } as unknown as Logger;
  const middleware = new MatchRelayAuthMiddleware(
    logger,
    cache as any,
    hasura as any,
  );
  return { middleware, hasura };
}

function call(
  middleware: MatchRelayAuthMiddleware,
  url: string,
  originAuth?: string,
) {
  const end = jest.fn();
  const status = jest.fn(() => ({ end }));
  const next = jest.fn();
  const request = {
    method: "POST",
    url,
    headers: originAuth ? { "x-origin-auth": originAuth } : {},
  };
  return middleware
    .use(request as any, { status } as any, next)
    .then(() => ({ status, next }));
}

describe("MatchRelayAuthMiddleware", () => {
  it("lets a match's own server post to its relay", async () => {
    const { middleware } = setup({ [MATCH_A]: "secret-a" });

    const { status, next } = await call(
      middleware,
      `/match-relay/${MATCH_A}/s123t456/7/delta?final=0`,
      `${MATCH_A}:secret-a`,
    );

    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("rejects one match's credential posting into another match's relay", async () => {
    const { middleware, hasura } = setup({
      [MATCH_A]: "secret-a",
      [MATCH_B]: "secret-b",
    });

    const { status, next } = await call(
      middleware,
      `/match-relay/${MATCH_B}/s999t999/0/start`,
      `${MATCH_A}:secret-a`,
    );

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("rejects the wrong password for the path's match", async () => {
    const { middleware } = setup({ [MATCH_B]: "secret-b" });

    const { status, next } = await call(
      middleware,
      `/match-relay/${MATCH_B}/s1t2/0/full`,
      `${MATCH_B}:not-the-password`,
    );

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("rejects a post with no x-origin-auth", async () => {
    const { middleware } = setup({ [MATCH_A]: "secret-a" });

    const { status, next } = await call(
      middleware,
      `/match-relay/${MATCH_A}/s1t2/0/full`,
    );

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("binds the game streamer status route to its match the same way", async () => {
    const { middleware } = setup({
      [MATCH_A]: "secret-a",
      [MATCH_B]: "secret-b",
    });

    const own = await call(
      middleware,
      `/game-streamer/${MATCH_A}/status`,
      `${MATCH_A}:secret-a`,
    );
    const other = await call(
      middleware,
      `/game-streamer/${MATCH_B}/status`,
      `${MATCH_A}:secret-a`,
    );

    expect(own.next).toHaveBeenCalled();
    expect(other.next).not.toHaveBeenCalled();
    expect(other.status).toHaveBeenCalledWith(401);
  });
});
