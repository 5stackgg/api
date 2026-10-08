import { Logger, LogLevel, Scope } from "@nestjs/common";
import { INQUIRER } from "@nestjs/core";

export function loggerFactory() {
  return {
    provide: Logger,
    scope: Scope.TRANSIENT,
    inject: [INQUIRER],
    useFactory: (parentClass: object) =>
      new Logger(parentClass.constructor.name),
  };
}

// debug and verbose are opt-in (LOG_LEVEL=debug or verbose). They carry the
// per-request chatter -- every status POST from a render or stream pod --
// that is only worth reading while chasing something.
export function logLevels(
  level: string | undefined = process.env.LOG_LEVEL,
): Array<LogLevel> {
  const levels: Array<LogLevel> = ["fatal", "error", "warn", "log"];
  const wanted = level?.trim().toLowerCase();

  if (wanted === "debug" || wanted === "verbose") {
    levels.push("debug");
  }

  if (wanted === "verbose") {
    levels.push("verbose");
  }

  return levels;
}
