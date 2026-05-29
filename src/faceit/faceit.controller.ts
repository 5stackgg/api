import { BadRequestException, Controller, Logger } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { FaceitService } from "./faceit.service";

@Controller("faceit")
export class FaceitController {
  constructor(
    private readonly faceitService: FaceitService,
    private readonly logger: Logger,
  ) {}

  @HasuraAction()
  public async refreshFaceitRank(data: {
    steam_id: string;
  }): Promise<{ success: boolean }> {
    if (!data.steam_id || !/^\d{5,20}$/.test(data.steam_id)) {
      throw new BadRequestException("invalid steam_id");
    }

    if (!this.faceitService.isEnabled()) {
      return { success: false };
    }

    const refreshed = await this.faceitService.refreshPlayer(data.steam_id);
    return { success: refreshed };
  }
}
