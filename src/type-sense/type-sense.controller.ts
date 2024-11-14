import { Controller } from "@nestjs/common";
import { TypeSenseService } from "./type-sense.service";
import { HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import {
  player_sanctions_set_input,
  players_set_input,
  team_roster_set_input,
} from "../../generated";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { RefreshPlayerJob } from "./jobs/RefreshPlayer";
import { Queue } from "bullmq";
import { TypesenseQueues } from "./enums/TypesenseQueues";
import { InjectQueue } from "@nestjs/bullmq";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";

@Controller("type-sense")
export class TypeSenseController {
  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly typeSense: TypeSenseService,
    private readonly matchAssistant: MatchAssistantService,
    @InjectQueue(TypesenseQueues.TypeSense) private queue: Queue,
  ) {}

  @HasuraEvent()
  public async player_events(data: HasuraEventData<players_set_input>) {
    await this.cache.forget(
      HasuraService.PLAYER_ROLE_CACHE_KEY(
        `${data.new.steam_id || data.old.steam_id}`,
      ),
    );

    if (data.op === "DELETE") {
      await this.typeSense.removePlayer(data.old.steam_id);
      return;
    }

    await this.typeSense.updatePlayer(data.new.steam_id as string);
  }

  @HasuraEvent()
  public async player_sanctions(
    data: HasuraEventData<player_sanctions_set_input>,
  ) {
    const endOfSanction = data.new.remove_sanction_date;

    if (endOfSanction) {
      const jobId = `player-sanctions:${data.new.type}:${data.new.player_steam_id}`;
      await this.queue.remove(jobId);

      await this.queue.add(
        RefreshPlayerJob.name,
        {
          steamId: data.new.player_steam_id,
        },
        {
          jobId,
          // Add a second to ensure sanction date is passed
          delay: new Date(endOfSanction).getTime() - Date.now() + 1000,
        },
      );
    }

    const { match_lineup_players } = await this.hasura.query({
      match_lineup_players: {
        __args: {
          where: {
            steam_id: {
              _eq: data.new.player_steam_id,
            },
            lineup: {
              v_match_lineup: {
                match: {
                  status: {
                    _eq: "Live",
                  },
                },
              },
            },
          },
        },
        lineup: {
          v_match_lineup: {
            match_id: true,
          },
        },
      },
    });

    for (const matchLineupPlayer of match_lineup_players) {
      await this.matchAssistant.sendServerMatchId(
        matchLineupPlayer.lineup.v_match_lineup.match_id,
      );
    }

    await this.typeSense.updatePlayer(data.new.player_steam_id as string);
  }

  @HasuraEvent()
  public async team_roster_events(
    data: HasuraEventData<team_roster_set_input>,
  ) {
    await this.typeSense.updatePlayer(
      (data.new.player_steam_id || data.old.player_steam_id) as string,
    );
  }
}
