import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { NadeMiningService } from "./nade-mining.service";

@Controller("nade-mining")
export class NadeMiningController {
  constructor(private readonly mining: NadeMiningService) {}

  @HasuraAction()
  public async saveNadeLineupFromDemo(data: {
    user: User;
    match_id: string;
    match_map_id: string;
    grenade_id: number;
    name: string;
    description?: string;
    visibility?: string;
    team_id?: string;
    tags?: Array<string>;
    collection_id?: string;
  }) {
    return await this.mining.saveFromDemo({
      user: data.user,
      match_id: data.match_id,
      match_map_id: data.match_map_id,
      grenade_id: data.grenade_id,
      name: data.name,
      description: data.description ?? null,
      visibility: data.visibility,
      team_id: data.team_id ?? null,
      tags: data.tags,
      collection_id: data.collection_id ?? null,
    });
  }

  @HasuraAction()
  public async nadeMatchUtilityReport(data: {
    user: User;
    match_id: string;
    steam_id?: string;
  }) {
    return await this.mining.utilityReport(data.user, {
      match_id: data.match_id,
      steam_id: data.steam_id ?? null,
    });
  }
}
