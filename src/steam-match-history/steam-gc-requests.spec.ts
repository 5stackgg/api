import { EventEmitter } from "events";
import { SteamGcConnectionError, SteamGcService } from "./steam-gc.service";
import { ResolveMatchMetadata } from "./jobs/ResolveMatchMetadata";

const SHARE_CODE = "CSGO-aaaaa-bbbbb-ccccc-ddddd-eeeee";
const VALVE_MATCH_ID = "1174469974867590708";
const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_LOGOFF_MS = 5 * 60_000;

const MATCH = {
  matchtime: 1700000000,
  watchablematchinfo: { game_map: "de_dust2" },
  roundstatsall: [{ map: "http://replay/demo.dem.bz2", reservation: {} }],
};

const build = () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new SteamGcService(
    logger as never,
    { get: jest.fn(() => "gc-bot") } as never,
    { get: jest.fn(), put: jest.fn() } as never,
  );
  const client = Object.assign(new EventEmitter(), { logOff: jest.fn() });
  const cs = Object.assign(new EventEmitter(), { requestGame: jest.fn() });

  service["client"] = client as never;
  service["cs"] = cs as never;
  service["gcReady"] = true;

  const requested = async () => {
    await jest.advanceTimersByTimeAsync(0);
    expect(cs.requestGame).toHaveBeenCalled();
    cs.requestGame.mockClear();
  };

  return { service, client, cs, requested };
};

const resolveJob = (steamGc: SteamGcService) => {
  const failures: Array<Array<unknown>> = [];
  const postgres = {
    query: jest.fn(
      async (sql: string, params: Array<unknown> = []): Promise<unknown[]> => {
        if (sql.includes("SELECT share_code")) {
          return [
            { share_code: SHARE_CODE, demo_url: null, match_start_time: null },
          ];
        }
        if (sql.includes("SET status = 'Failed'")) {
          failures.push(params);
        }
        return [];
      },
    ),
  };
  const job = new ResolveMatchMetadata(
    { log: jest.fn(), warn: jest.fn() } as never,
    postgres as never,
    steamGc,
    {} as never,
    {} as never,
  );

  const run = (attemptsMade: number) => {
    return job.process({
      data: { valve_match_id: VALVE_MATCH_ID },
      attemptsMade,
      opts: { attempts: 5 },
    } as never);
  };

  return { run, failures };
};

describe("SteamGcService.resolveShareCode", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("rejects, so the import is retried, when the session ends mid-request", async () => {
    const { service, requested } = build();

    const request = service.resolveShareCode(SHARE_CODE);
    const outcome = expect(request).rejects.toBeInstanceOf(
      SteamGcConnectionError,
    );
    await requested();
    service["teardown"]();
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    await outcome;
  });

  it("rejects, so the import is retried, when the GC never answers", async () => {
    const { service, requested } = build();

    const request = service.resolveShareCode(SHARE_CODE);
    const outcome = expect(request).rejects.toBeInstanceOf(
      SteamGcConnectionError,
    );
    await requested();
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    await outcome;
  });

  it("returns null when the GC answers without the match", async () => {
    const { service, cs, requested } = build();

    const request = service.resolveShareCode(SHARE_CODE);
    await requested();
    cs.emit("matchList", []);

    await expect(request).resolves.toBeNull();
  });

  it("resolves the match the GC answers with", async () => {
    const { service, cs, requested } = build();

    const request = service.resolveShareCode(SHARE_CODE);
    await requested();
    cs.emit("matchList", [MATCH]);

    await expect(request).resolves.toMatchObject({
      demoUrl: "http://replay/demo.dem.bz2",
      mapName: "de_dust2",
    });
  });

  it("does not log off in the middle of a request started just before the idle timeout", async () => {
    const { service, client, cs, requested } = build();

    const first = service.resolveShareCode(SHARE_CODE);
    await requested();
    cs.emit("matchList", [MATCH]);
    await first;

    await jest.advanceTimersByTimeAsync(IDLE_LOGOFF_MS - 1_000);
    const second = service.resolveShareCode(SHARE_CODE);
    const outcome = expect(second).resolves.toMatchObject({
      mapName: "de_dust2",
    });
    await requested();
    await jest.advanceTimersByTimeAsync(2_000);
    cs.emit("matchList", [MATCH]);
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    await outcome;
    expect(client.logOff).not.toHaveBeenCalled();
  });
});

describe("ResolveMatchMetadata when the GC does not answer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("leaves the import for the retry while attempts remain", async () => {
    const { service } = build();
    const { run, failures } = resolveJob(service);

    const outcome = expect(run(0)).rejects.toBeInstanceOf(
      SteamGcConnectionError,
    );
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    await outcome;
    expect(failures).toEqual([]);
  });

  it("marks the import Failed with the reason on the last attempt", async () => {
    const { service } = build();
    const { run, failures } = resolveJob(service);

    const outcome = expect(run(4)).rejects.toBeInstanceOf(
      SteamGcConnectionError,
    );
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    await outcome;
    expect(failures).toEqual([
      [VALVE_MATCH_ID, "steam gc did not answer in time"],
    ]);
  });
});
