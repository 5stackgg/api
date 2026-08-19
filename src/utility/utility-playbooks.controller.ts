import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import {
  UtilityPlaybookStepInput,
  UtilityPlaybooksService,
} from "./utility-playbooks.service";
import { UtilityPracticeService } from "./utility-practice.service";

@Controller("utility-playbooks")
export class UtilityPlaybooksController {
  constructor(
    private readonly playbooks: UtilityPlaybooksService,
    private readonly practice: UtilityPracticeService,
  ) {}

  @HasuraAction()
  public async saveUtilityPlaybook(data: {
    user: User;
    playbook_id?: string;
    name: string;
    description?: string;
    map_name: string;
    side: string;
    team_id?: string;
    visibility?: string;
    steps?: Array<UtilityPlaybookStepInput>;
  }) {
    const { user, ...input } = data;

    return await this.playbooks.save(user, input);
  }

  @HasuraAction()
  public async deleteUtilityPlaybook(data: { user: User; playbook_id: string }) {
    return await this.playbooks.remove(data.user, data.playbook_id);
  }

  @HasuraAction()
  public async loadUtilityPlaybookIntoSession(data: {
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
