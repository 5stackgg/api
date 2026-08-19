import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import {
  NadePlaybookStepInput,
  NadePlaybooksService,
} from "./nade-playbooks.service";
import { NadePracticeService } from "./nade-practice.service";

@Controller("nade-playbooks")
export class NadePlaybooksController {
  constructor(
    private readonly playbooks: NadePlaybooksService,
    private readonly practice: NadePracticeService,
  ) {}

  @HasuraAction()
  public async saveNadePlaybook(data: {
    user: User;
    playbook_id?: string;
    name: string;
    description?: string;
    map_name: string;
    side: string;
    team_id?: string;
    visibility?: string;
    steps?: Array<NadePlaybookStepInput>;
  }) {
    const { user, ...input } = data;

    return await this.playbooks.save(user, input);
  }

  @HasuraAction()
  public async deleteNadePlaybook(data: { user: User; playbook_id: string }) {
    return await this.playbooks.remove(data.user, data.playbook_id);
  }

  @HasuraAction()
  public async loadNadePlaybookIntoSession(data: {
    user: User;
    session_id: string;
    playbook_id?: string;
  }) {
    return await this.practice.loadPlaybook(data.user, {
      session_id: data.session_id,
      playbook_id: data.playbook_id ?? null,
    });
  }
}
