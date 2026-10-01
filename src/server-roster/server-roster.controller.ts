import { Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { User } from "src/auth/types/User";
import { CommunityStatsService } from "./community-stats.service";

@Controller("server-roster")
export class ServerRosterController {
  constructor(private readonly communityStats: CommunityStatsService) {}

  @HasuraAction()
  public async getServerCommunityStats(data: {
    server_id: string;
    user?: User;
  }) {
    return await this.communityStats.serverStats(data.server_id, data.user);
  }

  @HasuraAction()
  public async getServerLeaderboard(data: {
    server_id: string;
    period: string;
    metric: string;
    limit?: number | null;
    user?: User;
  }) {
    return await this.communityStats.leaderboard(
      data.server_id,
      data.period,
      data.metric,
      data.limit,
      data.user,
    );
  }

  @HasuraAction()
  public async getPlayerCommunityStats(data: {
    steam_id: string;
    user?: User;
  }) {
    return await this.communityStats.playerStats(data.steam_id, data.user);
  }
}
