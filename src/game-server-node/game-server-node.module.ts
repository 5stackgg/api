import { Module } from "@nestjs/common";
import { GameServerNodeService } from "./game-server-node.service";
import { GameServerNodeController } from "./game-server-node.controller";
import { TailscaleModule } from "../tailscale/tailscale.module";
import { HasuraModule } from "../hasura/hasura.module";
import { GameServerNodeGateway } from "./game-server-node.gateway";
import { CacheModule } from "../cache/cache.module";

@Module({
  providers: [GameServerNodeService, GameServerNodeGateway],
  imports: [TailscaleModule, HasuraModule, CacheModule],
  controllers: [GameServerNodeController],
})
export class GameServerNodeModule {}
