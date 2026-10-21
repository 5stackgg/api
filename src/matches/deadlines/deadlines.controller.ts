import { Controller } from "@nestjs/common";
import { HasuraEvent } from "../../hasura/hasura.controller";
import { HasuraEventData } from "../../hasura/types/HasuraEventData";
import { DeadlinesService } from "./deadlines.service";

type Row = { id?: string; veto_pick_expires_at?: string | null };

// Each handler re-reads its row and arms from that, never from the payload, so
// a late, repeated or out-of-order delivery arms the deadline the row has now.
@Controller()
export class DeadlinesController {
  constructor(private readonly deadlines: DeadlinesService) {}

  @HasuraEvent({ retry: true })
  public async match_deadlines(data: HasuraEventData<Row>) {
    const matchId = data.new.id || data.old.id;

    const match = await this.deadlines.armMatch(matchId);

    if (
      (data.new.veto_pick_expires_at ?? null) !==
      (data.old.veto_pick_expires_at ?? null)
    ) {
      await this.deadlines.scheduleVetoPickTimeout(
        matchId,
        match?.veto_pick_expires_at ?? null,
      );
    }
  }

  @HasuraEvent({ retry: true })
  public async tournament_deadlines(data: HasuraEventData<Row>) {
    await this.deadlines.armTournament(data.new.id || data.old.id);
  }

  @HasuraEvent({ retry: true })
  public async tournament_bracket_deadlines(data: HasuraEventData<Row>) {
    await this.deadlines.armBracket(data.new.id || data.old.id);
  }
}
