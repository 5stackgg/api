import {
  Module,
  MiddlewareConsumer,
  RequestMethod,
  NestModule,
} from "@nestjs/common";
import { HasuraModule } from "src/hasura/hasura.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { RconModule } from "src/rcon/rcon.module";
import { DedicatedServersModule } from "src/dedicated-servers/dedicated-servers.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { MatchServerMiddlewareMiddleware } from "src/matches/match-server-middleware/match-server-middleware.middleware";
import { SanctionsService } from "./sanctions.service";
import { SanctionsController } from "./sanctions.controller";

@Module({
  imports: [HasuraModule, PostgresModule, RconModule, DedicatedServersModule],
  providers: [SanctionsService, loggerFactory()],
  controllers: [SanctionsController],
})
export class SanctionsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MatchServerMiddlewareMiddleware).forRoutes({
      path: "sanctions/server/:serverId",
      method: RequestMethod.GET,
    });
  }
}
