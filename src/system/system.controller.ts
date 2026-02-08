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
import { LoggingService } from "src/k8s/logging/logging.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { PassThrough } from "stream";
import { PostgresService } from "src/postgres/postgres.service";

@Controller("system")
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly hasura: HasuraService,
    private readonly notifications: NotificationsService,
    private readonly gameServerNodeService: GameServerNodeService,
    private readonly loggingService: LoggingService,
    private readonly postgres: PostgresService,
  ) {}

  @Get("healthz")
  public async status() {
    return;
  }

  @HasuraAction()
  public async dbStats() {
    // Define a type for the result rows
    type DbStatRow = {
      queryid: string | number;
      query: string;
      calls: number;
      total_exec_time: number;
      mean_exec_time: number;
      max_exec_time: number;
      min_exec_time: number;
      total_rows: number;
      shared_blks_hit: number;
      shared_blks_read: number;
      local_blks_hit: number;
      local_blks_read: number;
    };

    const result = await this.postgres.query<DbStatRow>(`
      SELECT
          queryid,
          query,
          SUM(calls) AS calls,
          SUM(total_exec_time) AS total_exec_time,
          AVG(mean_exec_time) AS mean_exec_time,
          MAX(max_exec_time) AS max_exec_time,
          MIN(min_exec_time) AS min_exec_time,
          SUM(rows) AS total_rows,
          SUM(shared_blks_hit) AS shared_blks_hit,
          SUM(shared_blks_read) AS shared_blks_read,
          SUM(local_blks_hit) AS local_blks_hit,
          SUM(local_blks_read) AS local_blks_read
      FROM pg_stat_statements
      WHERE query NOT LIKE '/* pgbouncer */%'
      GROUP BY queryid, query
      HAVING SUM(calls) > 5
      ORDER BY mean_exec_time DESC
      LIMIT 50;
    `);

    return (result as unknown as any[]).map(
      (row): DbStatRow => ({
        queryid: row.queryid,
        query: row.query,
        calls: Number(row.calls),
        total_exec_time: Number(row.total_exec_time),
        mean_exec_time: Number(row.mean_exec_time),
        max_exec_time: Number(row.max_exec_time),
        min_exec_time: Number(row.min_exec_time),
        total_rows: Number(row.total_rows),
        shared_blks_hit: Number(row.shared_blks_hit),
        shared_blks_read: Number(row.shared_blks_read),
        local_blks_hit: Number(row.local_blks_hit),
        local_blks_read: Number(row.local_blks_read),
      }),
    );
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

    const isJob = service.startsWith("cs-update:") || service.startsWith("m-");

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

  @HasuraEvent()
  public async settings(data: HasuraEventData<settings_set_input>) {
    if (
      (data.new.name === "demo_network_limiter" ||
        data.old.name === "demo_network_limiter") &&
      (data.op === "INSERT" ||
        data.op === "DELETE" ||
        data.new.value !== data.old.value)
    ) {
      await this.gameServerNodeService.updateDemoNetworkLimiters();
    }

    await this.system.updateDefaultOptions();
  }
}
