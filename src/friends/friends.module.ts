import { Module } from "@nestjs/common";
import { FriendsController } from "./friends.controller";
import { HasuraModule } from "src/hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { FriendsService } from "./friends.service";
import { PlayerBlocksModule } from "src/player-blocks/player-blocks.module";

@Module({
  imports: [HasuraModule, PlayerBlocksModule],
  controllers: [FriendsController],
  providers: [loggerFactory(), FriendsService],
})
export class FriendsModule {}
