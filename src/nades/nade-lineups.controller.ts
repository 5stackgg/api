import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { NadeImportService } from "./nade-import.service";
import { NadeLineupsService } from "./nade-lineups.service";

@Controller("nade-lineups")
export class NadeLineupsController {
  constructor(
    private readonly lineups: NadeLineupsService,
    private readonly imports: NadeImportService,
  ) {}

  @HasuraAction()
  public async forkNadeLineup(data: {
    user: User;
    nade_lineup_id: string;
    name?: string;
    collection_id?: string;
  }) {
    return await this.lineups.fork(data.user, {
      nade_lineup_id: data.nade_lineup_id,
      name: data.name ?? null,
      collection_id: data.collection_id ?? null,
    });
  }

  @HasuraAction()
  public async importNadeLineups(data: {
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
  public async purgeNadeLineupSource(data: {
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
