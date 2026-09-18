import { Controller, Post, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { SystemService } from "./system.service";
import { HasuraAction } from "src/hasura/hasura.controller";
import { Get } from "@nestjs/common";
import { User } from "src/auth/types/User";
import { HasuraService } from "src/hasura/hasura.service";
import { NotificationsService } from "src/notifications/notifications.service";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { settings_set_input } from "generated/schema";
import { GameServerNodeService } from "src/game-server-node/game-server-node.service";
import { GameStreamerService } from "src/matches/game-streamer/game-streamer.service";
import { LoggingService } from "src/k8s/logging/logging.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { PassThrough } from "stream";
import { ChatService } from "src/chat/chat.service";
import { SystemSettingName } from "./enums/SystemSettingName";

@Controller("system")
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly hasura: HasuraService,
    private readonly notifications: NotificationsService,
    private readonly gameServerNodeService: GameServerNodeService,
    private readonly loggingService: LoggingService,
    private readonly chatService: ChatService,
  ) {}

  @Get("healthz")
  public async status() {
    return;
  }

  @Post("logs/download")
  public async logs(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const user = request.user;

    if (!user || !isRoleAbove(user.role, "administrator")) {
      response.status(403).json({
        message: "Forbidden",
      });
      return;
    }

    const {
      service,
      previous,
      tailLines,
      since,
    }: {
      service: string;
      previous?: boolean;
      tailLines?: number;
      since?: {
        start: string;
        until: string;
      };
    } = request.body;

    if (!service) {
      response.status(400).json({
        message: "service is required",
      });
      return;
    }

    // m- = match jobs, gs- = game-streamer jobs; both read by job-name label.
    const isJob =
      service.startsWith("cs-update:") ||
      service.startsWith("shader-bake:") ||
      service.startsWith("m-") ||
      service.startsWith("gs-");

    const stream = new PassThrough();

    try {
      const filename = `${service}-logs.zip`;

      response.setHeader("Content-Type", "application/zip");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      stream.pipe(response);

      stream.on("error", (error) => {
        if (!response.headersSent) {
          response.status(500).json({
            message: error?.message || "Stream error",
          });
          return;
        }
        response.destroy();
      });

      response.on("close", () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });

      await this.loggingService.getServiceLogs(
        service.startsWith("cs-update:")
          ? GameServerNodeService.GET_UPDATE_JOB_NAME(
              service.replace("cs-update:", ""),
            )
          : service.startsWith("shader-bake:")
            ? GameStreamerService.GET_BAKE_JOB_NAME(
                service.replace("shader-bake:", ""),
              )
            : service,
        stream,
        tailLines,
        !!previous,
        true,
        isJob,
        since,
      );

      if (stream.readableEnded || stream.destroyed) {
        if (!response.writableEnded) {
          response.end();
        }
      }
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          message:
            error?.body?.message || error.message || "Unable to get logs",
        });
        return;
      }
      stream.destroy();
      response.destroy();
    }
  }

  @HasuraAction()
  public async updateServices() {
    await this.system.updateServices();

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async restartService(data: { service: string }) {
    await this.system.restartService(data.service);

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async registerName(data: { user: User; name: string }) {
    const name = SystemController.validateName(data.name);

    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: data.user.steam_id,
        },
        name_registered: true,
      },
    });

    if (!player) {
      throw new Error("Player not found");
    }

    // Registration is the one rename that skips admin approval, so it is only
    // available to a player who has never registered a name. Everyone else
    // goes through requestNameChange.
    if (player.name_registered) {
      throw new Error(
        "Your name is already registered, request a name change instead",
      );
    }

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: {
            steam_id: data.user.steam_id,
          },
          _set: {
            name,
            name_registered: true,
          },
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  private static validateName(name: string) {
    const trimmed = (name ?? "").trim();

    if (trimmed.length < 3 || trimmed.length > 32) {
      throw new Error("Name must be between 3 and 32 characters");
    }

    return trimmed;
  }

  @HasuraAction()
  public async approveNameChange(data: { name: string; steam_id: string }) {
    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: {
            steam_id: data.steam_id,
          },
          _set: {
            name: data.name,
            name_registered: true,
          },
        },
        __typename: true,
      },
    });

    await this.notifications.notifyPlayers("NameChangeApproved", {
      message: `Your name change to ${NotificationsService.escapeHtml(data.name)} was approved`,
      title: "Name Change Approved",
      role: "user",
      entity_id: data.steam_id,
      steamIds: [data.steam_id],
    });

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async denyNameChange(data: { name: string; steam_id: string }) {
    await this.notifications.notifyPlayers("NameChangeDenied", {
      message: `Your name change to ${NotificationsService.escapeHtml(data.name)} was denied`,
      title: "Name Change Denied",
      role: "user",
      entity_id: data.steam_id,
      steamIds: [data.steam_id],
    });

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async requestNameChange(data: {
    user: User;
    name: string;
    steam_id: string;
  }) {
    const name = SystemController.validateName(data.name);

    // steam_id comes from the client, so a player could otherwise file a
    // rename for somebody else and have an admin approve it.
    const steamId = isRoleAbove(data.user?.role, "administrator")
      ? data.steam_id
      : data.user.steam_id;

    const { notifications } = await this.hasura.query({
      notifications: {
        __args: {
          where: {
            type: {
              _eq: "NameChangeRequest",
            },
            entity_id: {
              _eq: steamId,
            },
            is_read: {
              _eq: false,
            },
          },
        },
        __typename: true,
      },
    });

    if (notifications.length > 0) {
      throw new Error("You have already requested a name change");
    }

    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        name: true,
      },
    });

    if (!player) {
      throw new Error("Player not found");
    }

    await this.notifications.send(
      "NameChangeRequest",
      {
        message: `Player ${NotificationsService.escapeHtml(player.name)} has requested to change their name to ${NotificationsService.escapeHtml(name)}`,
        title: "Name Change Request",
        role: "administrator",
        entity_id: steamId,
      },
      [
        {
          label: "Deny",
          graphql: {
            type: "mutation",
            action: "denyNameChange",
            variables: {
              name,
              steam_id: steamId,
            },
            selection: {
              success: true,
            },
          },
        },
        {
          label: "Approve",
          graphql: {
            type: "mutation",
            action: "approveNameChange",
            variables: {
              name,
              steam_id: steamId,
            },
            selection: {
              success: true,
            },
          },
        },
      ],
    );

    return {
      success: true,
    };
  }

  @HasuraEvent()
  public async settings(data: HasuraEventData<settings_set_input>) {
    if (
      (data.new.name === SystemSettingName.DemoNetworkLimiter ||
        data.old.name === SystemSettingName.DemoNetworkLimiter) &&
      (data.op === "INSERT" ||
        data.op === "DELETE" ||
        data.new.value !== data.old.value)
    ) {
      await this.gameServerNodeService.updateDemoNetworkLimiters();
    }

    for (const { setting, type, fallback } of ChatService.TTL_SETTINGS) {
      if (
        (data.new.name === setting || data.old.name === setting) &&
        (data.op === "INSERT" ||
          data.op === "DELETE" ||
          data.new.value !== data.old.value)
      ) {
        const ttl = parseInt(data.new.value, 10);
        this.chatService.updateChatMessageTTL(
          type,
          isNaN(ttl) ? fallback : ttl,
        );
      }
    }

    await this.system.updateDefaultOptions();
  }
}
