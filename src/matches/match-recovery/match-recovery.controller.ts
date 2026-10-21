import { Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { User } from "src/auth/types/User";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { MatchRecoveryService } from "./match-recovery.service";

@Controller("match-recovery")
export class MatchRecoveryController {
  constructor(
    private readonly matchAssistant: MatchAssistantService,
    private readonly recovery: MatchRecoveryService,
  ) {}

  @HasuraAction()
  public async getMatchRestoreRounds(data: { match_id: string; user: User }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.getRestoreRounds(data.match_id, data.user);
  }

  @HasuraAction()
  public async restoreMatchRound(data: {
    match_id: string;
    round: number;
    user: User;
  }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.restoreRound(
      data.match_id,
      data.round,
      data.user,
    );
  }

  @HasuraAction()
  public async restartMatchMap(data: { match_id: string; user: User }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.restartMatchMap(data.match_id, data.user);
  }

  @HasuraAction()
  public async restartMatch(data: { match_id: string; user: User }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.restartMatch(data.match_id);
  }

  @HasuraAction()
  public async rewindMapVeto(data: {
    match_id: string;
    step: number;
    expected_picks?: number;
    user: User;
  }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.rewindMapVeto(
      data.match_id,
      data.step,
      data.expected_picks,
    );
  }

  @HasuraAction()
  public async extendVetoClock(data: {
    match_id: string;
    seconds: number;
    user: User;
  }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.extendVetoClock(data.match_id, data.seconds);
  }

  @HasuraAction()
  public async extendMatchAutoCancel(data: {
    match_id: string;
    minutes: number;
    user: User;
  }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.extendMatchAutoCancel(
      data.match_id,
      data.minutes,
    );
  }

  private async requireOrganizer(matchId: string, user: User) {
    if (!(await this.matchAssistant.isOrganizer(matchId, user))) {
      throw Error("you are not a match organizer");
    }
  }
}
