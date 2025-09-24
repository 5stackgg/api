import TurndownService from "turndown";
import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "generated/schema";

@Injectable()
export class NotificationsService {
  constructor(
    private readonly hasura: HasuraService,
    private readonly logger: Logger,
  ) {}

  async send(
    type: e_notification_types_enum,
    notification: {
      message: string;
      title: string;
      role: e_player_roles_enum;
      entity_id?: string;
    },
    actions?: Array<{
      label: string;
      graphql: {
        type: string;
        action: string;
        selection: Record<string, any>;
        variables?: Record<string, any>;
      };
    }>,
  ) {
    const { settings_by_pk: discord_support_webhook } = await this.hasura.query(
      {
        settings_by_pk: {
          __args: {
            name: "discord_support_webhook",
          },
          value: true,
        },
      },
    );

    const { settings_by_pk: discord_role_id } = await this.hasura.query({
      settings_by_pk: {
        __args: {
          name: "discord_support_role_id",
        },
        value: true,
      },
    });

    await this.hasura.mutation({
      insert_notifications_one: {
        __args: {
          object: {
            type,
            ...notification,
            actions,
          },
        },
        id: true,
      },
    });

    if (discord_support_webhook?.value) {
      try {
        await fetch(discord_support_webhook.value, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: new TurndownService().turndown(
              `${discord_role_id ? ` <@&${discord_role_id.value}> ` : ""} ${notification.message}`,
            ),
            username: "5stack",
          }),
        });
      } catch (error) {
        this.logger.error("Error sending discord notification", error);
      }
    }
  }
}
