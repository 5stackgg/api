import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { UtilityInsightsService } from "./utility-insights.service";

@Controller("utility-insights")
export class UtilityInsightsController {
  constructor(private readonly insights: UtilityInsightsService) {}

  @HasuraAction()
  public async utilityPracticePlan(data: {
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
  public async utilityLineupMissPattern(data: {
    user: User;
    utility_lineup_id: string;
  }) {
    return await this.insights.missPattern(data.user, {
      utility_lineup_id: data.utility_lineup_id,
    });
  }

  @HasuraAction()
  public async utilityTeamUtilityReport(data: {
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
