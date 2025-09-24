import { Module } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";

@Module({
  imports: [HasuraModule],
  providers: [NotificationsService, loggerFactory()],
  exports: [NotificationsService],
})
export class NotificationsModule {}
