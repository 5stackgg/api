const watches: Array<{
  path: string;
  query: Record<string, unknown>;
  onEvent: (phase: string, pod: unknown) => void;
  done: (error?: unknown) => void;
}> = [];
let failNextWatch = false;

jest.mock("@kubernetes/client-node", () => {
  const actual = jest.requireActual("@kubernetes/client-node");
  return {
    ...actual,
    KubeConfig: class KubeConfig {
      loadFromDefault() {}
      makeApiClient() {
        return {};
      }
    },
    Watch: class Watch {
      async watch(
        path: string,
        query: Record<string, unknown>,
        onEvent: (phase: string, pod: unknown) => void,
        done: (error?: unknown) => void,
      ) {
        if (failNextWatch) {
          failNextWatch = false;
          throw new Error("connect ECONNREFUSED");
        }
        watches.push({ path, query, onEvent, done });
        return new AbortController();
      }
    },
  };
});

import { SystemService } from "./system.service";

describe("SystemService pod watch", () => {
  let gone: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    watches.length = 0;
    failNextWatch = false;
    gone = jest.fn();
    new SystemService(
      {} as any,
      {} as any,
      {} as any,
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
    ).watchServicePods(gone);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("watches only the pods an update rolls out", () => {
    expect(watches).toHaveLength(1);
    expect(watches[0].path).toBe("/api/v1/namespaces/5stack/pods");
    expect(watches[0].query.labelSelector).toMatch(
      /^app in \(.*\bapi\b.*\bweb\b.*\bhasura\b.*\)$/,
    );
  });

  it("checks again when an old pod goes, and not as pods come up", () => {
    watches[0].onEvent("ADDED", {});
    watches[0].onEvent("MODIFIED", {});
    expect(gone).not.toHaveBeenCalled();

    watches[0].onEvent("DELETED", {});
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("watches again after the stream ends", async () => {
    watches[0].done();
    watches[0].done(new Error("socket hang up"));

    await jest.advanceTimersByTimeAsync(5000);

    expect(watches).toHaveLength(2);
  });

  it("keeps trying when the api server cannot be reached", async () => {
    watches[0].done();
    failNextWatch = true;

    await jest.advanceTimersByTimeAsync(5000);
    expect(watches).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(5000);
    expect(watches).toHaveLength(2);
  });
});
