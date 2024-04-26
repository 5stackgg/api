import { Logger, Scope } from "@nestjs/common";
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
