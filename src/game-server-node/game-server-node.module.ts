import { Module } from "@nestjs/common";
import { GameServerNodeService } from "./game-server-node.service";
import { GameServerNodeController } from "./game-server-node.controller";
import { TailscaleModule } from "../tailscale/tailscale.module";
import { HasuraModule } from "../hasura/hasura.module";

@Module({
  providers: [GameServerNodeService],
  imports: [TailscaleModule, HasuraModule],
  controllers: [GameServerNodeController],
})
export class GameServerNodeModule {}
