import { Injectable } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import { MatchAssistantService } from "../../matches/match-assistant/match-assistant.service";
import { getRandomNumber } from "../utilities/getRandomNumber";
import { CacheService } from "../../cache/cache.service";
import { InjectQueue } from "@nestjs/bullmq";
import { DiscordBotQueues } from "../enums/DiscordBotQueues";
import { Queue } from "bullmq";

@Injectable()
export class DiscordBotVetoService {
  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly matchAssistant: MatchAssistantService,
    @InjectQueue(DiscordBotQueues.DiscordBot) private readonly queue: Queue,
  ) {}

  static UPDATE_MAP_BANS_JOB_ID(matchId: string) {
    return `match:${matchId}:bans`;
  }

  public async getMapBanVotes(
    matchId: string,
  ): Promise<Record<string, number>> {
    const votes = await this.getVotes(matchId);

    const mapVotes: Record<string, number> = {};
    for (const userId of Object.keys(votes)) {
      const maps = votes[userId];

      for (const mapIndex of maps) {
        if (!mapVotes[mapIndex]) {
          mapVotes[mapIndex] = 0;
        }
        mapVotes[mapIndex]++;
      }
    }

    return mapVotes;
  }

  public async getTotalBanVotes(matchId: string) {
    return Object.values(await this.getMapBanVotes(matchId)).reduce(
      (acc, currentValue) => acc + currentValue,
      0,
    );
  }

  public async getTimeLeft(matchId: string) {
    const job = await this.queue.getJob(
      DiscordBotVetoService.UPDATE_MAP_BANS_JOB_ID(matchId),
    );
    if (!job) {
      return 10;
    }

    const { delay, timestamp } = job;

    const targetDate = new Date(timestamp + delay);

    return (targetDate.getTime() - new Date().getTime()) / 1000;
  }

  public async clearBanTimeout(matchId: string) {
    await this.queue.remove(
      DiscordBotVetoService.UPDATE_MAP_BANS_JOB_ID(matchId),
    );
  }

  public async pickVeto(matchId: string) {
    const mapVotes = Object.entries(await this.getMapBanVotes(matchId));

    await this.clearVotes(matchId);

    mapVotes.sort((a, b) => b[1] - a[1]);

    const availableMaps = await this.matchAssistant.getAvailableMaps(matchId);

    const pickedMaps = mapVotes.map((mapIndex) => {
      return availableMaps[parseInt(mapIndex.toString())];
    });

    let pickedMap = pickedMaps.at(0);

    if (!pickedMap) {
      pickedMap = availableMaps[getRandomNumber(0, availableMaps.length - 1)];
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        map_veto_picking_lineup_id: true,
      },
    });

    if (!match) {
      throw Error("unable to find match");
    }

    await this.hasura.mutation({
      insert_match_map_veto_picks_one: {
        __args: {
          object: {
            match_id: matchId,
            // TODO - veto type when we do best of X series
            type: "Ban",
            map_id: pickedMap.id,
            match_lineup_id: match.map_veto_picking_lineup_id,
          },
        },
        __typename: true,
      },
    });
  }

  private async getVotes(
    matchId: string,
  ): Promise<Record<string, Array<string>>> {
    return (await this.getBanVoteTag(matchId).get()) || {};
  }

  public async updateUserVotes(
    matchId: string,
    userId: string,
    mapIds: Array<string>,
  ) {
    await this.getBanVoteTag(matchId).put(userId, mapIds);

    return mapIds;
  }

  public async getUserVotes(
    matchId: string,
    userId: string,
  ): Promise<ReturnType<this["updateUserVotes"]>> {
    const voteTag = this.getBanVoteTag(matchId);

    return (await voteTag.get(userId)) || [];
  }

  private async clearVotes(matchId: string) {
    const voteTag = this.getBanVoteTag(matchId);

    await voteTag.forget();
  }

  private getBanVoteTag(matchId: string) {
    return this.cache.tags(["bot", matchId, "votes"]);
  }
}
