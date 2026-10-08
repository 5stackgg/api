import { logLevels } from "./LoggerFactory";

describe("logLevels", () => {
  it("leaves debug and verbose off unless asked for", () => {
    expect(logLevels(undefined)).toEqual(["fatal", "error", "warn", "log"]);
    expect(logLevels("")).toEqual(["fatal", "error", "warn", "log"]);
    expect(logLevels("nonsense")).toEqual(["fatal", "error", "warn", "log"]);
  });

  it("adds debug on LOG_LEVEL=debug", () => {
    expect(logLevels("debug")).toEqual([
      "fatal",
      "error",
      "warn",
      "log",
      "debug",
    ]);
    expect(logLevels("DEBUG")).toContain("debug");
  });

  it("adds debug and verbose on LOG_LEVEL=verbose", () => {
    expect(logLevels("verbose")).toEqual([
      "fatal",
      "error",
      "warn",
      "log",
      "debug",
      "verbose",
    ]);
  });
});
