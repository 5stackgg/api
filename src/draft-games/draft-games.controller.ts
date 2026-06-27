import { Controller } from "@nestjs/common";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { DraftGameService } from "./draft-game.service";
import { DraftService } from "./draft.service";

type DraftGameEvent = {
  op: "INSERT" | "UPDATE" | "DELETE" | "MANUAL";
  old: Record<string, any>;
  new: Record<string, any>;
};

@Controller("draft-games")
export class DraftGamesController {
  constructor(
    private readonly draftGameService: DraftGameService,
    private readonly draftService: DraftService,
  ) {}

  @HasuraEvent()
  public async draft_game_events(data: DraftGameEvent) {
    const draftGameId = (data.new?.id || data.old?.id) as string;
    if (!draftGameId) {
      return;
    }

    if (data.op === "DELETE") {
      await this.draftGameService.onDraftDeleted(draftGameId);
      return;
    }

    if (data.op !== "UPDATE") {
      return;
    }

    if (
      data.old?.status !== data.new?.status &&
      data.new?.status === "Filled"
    ) {
      await this.draftService.beginDraft(draftGameId);
    }
  }

  @HasuraEvent()
  public async draft_game_pick_events(data: DraftGameEvent) {
    if (data.op !== "INSERT") {
      return;
    }
    await this.draftService.applyPick(
      data.new.draft_game_id as string,
      data.new.picked_steam_id as string,
    );
  }

  @HasuraAction()
  public async createDraftGame(data: { user: User; settings: any }) {
    const draftGameId = await this.draftGameService.createDraftGame(
      data.user,
      data.settings,
    );
    return { draftGameId };
  }

  @HasuraAction()
  public async updateDraftGame(data: {
    user: User;
    draftGameId: string;
    settings: any;
  }) {
    await this.draftGameService.updateDraftSettings(
      data.user,
      data.draftGameId,
      data.settings,
    );
    return { success: true };
  }

  @HasuraAction()
  public async joinDraftGame(data: {
    user: User;
    draftGameId: string;
    inviteCode?: string;
  }) {
    await this.draftGameService.joinDraftGame(
      data.user,
      data.draftGameId,
      data.inviteCode,
    );
    return { success: true };
  }

  @HasuraAction()
  public async joinDraftGameAsParty(data: {
    user: User;
    draftGameId: string;
    inviteCode?: string;
  }) {
    await this.draftGameService.joinDraftGameAsParty(
      data.user,
      data.draftGameId,
      data.inviteCode,
    );
    return { success: true };
  }

  @HasuraAction()
  public async addDraftPlayer(data: {
    user: User;
    draftGameId: string;
    steamId: string;
  }) {
    await this.draftGameService.addDraftPlayer(
      data.user,
      data.draftGameId,
      data.steamId,
    );
    return { success: true };
  }

  @HasuraAction()
  public async respondDraftInvite(data: {
    user: User;
    draftGameId: string;
    accept: boolean;
  }) {
    await this.draftGameService.respondDraftInvite(
      data.user,
      data.draftGameId,
      data.accept,
    );
    return { success: true };
  }
}
