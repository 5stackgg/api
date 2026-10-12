import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchmakingQueues } from "../enums/MatchmakingQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchmakingLobbyService } from "../matchmaking-lobby.service";
import { HasuraService } from "../../hasura/hasura.service";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
import { SocketsService } from "src/sockets/sockets.service";

@UseQueue("Matchmaking", MatchmakingQueues.Matchmaking)
export class MarkPlayerOffline extends WorkerHost {
  constructor(
    private readonly hasura: HasuraService,
    private readonly matchmakingLobbyService: MatchmakingLobbyService,
    private readonly redisManager: RedisManagerService,
  ) {
    super();
  }

  async process(
    job: Job<{
      steamId: string;
    }>,
  ): Promise<void> {
    const { steamId } = job.data;

    // a reload, or a hidden tab on another pod, can be back by now
    if (
      await SocketsService.hasLivePresence(
        this.redisManager.getConnection(),
        steamId,
      )
    ) {
      return;
    }

    await this.hasura.mutation({
      delete_lobby_players: {
        __args: {
          where: {
            steam_id: {
              _eq: steamId,
            },
            status: {
              _eq: "Accepted",
            },
          },
        },
        __typename: true,
      },
    });

    const lobby = await this.matchmakingLobbyService.getPlayerLobby(steamId);

    if (!lobby) {
      return;
    }

    await this.matchmakingLobbyService.removeLobbyFromQueue(lobby.id);
    await this.matchmakingLobbyService.removeLobbyDetails(lobby.id);
  }
}
