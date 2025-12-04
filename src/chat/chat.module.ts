import { Module, forwardRef } from "@nestjs/common";
import { ChatService } from "./chat.service";
import { ChatGateway } from "./chat.gateway";
import { HasuraModule } from "src/hasura/hasura.module";
import { RconModule } from "src/rcon/rcon.module";
import { RedisModule } from "src/redis/redis.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { ChatController } from "./chat.controller";

@Module({
  imports: [HasuraModule, RedisModule, forwardRef(() => RconModule)],
  providers: [ChatService, ChatGateway, loggerFactory()],
  exports: [ChatService],
  controllers: [ChatController],
})
export class ChatModule {}
