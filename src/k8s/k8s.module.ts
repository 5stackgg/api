import { Module } from "@nestjs/common";
import { LoggingService } from "./logging/logging.service";
import { loggerFactory } from "src/utilities/LoggerFactory";

@Module({
  providers: [LoggingService, loggerFactory()],
  exports: [LoggingService],
})
export class K8sModule {}
