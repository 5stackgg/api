import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { LeaguesService } from "./leagues.service";
import { LeaguesController } from "./leagues.controller";

@Module({
  imports: [HasuraModule, PostgresModule, ConfigModule, NotificationsModule],
  controllers: [LeaguesController],
  exports: [LeaguesService],
  providers: [LeaguesService, loggerFactory()],
})
export class LeaguesModule {}
