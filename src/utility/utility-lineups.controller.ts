import { Controller } from "@nestjs/common";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { User } from "../auth/types/User";
import { UtilityImportService } from "./utility-import.service";
import { UtilityLineupsService } from "./utility-lineups.service";
import { UtilityPracticeService } from "./utility-practice.service";

@Controller("utility-lineups")
export class UtilityLineupsController {
  constructor(
    private readonly lineups: UtilityLineupsService,
    private readonly imports: UtilityImportService,
    private readonly practice: UtilityPracticeService,
  ) {}

  /**
   * A lineup changed, so any practice server on that map is holding a stale
   * library.
   *
   * Both maps matter on a move: the server the lineup left has one row too
   * many and the one it arrived on has one too few. This is a separate trigger
   * from the search one deliberately -- that one is not allowed to fire on the
   * geometry columns, and geometry is exactly what a server standing somebody
   * on a throw needs to have right.
   */
  @HasuraEvent()
  public async utility_lineups_practice_events(
    data: HasuraEventData<{
      map_name?: string | null;
      origin_source?: string | null;
    }>,
  ) {
    // A throw a practice server just recorded is already in that server's own
    // library -- the plugin adds it as it writes it -- so broadcasting the
    // insert tells every pod on the map to re-read a library only one of them
    // has a new row in, and tells the pod that caused it to re-read what it
    // already has. A player rehearsing one lineup saves it a dozen times in a
    // session, which is a dozen full-library fetches per connected player for
    // nothing. Every other insert -- authored on the website, forked, imported,
    // mined -- is a row no server on the map has, and does need the push.
    if (!data.old && data.new?.origin_source === "plugin") {
      return;
    }

    const maps = new Set(
      [data.new?.map_name, data.old?.map_name].filter(
        (map): map is string => !!map,
      ),
    );

    for (const map of maps) {
      await this.practice.refreshLibrariesOnMap(map);
    }
  }

  @HasuraAction()
  public async forkUtilityLineup(data: {
    user: User;
    utility_lineup_id: string;
    name?: string;
    collection_id?: string;
  }) {
    return await this.lineups.fork(data.user, {
      utility_lineup_id: data.utility_lineup_id,
      name: data.name ?? null,
      collection_id: data.collection_id ?? null,
    });
  }

  @HasuraAction()
  public async importUtilityLineups(data: {
    user: User;
    payload: unknown;
    dry_run?: boolean;
  }) {
    return await this.imports.importLineups(data.user, {
      payload: data.payload,
      dry_run: data.dry_run ?? null,
    });
  }

  @HasuraAction()
  public async purgeUtilityLineupSource(data: {
    user: User;
    origin_source: string;
    dry_run?: boolean;
  }) {
    return await this.imports.purgeSource(data.user, {
      origin_source: data.origin_source,
      dry_run: data.dry_run ?? null,
    });
  }
}
