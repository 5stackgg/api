import { WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Job } from "bullmq";
import { HasuraService } from "../../hasura/hasura.service";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsService } from "../../notifications/notifications.service";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

@UseQueue("GameServerNode", GameServerQueues.NodeOffline)
export class MarkGameServerNodeOffline extends WorkerHost {
  constructor(
    protected readonly hasura: HasuraService,
    protected readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(
    job: Job<{
      node: string;
    }>,
  ): Promise<void> {
    const { update_game_server_nodes_by_pk } = await this.hasura.mutation({
      update_game_server_nodes_by_pk: {
        __args: {
          pk_columns: {
            id: job.data.node,
          },
          _set: {
            status: "Offline",
            offline_at: new Date().toISOString(),
          },
        },
        label: true,
        region: true,
      },
    });

    await this.notifications.send(
      "GameNodeStatus",
      {
        message: `Game Server Node (${update_game_server_nodes_by_pk.label || job.data.node}) is Offline.`,
        title: "Game Server Node Offline",
        role: "administrator",
        entity_id: job.data.node,
      },
      undefined,
      DISCORD_COLORS.RED,
    );

    const region = update_game_server_nodes_by_pk.region;
    if (!region) {
      return;
    }

    const { server_regions_by_pk } = await this.hasura.query({
      server_regions_by_pk: {
        __args: { value: region },
        value: true,
        description: true,
        status: true,
      },
    });

    if (!server_regions_by_pk || server_regions_by_pk.status !== "Offline") {
      return;
    }

    await this.notifications.send(
      "GameNodeStatus",
      {
        message: `Region ${server_regions_by_pk.description || region} is Offline. All nodes in this region are unavailable.`,
        title: "Region Offline",
        role: "administrator",
        entity_id: region,
      },
      undefined,
      DISCORD_COLORS.RED,
    );

    await this.notifyStuckMatches(region);
  }

  private async notifyStuckMatches(region: string): Promise<void> {
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            status: {
              _in: [
                "Veto",
                "WaitingForServer",
                "Scheduled",
                "WaitingForCheckIn",
              ],
            },
            _or: [
              { region: { _eq: region } },
              { options: { regions: { _contains: [region] } } },
            ],
          },
        },
        id: true,
        region: true,
        status: true,
        options: {
          regions: true,
        },
      },
    });

    if (matches.length === 0) {
      return;
    }

    const regionValues = new Set<string>();
    for (const match of matches) {
      if (match.region) {
        regionValues.add(match.region);
      }
      for (const r of match.options?.regions || []) {
        regionValues.add(r);
      }
    }

    const { server_regions } = await this.hasura.query({
      server_regions: {
        __args: {
          where: { value: { _in: Array.from(regionValues) } },
        },
        value: true,
        status: true,
      },
    });

    const statusByRegion = new Map<string, string>();
    for (const sr of server_regions) {
      statusByRegion.set(sr.value, sr.status);
    }

    const unusable = (status: string | undefined) =>
      status === "Offline" || status === "Disabled";

    for (const match of matches) {
      const assignedRegions = match.region
        ? [match.region]
        : match.options?.regions || [];

      if (assignedRegions.length === 0) {
        continue;
      }

      const allDown = assignedRegions.every((r) =>
        unusable(statusByRegion.get(r)),
      );

      if (!allDown) {
        continue;
      }

      await this.notifications.send(
        "GameNodeStatus",
        {
          message: `Match ${match.id} has no available regions (${assignedRegions.join(", ")} are offline). An admin must override the region to unblock it.`,
          title: "Match stuck: no regions available",
          role: "administrator",
          entity_id: match.id,
        },
        undefined,
        DISCORD_COLORS.RED,
      );
    }
  }
}
