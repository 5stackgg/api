import { WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { DedicatedServerQueues } from "../enums/DedicatedServerQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { FileManagerService } from "../../file-manager/file-manager.service";
import { DedicatedServersService } from "../dedicated-servers.service";
import {
  DedicatedServerMigrationService,
  ServerMigrationNode,
} from "../dedicated-server-migration.service";

@UseQueue("DedicatedServers", DedicatedServerQueues.ServerMaintenance, {
  concurrency: 3,
})
export class CleanupDedicatedServerFiles extends WorkerHost {
  constructor(
    private readonly postgres: PostgresService,
    private readonly fileManager: FileManagerService,
    private readonly dedicatedServers: DedicatedServersService,
  ) {
    super();
  }

  async process(
    job: Job<{ serverId: string; gameServerNodeId: string }>,
  ): Promise<void> {
    const { serverId, gameServerNodeId } = job.data;

    const [node] = await this.postgres.query<
      Array<Pick<ServerMigrationNode, "status" | "node_ip">>
    >(
      `SELECT status, host(node_ip) AS node_ip FROM game_server_nodes WHERE id = $1`,
      [gameServerNodeId],
    );

    if (!node) {
      return;
    }

    if (
      !DedicatedServerMigrationService.isNodeUp(node as ServerMigrationNode)
    ) {
      throw new Error(`${gameServerNodeId} is offline, retrying later`);
    }

    await this.dedicatedServers.waitForDedicatedServerStopped(serverId, {
      acceptTerminating: false,
      timeoutMs: 2 * 60 * 1000,
    });

    try {
      await this.fileManager.deleteServerDirectory(gameServerNodeId, serverId);
    } catch (error) {
      if (
        error?.message ===
        FileManagerService.outdatedConnectorMessage(gameServerNodeId)
      ) {
        throw new UnrecoverableError(error.message);
      }

      throw error;
    }
  }
}
