import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { SocketQueues } from "../enums/SocketQueues";
import { Redis } from "ioredis";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { SocketsGateway } from "../sockets.gateway";

@UseQueue("Sockets", SocketQueues.CheckSocketNodes)
export class CheckSocketNodeJob extends WorkerHost {
  private redis: Redis;

  constructor(private readonly redisManager: RedisManagerService) {
    super();

    this.redis = this.redisManager.getConnection();
  }

  async process(): Promise<void> {
    for (const nodeId of await this.redis.smembers(
      SocketsGateway.GET_AVAILABLE_NODES_KEY(),
    )) {
      if (await this.redis.get(SocketsGateway.GET_NODE_STATUS_KEY(nodeId))) {
        continue;
      }

      const clients = await this.redis.smembers(
        SocketsGateway.GET_NODE_CLIENTS_KEY(nodeId),
      );
      for (const client of clients) {
        const [clientId, steamId] = client.split(":");

        const clientListKey =
          SocketsGateway.GET_CLIENT_CLIENTS_LIST_KEY(steamId);

        await this.redis.srem(
          clientListKey,
          SocketsGateway.GET_CLIENT_NODE_KEY(clientId, nodeId),
        );

        const clients = await this.redis.smembers(clientListKey);

        if (clients.length === 0) {
          await this.redis.del(
            SocketsGateway.GET_USER_CONNECTIONS_KEY(steamId),
          );
        }
      }

      await this.redis.srem("available-socket-nodes", nodeId);

      const players = await this.redis.keys("user:*");

      await this.redis.publish(
        `broadcast-message`,
        JSON.stringify({
          event: `players-online`,
          data: players.map((player) => player.slice(5)),
        }),
      );
    }
  }
}
