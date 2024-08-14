import { Controller } from "@nestjs/common";
import { TypeSenseService } from "./type-sense.service";
import { HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { players_set_input, team_roster_set_input } from "../../generated";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";

@Controller("type-sense")
export class TypeSenseController {
  constructor(
    private readonly cache: CacheService,
    private readonly typeSense: TypeSenseService,
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
  public async team_roster_events(
    data: HasuraEventData<team_roster_set_input>,
  ) {
    await this.typeSense.updatePlayer(
      (data.new.player_steam_id || data.old.player_steam_id) as string,
    );
  }
}
