import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { NadeInsightsService } from "./nade-insights.service";

@Controller("nade-insights")
export class NadeInsightsController {
  constructor(private readonly insights: NadeInsightsService) {}

  @HasuraAction()
  public async nadePracticePlan(data: {
    user: User;
    map_name: string;
    side?: string;
    limit?: number;
    order?: string;
  }) {
    return await this.insights.practicePlan(data.user, {
      map_name: data.map_name,
      side: data.side ?? null,
      limit: data.limit ?? null,
      order: data.order ?? null,
    });
  }

  @HasuraAction()
  public async nadeLineupMissPattern(data: {
    user: User;
    nade_lineup_id: string;
  }) {
    return await this.insights.missPattern(data.user, {
      nade_lineup_id: data.nade_lineup_id,
    });
  }

  @HasuraAction()
  public async nadeTeamUtilityReport(data: {
    user: User;
    team_id: string;
    map_name?: string;
    limit?: number;
  }) {
    return await this.insights.teamUtilityReport(data.user, {
      team_id: data.team_id,
      map_name: data.map_name ?? null,
      limit: data.limit ?? null,
    });
  }
}
