import { MatchServerMiddlewareMiddleware } from "./match-server-middleware.middleware";

const OWN_SERVER = "11111111-1111-4111-8111-111111111111";
const OTHER_SERVER = "22222222-2222-4222-8222-222222222222";
const OTHER_MATCH = "33333333-3333-4333-8333-333333333333";

describe("MatchServerMiddlewareMiddleware", () => {
  let hasura: { checkSecret: jest.Mock; query: jest.Mock };
  let middleware: MatchServerMiddlewareMiddleware;
  let next: jest.Mock;
  let status: jest.Mock;

  const passwords: Record<string, string> = {
    [OWN_SERVER]: "own-password",
    [OTHER_SERVER]: "other-password",
  };

  const run = (request: {
    params: Record<string, string>;
    body?: Record<string, string>;
    password: string;
  }) =>
    middleware.use(
      {
        headers: { authorization: `Bearer ${request.password}` },
        params: request.params,
        body: request.body,
      } as any,
      { status } as any,
      next,
    );

  beforeEach(() => {
    next = jest.fn();
    status = jest.fn().mockReturnValue({ end: jest.fn() });
    hasura = {
      checkSecret: jest.fn().mockReturnValue(false),
      query: jest.fn(async (query: any) => {
        if (query.servers_by_pk) {
          const id = query.servers_by_pk.__args.id;
          return {
            servers_by_pk: passwords[id]
              ? { api_password: passwords[id] }
              : null,
          };
        }

        return {
          matches_by_pk: {
            id: OTHER_MATCH,
            server: {
              api_password: passwords[OTHER_SERVER],
              current_match: { id: OTHER_MATCH },
            },
          },
        };
      }),
    };
    middleware = new MatchServerMiddlewareMiddleware(
      hasura as any,
      { warn: jest.fn() } as any,
    );
  });

  it("lets a server through to its own route", async () => {
    await run({ params: { serverId: OWN_SERVER }, password: "own-password" });

    expect(next).toHaveBeenCalled();
  });

  it("turns away the wrong password", async () => {
    await run({ params: { serverId: OWN_SERVER }, password: "nope" });

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  // The handler acts on the server in the route, so that is the one whose
  // password has to match -- not one the caller names in the body.
  it("authorizes the server the route names, whatever the body says", async () => {
    await run({
      params: { serverId: OTHER_SERVER },
      body: { serverId: OWN_SERVER },
      password: "own-password",
    });

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("authorizes the match the route names, whatever the body says", async () => {
    await run({
      params: { matchId: OTHER_MATCH },
      body: { serverId: OWN_SERVER },
      password: "own-password",
    });

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("still reads the body when the route names nothing", async () => {
    await run({
      params: {},
      body: { serverId: OWN_SERVER },
      password: "own-password",
    });

    expect(next).toHaveBeenCalled();
  });
});
