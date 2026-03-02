import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NotificationsService } from "./notifications.service";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, ConfigModule],
  providers: [NotificationsService, loggerFactory()],
  exports: [NotificationsService],
})
export class NotificationsModule {}
