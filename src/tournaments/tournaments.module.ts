import { Module } from "@nestjs/common";
import { TournamentsController } from "./tournaments.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { DemosModule } from "../demos/demos.module";
import { ClipsModule } from "../matches/clips/clips.module";
import { DiscordTournamentVoiceModule } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { NotificationsModule } from "../notifications/notifications.module";
import { PostgresModule } from "../postgres/postgres.module";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [
    HasuraModule,
    DemosModule,
    ClipsModule,
    DiscordTournamentVoiceModule,
    NotificationsModule,
    PostgresModule,
    RedisModule,
  ],
  controllers: [TournamentsController],
  providers: [loggerFactory()],
})
export class TournamentsModule {}
