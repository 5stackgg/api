import { Module } from "@nestjs/common";
import { FriendsController } from "./friends.controller";
import { HasuraModule } from "src/hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { CacheModule } from "src/cache/cache.module";
import { FriendsService } from "./friends.service";

@Module({
  imports: [HasuraModule],
  controllers: [FriendsController],
  providers: [loggerFactory(), FriendsService],
})
export class FriendsModule {}
