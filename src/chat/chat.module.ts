import { Module, forwardRef } from "@nestjs/common";
import { ChatService } from "./chat.service";
import { ChatGateway } from "./chat.gateway";
import { HasuraModule } from "src/hasura/hasura.module";
import { RconModule } from "src/rcon/rcon.module";
import { RedisModule } from "src/redis/redis.module";
import { loggerFactory } from "src/utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, RedisModule, forwardRef(() => RconModule)],
  providers: [ChatService, ChatGateway, loggerFactory()],
  exports: [ChatService],
})
export class ChatModule {}
