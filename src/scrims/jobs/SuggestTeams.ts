import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ScrimQueues } from "../enums/ScrimQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { AppConfig } from "../../configs/types/AppConfig";
import { e_notification_types_enum, e_player_roles_enum } from "generated/schema";

const RENOTIFY_DAYS = 7;

@UseQueue("Scrims", ScrimQueues.ScrimMatcher)
export class SuggestTeams extends WorkerHost {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
  ) {
    super();
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  async process(_job: Job): Promise<void> {
    const groups = await this.postgres.query<
      Array<{ member_steam_ids: Array<string>; together_count: number }>
    >(`SELECT member_steam_ids, together_count FROM suggest_player_groups()`);

    for (const group of groups) {
      const members = [...group.member_steam_ids].sort();
      const groupHash = members.join(":");

      if (await this.recentlyHandled(groupHash)) {
        continue;
      }

      await this.postgres.query(
        `INSERT INTO team_suggestions (member_steam_ids, group_hash, together_count, status, last_notified_at)
         VALUES ($1::bigint[], $2, $3, 'Suggested', now())
         ON CONFLICT (group_hash)
         DO UPDATE SET together_count = EXCLUDED.together_count, last_notified_at = now()`,
        [members, groupHash, group.together_count],
      );

      const createUrl = `${this.appConfig.webDomain}/teams/create?members=${encodeURIComponent(members.join(","))}`;

      await this.notifications.notifyPlayers(
        "FormTeamSuggestion" as e_notification_types_enum,
        {
          title: "Form a Team?",
          message: `You've played ${group.together_count} matches with the same group recently. <a href="${createUrl}">Create a team</a> together.`,
          role: "user" as e_player_roles_enum,
          entity_id: groupHash,
          steamIds: members,
        },
      );

      this.logger.log(
        `suggested team for group ${groupHash} (${group.together_count} matches together)`,
      );
    }
  }

  private async recentlyHandled(groupHash: string): Promise<boolean> {
    const rows = await this.postgres.query<
      Array<{ status: string; last_notified_at: string | null }>
    >(
      `SELECT status, last_notified_at FROM team_suggestions WHERE group_hash = $1`,
      [groupHash],
    );
    const existing = rows.at(0);
    if (!existing) {
      return false;
    }
    if (existing.status !== "Suggested") {
      return true;
    }
    if (!existing.last_notified_at) {
      return false;
    }
    const age = Date.now() - new Date(existing.last_notified_at).getTime();
    return age < RENOTIFY_DAYS * 24 * 60 * 60 * 1000;
  }
}
