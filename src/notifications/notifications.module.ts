import { Module } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import { HasuraModule } from "../hasura/hasura.module";

@Module({
  imports: [HasuraModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
