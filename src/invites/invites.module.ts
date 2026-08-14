import { Module } from "@nestjs/common";
import { InvitesController } from "./invites.controller";
import { HasuraModule } from "src/hasura/hasura.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { NotificationsModule } from "src/notifications/notifications.module";
import { loggerFactory } from "src/utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, PostgresModule, NotificationsModule],
  providers: [loggerFactory()],
  controllers: [InvitesController],
})
export class InvitesModule {}
