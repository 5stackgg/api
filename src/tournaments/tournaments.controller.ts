import { Controller, Logger } from "@nestjs/common";
import { HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { e_tournament_status_enum } from "../../generated/zeus";
import { TournamentsService } from "./tournaments.service";

@Controller("tournaments")
export class TournamentsController {
  constructor(
    public readonly logger: Logger,
    private readonly tournamentsService: TournamentsService,
  ) {}

  @HasuraEvent()
  public async tournament_events(data: HasuraEventData<"tournaments">) {
    if (data.new.status === e_tournament_status_enum.Live) {
      await this.tournamentsService.scheduleMatches(data.new.id as string);
    }
  }

  @HasuraEvent()
  public async tournament_bracket(
    data: HasuraEventData<"tournament_brackets">,
  ) {
    console.info("WEE", {
      data,
    });
  }
}
