import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { NotificationsService } from "../../notifications/notifications.service";

export default class MatchAbandoned extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_abandoned_matches_one: {
        __args: {
          object: {
            steam_id: this.data.steam_id,
            match_id: this.matchId,
          },
        },
        __typename: true,
      },
    });

    await this.notifyAdmins();
  }

  // Abandons are issued automatically and carry a cooldown that escalates on
  // repeat, so admins need to see them to spot an unfair one before the player
  // has to appeal it.
  private async notifyAdmins() {
    try {
      const { players_by_pk: player } = await this.hasura.query({
        players_by_pk: {
          __args: {
            steam_id: this.data.steam_id,
          },
          name: true,
        },
      });

      await this.notifications.send("MatchAbandoned", {
        message: `${NotificationsService.escapeHtml(player?.name ?? this.data.steam_id)} abandoned a match`,
        title: "Match Abandoned",
        role: "administrator",
        entity_id: this.matchId,
      });
    } catch (error) {
      // The abandon record is the thing that matters; never lose it over a
      // failed notification.
      this.logger.warn(
        `failed to notify admins of abandon by ${this.data.steam_id}`,
        error,
      );
    }
  }
}
