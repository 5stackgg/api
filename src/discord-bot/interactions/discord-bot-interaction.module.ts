import { Module, forwardRef } from "@nestjs/common";
import ScheduleMatch from "./ScheduleMatch";
import { DiscordBotModule } from "../discord-bot.module";
import { HasuraModule } from "../../hasura/hasura.module";
import { MatchesModule } from "../../matches/matches.module";
import UpdateMapStatus from "./UpdateMapStatus";
import VetoPick from "./VetoPick";
import UpdateMatchStatus from "./UpdateMatchStatus";
import { loggerFactory } from "../../utilities/LoggerFactory";
import { CacheModule } from "src/cache/cache.module";
import LinkDiscord from "./LinkDiscord";

@Module({
  imports: [
    forwardRef(() => DiscordBotModule),
    HasuraModule,
    MatchesModule,
    CacheModule,
  ],
  exports: [
    LinkDiscord,
    ScheduleMatch,
    UpdateMapStatus,
    UpdateMatchStatus,
    VetoPick,
  ],
  providers: [
    LinkDiscord,
    ScheduleMatch,
    UpdateMapStatus,
    UpdateMatchStatus,
    VetoPick,
    loggerFactory(),
  ],
})
export class DiscordBotInteractionModule {}
