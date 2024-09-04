import { forwardRef, Module } from "@nestjs/common";
import { HasuraModule } from "../hasura/hasura.module";
import { ServerGateway } from "../sockets/server.gateway";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { EncryptionModule } from "../encryption/encryption.module";
import { RconModule } from "../rcon/rcon.module";
import { MatchLobbyService } from "./match-lobby.service";
import { MatchesModule } from "src/matches/matches.module";
import { MatchMakingService } from "./match-making.servcie";

@Module({
  exports: [MatchLobbyService, MatchMakingService],
  imports: [
    HasuraModule,
    RedisModule,
    EncryptionModule,
    RconModule,
    forwardRef(() => MatchesModule),
  ],
  providers: [
    ServerGateway,
    MatchLobbyService,
    MatchMakingService,
    loggerFactory(),
  ],
})
export class SocketsModule {}
