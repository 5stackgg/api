import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { MapAssetsService } from "./map-assets.service";

@Controller("map-assets")
export class MapAssetsController {
  constructor(private readonly mapAssets: MapAssetsService) {}

  @HasuraAction()
  public async buildMapAssets(data: { game_server_node_id: string }) {
    return {
      success: await this.mapAssets.queueManualBuild(data.game_server_node_id),
    };
  }
}
