import { Controller, Logger } from "@nestjs/common";
import { SystemService } from "./system.service";
import { HasuraAction } from "src/hasura/hasura.controller";
import { Get } from "@nestjs/common";
import { User } from "src/auth/types/User";
import { HasuraService } from "src/hasura/hasura.service";
import { NotificationsService } from "src/notifications/notifications.service";
import { S3Service } from "src/s3/s3.service";
import { link } from "fs";

@Controller("system")
export class SystemController {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly system: SystemService,
    private readonly hasura: HasuraService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get("health")
  public async status() {
    return "OK";
  }

  @HasuraAction()
  public async updateServices() {
    await this.system.updateServices();

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async testUpload() {
    if (await this.s3.has("hello.txt")) {
      await this.s3.remove("hello.txt");
    }

    try {
      // test presigned url
      await this.s3.getPresignedUrl("hello.txt");

      await this.s3.put(
        "hello.txt",
        Buffer.from(`world : ${new Date().toISOString()}`),
      );

      return {};
    } catch (error) {
      this.logger.error(`Failed to upload file to S3: ${error.message}`);
      return {
        error: error.message,
      };
    }
  }

  @HasuraAction()
  public async getTestUploadLink() {
    try {
      return {
        link: await this.s3.getPresignedUrl("hello.txt", 60, "get"),
      };
    } catch (error) {
      this.logger.error(`Failed to get presigned URL: ${error.message}`);
      return {
        error: error.message,
      };
    }
  }

  @HasuraAction()
  public async registerName(data: { user: User; name: string }) {
    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: {
            steam_id: data.user.steam_id,
          },
          _set: {
            name: data.name,
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

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async requestNameChange(data: { name: string; steam_id: string }) {
    const { notifications } = await this.hasura.query({
      notifications: {
        __args: {
          where: {
            type: {
              _eq: "NameChangeRequest",
            },
            entity_id: {
              _eq: data.steam_id,
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
          steam_id: data.steam_id,
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
        message: `Player ${player.name} has requested to change their name to ${data.name}`,
        title: "Name Change Request",
        role: "administrator",
        entity_id: data.steam_id,
      },
      [
        {
          label: "Approve",
          graphql: {
            type: "mutation",
            action: "approveNameChange",
            variables: {
              name: data.name,
              steam_id: data.steam_id,
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
}
