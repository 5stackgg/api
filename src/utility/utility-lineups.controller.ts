import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { UtilityImportService } from "./utility-import.service";
import { UtilityLineupsService } from "./utility-lineups.service";

@Controller("utility-lineups")
export class UtilityLineupsController {
  constructor(
    private readonly lineups: UtilityLineupsService,
    private readonly imports: UtilityImportService,
  ) {}

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
